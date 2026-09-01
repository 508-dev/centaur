//! Per-session principal registration.
//!
//! Roles are registered once at startup (see [`crate::register_role`]); a
//! When a session starts, [`SessionRegistrar`] upserts the session's principal.
//! Iron-control owns default role assignment for brand-new principals, while
//! existing principals keep their current assignments so operator revocations
//! in console or ``centaur-perms`` remain sticky. The principal is derived from
//! the thread key (see [`crate::derive_principal`]).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::IronControlClient;
use crate::error::{IronControlError, Result};
use crate::models::{Principal, PrincipalInput, PrincipalPolicyInput, SlackChannelPermissionInput};
use crate::principal::{
    derive_principal_with_slack_team, derive_slack_requester_principal, is_direct_message,
    slack_conversation_id,
};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct SessionPrincipalMetadata<'a> {
    actor_user_id: Option<&'a str>,
    discord_actor_user_id: Option<&'a str>,
    discord_policy_roles: Option<&'a Value>,
    slack_team_id: Option<&'a str>,
    slack_user_email: Option<&'a str>,
    conversation_name: Option<&'a str>,
}

const DISCORD_REPO_CACHE_LABEL: &str = "centaur.discord.sandbox_repo_cache";
const DISCORD_OBSERVABILITY_LABEL: &str = "centaur.discord.sandbox_observability_enabled";
const DISCORD_SESSIONS_READ_LABEL: &str = "centaur.discord.sandbox_sessions_read_enabled";
const DISCORD_WORKFLOWS_READ_LABEL: &str = "centaur.discord.sandbox_workflows_read_enabled";
const DISCORD_WORKFLOWS_WRITE_LABEL: &str = "centaur.discord.sandbox_workflows_write_enabled";

#[derive(Clone, Debug, Eq, PartialEq)]
struct DiscordPrincipalCapabilities {
    repo_cache: String,
    observability: bool,
    sessions_read: bool,
    workflows_read: bool,
    workflows_write: bool,
}

impl DiscordPrincipalCapabilities {
    #[cfg(test)]
    fn safe() -> Self {
        Self {
            repo_cache: "none".to_owned(),
            observability: false,
            sessions_read: false,
            workflows_read: false,
            workflows_write: false,
        }
    }

    fn from_role_labels(labels: &BTreeMap<String, String>) -> Result<Self> {
        let repo_cache = labels
            .get(DISCORD_REPO_CACHE_LABEL)
            .map(String::as_str)
            .unwrap_or("none");
        if !matches!(repo_cache, "none" | "public" | "all") {
            return Err(IronControlError::DiscordPolicy(format!(
                "reviewed Discord role has invalid {DISCORD_REPO_CACHE_LABEL}"
            )));
        }
        Ok(Self {
            repo_cache: repo_cache.to_owned(),
            observability: discord_capability_bool(labels, DISCORD_OBSERVABILITY_LABEL)?,
            sessions_read: discord_capability_bool(labels, DISCORD_SESSIONS_READ_LABEL)?,
            workflows_read: discord_capability_bool(labels, DISCORD_WORKFLOWS_READ_LABEL)?,
            workflows_write: discord_capability_bool(labels, DISCORD_WORKFLOWS_WRITE_LABEL)?,
        })
    }
}

impl<'a> SessionPrincipalMetadata<'a> {
    fn from_session_metadata(metadata: Option<&'a Value>) -> Self {
        let Some(metadata) = metadata else {
            return Self::default();
        };
        Self {
            actor_user_id: metadata
                .get("slack_user_id")
                .or_else(|| metadata.get("aad_object_id"))
                .or_else(|| metadata.get("user_id"))
                .and_then(Value::as_str),
            discord_actor_user_id: metadata
                .get("discord_actor_user_id")
                .and_then(Value::as_str),
            discord_policy_roles: metadata.get("discord_policy_role_foreign_ids"),
            slack_team_id: metadata.get("slack_team_id").and_then(Value::as_str),
            slack_user_email: metadata.get("slack_user_email").and_then(Value::as_str),
            conversation_name: metadata
                .get("slack_conversation_name")
                .or_else(|| metadata.get("discord_conversation_name"))
                .or_else(|| metadata.get("linear_conversation_name"))
                .or_else(|| metadata.get("teams_conversation_name"))
                .and_then(Value::as_str),
        }
    }
}

/// Registers a session's principal against iron-control at session start.
///
/// Cheap to clone (the inner [`IronControlClient`] shares a connection pool),
/// so it can live on a shared runtime handle.
#[derive(Clone, Debug)]
pub struct SessionRegistrar {
    client: IronControlClient,
}

impl SessionRegistrar {
    pub fn new(client: IronControlClient) -> Self {
        Self { client }
    }

