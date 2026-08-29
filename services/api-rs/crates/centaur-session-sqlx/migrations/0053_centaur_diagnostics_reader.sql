do $$
begin
    if not exists (
        select 1 from pg_roles where rolname = 'centaur_diagnostics_reader'
    ) then
        create role centaur_diagnostics_reader
            nologin
            nosuperuser
            nocreatedb
            nocreaterole
            noinherit
            noreplication
            nobypassrls;
    end if;

    if not exists (
        select 1 from pg_roles where rolname = 'centaur_diagnostics_operator'
    ) then
        create role centaur_diagnostics_operator
            nologin
            nosuperuser
            nocreatedb
            nocreaterole
            noinherit
            noreplication
            nobypassrls;
    end if;
end
$$;

alter role centaur_diagnostics_reader
    nologin
    nosuperuser
    nocreatedb
    nocreaterole
    noinherit
    noreplication
    nobypassrls;

alter role centaur_diagnostics_operator
    nologin
    nosuperuser
    nocreatedb
    nocreaterole
    noinherit
    noreplication
    nobypassrls;

-- This role is intentionally independent from the legacy broad read-only role.
revoke centaur_readonly from centaur_diagnostics_reader;
revoke centaur_readonly from centaur_diagnostics_operator;

create schema if not exists centaur_diagnostics;
revoke all on schema centaur_diagnostics from public;
grant usage on schema centaur_diagnostics to centaur_diagnostics_reader;
grant usage on schema centaur_diagnostics to centaur_diagnostics_operator;

alter default privileges in schema centaur_diagnostics
    revoke all on tables from public;
alter default privileges in schema centaur_diagnostics
    grant select on tables to centaur_diagnostics_reader, centaur_diagnostics_operator;
alter default privileges in schema centaur_diagnostics
    revoke execute on functions from public;
alter default privileges in schema centaur_diagnostics
    grant execute on functions to centaur_diagnostics_reader, centaur_diagnostics_operator;

-- iron-proxy pins centaur.thread_key from the assigned sandbox's immutable
-- proxy label before SET ROLE. The proxy rejects client attempts to change a
-- pinned setting. Reader views therefore fail closed when the setting is
-- absent and expose exactly one session. Cross-session access requires a
-- separately granted operator role; this migration deliberately grants that
-- role to nobody.
create or replace function centaur_diagnostics.is_operator()
returns boolean
language sql
stable
parallel safe
set search_path = ''
as $$
    select current_user = 'centaur_diagnostics_operator'
$$;

create or replace function centaur_diagnostics.scoped_thread_key()
returns text
language sql
stable
parallel safe
set search_path = ''
as $$
    select nullif(pg_catalog.current_setting('centaur.thread_key', true), '')
$$;

create or replace function centaur_diagnostics.scoped_slack_thread_ts()
returns text
language sql
stable
parallel safe
set search_path = ''
as $$
    select (
        pg_catalog.regexp_match(
            coalesce(centaur_diagnostics.scoped_thread_key(), ''),
            '([0-9]{10}\.[0-9]{1,6})$'
        )
    )[1]
$$;

create or replace function centaur_diagnostics.allows_thread(candidate text)
returns boolean
language sql
stable
parallel safe
set search_path = ''
as $$
    select centaur_diagnostics.is_operator()
        or candidate = centaur_diagnostics.scoped_thread_key()
$$;

create or replace function centaur_diagnostics.allows_slack_channel(candidate text)
returns boolean
language sql
stable
parallel safe
set search_path = ''
as $$
    select centaur_diagnostics.is_operator()
        or candidate = any(
            pg_catalog.string_to_array(
                coalesce(centaur_diagnostics.scoped_thread_key(), ''),
                ':'
            )
        )
$$;

create or replace function centaur_diagnostics.allows_slack_message(
    candidate_channel text,
    candidate_message_ts text,
    candidate_thread_ts text,
    candidate_parent_message_ts text
)
returns boolean
language sql
stable
parallel safe
set search_path = ''
as $$
    select centaur_diagnostics.is_operator()
        or (
            centaur_diagnostics.allows_slack_channel(candidate_channel)
            and centaur_diagnostics.scoped_slack_thread_ts() is not null
            and centaur_diagnostics.scoped_slack_thread_ts() in (
                candidate_message_ts,
                candidate_thread_ts,
                candidate_parent_message_ts
            )
        )
$$;

create or replace view centaur_diagnostics.sessions
with (security_barrier = true) as
select
    thread_key,
    sandbox_id,
    harness_type,
    harness_thread_id,
    persona_id,
    status,
    metadata ->> 'source' as source,
    metadata ->> 'platform' as platform,
    metadata ->> 'thread_id' as external_thread_id,
    created_at,
    updated_at
from public.sessions
where centaur_diagnostics.allows_thread(thread_key);

