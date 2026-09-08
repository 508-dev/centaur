class Role < ApplicationRecord
  oid_prefix "role"

  DISCORD_REVOKED_SANDBOX_POLICY = {
    sandbox_repo_cache: "none",
    sandbox_observability_enabled: false,
    sandbox_sessions_read_enabled: false,
    sandbox_workflows_read_enabled: false,
    sandbox_workflows_write_enabled: false
  }.freeze

  include SyncConfigCacheInvalidation
  include ForeignIdCollisionGuard
  attr_readonly :foreign_id

  has_many :grants, dependent: :destroy
  has_many :principal_roles, dependent: :destroy
  has_many :principals, through: :principal_roles
  has_many :slack_channel_permissions, dependent: :destroy
  belongs_to :created_by, class_name: "User"

  include SlackChannelPermissionOwner

  URL_SAFE_FORMAT = /\A[A-Za-z0-9\-._~]+\z/
  URL_SAFE_MESSAGE = "must contain only URL-safe characters (A-Z, a-z, 0-9, -, ., _, ~)"

  validates :foreign_id, uniqueness: { allow_nil: true },
            format: { with: URL_SAFE_FORMAT, message: URL_SAFE_MESSAGE }, allow_nil: true
  validate :labels_is_a_hash
  validate :discord_github_policy_valid
  before_update :reconcile_discord_actor_sandbox_policy, if: :will_save_change_to_labels?
  before_destroy :revoke_discord_actor_sandbox_policy, prepend: true
  after_commit :clear_discord_actor_reconciliation
  after_rollback :clear_discord_actor_reconciliation

  def self.ensure_default_infra!(created_by:)
    role = find_or_initialize_by(foreign_id: "infra")
    if role.new_record?
      role.assign_attributes(
        name: "Infra",
        labels: { "managed-by" => "centaur" },
        assign_by_default: true,
        created_by: created_by
      )
      role.save!
    elsif !role.assign_by_default?
      role.update!(assign_by_default: true)
    end
    role
  end

  def self.replace_default_assignments!(role_ids)
    transaction do
      now = Time.current
      where(assign_by_default: true).where.not(id: role_ids)
        .update_all(assign_by_default: false, updated_at: now)
      where(id: role_ids, assign_by_default: false)
        .update_all(assign_by_default: true, updated_at: now)
    end
  end

  private

  def sync_config_affected_principals
    Principal.where(id: @sync_config_affected_principal_ids || principal_ids)
  end

  def reconcile_discord_actor_sandbox_policy
    ids = capture_discord_actor_reconciliation_ids
    return if ids.empty?

    policy = DiscordGithubRolePolicy.sandbox_policy_for_role(self) ||
      DISCORD_REVOKED_SANDBOX_POLICY
    apply_discord_actor_sandbox_policy(ids, policy)
  end

  def revoke_discord_actor_sandbox_policy
    ids = capture_discord_actor_reconciliation_ids
    apply_discord_actor_sandbox_policy(ids, DISCORD_REVOKED_SANDBOX_POLICY) if ids.any?
  end

  def capture_discord_actor_reconciliation_ids
    return @discord_actor_reconciliation_ids if
      instance_variable_defined?(:@discord_actor_reconciliation_ids)

    # Query the join directly: role.principals may have been loaded before a
    # newly created assignment and therefore be stale inside this transaction.
    @sync_config_affected_principal_ids = PrincipalRole
      .where(role_id: id)
      .pluck(:principal_id)
    @discord_actor_reconciliation_ids = Principal
      .where(id: @sync_config_affected_principal_ids)
      .where("foreign_id LIKE ?", "#{Principal::DISCORD_ACTOR_FOREIGN_ID_PREFIX}%")
      .ids
  end

  def apply_discord_actor_sandbox_policy(ids, policy)
    Principal.where(id: ids).order(:id).lock.each do |principal|
      principal.update_columns(
        **policy,
        labels: principal.labels.to_h.merge(
          Principal::SANDBOX_REPO_CACHE_LABEL => policy.fetch(:sandbox_repo_cache)
        ),
        updated_at: Time.current
      )
    end
  end

  def clear_discord_actor_reconciliation
    remove_instance_variable(:@discord_actor_reconciliation_ids) if
      instance_variable_defined?(:@discord_actor_reconciliation_ids)
    remove_instance_variable(:@sync_config_affected_principal_ids) if
      instance_variable_defined?(:@sync_config_affected_principal_ids)
  end

  def labels_is_a_hash
    errors.add(:labels, "must be a hash") unless labels.is_a?(Hash)
  end

  def discord_github_policy_valid
    DiscordGithubRolePolicy.validate_role(self)
  end
end