    /// Upsert the principal for ``thread_key`` using the session metadata the
    /// ingress supplied. Returns the upserted principal record (its ``id`` is
    /// the OID) so callers can bind the session's egress proxy to the same
    /// identity.
    ///
    /// Re-registering an existing channel/user refreshes identity metadata but
    /// leaves its role assignments to iron-control.
    pub async fn register_session(
        &self,
        thread_key: &str,
        metadata: Option<&Value>,
    ) -> Result<Principal> {
        let metadata = SessionPrincipalMetadata::from_session_metadata(metadata);
        let is_discord = thread_key.starts_with("discord:");
        let actor_user_id = if is_discord {
            metadata.discord_actor_user_id
        } else {
            metadata.actor_user_id
        };
        let principal = derive_principal_with_slack_team(
            thread_key,
            actor_user_id,
            metadata.slack_team_id,
            metadata.conversation_name,
        )?;
        let mut input = principal.to_principal_input();
        apply_slack_dm_email(thread_key, metadata.slack_user_email, &mut input);
        let exists = self.merge_existing_labels(&mut input).await?;
        let slack_permission = slack_permission_for_thread(
            thread_key,
            input.slack_channel_id.as_deref(),
            input.slack_user_id.as_deref(),
        );
        let should_upsert_slack_permission = !exists
            || slack_permission
                .as_ref()
                .is_some_and(|permission| is_direct_message(Some(&permission.channel_id)));
        let mut record = self.client.upsert_principal(&input).await?;
        if should_upsert_slack_permission && let Some(permission) = slack_permission {
            self.client
                .upsert_slack_channel_permission(&record.id, &permission)
                .await?;
        }
        if is_discord
            && (metadata.discord_actor_user_id.is_some() || metadata.discord_policy_roles.is_some())
        {
            record = self
                .reconcile_discord_policy_roles(
                    &record,
                    metadata.discord_actor_user_id,
                    metadata.discord_policy_roles,
                )
                .await?;
        }
        Ok(record)
    }

    /// Resolve the principal of the human requesting a turn. An authenticated
    /// Console request carries a fetch-only console-user foreign ID. Otherwise,
    /// Slack channel turns derive and upsert the requester from
    /// ``slack_user_id`` and friends. Returns ``Ok(None)`` for DM threads (the
    /// conversation principal already is the user's), for non-Slack threads,
    /// when the metadata carries no requester, and when the Slack requester is
    /// not proven to belong to the app's home team. This prevents Slack Connect
    /// users from supplying requester credentials to a shared channel turn.
    ///
    /// Unlike [`Self::register_session`], this never writes Slack channel
    /// permissions: the requester principal only scopes proxy credentials, and
    /// the conversation principal already owns the thread's Slack permission.
    /// Roles are left to iron-control's default assignment, as for sessions.
    pub async fn register_requester(
        &self,
        thread_key: &str,
        metadata: Option<&Value>,
    ) -> Result<Option<Principal>> {
        let Some(metadata) = metadata else {
            return Ok(None);
        };
        // The API server strips this reserved identity assertion from every
        // caller except the authenticated Console service. Checking the field,
        // rather than the thread namespace, also covers Console replies to
        // readable Slack and other non-Console sessions.
        if metadata.get("requester_principal_foreign_id").is_some() {
            return self.console_requester(metadata).await;
        }
        let Some(slack_team_id) = eligible_slack_requester_team(metadata) else {
            return Ok(None);
        };
        let Some(slack_user_id) = metadata.get("slack_user_id").and_then(Value::as_str) else {
            return Ok(None);
        };
        let Some(principal) = derive_slack_requester_principal(
            thread_key,
            slack_user_id,
            slack_team_id,
            metadata.get("slack_display_name").and_then(Value::as_str),
        ) else {
            return Ok(None);
        };
        let mut input = principal.to_principal_input();
        set_slack_email(
            &mut input,
            metadata.get("slack_user_email").and_then(Value::as_str),
        );
        self.merge_existing_labels(&mut input).await?;
        Ok(Some(self.client.upsert_principal(&input).await?))
    }

    /// Resolve the requester for a console thread. Console sessions have no
    /// Slack identity to derive, so the console service provisions a
    /// console-user principal for its authenticated user and passes that
    /// foreign ID in the execute metadata. Fetch-only: the console owns
    /// console-user principals' identity fields and reconciliation, so api-rs
    /// never upserts them, and a lookup failure degrades to a requester-less
    /// turn at the caller. The API server strips this metadata field from
    /// every caller except the authenticated console service.
    async fn console_requester(&self, metadata: &Value) -> Result<Option<Principal>> {
        let Some(foreign_id) = metadata
            .get("requester_principal_foreign_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|foreign_id| !foreign_id.is_empty())
        else {
            return Ok(None);
        };
        self.client.get_principal(foreign_id).await.map(Some)
    }

    pub async fn get_principal(&self, principal: &str) -> Result<Principal> {
        self.client.get_principal(principal).await
    }

    /// Fold an existing principal's labels under the freshly derived ones so
    /// labels an operator or the console added survive re-registration.
    /// Returns whether the principal already existed.
    async fn merge_existing_labels(&self, input: &mut PrincipalInput) -> Result<bool> {
        let existing = match self.client.get_principal(&input.foreign_id).await {
            Ok(existing) => Some(existing),
            Err(error) if is_status(&error, 404) => None,
            Err(error) => return Err(error),
        };
        let Some(existing) = existing else {
            return Ok(false);
        };
        let mut labels = existing.labels;
        labels.extend(std::mem::take(&mut input.labels));
        input.labels = labels;
        Ok(true)
    }

    /// Replace every role on an actor-scoped Discord principal with the one
    /// reviewed policy role asserted by the authenticated Discord ingress.
    /// Console replaces the role and capability tuple in one row-locked
    /// transaction. Direct grants are never deleted implicitly; their presence
    /// fails session creation for an operator to reconcile explicitly.
    async fn reconcile_discord_policy_roles(
        &self,
        principal: &Principal,
        actor_user_id: Option<&str>,
        role_value: Option<&Value>,
    ) -> Result<Principal> {
        let actor_user_id = actor_user_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                IronControlError::DiscordPolicy(
                    "actor-scoped Discord session is missing discord_actor_user_id".to_owned(),
                )
            })?;
        let role_foreign_ids = parse_discord_policy_roles(role_value)?;
        if principal.labels.get("discord_user_id").map(String::as_str) != Some(actor_user_id)
            || principal
                .labels
                .get("centaur_discord_policy_managed")
                .map(String::as_str)
                != Some("true")
        {
            return Err(IronControlError::DiscordPolicy(
                "resolved principal is not the expected policy-managed Discord actor".to_owned(),
            ));
        }