create or replace view centaur_diagnostics.session_executions
with (security_barrier = true) as
select
    execution_id,
    thread_key,
    status,
    metadata ->> 'model' as model,
    metadata ->> 'harness_run_id' as harness_run_id,
    metadata ->> 'base_image_ref' as base_image_ref,
    metadata ->> 'base_image_hash' as base_image_hash,
    metadata ->> 'overlay_hash' as overlay_hash,
    metadata ->> 'source' as source,
    metadata ->> 'platform' as platform,
    metadata ->> 'action' as action,
    metadata ->> 'workflow_name' as workflow_name,
    metadata ->> 'workflow_task_id' as workflow_task_id,
    metadata ->> 'workflow_run_id' as workflow_run_id,
    metadata ->> 'workflow_context_phase' as workflow_context_phase,
    case
        when metadata ->> 'idle_timeout_ms' ~ '^[0-9]+$'
        then (metadata ->> 'idle_timeout_ms')::bigint
    end as idle_timeout_ms,
    case
        when metadata ->> 'max_duration_ms' ~ '^[0-9]+$'
        then (metadata ->> 'max_duration_ms')::bigint
    end as max_duration_ms,
    error is not null and error <> '' as has_error,
    case when error is not null then octet_length(error) end as error_length,
    created_at,
    updated_at,
    started_at,
    completed_at,
    extract(epoch from completed_at - started_at) as duration_seconds
from public.session_executions
where centaur_diagnostics.allows_thread(thread_key);

create or replace view centaur_diagnostics.session_messages
with (security_barrier = true) as
select
    message_id,
    thread_key,
    role,
    case
        when jsonb_typeof(parts) = 'array' then jsonb_array_length(parts)
        else 0
    end as part_count,
    coalesce(
        (
            select jsonb_agg(distinct coalesce(part_values.part ->> 'type', 'unknown'))
            from jsonb_array_elements(
                case
                    when jsonb_typeof(parts) = 'array' then parts
                    else '[]'::jsonb
                end
            ) as part_values(part)
        ),
        '[]'::jsonb
    ) as part_types,
    metadata ->> 'source' as source,
    metadata ->> 'platform' as platform,
    metadata ->> 'action' as action,
    metadata ->> 'user_id' as user_id,
    created_at
from public.session_messages
where centaur_diagnostics.allows_thread(thread_key);

create or replace view centaur_diagnostics.session_events
with (security_barrier = true) as
select
    event_id,
    thread_key,
    execution_id,
    event_type,
    payload ->> 'type' as payload_type,
    payload ->> 'subtype' as payload_subtype,
    payload ->> 'status' as status,
    payload ->> 'turn_id' as turn_id,
    payload ? 'error' as has_error,
    case
        when payload ? 'error' then octet_length(payload ->> 'error')
    end as error_length,
    coalesce(
        (
            select jsonb_agg(payload_keys.key order by payload_keys.key)
            from jsonb_object_keys(
                case
                    when jsonb_typeof(payload) = 'object' then payload
                    else '{}'::jsonb
                end
            ) as payload_keys(key)
        ),
        '[]'::jsonb
    ) as payload_keys,
    created_at
from public.session_events
where centaur_diagnostics.allows_thread(thread_key);

create or replace view centaur_diagnostics.workflow_runs
with (security_barrier = true) as
select
    queue_name,
    run_id,
    task_id,
    task_name,
    workflow_name,
    harness_type,
    state,
    attempts,
    max_attempts,
    created_at,
    first_started_at,
    started_at,
    completed_at,
    failed_at,
    available_at,
    claimed,
    cancelled_at
from public.centaur_readonly_workflow_runs workflow_run
where centaur_diagnostics.is_operator()
   or exists (
        select 1
        from public.session_executions execution
        where centaur_diagnostics.allows_thread(execution.thread_key)
          and (
              execution.metadata ->> 'workflow_run_id' = workflow_run.run_id
              or execution.metadata ->> 'workflow_task_id' = workflow_run.task_id
          )
   );

create or replace view centaur_diagnostics.slack_sync_channels
with (security_barrier = true) as
select
    channel_id,
    channel_name,
    is_archived,
    is_syncable,
    member_count,
    first_seen_at,
    last_seen_at,
    updated_at
from public.slack_sync_channels
where centaur_diagnostics.allows_slack_channel(channel_id);

create or replace view centaur_diagnostics.slack_sync_checkpoints
with (security_barrier = true) as
select
    channel_id,
    watermark_ts,
    last_run_id,
    last_success_at,
    last_error <> '' as has_error,
    created_at,
    updated_at
from public.slack_sync_checkpoints
where centaur_diagnostics.allows_slack_channel(channel_id);

create or replace view centaur_diagnostics.slack_sync_messages
with (security_barrier = true) as
select
    channel_id,
    message_ts,
    occurred_at,
    thread_ts,
    parent_message_ts,
    is_thread_root,
    user_id,
    bot_id <> '' as has_bot_id,
    message_type,
    message_subtype,
    reply_count,
    latest_reply_ts,
    thread_refreshed_at,
    source_run_id,
    first_seen_at,
    last_seen_at,
    updated_at
from public.slack_sync_messages
where centaur_diagnostics.allows_slack_message(
    channel_id,
    message_ts,
    thread_ts,
    parent_message_ts
);

