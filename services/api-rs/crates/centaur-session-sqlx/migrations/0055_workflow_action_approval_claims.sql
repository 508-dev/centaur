create table workflow_action_proposal_approval_claims (
    fingerprint text primary key
        references workflow_action_proposals (fingerprint) on delete cascade,
    actor_id text not null,
    capability_class text not null,
    channel_id text not null,
    guild_id text not null,
    message_id text not null,
    policy_fingerprint text not null,
    principal_role text not null,
    repository_scope jsonb not null,
    root_message_id text not null,
    thread_id text not null,
    claimed_at timestamptz not null default now(),
    constraint workflow_action_approval_claim_repository_scope_check
        check (jsonb_typeof(repository_scope) = 'array')
);

revoke all on workflow_action_proposal_approval_claims from public;