        let direct_grants = self.client.list_principal_grants(&principal.id).await?;
        if !direct_grants.is_empty() {
            return Err(IronControlError::DiscordPolicy(format!(
                "principal {} has direct grants outside the reviewed role bundle",
                principal.foreign_id.as_deref().unwrap_or(&principal.id)
            )));
        }

        let mut desired_roles = Vec::with_capacity(role_foreign_ids.len());
        for foreign_id in role_foreign_ids {
            let role = self.client.get_role(foreign_id).await?;
            if role.foreign_id.as_deref() != Some(foreign_id)
                || role
                    .labels
                    .get("centaur_discord_policy_managed")
                    .map(String::as_str)
                    != Some("true")
            {
                return Err(IronControlError::DiscordPolicy(format!(
                    "role {foreign_id} is not marked as a reviewed Discord policy role"
                )));
            }
            desired_roles.push(role);
        }
        let capabilities = DiscordPrincipalCapabilities::from_role_labels(
            &desired_roles
                .first()
                .ok_or_else(|| {
                    IronControlError::DiscordPolicy(
                        "Discord policy did not resolve a reviewed role".to_owned(),
                    )
                })?
                .labels,
        )?;

        let policy = PrincipalPolicyInput {
            role_ids: desired_roles.into_iter().map(|role| role.id).collect(),
            sandbox_repo_cache: capabilities.repo_cache,
            sandbox_observability_enabled: capabilities.observability,
            sandbox_sessions_read_enabled: capabilities.sessions_read,
            sandbox_workflows_read_enabled: capabilities.workflows_read,
            sandbox_workflows_write_enabled: capabilities.workflows_write,
        };
        self.client
            .replace_principal_policy(&principal.id, &policy)
            .await?;
        let mut reconciled = principal.clone();
        reconciled.sandbox_observability_enabled = policy.sandbox_observability_enabled;
        Ok(reconciled)
    }
}

fn discord_capability_bool(labels: &BTreeMap<String, String>, key: &str) -> Result<bool> {
    match labels.get(key).map(String::as_str) {
        None | Some("false") => Ok(false),
        Some("true") => Ok(true),
        Some(_) => Err(IronControlError::DiscordPolicy(format!(
            "reviewed Discord role has invalid {key}"
        ))),
    }
}

fn parse_discord_policy_roles(value: Option<&Value>) -> Result<Vec<&str>> {
    let roles = value.and_then(Value::as_array).ok_or_else(|| {
        IronControlError::DiscordPolicy(
            "discord_policy_role_foreign_ids must be an array".to_owned(),
        )
    })?;
    if roles.len() != 1 {
        return Err(IronControlError::DiscordPolicy(
            "discord_policy_role_foreign_ids must select exactly one role".to_owned(),
        ));
    }
    let mut unique = BTreeSet::new();
    for role in roles {
        let role = role
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= 128)
            .ok_or_else(|| {
                IronControlError::DiscordPolicy(
                    "Discord policy role foreign IDs must be non-empty strings".to_owned(),
                )
            })?;
        if !unique.insert(role) {
            return Err(IronControlError::DiscordPolicy(
                "Discord policy role foreign IDs must be unique".to_owned(),
            ));
        }
    }
    Ok(unique.into_iter().collect())
}

