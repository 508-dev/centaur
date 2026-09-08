class PrincipalRole < ApplicationRecord
  oid_prefix "prole"

  include SyncConfigCacheInvalidation

  belongs_to :principal
  belongs_to :role

  validates :role_id, uniqueness: { scope: :principal_id, message: "is already assigned to this principal" }
  validate :discord_github_policy_valid
  before_destroy :revoke_discord_actor_sandbox_policy, prepend: true

  private

  def sync_config_affected_principals
    Principal.where(id: principal_id)
  end

  def revoke_discord_actor_sandbox_policy
    actor = principal
    return unless actor.discord_actor_principal?

    actor.with_lock do
      actor.update_columns(
        **Role::DISCORD_REVOKED_SANDBOX_POLICY,
        labels: actor.labels.to_h.merge(
          Principal::SANDBOX_REPO_CACHE_LABEL =>
            Role::DISCORD_REVOKED_SANDBOX_POLICY.fetch(:sandbox_repo_cache)
        ),
        updated_at: Time.current
      )
    end
  end

  def discord_github_policy_valid
    DiscordGithubRolePolicy.validate_principal_role(self)
  end
end
