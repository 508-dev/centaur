create table workflow_action_proposals (
    fingerprint text primary key,
    proposal jsonb not null,
    action_workflow text not null,
    observer_workflow text not null,
    observer_task_id text not null,
    observer_run_id text not null,
    expires_at timestamptz not null,
    consumed_at timestamptz,
    approved_by_actor_id text,
    approved_message_id text,
    approved_guild_id text,
    approved_channel_id text,
    approved_thread_id text,
    approved_root_message_id text,
    approved_policy_fingerprint text,
    approved_capability_class text,
    approved_principal_role text,
    approved_repository_scope jsonb,
    action_task_id text,
    action_run_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint workflow_action_proposals_fingerprint_check
        check (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
    constraint workflow_action_proposals_consumption_check
        check ((consumed_at is null
                and approved_by_actor_id is null
                and approved_message_id is null
                and approved_guild_id is null
                and approved_channel_id is null
                and approved_thread_id is null
                and approved_root_message_id is null
                and approved_policy_fingerprint is null
                and approved_capability_class is null
                and approved_principal_role is null
                and approved_repository_scope is null
                and action_task_id is null
                and action_run_id is null)
            or (consumed_at is not null
                and approved_by_actor_id is not null
                and approved_message_id is not null
                and approved_guild_id is not null
                and approved_channel_id is not null
                and approved_thread_id is not null
                and approved_root_message_id is not null
                and approved_policy_fingerprint is not null
                and approved_capability_class is not null
                and approved_principal_role is not null
                and approved_repository_scope is not null
                and action_task_id is not null
                and action_run_id is not null))
);

create index workflow_action_proposals_pending_idx
    on workflow_action_proposals (expires_at)
    where consumed_at is null;

create table workflow_semantic_notification_states (
    scope text primary key,
    semantic_fingerprint text,
    state_class text not null,
    active boolean not null,
    last_workflow_run_id text not null,
    last_notification_workflow_run_id text,
    last_notified_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint workflow_semantic_notification_fingerprint_check
        check (semantic_fingerprint is null or semantic_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
    constraint workflow_semantic_notification_active_check
        check ((active and semantic_fingerprint is not null)
            or (not active and semantic_fingerprint is null))
);

revoke all on workflow_action_proposals from public;
revoke all on workflow_semantic_notification_states from public;