fn eligible_slack_requester_team(metadata: &Value) -> Option<&str> {
    let requester_team = metadata
        .get("slack_team_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|team| !team.is_empty())?;
    let home_team = metadata
        .get("slack_home_team_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|team| !team.is_empty())?;
    (requester_team == home_team).then_some(requester_team)
}

fn slack_permission_for_thread(
    thread_key: &str,
    slack_channel_id: Option<&str>,
    slack_user_id: Option<&str>,
) -> Option<SlackChannelPermissionInput> {
    if let Some(channel_id) = slack_channel_id {
        let channel_id = channel_id.trim();
        return (!is_direct_message(Some(channel_id)))
            .then(|| slack_permission(channel_id.to_owned()));
    }

    slack_user_id?;
    let conversation_id = slack_conversation_id(thread_key)?;
    is_direct_message(Some(conversation_id)).then(|| slack_permission(conversation_id.to_owned()))
}

fn apply_slack_dm_email(
    thread_key: &str,
    slack_user_email: Option<&str>,
    input: &mut PrincipalInput,
) {
    let Some(conversation_id) = slack_conversation_id(thread_key) else {
        return;
    };
    if is_direct_message(Some(conversation_id)) {
        set_slack_email(input, slack_user_email);
    }
}

/// Stamp ``slack_email`` on a user principal, skipping blank emails. Shared by
/// the DM session path and the channel requester path so a user carries the
/// same identity either way.
fn set_slack_email(input: &mut PrincipalInput, slack_user_email: Option<&str>) {
    let Some(email) = slack_user_email
        .map(str::trim)
        .filter(|email| !email.is_empty())
    else {
        return;
    };
    if input.slack_user_id.is_some() {
        input.slack_email = Some(email.to_owned());
    }
}

fn slack_permission(channel_id: String) -> SlackChannelPermissionInput {
    SlackChannelPermissionInput {
        channel_id,
        upload_enabled: true,
        download_enabled: true,
        history_enabled: true,
    }
}

fn is_status(err: &IronControlError, code: u16) -> bool {
    matches!(err, IronControlError::Status { status, .. } if *status == code)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use crate::{PrincipalDerivationError, derive_principal};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[test]
    fn session_principal_metadata_prefers_slack_user_then_teams_ids() {
        assert_eq!(
            SessionPrincipalMetadata::from_session_metadata(Some(&json!({
                "slack_user_id": "U1",
                "aad_object_id": "aad-user-1",
                "user_id": "teams-user-1"
            })))
            .actor_user_id,
            Some("U1")
        );
        assert_eq!(
            SessionPrincipalMetadata::from_session_metadata(Some(&json!({
                "aad_object_id": "aad-user-1",
                "user_id": "teams-user-1"
            })))
            .actor_user_id,
            Some("aad-user-1")
        );
        assert_eq!(
            SessionPrincipalMetadata::from_session_metadata(Some(&json!({
                "user_id": "teams-user-1"
            })))
            .actor_user_id,
            Some("teams-user-1")
        );
    }

    #[test]
    fn session_principal_metadata_keeps_discord_actor_separate() {
        let value = json!({
            "discord_actor_user_id": "discord-user-1",
            "user_id": "generic-user-1",
            "discord_policy_role_foreign_ids": ["discord-observer"]
        });
        let metadata = SessionPrincipalMetadata::from_session_metadata(Some(&value));
        assert_eq!(metadata.discord_actor_user_id, Some("discord-user-1"));
        assert_eq!(metadata.actor_user_id, Some("generic-user-1"));
        assert_eq!(
            parse_discord_policy_roles(metadata.discord_policy_roles).unwrap(),
            vec!["discord-observer"]
        );
    }

    #[test]
    fn discord_policy_roles_require_one_bounded_role() {
        for value in [
            None,
            Some(json!([])),
            Some(json!(["one", "two"])),
            Some(json!([""])),
            Some(json!([1])),
        ] {
            assert!(parse_discord_policy_roles(value.as_ref()).is_err());
        }
    }

    #[test]
    fn discord_role_capabilities_are_typed_and_fail_closed() {
        let labels = BTreeMap::from([
            (DISCORD_REPO_CACHE_LABEL.to_owned(), "all".to_owned()),
            (DISCORD_OBSERVABILITY_LABEL.to_owned(), "true".to_owned()),
            (DISCORD_SESSIONS_READ_LABEL.to_owned(), "false".to_owned()),
            (DISCORD_WORKFLOWS_READ_LABEL.to_owned(), "true".to_owned()),
            (DISCORD_WORKFLOWS_WRITE_LABEL.to_owned(), "true".to_owned()),
        ]);
        assert_eq!(
            DiscordPrincipalCapabilities::from_role_labels(&labels).unwrap(),
            DiscordPrincipalCapabilities {
                repo_cache: "all".to_owned(),
                observability: true,
                sessions_read: false,
                workflows_read: true,
                workflows_write: true,
            }
        );
        assert_eq!(
            DiscordPrincipalCapabilities::from_role_labels(&BTreeMap::new()).unwrap(),
            DiscordPrincipalCapabilities::safe()
        );
        for labels in [
            BTreeMap::from([(DISCORD_REPO_CACHE_LABEL.to_owned(), "everything".to_owned())]),
            BTreeMap::from([(DISCORD_OBSERVABILITY_LABEL.to_owned(), "yes".to_owned())]),
        ] {
            assert!(DiscordPrincipalCapabilities::from_role_labels(&labels).is_err());
        }
    }

    #[test]
    fn session_principal_metadata_accepts_teams_name() {
        assert_eq!(
            SessionPrincipalMetadata::from_session_metadata(Some(&json!({
                "teams_conversation_name": "Casey Harper"
            })))
            .conversation_name,
            Some("Casey Harper")
        );
    }

    #[test]
    fn session_principal_metadata_carries_slack_team_id() {
        assert_eq!(
            SessionPrincipalMetadata::from_session_metadata(Some(&json!({
                "slack_team_id": "T123"
            })))
            .slack_team_id,
            Some("T123")
        );
    }

    #[test]
    fn session_principal_metadata_carries_slack_user_email() {
        assert_eq!(
            SessionPrincipalMetadata::from_session_metadata(Some(&json!({
                "slack_user_email": "ada@example.com"
            })))
            .slack_user_email,
            Some("ada@example.com")
        );
    }

    #[test]
    fn slack_dm_email_applies_only_to_dm_user_principals() {
        let mut dm_input = derive_principal("slack:T123:D123:ts", Some("U123"), None)
            .expect("DM principal should be derivable")
            .to_principal_input();
        apply_slack_dm_email(
            "slack:T123:D123:1773364194.179929",
            Some(" ada@example.com "),
            &mut dm_input,
        );
        assert_eq!(dm_input.slack_email.as_deref(), Some("ada@example.com"));

        let mut channel_input = derive_principal("slack:T123:C123:ts", Some("U123"), None)
            .expect("channel principal should be derivable")
            .to_principal_input();
        apply_slack_dm_email(
            "slack:T123:C123:1773364194.179929",
            Some("ada@example.com"),
            &mut channel_input,
        );
        assert_eq!(channel_input.slack_email, None);
    }

    #[tokio::test]
    async fn register_session_rejects_slack_dm_without_team_id() {
        let registrar =
            SessionRegistrar::new(IronControlClient::new("http://127.0.0.1:1", "test-key"));
        let metadata = json!({ "slack_user_id": "U123" });

        let error = registrar
            .register_session("slack:D123:1773364194.179929", Some(&metadata))
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            IronControlError::PrincipalDerivation(PrincipalDerivationError::MissingSlackTeamId)
        ));
    }

    #[tokio::test]
    async fn register_session_rejects_slack_dm_without_user_id() {
        let registrar =
            SessionRegistrar::new(IronControlClient::new("http://127.0.0.1:1", "test-key"));
        let metadata = json!({ "slack_team_id": "T123" });

        let error = registrar
            .register_session("slack:D123:1773364194.179929", Some(&metadata))
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            IronControlError::PrincipalDerivation(PrincipalDerivationError::MissingSlackUserId)
        ));
    }

    #[tokio::test]
    async fn register_session_leaves_default_roles_to_iron_control() {
        let (base_url, requests, server) = spawn_iron_control_stub(false).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({
            "slack_user_id": "U123",
            "slack_team_id": "T123",
            "slack_conversation_name": "general"
        });

        registrar
            .register_session("slack:T123:C123:1773364194.179929", Some(&metadata))
            .await
            .unwrap();

        let requests = requests.lock().unwrap();
        assert!(
            requests.contains(&"GET /api/v1/principals/lookup/slack-channel-t123-c123".to_owned())
        );
        assert!(requests.contains(&"PUT /api/v1/principals/slack-channel-t123-c123".to_owned()));
        assert!(
            requests.contains(
                &"POST /api/v1/principals/prn_channel/slack_channel_permissions".to_owned()
            )
        );
        assert!(
            !requests
                .iter()
                .any(|request| request == "POST /api/v1/principals/prn_channel/roles"),
            "iron-control assigns configured default roles during principal creation"
        );
        server.abort();
    }

    #[tokio::test]
    async fn register_session_does_not_restore_roles_for_existing_principal() {
        let (base_url, requests, server) = spawn_iron_control_stub(true).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({
            "slack_user_id": "U123",
            "slack_team_id": "T123",
            "slack_conversation_name": "general"
        });

        registrar
            .register_session("slack:T123:C123:1773364194.179929", Some(&metadata))
            .await
            .unwrap();

        let requests = requests.lock().unwrap();
        assert!(
            requests.contains(&"GET /api/v1/principals/lookup/slack-channel-t123-c123".to_owned())
        );
        assert!(requests.contains(&"PUT /api/v1/principals/slack-channel-t123-c123".to_owned()));
        assert!(
            !requests
                .iter()
                .any(|request| request.ends_with("/slack_channel_permissions")),
            "existing principals must not have Slack permissions reset"
        );
        assert!(
            !requests
                .iter()
                .any(|request| request == "POST /api/v1/principals/prn_channel/roles"),
            "existing principals must not have manually removed roles restored"
        );
        server.abort();
    }

    #[tokio::test]
    async fn register_session_upserts_slack_dm_permission_for_new_user_principal() {
        let (base_url, requests, server) = spawn_iron_control_stub(false).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({
            "slack_user_id": "U123",
            "slack_team_id": "T123",
            "slack_conversation_name": "Ada Lovelace"
        });

        registrar
            .register_session("slack:T123:D123:1773364194.179929", Some(&metadata))
            .await
            .unwrap();

        let requests = requests.lock().unwrap();
        assert!(requests.contains(&"PUT /api/v1/principals/slack-user-t123-u123".to_owned()));
        assert!(
            requests
                .contains(&"POST /api/v1/principals/prn_user/slack_channel_permissions".to_owned())
        );
        server.abort();
    }

    #[tokio::test]
    async fn register_session_upserts_slack_dm_permission_for_existing_user_principal() {
        let (base_url, requests, server) = spawn_iron_control_stub(true).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({
            "slack_user_id": "U123",
            "slack_team_id": "T123",
            "slack_conversation_name": "Ada Lovelace"
        });

        registrar
            .register_session("slack:T123:D123:1773364194.179929", Some(&metadata))
            .await
            .unwrap();

        let requests = requests.lock().unwrap();
        assert!(requests.contains(&"PUT /api/v1/principals/slack-user-t123-u123".to_owned()));
        assert!(
            requests
                .contains(&"POST /api/v1/principals/prn_user/slack_channel_permissions".to_owned())
        );
        assert!(
            !requests
                .iter()
                .any(|request| request == "POST /api/v1/principals/prn_user/roles"),
            "existing DM principals must not have manually removed roles restored"
        );
        server.abort();
    }

    #[tokio::test]
    async fn register_session_reconciles_discord_actor_to_the_exact_reviewed_role() {
        let (base_url, requests, server) = spawn_discord_policy_stub(DiscordPolicyStub {
            direct_grant: false,
            reviewed_role: true,
        })
        .await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = discord_policy_metadata();

        let principal = registrar
            .register_session(
                "discord:200000000000000001:300000000000000001:400000000000000001",
                Some(&metadata),
            )
            .await
            .unwrap();
        assert_eq!(principal.id, "prn_discord");

        let requests = requests.lock().unwrap();
        let principal_updates = requests
            .iter()
            .enumerate()
            .filter_map(|(index, request)| {
                (request
                    == "PUT /api/v1/principals/discord-user-200000000000000001-100000000000000001")
                    .then_some(index)
            })
            .collect::<Vec<_>>();
        assert_eq!(
            principal_updates.len(),
            1,
            "identity upsert remains separate from the atomic policy replacement"
        );
        let replace = requests
            .iter()
            .position(|request| request == "PUT /api/v1/principals/prn_discord/roles")
            .expect("roles and capabilities are replaced atomically");
        assert!(
            principal_updates[0] < replace,
            "identity is verified before its reviewed policy is committed"
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.as_str() == "PUT /api/v1/principals/prn_discord/roles")
                .count(),
            1,
        );
        server.abort();
    }

    #[tokio::test]
    async fn register_session_rejects_discord_principal_direct_grants() {
        let (base_url, requests, server) = spawn_discord_policy_stub(DiscordPolicyStub {
            direct_grant: true,
            reviewed_role: true,
        })
        .await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));

        let error = registrar
            .register_session(
                "discord:200000000000000001:300000000000000001:400000000000000001",
                Some(&discord_policy_metadata()),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, IronControlError::DiscordPolicy(_)));
        assert!(
            !requests
                .lock()
                .unwrap()
                .iter()
                .any(|request| request.contains("/roles")),
            "a direct grant blocks before any role mutation"
        );
        server.abort();
    }

    #[tokio::test]
    async fn register_session_rejects_unreviewed_discord_policy_role() {
        let (base_url, requests, server) = spawn_discord_policy_stub(DiscordPolicyStub {
            direct_grant: false,
            reviewed_role: false,
        })
        .await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));

        let error = registrar
            .register_session(
                "discord:200000000000000001:300000000000000001:400000000000000001",
                Some(&discord_policy_metadata()),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, IronControlError::DiscordPolicy(_)));
        assert!(
            !requests.lock().unwrap().iter().any(|request| {
                request.starts_with("DELETE ")
                    || request == "POST /api/v1/principals/prn_discord/roles"
                    || request == "PUT /api/v1/principals/prn_discord/roles"
            }),
            "an unreviewed role blocks before any assignment mutation"
        );
        server.abort();
    }

    #[test]
    fn slack_email_applies_only_to_user_principals_with_non_blank_email() {
        let mut user_input = derive_principal("slack:T123:D123:ts", Some("U123"), None)
            .expect("DM principal should be derivable")
            .to_principal_input();
        set_slack_email(&mut user_input, Some(" ada@example.com "));
        assert_eq!(user_input.slack_email.as_deref(), Some("ada@example.com"));

        let mut blank_input = derive_principal("slack:T123:D123:ts", Some("U123"), None)
            .expect("DM principal should be derivable")
            .to_principal_input();
        set_slack_email(&mut blank_input, Some("   "));
        assert_eq!(blank_input.slack_email, None);

        let mut channel_input = derive_principal("slack:T123:C123:ts", None, None)
            .expect("channel principal should be derivable")
            .to_principal_input();
        set_slack_email(&mut channel_input, Some("ada@example.com"));
        assert_eq!(channel_input.slack_email, None);
    }

    #[tokio::test]
    async fn register_requester_upserts_user_principal_without_roles_or_permissions() {
        let (base_url, requests, server) = spawn_iron_control_stub(false).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({
            "slack_user_id": "U123",
            "slack_team_id": "T123",
            "slack_home_team_id": "T123",
            "slack_display_name": "Ada Lovelace",
            "slack_user_email": "ada@example.com"
        });

        let principal = registrar
            .register_requester("slack:T123:C123:1773364194.179929", Some(&metadata))
            .await
            .unwrap()
            .expect("channel requester resolves to a principal");
        assert_eq!(principal.id, "prn_user");

        let requests = requests.lock().unwrap();
        assert!(
            requests.contains(&"GET /api/v1/principals/lookup/slack-user-t123-u123".to_owned())
        );
        assert!(requests.contains(&"PUT /api/v1/principals/slack-user-t123-u123".to_owned()));
        assert!(
            !requests
                .iter()
                .any(|request| request.ends_with("/slack_channel_permissions")),
            "requester upserts must not write Slack channel permissions"
        );
        assert!(
            !requests
                .iter()
                .any(|request| request == "POST /api/v1/principals/prn_user/roles"),
            "iron-control owns default role assignment"
        );
        server.abort();
    }

    #[tokio::test]
    async fn register_requester_merges_labels_for_existing_principal() {
        let (base_url, requests, server) = spawn_iron_control_stub(true).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({
            "slack_user_id": "U123",
            "slack_team_id": "T123",
            "slack_home_team_id": "T123"
        });

        let principal = registrar
            .register_requester("slack:T123:C123:1773364194.179929", Some(&metadata))
            .await
            .unwrap()
            .expect("channel requester resolves to a principal");
        assert_eq!(principal.id, "prn_user");

        let requests = requests.lock().unwrap();
        assert!(requests.contains(&"PUT /api/v1/principals/slack-user-t123-u123".to_owned()));
        assert!(
            !requests
                .iter()
                .any(|request| request.ends_with("/slack_channel_permissions")),
            "existing requester principals must not have Slack permissions reset"
        );
        assert!(
            !requests
                .iter()
                .any(|request| request == "POST /api/v1/principals/prn_user/roles"),
            "existing requester principals must not have removed roles restored"
        );
        server.abort();
    }

    #[tokio::test]
    async fn register_requester_returns_none_for_dm_thread() {
        let (base_url, requests, server) = spawn_iron_control_stub(false).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({
            "slack_user_id": "U123",
            "slack_team_id": "T123",
            "slack_home_team_id": "T123"
        });

        let principal = registrar
            .register_requester("slack:T123:D123:1773364194.179929", Some(&metadata))
            .await
            .unwrap();

        assert_eq!(principal, None);
        assert!(requests.lock().unwrap().is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn register_requester_returns_none_without_slack_user_id() {
        let (base_url, requests, server) = spawn_iron_control_stub(false).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({
            "aad_object_id": "aad-user-1",
            "user_id": "teams-user-1",
            "slack_team_id": "T123",
            "slack_home_team_id": "T123"
        });

        let principal = registrar
            .register_requester("slack:T123:C123:1773364194.179929", Some(&metadata))
            .await
            .unwrap();

        assert_eq!(principal, None);
        assert!(requests.lock().unwrap().is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn register_requester_returns_none_for_non_slack_thread() {
        let (base_url, requests, server) = spawn_iron_control_stub(false).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({
            "slack_user_id": "U123",
            "slack_team_id": "T123",
            "slack_home_team_id": "T123"
        });

        let principal = registrar
            .register_requester("linear:issue-1", Some(&metadata))
            .await
            .unwrap();

        assert_eq!(principal, None);
        assert!(requests.lock().unwrap().is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn register_requester_returns_none_for_external_slack_team() {
        let (base_url, requests, server) = spawn_iron_control_stub(false).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({
            "slack_user_id": "U123",
            "slack_team_id": "T_EXTERNAL",
            "slack_home_team_id": "T_HOME"
        });

        let principal = registrar
            .register_requester("slack:T_HOME:C123:1773364194.179929", Some(&metadata))
            .await
            .unwrap();

        assert_eq!(principal, None);
        assert!(requests.lock().unwrap().is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn register_requester_returns_none_without_home_team() {
        let (base_url, requests, server) = spawn_iron_control_stub(false).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({
            "slack_user_id": "U123",
            "slack_team_id": "T123"
        });

        let principal = registrar
            .register_requester("slack:T123:C123:1773364194.179929", Some(&metadata))
            .await
            .unwrap();

        assert_eq!(principal, None);
        assert!(requests.lock().unwrap().is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn register_requester_resolves_console_requester_principal() {
        let (base_url, requests, server) = spawn_iron_control_stub(false).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({
            "requester_principal_foreign_id": "console-user-ada-example-com-abc123"
        });

        let principal = registrar
            .register_requester(
                "console:9f1b7a3c-2d4e-4f6a-8b0c-1d2e3f4a5b6c",
                Some(&metadata),
            )
            .await
            .unwrap()
            .expect("console requester resolves to the provisioned principal");
        assert_eq!(principal.id, "prn_console_user");

        let requests = requests.lock().unwrap();
        assert_eq!(
            requests.as_slice(),
            ["GET /api/v1/principals/lookup/console-user-ada-example-com-abc123".to_owned()],
            "console requesters are fetched, never upserted"
        );
        server.abort();
    }

    #[tokio::test]
    async fn register_requester_resolves_console_requester_for_slack_thread() {
        let (base_url, requests, server) = spawn_iron_control_stub(false).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({
            "requester_principal_foreign_id": "console-user-ada-example-com-abc123"
        });

        let principal = registrar
            .register_requester("slack:T123:C123:1773364194.179929", Some(&metadata))
            .await
            .unwrap()
            .expect("console requester resolves independently of the thread namespace");

        assert_eq!(principal.id, "prn_console_user");
        assert_eq!(
            requests.lock().unwrap().as_slice(),
            ["GET /api/v1/principals/lookup/console-user-ada-example-com-abc123".to_owned()]
        );
        server.abort();
    }

    #[tokio::test]
    async fn register_requester_returns_none_for_console_thread_without_foreign_id() {
        let (base_url, requests, server) = spawn_iron_control_stub(false).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({ "user_email": "ada@example.com" });

        let principal = registrar
            .register_requester(
                "console:9f1b7a3c-2d4e-4f6a-8b0c-1d2e3f4a5b6c",
                Some(&metadata),
            )
            .await
            .unwrap();

        assert_eq!(principal, None);
        assert!(requests.lock().unwrap().is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn register_requester_errors_for_unknown_console_principal() {
        let (base_url, requests, server) = spawn_iron_control_stub(false).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({
            "requester_principal_foreign_id": "console-user-ghost"
        });

        let result = registrar
            .register_requester(
                "console:9f1b7a3c-2d4e-4f6a-8b0c-1d2e3f4a5b6c",
                Some(&metadata),
            )
            .await;

        assert!(result.is_err());
        assert_eq!(
            requests.lock().unwrap().as_slice(),
            ["GET /api/v1/principals/lookup/console-user-ghost".to_owned()]
        );
        server.abort();
    }

    #[test]
    fn requester_team_eligibility_requires_matching_non_blank_teams() {
        for metadata in [
            json!({"slack_home_team_id": "T123"}),
            json!({"slack_team_id": "T123"}),
            json!({"slack_team_id": "", "slack_home_team_id": "T123"}),
            json!({"slack_team_id": "T123", "slack_home_team_id": "   "}),
            json!({"slack_team_id": "T_EXTERNAL", "slack_home_team_id": "T_HOME"}),
        ] {
            assert_eq!(eligible_slack_requester_team(&metadata), None);
        }

        assert_eq!(
            eligible_slack_requester_team(&json!({
                "slack_team_id": " T123 ",
                "slack_home_team_id": "T123"
            })),
            Some("T123")
        );
    }

    #[test]
    fn slack_permission_for_thread_skips_dm_channel_fallback_without_user() {
        assert_eq!(
            slack_permission_for_thread("slack:D123:ts", Some("D123"), None),
            None
        );
    }

    fn discord_policy_metadata() -> Value {
        json!({
            "discord_actor_user_id": "100000000000000001",
            "discord_policy_role_foreign_ids": ["discord-observer"]
        })
    }

    #[derive(Clone, Copy)]
    struct DiscordPolicyStub {
        direct_grant: bool,
        reviewed_role: bool,
    }

    async fn spawn_discord_policy_stub(
        config: DiscordPolicyStub,
    ) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut request = Vec::new();
                let mut buf = [0u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&buf[..read]),
                    }
                }
                let request = String::from_utf8_lossy(&request);
                let first_line = request.lines().next().unwrap_or_default();
                let mut parts = first_line.split_whitespace();
                let method = parts.next().unwrap_or_default();
                let path = parts.next().unwrap_or_default();
                seen.lock().unwrap().push(format!("{method} {path}"));

                let principal = r#"{"data":{"id":"prn_discord","foreign_id":"discord-user-200000000000000001-100000000000000001","name":"Discord User","labels":{"managed-by":"centaur","discord_guild_id":"200000000000000001","discord_channel_id":"300000000000000001","discord_user_id":"100000000000000001","centaur_discord_policy_managed":"true"}}}"#;
                let role_labels = if config.reviewed_role {
                    r#"{"centaur_discord_policy_managed":"true","centaur.discord.sandbox_repo_cache":"all","centaur.discord.sandbox_observability_enabled":"true","centaur.discord.sandbox_sessions_read_enabled":"false","centaur.discord.sandbox_workflows_read_enabled":"true","centaur.discord.sandbox_workflows_write_enabled":"true"}"#
                } else {
                    "{}"
                };
                let role = format!(
                    r#"{{"data":{{"id":"role_observer","foreign_id":"discord-observer","name":"Discord Observer","labels":{role_labels}}}}}"#
                );
                let grants = if config.direct_grant {
                    r#"{"data":[{"id":"grant_direct","principal_id":"prn_discord"}]}"#
                } else {
                    r#"{"data":[]}"#
                };
                let (status_line, body) = match (method, path) {
                    (
                        "GET",
                        "/api/v1/principals/lookup/discord-user-200000000000000001-100000000000000001",
                    ) => ("404 Not Found", r#"{"error":"not found"}"#.to_owned()),
                    (
                        "PUT",
                        "/api/v1/principals/discord-user-200000000000000001-100000000000000001",
                    ) => ("200 OK", principal.to_owned()),
                    ("GET", "/api/v1/principals/prn_discord/grants?page=1&limit=100") => {
                        ("200 OK", grants.to_owned())
                    }
                    ("GET", "/api/v1/roles/lookup/discord-observer") => ("200 OK", role),
                    ("PUT", "/api/v1/principals/prn_discord/roles") => {
                        ("200 OK", r#"{"data":{"ok":true}}"#.to_owned())
                    }
                    _ => (
                        "500 Internal Server Error",
                        r#"{"error":"unexpected"}"#.to_owned(),
                    ),
                };
                let response = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len(),
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        (base_url, requests, handle)
    }

    async fn spawn_iron_control_stub(
        principal_exists: bool,
    ) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut request = Vec::new();
                let mut buf = [0u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&buf[..read]),
                    }
                }
                let request = String::from_utf8_lossy(&request);
                let first_line = request.lines().next().unwrap_or_default();
                let mut parts = first_line.split_whitespace();
                let method = parts.next().unwrap_or_default();
                let path = parts.next().unwrap_or_default();
                seen.lock().unwrap().push(format!("{method} {path}"));

                let (status_line, body) = match (method, path) {
                    ("GET", "/api/v1/principals/lookup/slack-channel-t123-c123")
                        if principal_exists =>
                    {
                        ("200 OK", channel_principal_body())
                    }
                    ("GET", "/api/v1/principals/lookup/slack-user-t123-u123")
                        if principal_exists =>
                    {
                        ("200 OK", user_principal_body())
                    }
                    ("GET", "/api/v1/principals/lookup/slack-channel-t123-c123")
                    | ("GET", "/api/v1/principals/lookup/slack-user-t123-u123") => {
                        ("404 Not Found", r#"{"error":"not found"}"#.to_owned())
                    }
                    ("PUT", "/api/v1/principals/slack-channel-t123-c123") => {
                        ("200 OK", channel_principal_body())
                    }
                    ("PUT", "/api/v1/principals/slack-user-t123-u123") => {
                        ("200 OK", user_principal_body())
                    }
                    ("GET", "/api/v1/principals/lookup/console-user-ada-example-com-abc123") => {
                        ("200 OK", console_user_principal_body())
                    }
                    ("GET", "/api/v1/principals/lookup/console-user-ghost") => {
                        ("404 Not Found", r#"{"error":"not found"}"#.to_owned())
                    }
                    (
                        "POST",
                        "/api/v1/principals/prn_channel/slack_channel_permissions"
                        | "/api/v1/principals/prn_user/slack_channel_permissions",
                    ) => ("200 OK", r#"{"data":{"ok":true}}"#.to_owned()),
                    ("POST", "/api/v1/principals/prn_channel/roles") => {
                        ("200 OK", r#"{"data":{"ok":true}}"#.to_owned())
                    }
                    _ => (
                        "500 Internal Server Error",
                        r#"{"error":"unexpected"}"#.to_owned(),
                    ),
                };
                let response = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len(),
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        (base_url, requests, handle)
    }

    fn channel_principal_body() -> String {
        r#"{"data":{"id":"prn_channel","foreign_id":"slack-channel-t123-c123","name":"Slack Channel #general","labels":{}}}"#.to_owned()
    }

    fn user_principal_body() -> String {
        r#"{"data":{"id":"prn_user","foreign_id":"slack-user-t123-u123","name":"Slack DM @Ada Lovelace","labels":{}}}"#.to_owned()
    }

    fn console_user_principal_body() -> String {
        r#"{"data":{"id":"prn_console_user","foreign_id":"console-user-ada-example-com-abc123","name":"Ada Lovelace","labels":{}}}"#.to_owned()
    }
}