create or replace view centaur_diagnostics.slack_sync_message_attachments
with (security_barrier = true) as
select
    channel_id,
    message_ts,
    slack_file_id,
    mimetype,
    filetype,
    size_bytes,
    download_status,
    download_error <> '' as has_download_error,
    content_sha256 is not null as has_content_hash,
    source_run_id,
    first_seen_at,
    last_seen_at,
    updated_at
from public.slack_sync_message_attachments attachment
where centaur_diagnostics.is_operator()
   or exists (
        select 1
        from public.slack_sync_messages message
        where message.channel_id = attachment.channel_id
          and message.message_ts = attachment.message_ts
          and centaur_diagnostics.allows_slack_message(
              message.channel_id,
              message.message_ts,
              message.thread_ts,
              message.parent_message_ts
          )
   );

create or replace view centaur_diagnostics.slack_sync_backfill_jobs
with (security_barrier = true) as
select
    job_id,
    job_type,
    channel_id,
    payload_json ->> 'thread_ts' as thread_ts,
    status,
    priority,
    attempt_count,
    last_run_id,
    last_enqueued_at,
    last_started_at,
    last_completed_at,
    last_error <> '' as has_error,
    created_at,
    updated_at
from public.slack_sync_backfill_jobs
where centaur_diagnostics.allows_slack_channel(channel_id)
  and (
      centaur_diagnostics.is_operator()
      or payload_json ->> 'thread_ts' = centaur_diagnostics.scoped_slack_thread_ts()
  );

create or replace view centaur_diagnostics.slack_sync_runs
with (security_barrier = true) as
select
    run_id,
    workflow_run_id,
    mode,
    status,
    channels_requested,
    channels_synced,
    channels_skipped,
    channels_failed,
    messages_fetched,
    messages_upserted,
    threads_fetched,
    replies_fetched,
    replies_upserted,
    started_at,
    finished_at,
    error_text <> '' as has_error,
    metadata ->> 'source' as source
from public.slack_sync_runs
where centaur_diagnostics.is_operator()
   or channels_requested ?| pg_catalog.string_to_array(
       coalesce(centaur_diagnostics.scoped_thread_key(), ''), ':'
   )
   or channels_synced ?| pg_catalog.string_to_array(
       coalesce(centaur_diagnostics.scoped_thread_key(), ''), ':'
   )
   or channels_failed ?| pg_catalog.string_to_array(
       coalesce(centaur_diagnostics.scoped_thread_key(), ''), ':'
   )
   or channels_skipped ?| pg_catalog.string_to_array(
       coalesce(centaur_diagnostics.scoped_thread_key(), ''), ':'
   );

do $$
begin
    if to_regclass('public.agent_runtime_assignments') is not null then
        execute $view$
            create or replace view centaur_diagnostics.agent_runtime_assignments
            with (security_barrier = true) as
            select
                thread_key,
                assignment_generation,
                runtime_id,
                harness,
                engine,
                persona_id,
                effective_agents_md_sha256,
                state,
                created_at,
                updated_at,
                released_at
            from public.agent_runtime_assignments
            where centaur_diagnostics.allows_thread(thread_key)
        $view$;
    end if;

    if to_regclass('public.agent_execution_requests') is not null then
        execute $view$
            create or replace view centaur_diagnostics.agent_execution_requests
            with (security_barrier = true) as
            select
                execution_id,
                thread_key,
                assignment_generation,
                execute_id,
                durable_turn_id,
                status,
                created_at,
                claimed_at,
                started_at,
                last_progress_at,
                silence_deadline_at,
                hard_deadline_at,
                stream_break_count,
                last_stream_break_at,
                completed_at,
                worker_id is not null as claimed,
                updated_at
            from public.agent_execution_requests
            where centaur_diagnostics.allows_thread(thread_key)
        $view$;
    end if;

    if to_regclass('public.sandbox_sessions') is not null then
        execute $view$
            create or replace view centaur_diagnostics.sandbox_sessions
            with (security_barrier = true) as
            select
                thread_key,
                sandbox_id,
                harness,
                engine,
                state,
                last_delivered_id,
                agent_thread_id,
                inflight_turn_id,
                inflight_started_at,
                inflight_attempts,
                last_result_at,
                trace_id,
                started_at,
                updated_at,
                wire_connected_at,
                wire_last_seen_at
            from public.sandbox_sessions
            where centaur_diagnostics.allows_thread(thread_key)
        $view$;
    end if;

    if to_regclass('public.thread_traces') is not null then
        execute $view$
            create or replace view centaur_diagnostics.thread_traces
            with (security_barrier = true) as
            select
                thread_key,
                trace_id,
                root_span_id,
                created_at,
                updated_at
            from public.thread_traces
            where centaur_diagnostics.allows_thread(thread_key)
        $view$;
    end if;
end
$$;

revoke all on all tables in schema centaur_diagnostics from public;
revoke all on all functions in schema centaur_diagnostics from public;
grant select on all tables in schema centaur_diagnostics
    to centaur_diagnostics_reader, centaur_diagnostics_operator;
grant execute on all functions in schema centaur_diagnostics
    to centaur_diagnostics_reader, centaur_diagnostics_operator;

grant centaur_diagnostics_reader to current_user;
