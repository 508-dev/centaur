use std::{
    env,
    error::Error,
    str::FromStr,
    time::{SystemTime, UNIX_EPOCH},
};

use sqlx::{Connection, Executor, PgConnection, Row, postgres::PgConnectOptions};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static RLS_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, PartialEq, Eq)]
struct VisibleRows {
    slack_channels: Vec<String>,
    slack_users: Vec<String>,
    slack_messages: Vec<String>,
    slack_attachments: Vec<String>,
    context_docs: Vec<String>,
    google_drive_runs: i64,
    google_drive_files: i64,
    google_drive_checkpoints: i64,
    google_calendar_runs: i64,
    google_calendar_calendars: i64,
    google_calendar_events: i64,
    google_calendar_checkpoints: i64,
    linear_runs: i64,
    linear_projects: i64,
    linear_issues: i64,
    linear_comments: i64,
    linear_checkpoints: i64,
}

#[derive(Debug, PartialEq, Eq)]
struct CompanyContextSearchRows {
    company_context_docs: Vec<String>,
    google_docs: Vec<String>,
    granola_docs: Vec<String>,
    slack_private_docs: Vec<String>,
    slack_private_conversation_docs: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct CompanyContextReaderRows {
    slack_channels: Vec<String>,
    company_context_docs: Vec<String>,
    google_docs_observations: Vec<String>,
    google_docs: Vec<String>,
    granola_docs: Vec<String>,
    slack_private_docs: Vec<String>,
    slack_private_conversation_docs: Vec<String>,
}

#[derive(Default)]
struct CompanyContextReaderSettings<'a> {
    slack_channel_id: Option<&'a str>,
    slack_history_channel_ids: Option<&'a str>,
    slack_include_public: Option<bool>,
    slack_team_id: Option<&'a str>,
    slack_user_id: Option<&'a str>,
    user_email: Option<&'a str>,
    google_email: Option<&'a str>,
    google_subject: Option<&'a str>,
}

#[tokio::test]
async fn etl_context_rls_enforces_channel_visibility() -> Result<(), Box<dyn Error>> {
    let Some(mut fixture) = RlsTestFixture::create().await? else {
        return Ok(());
    };
    let result = assert_channel_visibility(&mut fixture.conn).await;
    fixture.finish(result).await
}

#[tokio::test]
async fn company_context_reader_role_has_narrow_security_surface() -> Result<(), Box<dyn Error>> {
    let Some(mut fixture) = RlsTestFixture::create().await? else {
        return Ok(());
    };
    let result = assert_company_context_reader_role_security(&mut fixture.conn)
        .await
        .map_err(Into::into);
    fixture.finish(result).await
}

#[tokio::test]
async fn centaur_diagnostics_reader_exposes_only_sanitized_views() -> Result<(), Box<dyn Error>> {
    let Some(mut fixture) = RlsTestFixture::create().await? else {
        return Ok(());
    };
    let result = assert_centaur_diagnostics_reader_security(&mut fixture.conn).await;
    fixture.finish(result).await
}

#[tokio::test]
async fn company_context_reader_preserves_scoped_search_behavior() -> Result<(), Box<dyn Error>> {
    let Some(mut fixture) = RlsTestFixture::create().await? else {
        return Ok(());
    };
    let result = assert_company_context_reader_search_behavior(&mut fixture.conn).await;
    fixture.finish(result).await
}

#[tokio::test]
async fn company_context_reader_scores_multiterm_granola_keyword_results()
-> Result<(), Box<dyn Error>> {
    let Some(mut fixture) = RlsTestFixture::create().await? else {
        return Ok(());
    };
    let result = assert_multiterm_granola_keyword_score(&mut fixture.conn).await;
    fixture.finish(result).await
}

#[tokio::test]
async fn company_context_reader_scopes_multiterm_granola_keyword_results()
-> Result<(), Box<dyn Error>> {
    let Some(mut fixture) = RlsTestFixture::create().await? else {
        return Ok(());
    };
    let result = assert_multiterm_granola_keyword_scope(&mut fixture.conn).await;
    fixture.finish(result).await
}

#[tokio::test]
async fn company_context_reader_denies_unauthorized_user_data() -> Result<(), Box<dyn Error>> {
    let Some(mut fixture) = RlsTestFixture::create().await? else {
        return Ok(());
    };
    let result = assert_company_context_reader_denies_unauthorized_rows(&mut fixture.conn)
        .await
        .map_err(Into::into);
    fixture.finish(result).await
}

#[tokio::test]
async fn company_context_reader_accepts_only_explicit_channel_grants() -> Result<(), Box<dyn Error>>
{
    let Some(mut fixture) = RlsTestFixture::create().await? else {
        return Ok(());
    };
    let result = assert_company_context_reader_channel_grants(&mut fixture.conn)
        .await
        .map_err(Into::into);
    fixture.finish(result).await
}

#[tokio::test]
async fn company_context_reader_public_membership_does_not_grant_channel_access()
-> Result<(), Box<dyn Error>> {
    let Some(mut fixture) = RlsTestFixture::create().await? else {
        return Ok(());
    };
    let result = assert_company_context_reader_public_channel_membership(&mut fixture.conn)
        .await
        .map_err(Into::into);
    fixture.finish(result).await
}

async fn assert_channel_visibility(conn: &mut PgConnection) -> Result<(), Box<dyn Error>> {
    assert_rls_enabled(conn).await?;
    assert_expected_policies(conn).await?;
    assert_legacy_admin_state_is_removed(conn).await?;

    let c_alpha = visible_rows(conn, "centaur_slack_reader", Some("C_ALPHA")).await?;
    assert_eq!(
        c_alpha,
        VisibleRows {
            slack_channels: vec!["C_ALPHA".to_owned()],
            slack_users: vec![],
            slack_messages: vec!["C_ALPHA:1000.000001".to_owned()],
            slack_attachments: vec!["C_ALPHA:1000.000001:F_ALPHA".to_owned()],
            context_docs: vec!["doc_slack_alpha".to_owned()],
            google_drive_runs: 0,
            google_drive_files: 0,
            google_drive_checkpoints: 0,
            google_calendar_runs: 0,
            google_calendar_calendars: 0,
            google_calendar_events: 0,
            google_calendar_checkpoints: 0,
            linear_runs: 0,
            linear_projects: 0,
            linear_issues: 0,
            linear_comments: 0,
            linear_checkpoints: 0,
        }
    );

    let c_beta = visible_rows(conn, "centaur_slack_reader", Some("C_BETA")).await?;
    assert_eq!(
        c_beta,
        VisibleRows {
            slack_channels: vec!["C_BETA".to_owned()],
            slack_users: vec![],
            slack_messages: vec!["C_BETA:1000.000002".to_owned()],
            slack_attachments: vec!["C_BETA:1000.000002:F_BETA".to_owned()],
            context_docs: vec!["doc_slack_beta".to_owned()],
            google_drive_runs: 0,
            google_drive_files: 0,
            google_drive_checkpoints: 0,
            google_calendar_runs: 0,
            google_calendar_calendars: 0,
            google_calendar_events: 0,
            google_calendar_checkpoints: 0,
            linear_runs: 0,
            linear_projects: 0,
            linear_issues: 0,
            linear_comments: 0,
            linear_checkpoints: 0,
        }
    );

    let dm_or_missing_channel = visible_rows(conn, "centaur_slack_reader", Some("")).await?;
    assert_eq!(dm_or_missing_channel, empty_visible_rows());

    let unset_channel = visible_rows(conn, "centaur_slack_reader", None).await?;
    assert_eq!(unset_channel, empty_visible_rows());

    let formerly_admin_channel =
        visible_rows(conn, "centaur_slack_reader", Some("C_ADMIN")).await?;
    assert_eq!(
        formerly_admin_channel,
        VisibleRows {
            slack_channels: vec!["C_ADMIN".to_owned()],
            slack_users: vec![],
            slack_messages: vec![],
            slack_attachments: vec![],
            context_docs: vec![],
            google_drive_runs: 0,
            google_drive_files: 0,
            google_drive_checkpoints: 0,
            google_calendar_runs: 0,
            google_calendar_calendars: 0,
            google_calendar_events: 0,
            google_calendar_checkpoints: 0,
            linear_runs: 0,
            linear_projects: 0,
            linear_issues: 0,
            linear_comments: 0,
            linear_checkpoints: 0,
        }
    );

    let readonly_role = visible_rows(conn, "centaur_readonly", None).await?;
    assert_eq!(readonly_role, public_visible_rows());

    let readonly_private_channel =
        visible_rows(conn, "centaur_readonly", Some("G_PRIVATE")).await?;
    assert_eq!(readonly_private_channel, public_and_private_visible_rows());

    Ok(())
}

