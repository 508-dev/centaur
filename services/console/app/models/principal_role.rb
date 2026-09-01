class PrincipalRole < ApplicationRecord
  oid_prefix "prole"

  include SyncConfigCacheInvalidation

  belongs_to :principal
  belongs_to :role

  validates :role_id, uniqueness: { scope: :principal_id, message: "is already assigned to this principal" }
  validate :discord_github_policy_valid

  private

  def sync_config_affected_principals
    Principal.where(id: principal_id)
  end

  def discord_github_policy_valid
    DiscordGithubRolePolicy.validate_principal_role(self)
  end
end
