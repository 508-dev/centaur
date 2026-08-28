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

-- This role is intentionally independent from the legacy broad read-only role.
revoke centaur_readonly from centaur_diagnostics_reader;

create schema if not exists centaur_diagnostics;
revoke all on schema centaur_diagnostics from public;
grant usage on schema centaur_diagnostics to centaur_diagnostics_reader;

alter default privileges in schema centaur_diagnostics
    revoke all on tables from public;

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
from public.sessions;

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
from public.session_executions;

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
from public.session_messages;

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
from public.session_events;

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
from public.centaur_readonly_workflow_runs;

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
from public.slack_sync_channels;

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
from public.slack_sync_checkpoints;

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
from public.slack_sync_messages;

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
from public.slack_sync_message_attachments;

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
from public.slack_sync_backfill_jobs;

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
from public.slack_sync_runs;

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
        $view$;
    end if;
end
$$;

revoke all on all tables in schema centaur_diagnostics from public;
grant select on all tables in schema centaur_diagnostics to centaur_diagnostics_reader;

grant centaur_diagnostics_reader to current_user;