async fn assert_company_context_reader_search_behavior(
    conn: &mut PgConnection,
) -> Result<(), Box<dyn Error>> {
    let company_context_public = company_context_docs(conn, None, r#"[]"#, true).await?;
    assert_eq!(
        company_context_public,
        vec!["doc_slack_alpha".to_owned(), "doc_slack_beta".to_owned(),]
    );

    let company_context_private_history =
        company_context_docs(conn, None, r#"["G_PRIVATE"]"#, true).await?;
    assert_eq!(
        company_context_private_history,
        vec![
            "doc_slack_alpha".to_owned(),
            "doc_slack_beta".to_owned(),
            "doc_slack_private".to_owned(),
        ]
    );

    let company_context_history_no_public =
        company_context_docs(conn, None, r#"["C_ALPHA"]"#, false).await?;
    assert_eq!(
        company_context_history_no_public,
        vec!["doc_slack_alpha".to_owned()]
    );

    let company_context_current_channel =
        company_context_docs(conn, Some("C_ALPHA"), r#"[]"#, false).await?;
    assert_eq!(
        company_context_current_channel,
        vec!["doc_slack_alpha".to_owned()]
    );

    let search_rows = company_context_search_rows(conn).await?;
    assert_eq!(
        search_rows,
        CompanyContextSearchRows {
            company_context_docs: vec![
                "doc_slack_alpha".to_owned(),
                "doc_slack_beta".to_owned(),
                "doc_slack_private".to_owned(),
            ],
            google_docs: vec!["gdocs_doc".to_owned()],
            granola_docs: vec![
                "granola:note:granola_note".to_owned(),
                "granola:note:granola_note_old".to_owned(),
            ],
            slack_private_docs: vec!["slack_dm:T_HOME:D_VISIBLE:2000.000001".to_owned()],
            slack_private_conversation_docs: vec![
                "slack_dm_conversation:T_HOME:D_VISIBLE".to_owned(),
                "slack_dm_conversation:T_HOME:G_PRIVATE".to_owned(),
            ],
        }
    );

    Ok(())
}

async fn assert_multiterm_granola_keyword_score(
    conn: &mut PgConnection,
) -> Result<(), Box<dyn Error>> {
    let rows = granola_keyword_search_rows(conn, "viewer@example.com").await?;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "granola:note:granola_note");
    assert!(rows[0].1 > 0.0, "matching document must have a BM25 score");
    Ok(())
}

async fn assert_multiterm_granola_keyword_scope(
    conn: &mut PgConnection,
) -> Result<(), Box<dyn Error>> {
    let viewer_rows = granola_keyword_search_rows(conn, "viewer@example.com").await?;
    assert_eq!(
        viewer_rows
            .iter()
            .map(|(document_id, _score)| document_id.as_str())
            .collect::<Vec<_>>(),
        vec!["granola:note:granola_note"]
    );

    let other_rows = granola_keyword_search_rows(conn, "other@example.com").await?;
    assert_eq!(
        other_rows
            .iter()
            .map(|(document_id, _score)| document_id.as_str())
            .collect::<Vec<_>>(),
        vec!["granola:note:granola_note_other"]
    );
    Ok(())
}

async fn assert_centaur_diagnostics_reader_security(
    conn: &mut PgConnection,
) -> Result<(), Box<dyn Error>> {
    conn.execute("revoke centaur_diagnostics_operator from current_user")
        .await?;
    sqlx::raw_sql(
        r#"
        insert into sessions
            (thread_key, harness_type, status, metadata)
        values
            (
                'discord:test-guild:test-channel:test-thread',
                'codex',
                'idle',
                '{"source":"discord","platform":"discord","thread_id":"test-thread"}'
            ),
            (
                'discord:other-guild:other-channel:other-thread',
                'codex',
                'idle',
                '{"source":"discord","platform":"discord","thread_id":"other-thread"}'
            );

        insert into session_messages
            (message_id, thread_key, role, parts, metadata)
        values
            (
                'msg_diagnostics',
                'discord:test-guild:test-channel:test-thread',
                'user',
                '[{"type":"text","text":"diagnostic-secret"}]',
                '{"source":"discord","platform":"discord","user_id":"test-user"}'
            ),
            (
                'msg_diagnostics_other',
                'discord:other-guild:other-channel:other-thread',
                'user',
                '[{"type":"text","text":"other-session-secret"}]',
                '{"source":"discord","platform":"discord","user_id":"other-user"}'
            );

        insert into session_executions
            (execution_id, thread_key, status, metadata, error, started_at, completed_at)
        values
            (
                'exe_diagnostics',
                'discord:test-guild:test-channel:test-thread',
                'failed',
                '{"model":"test-model","workflow_name":"test-workflow"}',
                'diagnostic-secret',
                now() - interval '1 minute',
                now()
            ),
            (
                'exe_diagnostics_other',
                'discord:other-guild:other-channel:other-thread',
                'failed',
                '{"model":"other-model","workflow_name":"other-workflow"}',
                'other-session-secret',
                now() - interval '1 minute',
                now()
            );

        insert into session_events
            (thread_key, execution_id, event_type, payload)
        values
            (
                'discord:test-guild:test-channel:test-thread',
                'exe_diagnostics',
                'session.execution_failed',
                '{"type":"result","status":"failed","error":"diagnostic-secret","terminal_reason":"diagnostic-secret"}'
            ),
            (
                'discord:test-guild:test-channel:test-thread',
                'exe_diagnostics',
                'session.output',
                '"ordinary output"'
            ),
            (
                'discord:other-guild:other-channel:other-thread',
                'exe_diagnostics_other',
                'session.execution_failed',
                '{"type":"result","status":"failed","error":"other-session-secret"}'
            );
        "#,
    )
    .execute(&mut *conn)
    .await?;

    sqlx::query("select set_config('centaur.thread_key', $1, false)")
        .bind("discord:test-guild:test-channel:test-thread")
        .execute(&mut *conn)
        .await?;
    conn.execute("set role centaur_diagnostics_reader").await?;

    let current_user: String = sqlx::query_scalar("select current_user::text")
        .fetch_one(&mut *conn)
        .await?;
    let message_shape: (i32, serde_json::Value) = sqlx::query_as(
        "select part_count, part_types from centaur_diagnostics.session_messages \
         where message_id = 'msg_diagnostics'",
    )
    .fetch_one(&mut *conn)
    .await?;
    let execution_shape: (bool, Option<i32>) = sqlx::query_as(
        "select has_error, error_length from centaur_diagnostics.session_executions \
         where execution_id = 'exe_diagnostics'",
    )
    .fetch_one(&mut *conn)
    .await?;
    let event_shape: (bool, Option<i32>, serde_json::Value) = sqlx::query_as(
        "select has_error, error_length, payload_keys \
         from centaur_diagnostics.session_events \
         where execution_id = 'exe_diagnostics' \
           and event_type = 'session.execution_failed'",
    )
    .fetch_one(&mut *conn)
    .await?;
    let scalar_event_payload_keys: serde_json::Value = sqlx::query_scalar(
        "select payload_keys from centaur_diagnostics.session_events \
         where execution_id = 'exe_diagnostics' \
           and event_type = 'session.output'",
    )
    .fetch_one(&mut *conn)
    .await?;
    let broad_role_member: bool =
        sqlx::query_scalar("select pg_has_role(current_user, 'centaur_readonly', 'member')")
            .fetch_one(&mut *conn)
            .await?;
    let role_attributes: (bool, bool, bool, bool, bool, bool, bool) = sqlx::query_as(
        "select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, \
         rolreplication, rolbypassrls from pg_roles where rolname = current_user",
    )
    .fetch_one(&mut *conn)
    .await?;
    let visible_sessions: Vec<String> = sqlx::query_scalar(
        "select thread_key from centaur_diagnostics.sessions order by thread_key",
    )
    .fetch_all(&mut *conn)
    .await?;
    let visible_executions: Vec<String> = sqlx::query_scalar(
        "select execution_id from centaur_diagnostics.session_executions order by execution_id",
    )
    .fetch_all(&mut *conn)
    .await?;
    let visible_messages: Vec<String> = sqlx::query_scalar(
        "select message_id from centaur_diagnostics.session_messages order by message_id",
    )
    .fetch_all(&mut *conn)
    .await?;
    let visible_events: Vec<String> = sqlx::query_scalar(
        "select execution_id from centaur_diagnostics.session_events order by event_id",
    )
    .fetch_all(&mut *conn)
    .await?;
    let pinned_scope: Option<String> =
        sqlx::query_scalar("select centaur_diagnostics.scoped_thread_key()")
            .fetch_one(&mut *conn)
            .await?;
    let reader_is_operator: bool = sqlx::query_scalar("select centaur_diagnostics.is_operator()")
        .fetch_one(&mut *conn)
        .await?;
    let reader_has_operator_membership: bool = sqlx::query_scalar(
        "select pg_has_role(current_user, 'centaur_diagnostics_operator', 'member')",
    )
    .fetch_one(&mut *conn)
    .await?;

    let raw_message = sqlx::query("select parts from public.session_messages limit 1")
        .fetch_optional(&mut *conn)
        .await;
    let raw_event = sqlx::query("select payload from public.session_events limit 1")
        .fetch_optional(&mut *conn)
        .await;
    let hidden_message_parts =
        sqlx::query("select parts from centaur_diagnostics.session_messages limit 1")
            .fetch_optional(&mut *conn)
            .await;
    let hidden_event_payload =
        sqlx::query("select payload from centaur_diagnostics.session_events limit 1")
            .fetch_optional(&mut *conn)
            .await;

    conn.execute("reset role").await?;

    sqlx::query("select set_config('centaur.thread_key', '', false)")
        .execute(&mut *conn)
        .await?;
    conn.execute("set role centaur_diagnostics_reader").await?;
    let unscoped_session_count: i64 =
        sqlx::query_scalar("select count(*) from centaur_diagnostics.sessions")
            .fetch_one(&mut *conn)
            .await?;
    conn.execute("reset role").await?;

    conn.execute("grant centaur_diagnostics_operator to current_user")
        .await?;
    conn.execute("set role centaur_diagnostics_operator")
        .await?;
    let operator_session_count: i64 =
        sqlx::query_scalar("select count(*) from centaur_diagnostics.sessions")
            .fetch_one(&mut *conn)
            .await?;
    let operator_is_operator: bool = sqlx::query_scalar("select centaur_diagnostics.is_operator()")
        .fetch_one(&mut *conn)
        .await?;
    let operator_attributes: (bool, bool, bool, bool, bool, bool, bool) = sqlx::query_as(
        "select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, \
         rolreplication, rolbypassrls from pg_roles where rolname = current_user",
    )
    .fetch_one(&mut *conn)
    .await?;
    conn.execute("reset role").await?;
    conn.execute("revoke centaur_diagnostics_operator from current_user")
        .await?;

    assert_eq!(current_user, "centaur_diagnostics_reader");
    assert_eq!(message_shape.0, 1);
    assert_eq!(message_shape.1, serde_json::json!(["text"]));
    assert_eq!(execution_shape, (true, Some(17)));
    assert!(event_shape.0);
    assert_eq!(event_shape.1, Some(17));
    assert_eq!(
        event_shape.2,
        serde_json::json!(["error", "status", "terminal_reason", "type"])
    );
    assert_eq!(scalar_event_payload_keys, serde_json::json!([]));
    assert!(!broad_role_member);
    assert_eq!(
        role_attributes,
        (false, false, false, false, false, false, false)
    );
    assert_eq!(
        visible_sessions,
        vec!["discord:test-guild:test-channel:test-thread".to_owned()]
    );
    assert_eq!(visible_executions, vec!["exe_diagnostics".to_owned()]);
    assert_eq!(visible_messages, vec!["msg_diagnostics".to_owned()]);
    assert_eq!(
        visible_events,
        vec!["exe_diagnostics".to_owned(), "exe_diagnostics".to_owned()]
    );
    assert_eq!(
        pinned_scope.as_deref(),
        Some("discord:test-guild:test-channel:test-thread")
    );
    assert!(!reader_is_operator);
    assert!(!reader_has_operator_membership);
    assert_eq!(unscoped_session_count, 0);
    assert!(operator_session_count >= 2);
    assert!(operator_is_operator);
    assert_eq!(
        operator_attributes,
        (false, false, false, false, false, false, false)
    );
    assert_database_error_code(raw_message, "42501");
    assert_database_error_code(raw_event, "42501");
    assert_database_error_code(hidden_message_parts, "42703");
    assert_database_error_code(hidden_event_payload, "42703");
    Ok(())
}

fn assert_database_error_code<T>(result: Result<T, sqlx::Error>, expected: &str) {
    let Err(sqlx::Error::Database(error)) = result else {
        panic!("expected database error with SQLSTATE {expected}");
    };
    assert_eq!(error.code().as_deref(), Some(expected));
}

fn test_database_url() -> Option<String> {
    env::var("SESSION_SQLX_TEST_DATABASE_URL")
        .or_else(|_| env::var("SESSION_RUNTIME_TEST_DATABASE_URL"))
        .map_err(|_| {
            eprintln!(
                "skipping ETL RLS tests: set SESSION_SQLX_TEST_DATABASE_URL to a Postgres URL"
            );
        })
        .ok()
}

struct TestDatabase {
    name: String,
    options: PgConnectOptions,
}

struct RlsTestFixture {
    _test_guard: tokio::sync::MutexGuard<'static, ()>,
    admin_conn: PgConnection,
    conn: PgConnection,
    database: TestDatabase,
}

impl RlsTestFixture {
    async fn create() -> Result<Option<Self>, Box<dyn Error>> {
        let Some(database_url) = test_database_url() else {
            return Ok(None);
        };
        let test_guard = RLS_TEST_LOCK.lock().await;
        let mut admin_conn = PgConnection::connect(&database_url).await?;
        let database = TestDatabase::create(&mut admin_conn, &database_url).await?;
        let mut conn = match PgConnection::connect_with(&database.options).await {
            Ok(conn) => conn,
            Err(err) => {
                database.drop(&mut admin_conn).await?;
                return Err(err.into());
            }
        };

        let setup_result = async {
            MIGRATOR.run(&mut conn).await?;
            insert_fixture_rows(&mut conn).await?;
            Ok::<(), Box<dyn Error>>(())
        }
        .await;
        if let Err(err) = setup_result {
            conn.close().await?;
            database.drop(&mut admin_conn).await?;
            return Err(err);
        }

        Ok(Some(Self {
            _test_guard: test_guard,
            admin_conn,
            conn,
            database,
        }))
    }

    async fn finish(self, result: Result<(), Box<dyn Error>>) -> Result<(), Box<dyn Error>> {
        let Self {
            _test_guard,
            mut admin_conn,
            conn,
            database,
        } = self;
        let close_result = conn.close().await;
        let drop_result = database.drop(&mut admin_conn).await;

        result?;
        close_result?;
        drop_result?;
        Ok(())
    }
}

impl TestDatabase {
    async fn create(conn: &mut PgConnection, database_url: &str) -> Result<Self, Box<dyn Error>> {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let name = format!("centaur_etl_rls_{}_{}", std::process::id(), nanos);
        conn.execute(format!(r#"create database "{}""#, name).as_str())
            .await?;
        let options = PgConnectOptions::from_str(database_url)?.database(&name);
        Ok(Self { name, options })
    }

    async fn drop(&self, conn: &mut PgConnection) -> Result<(), sqlx::Error> {
        conn.execute(format!(r#"drop database if exists "{}""#, self.name).as_str())
            .await?;
        Ok(())
    }
}

async fn assert_rls_enabled(conn: &mut PgConnection) -> Result<(), sqlx::Error> {
    let tables_without_rls: Vec<String> = sqlx::query_scalar(
        r#"
        select distinct policies.tablename
        from pg_policies policies
        join pg_class tables
          on tables.oid = to_regclass(quote_ident(policies.schemaname) || '.' || quote_ident(policies.tablename))
        where policies.schemaname = current_schema()
          and not tables.relrowsecurity
        order by policies.tablename
        "#,
    )
    .fetch_all(&mut *conn)
    .await?;

    assert!(
        tables_without_rls.is_empty(),
        "expected row level security on tables with policies: {tables_without_rls:?}"
    );
    Ok(())
}

async fn assert_expected_policies(conn: &mut PgConnection) -> Result<(), sqlx::Error> {
    let policies: Vec<(String, String)> = sqlx::query(
        r#"
        select tablename, policyname
        from pg_policies
        where schemaname = current_schema()
        order by tablename, policyname
        "#,
    )
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .map(|row| (row.get("tablename"), row.get("policyname")))
    .collect();

    for expected in expected_policies() {
        assert!(
            policies.contains(&expected),
            "missing RLS policy {} on {}",
            expected.1,
            expected.0
        );
    }

    Ok(())
}

fn expected_policies() -> Vec<(String, String)> {
    [
        (
            "slack_sync_channels",
            "centaur_slack_channels_reader_select",
        ),
        ("slack_sync_users", "centaur_slack_users_reader_select"),
        (
            "slack_sync_messages",
            "centaur_slack_messages_reader_select",
        ),
        (
            "slack_sync_message_attachments",
            "centaur_slack_message_attachments_reader_select",
        ),
        (
            "company_context_documents",
            "centaur_context_docs_reader_select",
        ),
        (
            "company_context_documents",
            "centaur_readonly_company_context_documents_select",
        ),
        (
            "company_context_documents",
            "centaur_cc_reader_documents_select",
        ),
        ("slack_sync_channels", "centaur_cc_reader_channels_select"),
        (
            "granola_context_documents",
            "centaur_cc_reader_granola_documents_select",
        ),
        (
            "slack_private_context_documents",
            "centaur_cc_reader_private_docs_select",
        ),
        (
            "slack_private_conversation_context_documents",
            "centaur_cc_reader_private_conversation_docs_select",
        ),
        (
            "google_docs_sync_file_observations",
            "centaur_cc_reader_gdocs_observations_select",
        ),
        (
            "google_docs_context_documents",
            "centaur_cc_reader_gdocs_documents_select",
        ),
        (
            "google_drive_sync_runs",
            "centaur_google_drive_runs_reader_select",
        ),
        (
            "google_drive_sync_runs",
            "centaur_readonly_google_drive_sync_runs_select",
        ),
        (
            "google_drive_sync_files",
            "centaur_google_drive_files_reader_select",
        ),
        (
            "google_drive_sync_files",
            "centaur_readonly_google_drive_sync_files_select",
        ),
        (
            "google_drive_sync_checkpoints",
            "centaur_google_drive_checkpoints_reader_select",
        ),
        (
            "google_drive_sync_checkpoints",
            "centaur_readonly_google_drive_sync_checkpoints_select",
        ),
        (
            "google_calendar_sync_runs",
            "centaur_google_calendar_runs_reader_select",
        ),
        (
            "google_calendar_sync_runs",
            "centaur_readonly_google_calendar_sync_runs_select",
        ),
        (
            "google_calendar_sync_calendars",
            "centaur_google_calendar_calendars_reader_select",
        ),
        (
            "google_calendar_sync_calendars",
            "centaur_readonly_google_calendar_sync_calendars_select",
        ),
        (
            "google_calendar_sync_events",
            "centaur_google_calendar_events_reader_select",
        ),
        (
            "google_calendar_sync_events",
            "centaur_readonly_google_calendar_sync_events_select",
        ),
        (
            "google_calendar_sync_checkpoints",
            "centaur_google_calendar_checkpoints_reader_select",
        ),
        (
            "google_calendar_sync_checkpoints",
            "centaur_readonly_google_calendar_sync_checkpoints_select",
        ),
        ("linear_sync_runs", "centaur_linear_runs_reader_select"),
        (
            "linear_sync_runs",
            "centaur_readonly_linear_sync_runs_select",
        ),
        (
            "linear_sync_projects",
            "centaur_linear_projects_reader_select",
        ),
        (
            "linear_sync_projects",
            "centaur_readonly_linear_sync_projects_select",
        ),
        ("linear_sync_issues", "centaur_linear_issues_reader_select"),
        (
            "linear_sync_issues",
            "centaur_readonly_linear_sync_issues_select",
        ),
        (
            "linear_sync_comments",
            "centaur_linear_comments_reader_select",
        ),
        (
            "linear_sync_comments",
            "centaur_readonly_linear_sync_comments_select",
        ),
        (
            "linear_sync_checkpoints",
            "centaur_linear_checkpoints_reader_select",
        ),
        (
            "linear_sync_checkpoints",
            "centaur_readonly_linear_sync_checkpoints_select",
        ),
        (
            "slack_sync_channels",
            "centaur_readonly_slack_sync_channels_select",
        ),
        (
            "slack_sync_users",
            "centaur_readonly_slack_sync_users_select",
        ),
        (
            "slack_sync_messages",
            "centaur_readonly_slack_sync_messages_select",
        ),
        (
            "slack_sync_message_attachments",
            "centaur_readonly_slack_sync_message_attachments_select",
        ),
    ]
    .into_iter()
    .map(|(table, policy)| (table.to_owned(), policy.to_owned()))
    .collect()
}

async fn assert_legacy_admin_state_is_removed(conn: &mut PgConnection) -> Result<(), sqlx::Error> {
    let table_name: Option<String> =
        sqlx::query_scalar("select to_regclass('slack_context_rls_admin_channels')::text")
            .fetch_one(&mut *conn)
            .await?;
    assert_eq!(
        table_name, None,
        "admin channels must be managed by iron-control"
    );

    let function_count: i64 = sqlx::query_scalar(
        "select count(*) from pg_proc where proname = 'centaur_etl_admin_channel'",
    )
    .fetch_one(&mut *conn)
    .await?;
    assert_eq!(
        function_count, 0,
        "admin-channel lookup function must be removed"
    );

    let admin_role_count: i64 =
        sqlx::query_scalar("select count(*) from pg_roles where rolname = 'centaur_slack_admin'")
            .fetch_one(&mut *conn)
            .await?;
    assert_eq!(
        admin_role_count, 0,
        "legacy slack admin DB role must be removed"
    );
    Ok(())
}

async fn assert_company_context_reader_role_security(
    conn: &mut PgConnection,
) -> Result<(), sqlx::Error> {
    let role_flags: (bool, bool, bool) = sqlx::query_as(
        "select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'centaur_company_context_reader'",
    )
    .fetch_one(&mut *conn)
    .await?;
    assert_eq!(
        role_flags,
        (false, false, false),
        "company context reader must not be superuser, bypass RLS, or log in directly"
    );

    let inherited_roles: Vec<String> = sqlx::query_scalar(
        r#"
        select granted.rolname
        from pg_auth_members memberships
        join pg_roles member on member.oid = memberships.member
        join pg_roles granted on granted.oid = memberships.roleid
        where member.rolname = 'centaur_company_context_reader'
        order by granted.rolname
        "#,
    )
    .fetch_all(&mut *conn)
    .await?;
    assert!(
        inherited_roles.is_empty(),
        "company context reader must not inherit broader roles: {inherited_roles:?}"
    );

    let readable_relations: Vec<String> = sqlx::query_scalar(
        r#"
        select relations.relname
        from pg_class relations
        join pg_namespace schemas on schemas.oid = relations.relnamespace
        where schemas.nspname = 'public'
          and relations.relkind in ('r', 'p', 'v', 'm', 'f')
          and not exists (
              select 1
              from pg_depend dependencies
              where dependencies.classid = 'pg_class'::regclass
                and dependencies.objid = relations.oid
                and dependencies.deptype = 'e'
          )
          and (
              has_table_privilege(
                  'centaur_company_context_reader',
                  relations.oid,
                  'SELECT'
              )
              or has_any_column_privilege(
                  'centaur_company_context_reader',
                  relations.oid,
                  'SELECT'
              )
          )
        order by relations.relname
        "#,
    )
    .fetch_all(&mut *conn)
    .await?;
    assert_eq!(
        readable_relations,
        vec![
            "company_context_documents".to_owned(),
            "google_docs_context_documents".to_owned(),
            "google_docs_sync_file_observations".to_owned(),
            "granola_context_documents".to_owned(),
            "slack_private_context_documents".to_owned(),
            "slack_private_conversation_context_documents".to_owned(),
            "slack_sync_channels".to_owned(),
        ],
        "company context reader gained effective access to an unexpected application table or view"
    );

    let tables_without_rls: Vec<String> = sqlx::query_scalar(
        r#"
        select tables.relname
        from pg_class tables
        join pg_namespace schemas on schemas.oid = tables.relnamespace
        where schemas.nspname = 'public'
          and tables.relname = any($1::text[])
          and not tables.relrowsecurity
        order by tables.relname
        "#,
    )
    .bind(&readable_relations)
    .fetch_all(&mut *conn)
    .await?;
    assert!(
        tables_without_rls.is_empty(),
        "company context reader table lacks RLS: {tables_without_rls:?}"
    );

    let writable_relations: Vec<(String, String)> = sqlx::query_as(
        r#"
        with application_relations as (
            select relations.oid, relations.relname
            from pg_class relations
            join pg_namespace schemas on schemas.oid = relations.relnamespace
            where schemas.nspname = 'public'
              and relations.relkind in ('r', 'p', 'v', 'm', 'f')
              and not exists (
                  select 1
                  from pg_depend dependencies
                  where dependencies.classid = 'pg_class'::regclass
                    and dependencies.objid = relations.oid
                    and dependencies.deptype = 'e'
              )
        ), effective_write_privileges as (
            select relations.relname, privileges.privilege
            from application_relations relations
            cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) privileges(privilege)
            where has_table_privilege(
                'centaur_company_context_reader',
                relations.oid,
                privileges.privilege
            )

            union

            select relations.relname, privileges.privilege
            from application_relations relations
            cross join (values ('INSERT'), ('UPDATE')) privileges(privilege)
            where has_any_column_privilege(
                'centaur_company_context_reader',
                relations.oid,
                privileges.privilege
            )
        )
        select relname, privilege
        from effective_write_privileges
        order by relname, privilege
        "#,
    )
    .fetch_all(&mut *conn)
    .await?;
    assert!(
        writable_relations.is_empty(),
        "company context reader gained an effective write privilege: {writable_relations:?}"
    );
    Ok(())
}

async fn assert_company_context_reader_denies_unauthorized_rows(
    conn: &mut PgConnection,
) -> Result<(), sqlx::Error> {
    let missing_identity =
        company_context_reader_rows(conn, CompanyContextReaderSettings::default()).await?;
    assert_eq!(
        missing_identity,
        CompanyContextReaderRows {
            slack_channels: Vec::new(),
            company_context_docs: Vec::new(),
            google_docs_observations: Vec::new(),
            google_docs: Vec::new(),
            granola_docs: Vec::new(),
            slack_private_docs: Vec::new(),
            slack_private_conversation_docs: Vec::new(),
        },
        "missing identity and access settings must fail closed across every company context source"
    );

    let viewer = company_context_reader_rows(
        conn,
        CompanyContextReaderSettings {
            slack_history_channel_ids: Some("[]"),
            slack_include_public: Some(false),
            slack_team_id: Some("T_HOME"),
            slack_user_id: Some("U_PRIVATE"),
            google_subject: Some("google_subject"),
            ..Default::default()
        },
    )
    .await?;
    assert_eq!(
        viewer,
        CompanyContextReaderRows {
            slack_channels: vec!["G_PRIVATE".to_owned()],
            company_context_docs: vec!["doc_slack_private".to_owned()],
            google_docs_observations: vec!["gdocs_observed_file".to_owned()],
            google_docs: vec!["gdocs_doc".to_owned()],
            granola_docs: vec![
                "granola:note:granola_note".to_owned(),
                "granola:note:granola_note_old".to_owned(),
            ],
            slack_private_docs: vec!["slack_dm:T_HOME:D_VISIBLE:2000.000001".to_owned()],
            slack_private_conversation_docs: vec![
                "slack_dm_conversation:T_HOME:D_VISIBLE".to_owned(),
                "slack_dm_conversation:T_HOME:G_PRIVATE".to_owned(),
            ],
        },
        "viewer scope leaked another user, team, inactive, or mismatched source row"
    );

    let other_user = company_context_reader_rows(
        conn,
        CompanyContextReaderSettings {
            slack_history_channel_ids: Some("[]"),
            slack_include_public: Some(false),
            slack_team_id: Some("T_HOME"),
            slack_user_id: Some("U_OTHER"),
            user_email: Some("other@example.com"),
            google_subject: Some("google_subject_other"),
            ..Default::default()
        },
    )
    .await?;
    assert_eq!(
        other_user,
        CompanyContextReaderRows {
            slack_channels: vec!["G_PRIVATE_OTHER".to_owned()],
            company_context_docs: vec!["doc_slack_private_other".to_owned()],
            google_docs_observations: vec!["gdocs_observed_other".to_owned()],
            google_docs: vec!["gdocs_doc_other".to_owned()],
            granola_docs: vec!["granola:note:granola_note_other".to_owned()],
            slack_private_docs: vec!["slack_dm:T_HOME:D_HIDDEN:2000.000002".to_owned()],
            slack_private_conversation_docs: vec![
                "slack_dm_conversation:T_HOME:D_HIDDEN".to_owned(),
                "slack_dm_conversation:T_HOME:G_PRIVATE_OTHER".to_owned(),
            ],
        },
        "other user scope leaked the viewer's rows"
    );

    let wrong_team = company_context_reader_rows(
        conn,
        CompanyContextReaderSettings {
            slack_history_channel_ids: Some("[]"),
            slack_include_public: Some(false),
            slack_team_id: Some("T_OTHER"),
            slack_user_id: Some("U_PRIVATE"),
            ..Default::default()
        },
    )
    .await?;
    assert_eq!(
        wrong_team,
        CompanyContextReaderRows {
            slack_channels: vec!["G_PRIVATE_CROSS_TEAM".to_owned()],
            company_context_docs: vec!["doc_slack_private_cross_team".to_owned()],
            google_docs_observations: Vec::new(),
            google_docs: Vec::new(),
            granola_docs: Vec::new(),
            slack_private_docs: vec!["slack_dm:T_OTHER:D_CROSS_TEAM:2000.000004".to_owned()],
            slack_private_conversation_docs: vec![
                "slack_dm_conversation:T_OTHER:D_CROSS_TEAM".to_owned(),
                "slack_dm_conversation:T_OTHER:G_PRIVATE_CROSS_TEAM".to_owned(),
            ],
        },
        "Slack team scope leaked rows from another team"
    );

    let google_email_only = company_context_reader_rows(
        conn,
        CompanyContextReaderSettings {
            slack_history_channel_ids: Some("[]"),
            slack_include_public: Some(false),
            slack_team_id: Some("T_HOME"),
            slack_user_id: Some("U_PRIVATE"),
            google_email: Some("viewer@example.com"),
            ..Default::default()
        },
    )
    .await?;
    assert!(google_email_only.google_docs.is_empty());
    assert!(google_email_only.google_docs_observations.is_empty());

    let slack_email_only = company_context_reader_rows(
        conn,
        CompanyContextReaderSettings {
            slack_history_channel_ids: Some("[]"),
            slack_include_public: Some(false),
            slack_team_id: Some("T_HOME"),
            slack_user_id: Some("U_PRIVATE"),
            user_email: Some("viewer@example.com"),
            ..Default::default()
        },
    )
    .await?;
    assert!(slack_email_only.google_docs.is_empty());
    assert!(slack_email_only.google_docs_observations.is_empty());

    Ok(())
}

async fn assert_company_context_reader_channel_grants(
    conn: &mut PgConnection,
) -> Result<(), sqlx::Error> {
    let channel_grants_only = company_context_reader_rows(
        conn,
        CompanyContextReaderSettings {
            slack_channel_id: Some("C_ALPHA"),
            slack_history_channel_ids: Some(r#"["G_PRIVATE_OTHER"]"#),
            slack_include_public: Some(false),
            ..Default::default()
        },
    )
    .await?;
    assert_eq!(
        channel_grants_only,
        CompanyContextReaderRows {
            slack_channels: vec!["C_ALPHA".to_owned(), "G_PRIVATE_OTHER".to_owned()],
            company_context_docs: vec![
                "doc_slack_alpha".to_owned(),
                "doc_slack_private_other".to_owned(),
            ],
            google_docs_observations: Vec::new(),
            google_docs: Vec::new(),
            granola_docs: Vec::new(),
            slack_private_docs: Vec::new(),
            slack_private_conversation_docs: Vec::new(),
        },
        "channel-only grants must expose exactly the granted channels without user-scoped data"
    );
    Ok(())
}

async fn assert_company_context_reader_public_channel_membership(
    conn: &mut PgConnection,
) -> Result<(), sqlx::Error> {
    let mut tx = conn.begin().await?;
    sqlx::query(
        r#"
        insert into slack_private_sync_conversations
            (home_team_id, conversation_id, conversation_type)
        values ('T_HOME', 'C_BETA', 'private_channel')
        "#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        insert into slack_private_sync_conversation_members
            (home_team_id, conversation_id, user_id, is_current_member)
        values ('T_HOME', 'C_BETA', 'U_PUBLIC_ONLY', true)
        "#,
    )
    .execute(&mut *tx)
    .await?;

    tx.execute("set local search_path to public").await?;
    tx.execute("set role centaur_company_context_reader")
        .await?;
    sqlx::query("select set_config('centaur.slack_history_channel_ids', '[]', true)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("select set_config('centaur.slack_include_public', 'false', true)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("select set_config('centaur.slack_team_id', 'T_HOME', true)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("select set_config('centaur.slack_user_id', 'U_PUBLIC_ONLY', true)")
        .execute(&mut *tx)
        .await?;

    let visible_channels = text_array(
        &mut tx,
        "select coalesce(array_agg(channel_id order by channel_id), '{}') from slack_sync_channels",
    )
    .await?;
    let visible_documents = text_array(
        &mut tx,
        "select coalesce(array_agg(document_id order by document_id), '{}') from company_context_documents",
    )
    .await?;
    assert!(
        visible_channels.is_empty(),
        "membership must not grant access to a public channel when public access is disabled"
    );
    assert!(
        visible_documents.is_empty(),
        "membership must not expose a public channel document when public access is disabled"
    );

    tx.execute("reset role").await?;
    tx.rollback().await?;
    Ok(())
}

async fn insert_fixture_rows(conn: &mut PgConnection) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(
        r#"
        insert into slack_sync_channels (channel_id, channel_name, is_private) values
            ('C_ALPHA', 'alpha', false),
            ('C_BETA', 'beta', false),
            ('C_ADMIN', 'admin', false),
            ('G_PRIVATE', 'private', true),
            ('G_PRIVATE_OTHER', 'private-other', true),
            ('G_PRIVATE_INACTIVE', 'private-inactive', true),
            ('G_PRIVATE_CROSS_TEAM', 'private-cross-team', true);

        insert into slack_sync_users (user_id, user_name, team_id, raw_payload) values
            ('U_ALPHA', 'alpha user', '', '{}'),
            ('U_BETA', 'beta user', '', '{}'),
            ('U_PRIVATE', 'private user', 'T_HOME', '{"profile": {"email": "viewer@example.com"}}');

        insert into slack_sync_messages (channel_id, message_ts, user_id, text) values
            ('C_ALPHA', '1000.000001', 'U_ALPHA', 'alpha channel message'),
            ('C_BETA', '1000.000002', 'U_BETA', 'beta channel message'),
            ('G_PRIVATE', '1000.000003', 'U_PRIVATE', 'private channel message');

        insert into slack_sync_message_attachments
            (channel_id, message_ts, slack_file_id, name)
        values
            ('C_ALPHA', '1000.000001', 'F_ALPHA', 'alpha.pdf'),
            ('C_BETA', '1000.000002', 'F_BETA', 'beta.pdf'),
            ('G_PRIVATE', '1000.000003', 'F_PRIVATE', 'private.pdf');

        insert into company_context_documents
            (document_id, source, source_type, source_document_id, metadata)
        values
            ('doc_slack_alpha', 'slack', 'slack_thread', 'C_ALPHA:1000.000001', '{"channel_id": "C_ALPHA"}'),
            ('doc_slack_beta', 'slack', 'slack_thread', 'C_BETA:1000.000002', '{"channel_id": "C_BETA"}'),
            ('doc_slack_private', 'slack', 'slack_thread', 'G_PRIVATE:1000.000003', '{"channel_id": "G_PRIVATE"}'),
            ('doc_slack_private_other', 'slack', 'slack_thread', 'G_PRIVATE_OTHER:1000.000004', '{"channel_id": "G_PRIVATE_OTHER"}'),
            ('doc_slack_private_inactive', 'slack', 'slack_thread', 'G_PRIVATE_INACTIVE:1000.000005', '{"channel_id": "G_PRIVATE_INACTIVE"}'),
            ('doc_slack_private_cross_team', 'slack', 'slack_thread', 'G_PRIVATE_CROSS_TEAM:1000.000006', '{"channel_id": "G_PRIVATE_CROSS_TEAM"}'),
            ('doc_slack_unknown_channel', 'slack', 'slack_thread', 'unknown', '{}'),
            ('doc_gdrive', 'google_drive', 'google_doc', 'gdrive_file', '{}'),
            ('doc_gcal', 'google_calendar', 'calendar_event', 'gcal_event', '{}'),
            ('doc_linear', 'linear', 'linear_issue', 'linear_issue', '{}');

        insert into google_drive_sync_runs (run_id, status) values ('gdrive_run', 'succeeded');
        insert into google_drive_sync_files (file_id) values ('gdrive_file');
        insert into google_drive_sync_checkpoints (scope_id) values ('gdrive_scope');

        insert into google_calendar_sync_runs (run_id, status) values ('gcal_run', 'succeeded');
        insert into google_calendar_sync_calendars (calendar_id) values ('gcal_calendar');
        insert into google_calendar_sync_events (calendar_id, event_id)
            values ('gcal_calendar', 'gcal_event');
        insert into google_calendar_sync_checkpoints (calendar_id) values ('gcal_calendar');

        insert into linear_sync_runs (run_id, status) values ('linear_run', 'succeeded');
        insert into linear_sync_projects (project_id) values ('linear_project');
        insert into linear_sync_issues (issue_id) values ('linear_issue');
        insert into linear_sync_comments (comment_id) values ('linear_comment');
        insert into linear_sync_checkpoints (scope_id) values ('linear_scope');

        insert into google_docs_sync_runs
            (run_id, status, broker_credential_id, provider_subject, provider_email)
        values
            ('gdocs_run', 'succeeded', 'gdocs_credential', 'google_subject', 'viewer@example.com');
        insert into google_docs_sync_files (file_id, source_run_id)
        values
            ('gdocs_file', 'gdocs_run'),
            ('gdocs_file_other', 'gdocs_run'),
            ('gdocs_file_inactive', 'gdocs_run'),
            ('gdocs_file_blank_email', 'gdocs_run');
        insert into google_docs_sync_file_observations
            (broker_credential_id, observed_file_id, file_id, provider_subject, provider_email, active)
        values
            ('gdocs_credential', 'gdocs_observed_file', 'gdocs_file', 'google_subject', 'viewer@example.com', true),
            ('gdocs_credential', 'gdocs_observed_other', 'gdocs_file_other', 'google_subject_other', 'other@example.com', true),
            ('gdocs_credential', 'gdocs_observed_inactive', 'gdocs_file_inactive', 'google_subject', 'viewer@example.com', false),
            ('gdocs_credential', 'gdocs_observed_blank_email', 'gdocs_file_blank_email', 'google_subject_blank_email', '', true);
        insert into google_docs_context_documents
            (document_id, file_id, chunk_id, title, body)
        values
            ('gdocs_doc', 'gdocs_file', 'chunk_1', 'Google Doc', 'Google Doc body'),
            ('gdocs_doc_other', 'gdocs_file_other', 'chunk_1', 'Other Google Doc', 'Other Google Doc body'),
            ('gdocs_doc_inactive', 'gdocs_file_inactive', 'chunk_1', 'Inactive Google Doc', 'Inactive Google Doc body'),
            ('gdocs_doc_blank_email', 'gdocs_file_blank_email', 'chunk_1', 'Blank Email Google Doc', 'Blank Email Google Doc body');

        insert into granola_sync_notes
            (note_id, title, access_emails, source_created_at)
        values
            ('granola_note', 'Project planning', array['viewer@example.com'], '2026-06-01'),
            ('granola_note_old', 'Project planning', array['viewer@example.com'], '2026-04-01'),
            ('granola_note_other', 'Project planning', array['other@example.com'], '2026-06-01'),
            ('granola_note_no_access', 'Project planning', array[]::text[], '2026-06-01');

        insert into slack_private_sync_conversations
            (home_team_id, conversation_id, conversation_type)
        values
            ('T_HOME', 'G_PRIVATE', 'private_channel'),
            ('T_HOME', 'G_PRIVATE_OTHER', 'private_channel'),
            ('T_HOME', 'G_PRIVATE_INACTIVE', 'private_channel'),
            ('T_OTHER', 'G_PRIVATE_CROSS_TEAM', 'private_channel'),
            ('T_HOME', 'D_VISIBLE', 'im'),
            ('T_HOME', 'D_HIDDEN', 'im'),
            ('T_HOME', 'D_INACTIVE', 'im'),
            ('T_OTHER', 'D_CROSS_TEAM', 'im');
        insert into slack_private_sync_conversation_members
            (home_team_id, conversation_id, user_id, is_current_member)
        values
            ('T_HOME', 'G_PRIVATE', 'U_PRIVATE', true),
            ('T_HOME', 'G_PRIVATE_OTHER', 'U_OTHER', true),
            ('T_HOME', 'G_PRIVATE_INACTIVE', 'U_PRIVATE', false),
            ('T_OTHER', 'G_PRIVATE_CROSS_TEAM', 'U_PRIVATE', true),
            ('T_HOME', 'D_VISIBLE', 'U_PRIVATE', true),
            ('T_HOME', 'D_HIDDEN', 'U_OTHER', true),
            ('T_HOME', 'D_INACTIVE', 'U_PRIVATE', false),
            ('T_OTHER', 'D_CROSS_TEAM', 'U_PRIVATE', true);
        insert into slack_private_sync_messages
            (home_team_id, conversation_id, message_ts, user_id, text)
        values
            ('T_HOME', 'D_VISIBLE', '2000.000001', 'U_VIEWER', 'visible dm'),
            ('T_HOME', 'D_HIDDEN', '2000.000002', 'U_OTHER', 'other user dm'),
            ('T_HOME', 'D_INACTIVE', '2000.000003', 'U_PRIVATE', 'inactive dm'),
            ('T_OTHER', 'D_CROSS_TEAM', '2000.000004', 'U_PRIVATE', 'cross-team dm');
        "#,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn visible_rows(
    conn: &mut PgConnection,
    role: &str,
    slack_channel_id: Option<&str>,
) -> Result<VisibleRows, sqlx::Error> {
    let mut tx = conn.begin().await?;
    tx.execute("set local search_path to public").await?;
    tx.execute(format!("set role {role}").as_str()).await?;
    if let Some(channel_id) = slack_channel_id {
        sqlx::query("select set_config('centaur.slack_channel_id', $1, true)")
            .bind(channel_id)
            .execute(&mut *tx)
            .await?;
    }

    let rows = VisibleRows {
        slack_channels: text_array(
            &mut tx,
            "select coalesce(array_agg(channel_id order by channel_id), '{}') from slack_sync_channels",
        )
        .await?,
        slack_users: text_array(
            &mut tx,
            "select coalesce(array_agg(user_id order by user_id), '{}') from slack_sync_users",
        )
        .await?,
        slack_messages: text_array(
            &mut tx,
            "select coalesce(array_agg(channel_id || ':' || message_ts order by channel_id, message_ts), '{}') from slack_sync_messages",
        )
        .await?,
        slack_attachments: text_array(
            &mut tx,
            "select coalesce(array_agg(channel_id || ':' || message_ts || ':' || slack_file_id order by channel_id, message_ts, slack_file_id), '{}') from slack_sync_message_attachments",
        )
        .await?,
        context_docs: text_array(
            &mut tx,
            "select coalesce(array_agg(document_id order by document_id), '{}') from company_context_documents",
        )
        .await?,
        google_drive_runs: count(&mut tx, "google_drive_sync_runs").await?,
        google_drive_files: count(&mut tx, "google_drive_sync_files").await?,
        google_drive_checkpoints: count(&mut tx, "google_drive_sync_checkpoints").await?,
        google_calendar_runs: count(&mut tx, "google_calendar_sync_runs").await?,
        google_calendar_calendars: count(&mut tx, "google_calendar_sync_calendars").await?,
        google_calendar_events: count(&mut tx, "google_calendar_sync_events").await?,
        google_calendar_checkpoints: count(&mut tx, "google_calendar_sync_checkpoints").await?,
        linear_runs: count(&mut tx, "linear_sync_runs").await?,
        linear_projects: count(&mut tx, "linear_sync_projects").await?,
        linear_issues: count(&mut tx, "linear_sync_issues").await?,
        linear_comments: count(&mut tx, "linear_sync_comments").await?,
        linear_checkpoints: count(&mut tx, "linear_sync_checkpoints").await?,
    };

    tx.execute("reset role").await?;
    tx.rollback().await?;
    Ok(rows)
}

async fn company_context_docs(
    conn: &mut PgConnection,
    slack_channel_id: Option<&str>,
    slack_history_channel_ids: &str,
    include_public_slack: bool,
) -> Result<Vec<String>, sqlx::Error> {
    let mut tx = conn.begin().await?;
    tx.execute("set local search_path to public").await?;
    tx.execute("set role centaur_company_context_reader")
        .await?;
    if let Some(channel_id) = slack_channel_id {
        sqlx::query("select set_config('centaur.slack_channel_id', $1, true)")
            .bind(channel_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("select set_config('centaur.slack_history_channel_ids', $1, true)")
        .bind(slack_history_channel_ids)
        .execute(&mut *tx)
        .await?;
    sqlx::query("select set_config('centaur.slack_include_public', $1, true)")
        .bind(if include_public_slack {
            "true"
        } else {
            "false"
        })
        .execute(&mut *tx)
        .await?;

    let rows = text_array(
        &mut tx,
        "select coalesce(array_agg(document_id order by document_id), '{}') from company_context_documents",
    )
    .await?;

    tx.execute("reset role").await?;
    tx.rollback().await?;
    Ok(rows)
}

async fn granola_keyword_search_rows(
    conn: &mut PgConnection,
    user_email: &str,
) -> Result<Vec<(String, f32)>, sqlx::Error> {
    let mut tx = conn.begin().await?;
    tx.execute("set local search_path to public").await?;
    tx.execute("set role centaur_company_context_reader")
        .await?;
    sqlx::query("select set_config('centaur.user_email', $1, true)")
        .bind(user_email)
        .execute(&mut *tx)
        .await?;
    let occurred_after = time::Date::from_calendar_date(2026, time::Month::May, 1)
        .expect("2026-05-01 must be a valid date")
        .midnight()
        .assume_utc();
    let occurred_before = time::Date::from_calendar_date(2026, time::Month::July, 1)
        .expect("2026-07-01 must be a valid date")
        .midnight()
        .assume_utc();

    let rows = sqlx::query_as(
        r#"
        select document_id, paradedb.score(document_id) as score
        from granola_context_documents
        where (
            (title ||| $1::text::pdb.boost(8) or body ||| $1::text::pdb.boost(2))
            or (title ||| $2::text::pdb.boost(4) or body ||| $2::text)
            or (title ||| $3::text::pdb.boost(4) or body ||| $3::text)
        )
        and ($4::timestamptz is null or occurred_at >= $4)
        and ($5::timestamptz is null or occurred_at < $5)
        order by paradedb.score(document_id) desc
        limit $6
        "#,
    )
    .bind("project planning")
    .bind("project")
    .bind("planning")
    .bind(occurred_after)
    .bind(occurred_before)
    .bind(10_i64)
    .fetch_all(&mut *tx)
    .await?;

    tx.execute("reset role").await?;
    tx.rollback().await?;
    Ok(rows)
}

async fn company_context_search_rows(
    conn: &mut PgConnection,
) -> Result<CompanyContextSearchRows, sqlx::Error> {
    let mut tx = conn.begin().await?;
    tx.execute("set local search_path to public").await?;
    tx.execute("set role centaur_company_context_reader")
        .await?;
    sqlx::query("select set_config('centaur.slack_channel_id', 'C_ALPHA', true)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("select set_config('centaur.slack_history_channel_ids', $1, true)")
        .bind(r#"["G_PRIVATE"]"#)
        .execute(&mut *tx)
        .await?;
    sqlx::query("select set_config('centaur.slack_include_public', 'true', true)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("select set_config('centaur.slack_team_id', 'T_HOME', true)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("select set_config('centaur.slack_user_id', 'U_PRIVATE', true)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("select set_config('centaur.user_email', 'viewer@example.com', true)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("select set_config('centaur.google_subject', 'google_subject', true)")
        .execute(&mut *tx)
        .await?;

    let rows = CompanyContextSearchRows {
        company_context_docs: text_array(
            &mut tx,
            "select coalesce(array_agg(document_id order by document_id), '{}') from company_context_documents",
        )
        .await?,
        google_docs: text_array(
            &mut tx,
            "select coalesce(array_agg(document_id order by document_id), '{}') from google_docs_context_documents",
        )
        .await?,
        granola_docs: text_array(
            &mut tx,
            "select coalesce(array_agg(document_id order by document_id), '{}') from granola_context_documents",
        )
        .await?,
        slack_private_docs: text_array(
            &mut tx,
            "select coalesce(array_agg(document_id order by document_id), '{}') from slack_private_context_documents",
        )
        .await?,
        slack_private_conversation_docs: text_array(
            &mut tx,
            "select coalesce(array_agg(document_id order by document_id), '{}') from slack_private_conversation_context_documents",
        )
        .await?,
    };

    tx.execute("reset role").await?;
    tx.rollback().await?;
    Ok(rows)
}

async fn company_context_reader_rows(
    conn: &mut PgConnection,
    settings: CompanyContextReaderSettings<'_>,
) -> Result<CompanyContextReaderRows, sqlx::Error> {
    let mut tx = conn.begin().await?;
    tx.execute("set local search_path to public").await?;
    tx.execute("set role centaur_company_context_reader")
        .await?;

    for (name, value) in [
        ("centaur.slack_channel_id", settings.slack_channel_id),
        (
            "centaur.slack_history_channel_ids",
            settings.slack_history_channel_ids,
        ),
        ("centaur.slack_team_id", settings.slack_team_id),
        ("centaur.slack_user_id", settings.slack_user_id),
        ("centaur.user_email", settings.user_email),
        ("centaur.google_email", settings.google_email),
        ("centaur.google_subject", settings.google_subject),
    ] {
        if let Some(value) = value {
            sqlx::query("select set_config($1, $2, true)")
                .bind(name)
                .bind(value)
                .execute(&mut *tx)
                .await?;
        }
    }
    if let Some(include_public) = settings.slack_include_public {
        sqlx::query("select set_config('centaur.slack_include_public', $1, true)")
            .bind(if include_public { "true" } else { "false" })
            .execute(&mut *tx)
            .await?;
    }

    let rows = CompanyContextReaderRows {
        slack_channels: text_array(
            &mut tx,
            "select coalesce(array_agg(channel_id order by channel_id), '{}') from slack_sync_channels",
        )
        .await?,
        company_context_docs: text_array(
            &mut tx,
            "select coalesce(array_agg(document_id order by document_id), '{}') from company_context_documents",
        )
        .await?,
        google_docs_observations: text_array(
            &mut tx,
            "select coalesce(array_agg(observed_file_id order by observed_file_id), '{}') from google_docs_sync_file_observations",
        )
        .await?,
        google_docs: text_array(
            &mut tx,
            "select coalesce(array_agg(document_id order by document_id), '{}') from google_docs_context_documents",
        )
        .await?,
        granola_docs: text_array(
            &mut tx,
            "select coalesce(array_agg(document_id order by document_id), '{}') from granola_context_documents",
        )
        .await?,
        slack_private_docs: text_array(
            &mut tx,
            "select coalesce(array_agg(document_id order by document_id), '{}') from slack_private_context_documents",
        )
        .await?,
        slack_private_conversation_docs: text_array(
            &mut tx,
            "select coalesce(array_agg(document_id order by document_id), '{}') from slack_private_conversation_context_documents",
        )
        .await?,
    };

    tx.execute("reset role").await?;
    tx.rollback().await?;
    Ok(rows)
}

async fn text_array(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    query: &str,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(query).fetch_one(&mut **tx).await
}

async fn count(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    table: &str,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(format!("select count(*) from {table}").as_str())
        .fetch_one(&mut **tx)
        .await
}

fn empty_visible_rows() -> VisibleRows {
    VisibleRows {
        slack_channels: vec![],
        slack_users: vec![],
        slack_messages: vec![],
        slack_attachments: vec![],
        context_docs: vec![],
        google_drive_runs: 0,
        google_drive_files: 0,
        google_drive_checkpoints: 0,
        google_calendar_runs: 0,
        google_calendar_calendars: 0,
        google_calendar_events: 0,
        google_calendar_checkpoints: 0,
        linear_runs: 0,
        linear_projects: 0,
        linear_issues: 0,
        linear_comments: 0,
        linear_checkpoints: 0,
    }
}

fn public_visible_rows() -> VisibleRows {
    VisibleRows {
        slack_channels: vec![
            "C_ADMIN".to_owned(),
            "C_ALPHA".to_owned(),
            "C_BETA".to_owned(),
        ],
        slack_users: vec![
            "U_ALPHA".to_owned(),
            "U_BETA".to_owned(),
            "U_PRIVATE".to_owned(),
        ],
        slack_messages: vec![
            "C_ALPHA:1000.000001".to_owned(),
            "C_BETA:1000.000002".to_owned(),
        ],
        slack_attachments: vec![
            "C_ALPHA:1000.000001:F_ALPHA".to_owned(),
            "C_BETA:1000.000002:F_BETA".to_owned(),
        ],
        context_docs: vec![
            "doc_gcal".to_owned(),
            "doc_gdrive".to_owned(),
            "doc_linear".to_owned(),
            "doc_slack_alpha".to_owned(),
            "doc_slack_beta".to_owned(),
        ],
        google_drive_runs: 1,
        google_drive_files: 1,
        google_drive_checkpoints: 1,
        google_calendar_runs: 1,
        google_calendar_calendars: 1,
        google_calendar_events: 1,
        google_calendar_checkpoints: 1,
        linear_runs: 1,
        linear_projects: 1,
        linear_issues: 1,
        linear_comments: 1,
        linear_checkpoints: 1,
    }
}

fn public_and_private_visible_rows() -> VisibleRows {
    let mut rows = public_visible_rows();
    rows.slack_channels.push("G_PRIVATE".to_owned());
    rows.slack_messages.push("G_PRIVATE:1000.000003".to_owned());
    rows.slack_attachments
        .push("G_PRIVATE:1000.000003:F_PRIVATE".to_owned());
    rows.context_docs.push("doc_slack_private".to_owned());
    rows
}
