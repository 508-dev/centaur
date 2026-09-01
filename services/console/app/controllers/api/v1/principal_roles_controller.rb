module Api
  module V1
    # Manages role assignments for a principal:
    #   GET    /api/v1/principals/:principal_id/roles
    #   POST   /api/v1/principals/:principal_id/roles      (body: data: { role_id })
    #   PUT    /api/v1/principals/:principal_id/roles      (atomic roles + sandbox policy)
    #   DELETE /api/v1/principals/:principal_id/roles/:id  (:id is the role oid)
    class PrincipalRolesController < Api::BaseController
      POLICY_KEYS = %w[
        role_ids
        sandbox_repo_cache
        sandbox_observability_enabled
        sandbox_sessions_read_enabled
        sandbox_workflows_read_enabled
        sandbox_workflows_write_enabled
      ].freeze
      BOOLEAN_POLICY_KEYS = (POLICY_KEYS - %w[role_ids sandbox_repo_cache]).freeze

      def index
        principal = Principal.find_by_oid!(params[:principal_id])
        roles = principal.roles.includes(:slack_channel_permissions).order(:id)
        render json: { data: roles.map { |r| role_payload(r) } }
      end

      # Idempotent: re-assigning a role the principal already holds returns the
      # existing assignment with 200 rather than a uniqueness 422.
      def create
        principal = Principal.find_by_oid!(params[:principal_id])
        role = Role.find_by_oid!(data_params.require(:role_id))
        existing = principal.principal_roles.find_by(role: role)
        if existing
          render status: :ok, json: { data: role_payload(role) }
        else
          principal.principal_roles.create!(role: role)
          render status: :created, json: { data: role_payload(role) }
        end
      rescue ActiveRecord::RecordInvalid => e
        render_validation_error(e.record)
      end

      def replace
        principal = Principal.find_by_oid!(params[:principal_id])
        policy = replacement_policy
        roles = policy.delete(:role_ids).map { |role_id| Role.find_by_oid!(role_id) }
        principal.replace_roles_and_sandbox_policy!(roles:, **policy)
        render json: { data: roles.map { |role| role_payload(role) } }
      rescue ActiveRecord::RecordInvalid => e
        render_validation_error(e.record)
      end

      def destroy
        principal = Principal.find_by_oid!(params[:principal_id])
        role = Role.find_by_oid!(params[:id])
        assignment = principal.principal_roles.find_by!(role: role)
        assignment.destroy!
        head :no_content
      end

      private

      def replacement_policy
        raw = data_params.to_unsafe_h.stringify_keys
        unless raw.keys.sort == POLICY_KEYS.sort
          raise ActionController::BadRequest, "atomic principal policy has invalid fields"
        end
        role_ids = raw.fetch("role_ids")
        unless role_ids.is_a?(Array) && role_ids.length.between?(1, 16) &&
               role_ids.all? { |role_id| role_id.is_a?(String) && role_id.match?(/\Arole_[A-Za-z0-9_-]+\z/) } &&
               role_ids.uniq.length == role_ids.length
          raise ActionController::BadRequest, "role_ids must contain unique role OIDs"
        end
        unless Principal::SANDBOX_REPO_CACHE_VALUES.include?(raw.fetch("sandbox_repo_cache"))
          raise ActionController::BadRequest, "sandbox_repo_cache is invalid"
        end
        unless BOOLEAN_POLICY_KEYS.all? { |key| [ true, false ].include?(raw.fetch(key)) }
          raise ActionController::BadRequest, "sandbox capability values must be booleans"
        end
        raw.symbolize_keys
      end

      def role_payload(role)
        {
          id: role.oid,
          foreign_id: role.foreign_id,
          name: role.name,
          labels: role.labels,
          slack_channel_permissions: role.slack_channel_permissions_payload,
          created_at: role.created_at,
          updated_at: role.updated_at
        }
      end
    end
  end
end
