use std::{
    collections::{BTreeMap, BTreeSet},
    env,
};

use absurd::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use time::OffsetDateTime;

use super::{CreateWorkflowRunRequest, WorkflowRuntime, WorkflowRuntimeError};

const MIN_PROPOSAL_TTL_SECONDS: i64 = 5 * 60;
const MAX_PROPOSAL_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
const MAX_PARAMETERS_BYTES: usize = 16 * 1024;
const MAX_PARAMETER_DEPTH: usize = 8;
const APPROVAL_ROLE_ALLOWLIST_ENV: &str = "DISCORDBOT_APPROVAL_ROLE_ALLOWLIST";
const ACTION_PROPOSAL_BINDINGS_ENV: &str = "CENTAUR_ACTION_PROPOSAL_BINDINGS_JSON";

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActionProposalBinding {
    action_type: String,
    action_workflow: String,
    observer_workflow: String,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProposalEvidence {
    pub content_digest: String,
    pub source_id: String,
    pub source_type: String,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProposalValidation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_digest: Option<String>,
    pub name: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ActionProposal {
    pub action_type: String,
    pub action_workflow: String,
    pub base_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_ref: Option<String>,
    #[serde(default)]
    pub parameters: Value,
    pub repository: String,
    #[serde(default)]
    pub source_ids: BTreeMap<String, String>,
    #[serde(default)]
    pub evidence: Vec<ProposalEvidence>,
    pub validations: Vec<ProposalValidation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PutActionProposalRequest {
    pub proposal: ActionProposal,
    pub expires_in_seconds: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ActionProposalState {
    pub action_run_id: Option<String>,
    pub action_task_id: Option<String>,
    pub action_workflow: String,
    pub created: bool,
    pub expires_at: OffsetDateTime,
    pub fingerprint: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ApproveActionProposalRequest {
    pub actor_id: String,
    pub capability_class: String,
    pub channel_id: String,
    pub guild_id: String,
    pub message_id: String,
    pub policy_fingerprint: String,
    pub principal_role: String,
    pub repository_scope: Vec<String>,
    pub root_message_id: String,
    pub thread_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ApproveActionProposalResponse {
    pub action_run_id: String,
    pub action_task_id: String,
    pub action_workflow: String,
    pub console_url: Option<String>,
    pub created: bool,
    pub fingerprint: String,
    pub ok: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NotificationTransitionRequest {
    pub scope: String,
    pub semantic_fingerprint: Option<String>,
    pub state_class: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NotificationTransitionResponse {
    pub notify: bool,
    pub resolution: bool,
    pub state_persisted: bool,
}

#[derive(Clone, Debug)]
struct PreviousNotificationState {
    active: bool,
    last_notification_workflow_run_id: Option<String>,
    semantic_fingerprint: Option<String>,
    state_class: String,
}

impl ActionProposal {
    pub fn normalize_and_fingerprint(mut self) -> Result<(Self, String), WorkflowRuntimeError> {
        self.action_type = bounded_identifier("action_type", &self.action_type, 96)?;
        self.action_workflow = bounded_identifier("action_workflow", &self.action_workflow, 128)?;
        self.repository = normalize_exact_repository(&self.repository)?;
        self.base_ref = bounded_string("base_ref", &self.base_ref, 128)?;
        self.head_ref = self
            .head_ref
            .as_deref()
            .map(|value| bounded_string("head_ref", value, 128))
            .transpose()?;
        if self.action_type.starts_with("github:") {
            self.base_ref = immutable_git_object_id("base_ref", &self.base_ref)?;
            self.head_ref = self
                .head_ref
                .as_deref()
                .map(|value| immutable_git_object_id("head_ref", value))
                .transpose()?;
        }
        if self.source_ids.len() > 16 {
            return Err(WorkflowRuntimeError::BadRequest(
                "proposal source_ids must contain at most 16 entries".to_owned(),
            ));
        }
        self.source_ids = self
            .source_ids
            .into_iter()
            .map(|(key, value)| {
                Ok((
                    bounded_identifier("source id name", &key, 64)?,
                    bounded_string("source id", &value, 256)?,
                ))
            })
            .collect::<Result<_, WorkflowRuntimeError>>()?;
        if self.evidence.len() > 32 {
            return Err(WorkflowRuntimeError::BadRequest(
                "proposal evidence must contain at most 32 entries".to_owned(),
            ));
        }
        for evidence in &mut self.evidence {
            evidence.source_type =
                bounded_identifier("evidence source_type", &evidence.source_type, 64)?;
            evidence.source_id = bounded_string("evidence source_id", &evidence.source_id, 256)?;
            evidence.content_digest =
                sha256_fingerprint("evidence content_digest", &evidence.content_digest)?;
        }
        self.evidence.sort();
        self.evidence.dedup();
        if self.validations.is_empty() || self.validations.len() > 16 {
            return Err(WorkflowRuntimeError::BadRequest(
                "proposal validations must contain between 1 and 16 entries".to_owned(),
            ));
        }
        for validation in &mut self.validations {
            validation.name = bounded_identifier("validation name", &validation.name, 64)?;
            if !matches!(validation.status.as_str(), "passed" | "failed" | "skipped") {
                return Err(WorkflowRuntimeError::BadRequest(
                    "validation status must be passed, failed, or skipped".to_owned(),
                ));
            }
            validation.evidence_digest = validation
                .evidence_digest
                .as_deref()
                .map(|value| sha256_fingerprint("validation evidence_digest", value))
                .transpose()?;
        }
        self.validations
            .sort_by(|left, right| left.name.cmp(&right.name));
        if self
            .validations
            .windows(2)
            .any(|pair| pair[0].name == pair[1].name)
        {
            return Err(WorkflowRuntimeError::BadRequest(
                "proposal validation names must be unique".to_owned(),
            ));
        }
        validate_parameter_value(&self.parameters, 0)?;
        let canonical = serde_json::to_vec(&self)?;
        if canonical.len() > MAX_PARAMETERS_BYTES * 2 {
            return Err(WorkflowRuntimeError::BadRequest(
                "canonical proposal is too large".to_owned(),
            ));
        }
        let fingerprint = format!("sha256:{}", hex::encode(Sha256::digest(&canonical)));
        Ok((self, fingerprint))
    }

    fn is_approvable(&self) -> bool {
        self.validations
            .iter()
            .all(|validation| validation.status != "failed")
    }
}

pub async fn put_action_proposal(
    client: &Client,
    request: PutActionProposalRequest,
    observer_workflow: &str,
    observer_task_id: &str,
    observer_run_id: &str,
) -> Result<ActionProposalState, WorkflowRuntimeError> {
    if !(MIN_PROPOSAL_TTL_SECONDS..=MAX_PROPOSAL_TTL_SECONDS).contains(&request.expires_in_seconds)
    {
        return Err(WorkflowRuntimeError::BadRequest(format!(
            "proposal expires_in_seconds must be between {MIN_PROPOSAL_TTL_SECONDS} and {MAX_PROPOSAL_TTL_SECONDS}"
        )));
    }
    let (proposal, fingerprint) = request.proposal.normalize_and_fingerprint()?;
    let action_workflow = reviewed_action_workflow(
        observer_workflow,
        &proposal.action_type,
        &proposal.action_workflow,
    )?;
    let proposal_json = serde_json::to_value(&proposal)?;
    let expires_at =
        OffsetDateTime::now_utc() + time::Duration::seconds(request.expires_in_seconds);
    let inserted = sqlx::query(
        "INSERT INTO workflow_action_proposals (\
         fingerprint, proposal, action_workflow, observer_workflow, observer_task_id, \
         observer_run_id, expires_at) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7) \
         ON CONFLICT (fingerprint) DO NOTHING",
    )
    .bind(&fingerprint)
    .bind(&proposal_json)
    .bind(&action_workflow)
    .bind(observer_workflow)
    .bind(observer_task_id)
    .bind(observer_run_id)
    .bind(expires_at)
    .execute(client.pool())
    .await?
    .rows_affected()
        == 1;

    let mut row = proposal_row(client, &fingerprint).await?;
    let stored_proposal: Value = row.try_get("proposal")?;
    if stored_proposal != proposal_json {
        return Err(WorkflowRuntimeError::Internal(
            "action proposal fingerprint collision".to_owned(),
        ));
    }
    let mut created = inserted;
    let consumed_at: Option<OffsetDateTime> = row.try_get("consumed_at")?;
    let stored_expires_at: OffsetDateTime = row.try_get("expires_at")?;
    if !inserted && consumed_at.is_none() && stored_expires_at <= OffsetDateTime::now_utc() {
        let reactivated = sqlx::query(
            "UPDATE workflow_action_proposals SET observer_workflow = $2, observer_task_id = $3, \
             observer_run_id = $4, expires_at = $5, updated_at = NOW() \
             WHERE fingerprint = $1 AND consumed_at IS NULL AND expires_at <= NOW()",
        )
        .bind(&fingerprint)
        .bind(observer_workflow)
        .bind(observer_task_id)
        .bind(observer_run_id)
        .bind(expires_at)
        .execute(client.pool())
        .await?
        .rows_affected()
            == 1;
        row = proposal_row(client, &fingerprint).await?;
        created = reactivated;
    }
    action_proposal_state(row, created)
}

impl WorkflowRuntime {
    pub async fn approve_action_proposal(
        &self,
        fingerprint: &str,
        mut request: ApproveActionProposalRequest,
    ) -> Result<ApproveActionProposalResponse, WorkflowRuntimeError> {
        let fingerprint = validate_approval_request(fingerprint, &request)?;
        request.repository_scope = request
            .repository_scope
            .iter()
            .map(|repository| normalize_exact_repository(repository))
            .collect::<Result<Vec<_>, _>>()?;
        request.repository_scope.sort();
        let mut tx = self.inner.client.pool().begin().await?;
        let row = sqlx::query(
            "SELECT proposal, action_workflow, observer_workflow, expires_at, consumed_at, action_task_id, action_run_id \
             FROM workflow_action_proposals WHERE fingerprint = $1 FOR UPDATE",
        )
        .bind(&fingerprint)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| WorkflowRuntimeError::NotFound("action proposal not found".to_owned()))?;
        let stored_action_workflow: String = row.try_get("action_workflow")?;
        let observer_workflow: String = row.try_get("observer_workflow")?;
        let proposal_value: Value = row.try_get("proposal")?;
        let (proposal, computed_fingerprint) =
            serde_json::from_value::<ActionProposal>(proposal_value.clone())?
                .normalize_and_fingerprint()?;
        if computed_fingerprint != fingerprint {
            return Err(WorkflowRuntimeError::Internal(
                "stored action proposal fingerprint is invalid".to_owned(),
            ));
        }
        let action_workflow = reviewed_action_workflow(
            &observer_workflow,
            &proposal.action_type,
            &proposal.action_workflow,
        )?;
        if action_workflow != stored_action_workflow {
            return Err(WorkflowRuntimeError::Internal(
                "stored action proposal workflow binding is invalid".to_owned(),
            ));
        }
        if !proposal.is_approvable() {
            return Err(WorkflowRuntimeError::BadRequest(
                "action proposal has a failed validation".to_owned(),
            ));
        }
        if !request
            .repository_scope
            .iter()
            .any(|repository| repository.eq_ignore_ascii_case(&proposal.repository))
        {
            return Err(WorkflowRuntimeError::BadRequest(
                "approver policy does not include the proposal repository".to_owned(),
            ));
        }
        if let (Some(action_task_id), Some(action_run_id)) = (
            row.try_get::<Option<String>, _>("action_task_id")?,
            row.try_get::<Option<String>, _>("action_run_id")?,
        ) {
            tx.commit().await?;
            return Ok(approval_response(
                &fingerprint,
                &action_workflow,
                action_task_id,
                action_run_id,
                false,
            ));
        }
        let expires_at: OffsetDateTime = row.try_get("expires_at")?;
        if expires_at <= OffsetDateTime::now_utc() {
            return Err(WorkflowRuntimeError::BadRequest(
                "action proposal expired; run a fresh observation".to_owned(),
            ));
        }
        let run = self
            .create_run(CreateWorkflowRunRequest {
                workflow_name: action_workflow.clone(),
                input: json!({
                    "approval": {
                        "actor_id": request.actor_id,
                        "capability_class": request.capability_class,
                        "channel_id": request.channel_id,
                        "guild_id": request.guild_id,
                        "message_id": request.message_id,
                        "policy_fingerprint": request.policy_fingerprint,
                        "principal_role": request.principal_role,
                        "proposal_fingerprint": &fingerprint,
                        "repository_scope": request.repository_scope,
                        "root_message_id": request.root_message_id,
                        "thread_id": request.thread_id,
                    },
                    "proposal": proposal_value,
                }),
                idempotency_key: Some(format!("approved-proposal:{fingerprint}")),
                harness_type: None,
                max_attempts: Some(3),
            })
            .await?;
        sqlx::query(
            "UPDATE workflow_action_proposals SET consumed_at = NOW(), approved_by_actor_id = $2, \
             approved_message_id = $3, approved_guild_id = $4, approved_channel_id = $5, \
             approved_thread_id = $6, approved_root_message_id = $7, \
             approved_policy_fingerprint = $8, approved_capability_class = $9, \
             approved_principal_role = $10, approved_repository_scope = $11::jsonb, \
             action_task_id = $12, action_run_id = $13, updated_at = NOW() \
             WHERE fingerprint = $1 AND consumed_at IS NULL",
        )
        .bind(&fingerprint)
        .bind(&request.actor_id)
        .bind(&request.message_id)
        .bind(&request.guild_id)
        .bind(&request.channel_id)
        .bind(&request.thread_id)
        .bind(&request.root_message_id)
        .bind(&request.policy_fingerprint)
        .bind(&request.capability_class)
        .bind(&request.principal_role)
        .bind(serde_json::to_value(&request.repository_scope)?)
        .bind(&run.task_id)
        .bind(&run.run_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(approval_response(
            &fingerprint,
            &action_workflow,
            run.task_id,
            run.run_id,
            run.created,
        ))
    }
}

pub async fn transition_notification_state(
    client: &Client,
    request: NotificationTransitionRequest,
    workflow_run_id: &str,
) -> Result<NotificationTransitionResponse, WorkflowRuntimeError> {
    let request = normalize_notification_request(request)?;
    match try_transition_notification_state(client, request, workflow_run_id).await {
        Ok(response) => Ok(response),
        Err(error) => {
            tracing::warn!(%error, workflow_run_id, "workflow semantic notification state unavailable");
            Ok(NotificationTransitionResponse {
                notify: true,
                resolution: false,
                state_persisted: false,
            })
        }
    }
}

fn normalize_notification_request(
    mut request: NotificationTransitionRequest,
) -> Result<NotificationTransitionRequest, WorkflowRuntimeError> {
    request.scope = bounded_identifier("notification scope", &request.scope, 160)?;
    request.state_class = bounded_identifier("notification state_class", &request.state_class, 96)?;
    request.semantic_fingerprint = request
        .semantic_fingerprint
        .as_deref()
        .map(|value| sha256_fingerprint("semantic_fingerprint", value))
        .transpose()?;
    Ok(request)
}

async fn try_transition_notification_state(
    client: &Client,
    request: NotificationTransitionRequest,
    workflow_run_id: &str,
) -> Result<NotificationTransitionResponse, WorkflowRuntimeError> {
    let scope = request.scope;
    let state_class = request.state_class;
    let active = request.semantic_fingerprint.is_some();
    let mut tx = client.pool().begin().await?;
    // A missing scope row cannot be protected by SELECT ... FOR UPDATE. Take a
    // transaction-scoped advisory lock first so concurrent first transitions
    // calculate notification ownership one at a time across API replicas.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&scope)
        .fetch_optional(&mut *tx)
        .await?;
    let previous = sqlx::query(
        "SELECT semantic_fingerprint, state_class, active, last_notification_workflow_run_id \
         FROM workflow_semantic_notification_states \
         WHERE scope = $1 FOR UPDATE",
    )
    .bind(&scope)
    .fetch_optional(&mut *tx)
    .await?;
    let previous = previous
        .map(|row| {
            Ok::<_, WorkflowRuntimeError>(PreviousNotificationState {
                active: row.try_get("active")?,
                last_notification_workflow_run_id: row
                    .try_get("last_notification_workflow_run_id")?,
                semantic_fingerprint: row.try_get("semantic_fingerprint")?,
                state_class: row.try_get("state_class")?,
            })
        })
        .transpose()?;
    let (notify, resolution) = notification_transition_decision(
        previous.as_ref(),
        active,
        request.semantic_fingerprint.as_deref(),
        &state_class,
        workflow_run_id,
    );
    sqlx::query(
        "INSERT INTO workflow_semantic_notification_states (\
         scope, semantic_fingerprint, state_class, active, last_workflow_run_id, \
         last_notification_workflow_run_id, last_notified_at) \
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN $5 END, CASE WHEN $6 THEN NOW() END) \
         ON CONFLICT (scope) DO UPDATE SET semantic_fingerprint = EXCLUDED.semantic_fingerprint, \
         state_class = EXCLUDED.state_class, active = EXCLUDED.active, \
         last_workflow_run_id = EXCLUDED.last_workflow_run_id, \
         last_notification_workflow_run_id = CASE WHEN $6 \
           THEN EXCLUDED.last_notification_workflow_run_id \
           ELSE workflow_semantic_notification_states.last_notification_workflow_run_id END, \
         last_notified_at = CASE WHEN $6 THEN NOW() ELSE workflow_semantic_notification_states.last_notified_at END, \
         updated_at = NOW()",
    )
    .bind(&scope)
    .bind(&request.semantic_fingerprint)
    .bind(&state_class)
    .bind(active)
    .bind(workflow_run_id)
    .bind(notify)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(NotificationTransitionResponse {
        notify,
        resolution,
        state_persisted: true,
    })
}

fn notification_transition_decision(
    previous: Option<&PreviousNotificationState>,
    active: bool,
    semantic_fingerprint: Option<&str>,
    state_class: &str,
    workflow_run_id: &str,
) -> (bool, bool) {
    let Some(previous) = previous else {
        return (active, false);
    };
    let unchanged = previous.active == active
        && previous.semantic_fingerprint.as_deref() == semantic_fingerprint
        && previous.state_class == state_class;
    if unchanged && previous.last_notification_workflow_run_id.as_deref() == Some(workflow_run_id) {
        return (true, !active);
    }
    if !active {
        return (previous.active, previous.active);
    }
    (!unchanged, false)
}

async fn proposal_row(
    client: &Client,
    fingerprint: &str,
) -> Result<sqlx::postgres::PgRow, WorkflowRuntimeError> {
    sqlx::query(
        "SELECT proposal, action_workflow, expires_at, consumed_at, action_task_id, action_run_id \
         FROM workflow_action_proposals WHERE fingerprint = $1",
    )
    .bind(fingerprint)
    .fetch_one(client.pool())
    .await
    .map_err(WorkflowRuntimeError::from)
}

fn action_proposal_state(
    row: sqlx::postgres::PgRow,
    created: bool,
) -> Result<ActionProposalState, WorkflowRuntimeError> {
    let consumed_at: Option<OffsetDateTime> = row.try_get("consumed_at")?;
    let expires_at: OffsetDateTime = row.try_get("expires_at")?;
    let status = if consumed_at.is_some() {
        "consumed"
    } else if expires_at <= OffsetDateTime::now_utc() {
        "expired"
    } else {
        "pending"
    };
    let proposal: Value = row.try_get("proposal")?;
    let (_, fingerprint) =
        serde_json::from_value::<ActionProposal>(proposal)?.normalize_and_fingerprint()?;
    Ok(ActionProposalState {
        action_run_id: row.try_get("action_run_id")?,
        action_task_id: row.try_get("action_task_id")?,
        action_workflow: row.try_get("action_workflow")?,
        created,
        expires_at,
        fingerprint,
        status: status.to_owned(),
    })
}

fn validate_approval_request(
    fingerprint: &str,
    request: &ApproveActionProposalRequest,
) -> Result<String, WorkflowRuntimeError> {
    let allowed_roles = env::var(APPROVAL_ROLE_ALLOWLIST_ENV)
        .unwrap_or_default()
        .split(|ch: char| ch == ',' || ch.is_whitespace())
        .filter(|role| !role.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    validate_approval_request_with_roles(fingerprint, request, &allowed_roles)
}

fn validate_approval_request_with_roles(
    fingerprint: &str,
    request: &ApproveActionProposalRequest,
    allowed_roles: &[String],
) -> Result<String, WorkflowRuntimeError> {
    let fingerprint = sha256_fingerprint("proposal fingerprint", fingerprint)?;
    for (name, value) in [
        ("actor_id", request.actor_id.as_str()),
        ("channel_id", request.channel_id.as_str()),
        ("guild_id", request.guild_id.as_str()),
        ("message_id", request.message_id.as_str()),
        ("root_message_id", request.root_message_id.as_str()),
        ("thread_id", request.thread_id.as_str()),
    ] {
        if !is_discord_snowflake(value) {
            return Err(WorkflowRuntimeError::BadRequest(format!(
                "approval {name} must be a numeric Discord ID"
            )));
        }
    }
    if request.root_message_id != request.thread_id {
        return Err(WorkflowRuntimeError::BadRequest(
            "approval root must match the immutable Discord thread".to_owned(),
        ));
    }
    bounded_identifier("approval capability_class", &request.capability_class, 64)?;
    sha256_fingerprint("approval policy_fingerprint", &request.policy_fingerprint)?;
    bounded_identifier("approval principal_role", &request.principal_role, 128)?;
    if !allowed_roles
        .iter()
        .any(|role| role == &request.principal_role)
    {
        return Err(WorkflowRuntimeError::BadRequest(
            "Discord role is not permitted to approve workflow proposals".to_owned(),
        ));
    }
    if request.repository_scope.is_empty() || request.repository_scope.len() > 64 {
        return Err(WorkflowRuntimeError::BadRequest(
            "approval repository_scope has an invalid size".to_owned(),
        ));
    }
    let mut repositories = BTreeSet::new();
    for repository in &request.repository_scope {
        let repository = normalize_exact_repository(repository)?;
        if !repositories.insert(repository) {
            return Err(WorkflowRuntimeError::BadRequest(
                "approval repository_scope must contain unique repositories".to_owned(),
            ));
        }
    }
    Ok(fingerprint)
}

fn approval_response(
    fingerprint: &str,
    action_workflow: &str,
    action_task_id: String,
    action_run_id: String,
    created: bool,
) -> ApproveActionProposalResponse {
    let console_url = env::var("CENTAUR_CONSOLE_PUBLIC_URL")
        .ok()
        .map(|base| base.trim_end_matches('/').to_owned())
        .filter(|base| !base.is_empty())
        .map(|base| format!("{base}/console/workflows/{action_workflow}"));
    ApproveActionProposalResponse {
        action_run_id,
        action_task_id,
        action_workflow: action_workflow.to_owned(),
        console_url,
        created,
        fingerprint: fingerprint.to_owned(),
        ok: true,
    }
}

fn validate_parameter_value(value: &Value, depth: usize) -> Result<(), WorkflowRuntimeError> {
    if depth > MAX_PARAMETER_DEPTH {
        return Err(WorkflowRuntimeError::BadRequest(
            "proposal parameters are nested too deeply".to_owned(),
        ));
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
        Value::String(value) if value.len() <= 2_048 => {}
        Value::String(_) => {
            return Err(WorkflowRuntimeError::BadRequest(
                "proposal parameter strings must be at most 2048 bytes".to_owned(),
            ));
        }
        Value::Array(values) if values.len() <= 64 => {
            for value in values {
                validate_parameter_value(value, depth + 1)?;
            }
        }
        Value::Array(_) => {
            return Err(WorkflowRuntimeError::BadRequest(
                "proposal parameter arrays must contain at most 64 entries".to_owned(),
            ));
        }
        Value::Object(values) if values.len() <= 64 => {
            for (key, value) in values {
                bounded_identifier("proposal parameter key", key, 64)?;
                validate_parameter_value(value, depth + 1)?;
            }
        }
        Value::Object(_) => {
            return Err(WorkflowRuntimeError::BadRequest(
                "proposal parameter objects must contain at most 64 entries".to_owned(),
            ));
        }
    }
    if serde_json::to_vec(value)?.len() > MAX_PARAMETERS_BYTES {
        return Err(WorkflowRuntimeError::BadRequest(
            "proposal parameters must be at most 16384 bytes".to_owned(),
        ));
    }
    Ok(())
}

fn bounded_identifier(
    name: &str,
    value: &str,
    maximum: usize,
) -> Result<String, WorkflowRuntimeError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > maximum
        || !value.bytes().enumerate().all(|(index, byte)| {
            if index == 0 {
                byte.is_ascii_alphanumeric()
            } else {
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':')
            }
        })
    {
        return Err(WorkflowRuntimeError::BadRequest(format!(
            "{name} is invalid"
        )));
    }
    Ok(value.to_owned())
}

fn bounded_string(name: &str, value: &str, maximum: usize) -> Result<String, WorkflowRuntimeError> {
    let value = value.trim();
    if value.is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        return Err(WorkflowRuntimeError::BadRequest(format!(
            "{name} is invalid"
        )));
    }
    Ok(value.to_owned())
}

pub fn normalize_exact_repository(value: &str) -> Result<String, WorkflowRuntimeError> {
    let value = value.trim().to_ascii_lowercase();
    let mut parts = value.split('/');
    let owner = parts.next().unwrap_or_default();
    let repository = parts.next().unwrap_or_default();
    let valid = !owner.is_empty()
        && !repository.is_empty()
        && parts.next().is_none()
        && !value.contains('*')
        && !matches!(owner, "." | "..")
        && !matches!(repository, "." | "..")
        && owner.bytes().all(is_github_name_byte)
        && repository.bytes().all(is_github_name_byte);
    if !valid {
        return Err(WorkflowRuntimeError::BadRequest(
            "proposal repository must be an exact owner/repository name".to_owned(),
        ));
    }
    Ok(value)
}

fn reviewed_action_workflow(
    observer_workflow: &str,
    action_type: &str,
    proposed_action_workflow: &str,
) -> Result<String, WorkflowRuntimeError> {
    let raw = env::var(ACTION_PROPOSAL_BINDINGS_ENV).unwrap_or_else(|_| "[]".to_owned());
    let bindings = serde_json::from_str::<Vec<ActionProposalBinding>>(&raw).map_err(|_| {
        WorkflowRuntimeError::Internal(
            "CENTAUR_ACTION_PROPOSAL_BINDINGS_JSON is invalid".to_owned(),
        )
    })?;
    reviewed_action_workflow_with_bindings(
        observer_workflow,
        action_type,
        proposed_action_workflow,
        &bindings,
    )
}

fn reviewed_action_workflow_with_bindings(
    observer_workflow: &str,
    action_type: &str,
    proposed_action_workflow: &str,
    bindings: &[ActionProposalBinding],
) -> Result<String, WorkflowRuntimeError> {
    if bindings.len() > 128 {
        return Err(WorkflowRuntimeError::Internal(
            "action proposal workflow binding policy is too large".to_owned(),
        ));
    }
    let observer_workflow = bounded_identifier("observer_workflow", observer_workflow, 128)?;
    let action_type = bounded_identifier("action_type", action_type, 96)?;
    let proposed_action_workflow =
        bounded_identifier("action_workflow", proposed_action_workflow, 128)?;
    let mut reviewed = BTreeMap::new();
    for binding in bindings {
        let key = (
            bounded_identifier("binding observer_workflow", &binding.observer_workflow, 128)?,
            bounded_identifier("binding action_type", &binding.action_type, 96)?,
        );
        let action_workflow =
            bounded_identifier("binding action_workflow", &binding.action_workflow, 128)?;
        if reviewed.insert(key, action_workflow).is_some() {
            return Err(WorkflowRuntimeError::Internal(
                "action proposal workflow binding policy contains a duplicate tuple".to_owned(),
            ));
        }
    }
    let Some(action_workflow) = reviewed.get(&(observer_workflow, action_type)) else {
        return Err(WorkflowRuntimeError::BadRequest(
            "observer workflow and action type are not bound to a reviewed action workflow"
                .to_owned(),
        ));
    };
    if action_workflow != &proposed_action_workflow {
        return Err(WorkflowRuntimeError::BadRequest(
            "proposal action_workflow does not match the reviewed workflow binding".to_owned(),
        ));
    }
    Ok(action_workflow.clone())
}

fn immutable_git_object_id(name: &str, value: &str) -> Result<String, WorkflowRuntimeError> {
    let value = value.trim().to_ascii_lowercase();
    if !matches!(value.len(), 40 | 64)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(WorkflowRuntimeError::BadRequest(format!(
            "GitHub proposal {name} must be an immutable 40- or 64-character object ID"
        )));
    }
    Ok(value)
}

fn is_github_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
}

fn sha256_fingerprint(name: &str, value: &str) -> Result<String, WorkflowRuntimeError> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(WorkflowRuntimeError::BadRequest(format!(
            "{name} must be a sha256 fingerprint"
        )));
    }
    Ok(value)
}

fn is_discord_snowflake(value: &str) -> bool {
    (16..=22).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposal() -> ActionProposal {
        ActionProposal {
            action_type: "github:create_improvement_pr".to_owned(),
            action_workflow: "execute_approved_improvement".to_owned(),
            base_ref: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            head_ref: None,
            parameters: json!({"source": "weekly_ops_review"}),
            repository: "508-dev/508-workflows".to_owned(),
            source_ids: BTreeMap::from([
                ("github_run".to_owned(), "123".to_owned()),
                ("sentry_issue".to_owned(), "OPS-42".to_owned()),
            ]),
            evidence: vec![ProposalEvidence {
                content_digest: format!("sha256:{}", "a".repeat(64)),
                source_id: "OPS-42".to_owned(),
                source_type: "sentry".to_owned(),
            }],
            validations: vec![ProposalValidation {
                evidence_digest: Some(format!("sha256:{}", "b".repeat(64))),
                name: "source_current".to_owned(),
                status: "passed".to_owned(),
            }],
        }
    }

    #[test]
    fn proposal_fingerprint_is_canonical_and_excludes_ordering_noise() {
        let first = proposal();
        let mut second = proposal();
        second.repository = "508-DEV/508-WORKFLOWS".to_owned();
        second.evidence.reverse();

        let (first, first_fingerprint) = first.normalize_and_fingerprint().unwrap();
        let (second, second_fingerprint) = second.normalize_and_fingerprint().unwrap();

        assert_eq!(first.repository, "508-dev/508-workflows");
        assert_eq!(first, second);
        assert_eq!(first_fingerprint, second_fingerprint);
        assert_eq!(
            first_fingerprint,
            "sha256:10dee99e59991ad9b3c2caf55898a1647d627e03469da1ac052b67aaa8360659"
        );
    }

    #[test]
    fn proposal_rejects_unknown_validation_status_and_wildcard_scope() {
        let mut invalid_status = proposal();
        invalid_status.validations[0].status = "unknown".to_owned();
        assert!(
            invalid_status
                .normalize_and_fingerprint()
                .unwrap_err()
                .to_string()
                .contains("passed, failed, or skipped")
        );

        let mut wildcard = proposal();
        wildcard.repository = "508-dev/*".to_owned();
        assert!(
            wildcard
                .normalize_and_fingerprint()
                .unwrap_err()
                .to_string()
                .contains("exact owner/repository")
        );

        for repository in ["./repo", "508-dev/.", "508-dev/.."] {
            assert!(normalize_exact_repository(repository).is_err());
        }
    }

    #[test]
    fn github_proposal_rejects_mutable_refs() {
        for field in ["base", "head"] {
            let mut mutable = proposal();
            if field == "base" {
                mutable.base_ref = "main".to_owned();
            } else {
                mutable.head_ref = Some("automation/fix".to_owned());
            }
            assert!(
                mutable
                    .normalize_and_fingerprint()
                    .unwrap_err()
                    .to_string()
                    .contains("must be an immutable")
            );
        }
    }

    #[test]
    fn proposal_rejects_conflicting_duplicate_validation_names() {
        let mut duplicate = proposal();
        duplicate.validations.push(ProposalValidation {
            evidence_digest: None,
            name: "source_current".to_owned(),
            status: "failed".to_owned(),
        });
        assert!(
            duplicate
                .normalize_and_fingerprint()
                .unwrap_err()
                .to_string()
                .contains("must be unique")
        );
    }

    #[test]
    fn notification_state_rejects_malformed_semantic_inputs_before_storage() {
        assert!(
            normalize_notification_request(NotificationTransitionRequest {
                scope: "weekly ops with spaces".to_owned(),
                semantic_fingerprint: Some(format!("sha256:{}", "a".repeat(64))),
                state_class: "proposal_pending".to_owned(),
            })
            .is_err()
        );
        assert!(
            normalize_notification_request(NotificationTransitionRequest {
                scope: "weekly_ops_review:automations".to_owned(),
                semantic_fingerprint: Some("model-prose-is-not-state".to_owned()),
                state_class: "proposal_pending".to_owned(),
            })
            .is_err()
        );
    }

    #[test]
    fn notification_claim_replays_only_within_the_claiming_workflow_run() {
        let fingerprint = format!("sha256:{}", "a".repeat(64));
        let previous = PreviousNotificationState {
            active: true,
            last_notification_workflow_run_id: Some("run-claim".to_owned()),
            semantic_fingerprint: Some(fingerprint.clone()),
            state_class: "proposal_pending".to_owned(),
        };

        assert_eq!(
            notification_transition_decision(
                Some(&previous),
                true,
                Some(&fingerprint),
                "proposal_pending",
                "run-claim",
            ),
            (true, false)
        );
        assert_eq!(
            notification_transition_decision(
                Some(&previous),
                true,
                Some(&fingerprint),
                "proposal_pending",
                "run-later",
            ),
            (false, false)
        );

        let resolved = PreviousNotificationState {
            active: false,
            last_notification_workflow_run_id: Some("run-resolve".to_owned()),
            semantic_fingerprint: None,
            state_class: "clear".to_owned(),
        };
        assert_eq!(
            notification_transition_decision(Some(&resolved), false, None, "clear", "run-resolve",),
            (true, true)
        );
        assert_eq!(
            notification_transition_decision(Some(&resolved), false, None, "clear", "run-later",),
            (false, false)
        );
    }

    #[test]
    fn approval_request_requires_exact_discord_and_repository_scope() {
        let fingerprint = format!("sha256:{}", "a".repeat(64));
        let mut request = ApproveActionProposalRequest {
            actor_id: "100000000000000001".to_owned(),
            capability_class: "github:approve".to_owned(),
            channel_id: "300000000000000001".to_owned(),
            guild_id: "200000000000000001".to_owned(),
            message_id: "600000000000000001".to_owned(),
            policy_fingerprint: format!("sha256:{}", "b".repeat(64)),
            principal_role: "discord-operator".to_owned(),
            repository_scope: vec!["508-dev/508-workflows".to_owned()],
            root_message_id: "400000000000000001".to_owned(),
            thread_id: "400000000000000001".to_owned(),
        };
        let allowed_roles = vec!["discord-operator".to_owned()];

        assert_eq!(
            validate_approval_request_with_roles(
                &fingerprint.to_ascii_uppercase(),
                &request,
                &allowed_roles,
            )
            .unwrap(),
            fingerprint
        );

        request.repository_scope = vec!["508-dev/*".to_owned()];
        assert!(
            validate_approval_request_with_roles(&fingerprint, &request, &allowed_roles).is_err()
        );
        request.repository_scope = vec!["508-dev/508-workflows".to_owned()];
        request.root_message_id = "400000000000000002".to_owned();
        assert!(
            validate_approval_request_with_roles(&fingerprint, &request, &allowed_roles).is_err()
        );
        request.root_message_id = request.thread_id.clone();
        assert!(validate_approval_request_with_roles(&fingerprint, &request, &[]).is_err());
    }

    #[test]
    fn observer_and_action_type_select_exactly_one_reviewed_action_workflow() {
        let bindings = vec![ActionProposalBinding {
            action_type: "github:create_improvement_pr".to_owned(),
            action_workflow: "execute_approved_improvement".to_owned(),
            observer_workflow: "weekly_ops_review".to_owned(),
        }];

        assert_eq!(
            reviewed_action_workflow_with_bindings(
                "weekly_ops_review",
                "github:create_improvement_pr",
                "execute_approved_improvement",
                &bindings,
            )
            .unwrap(),
            "execute_approved_improvement"
        );
        assert!(
            reviewed_action_workflow_with_bindings(
                "weekly_ops_review",
                "github:create_improvement_pr",
                "unrelated_privileged_workflow",
                &bindings,
            )
            .is_err()
        );
        assert!(
            reviewed_action_workflow_with_bindings(
                "other_observer",
                "github:create_improvement_pr",
                "execute_approved_improvement",
                &bindings,
            )
            .is_err()
        );

        let duplicate = vec![bindings[0].clone(), bindings[0].clone()];
        assert!(
            reviewed_action_workflow_with_bindings(
                "weekly_ops_review",
                "github:create_improvement_pr",
                "execute_approved_improvement",
                &duplicate,
            )
            .is_err()
        );
    }
}
