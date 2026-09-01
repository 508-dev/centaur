# Validates the GitHub App boundary for roles that Core marks as reviewed
# Discord policy roles. The policy is enforced where the effective grant graph
# can change and again when a proxy config is rendered, so a later Console
# mutation cannot widen credentials already assigned to a Discord actor.
class DiscordGithubRolePolicy
  MANAGED_ROLE_LABEL = "centaur_discord_policy_managed".freeze
  REPOSITORY_SCOPE_LABEL = "repository_scope".freeze
  SECRET_REPOSITORIES_LABEL = "repositories".freeze
  TOKEN_BROKER_SOURCE = "token_broker".freeze
  GITHUB_APP_INSTALLATION_GRANT = "github_app_installation".freeze
  MAX_REPOSITORIES = 64
  REPOSITORY_FORMAT = /\A[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\z/

  class << self
    def validate_role(role)
      add_errors(role, policy_errors(role))
    end

    def validate_grant(grant)
      if managed_principal?(grant.principal)
        grant.errors.add(:base, "Discord policy-managed principals may not receive direct grants")
        return
      end

      role = grant.role
      credential = grant.grantable
      return unless managed_role?(role) && credential

      if credential.is_a?(StaticSecret)
        extra_secret = grant.new_record? ? credential : nil
        add_errors(grant, policy_errors(role, extra_static_secret: extra_secret))
      else
        add_errors(grant, nonstatic_credential_errors(role, credential))
      end
    end

    # Request rules are mutable after a credential has been granted. Enforce
    # the same boundary at that mutation point so a previously harmless
    # non-static credential cannot later be pointed at GitHub. Static secrets
    # have their own complete-profile validation in validate_static_secret.
    def validate_request_rule(rule)
      credential = credential_for_rule(rule)
      return unless credential && !credential.is_a?(StaticSecret)
      return unless github_targetable_rule?(rule)

      policy_roles_granting(credential).each do |role|
        rule.errors.add(
          :base,
          "Discord policy role #{role.foreign_id || role.oid}: may not grant #{credential.class.model_name.human.downcase} credentials that can target GitHub"
        )
      end
    end

    def validate_static_secret(secret)
      policy_roles_granting(secret).each do |role|
        messages = policy_errors(
          role,
          replacement_static_secret: secret,
          replacement_rules: secret.kind_rules_for_validation
        )
        add_errors(secret, prefix_errors(role, messages))
      end
    end

    def validate_secret_source(source)
      secret = source.static_secret
      return unless secret

      policy_roles_granting(secret).each do |role|
        messages = policy_errors(
          role,
          replacement_static_secret: secret,
          replacement_source: source
        )
        add_errors(source, prefix_errors(role, messages))
      end
    end

    def validate_broker_credential(credential)
      policy_roles_referencing(credential).each do |role|
        messages = policy_errors(role, replacement_broker: credential)
        add_errors(credential, prefix_errors(role, messages))
      end
    end

    def validate_principal_role(assignment)
      principal = assignment.principal
      return unless managed_principal?(principal)

      role = assignment.role
      unless managed_role?(role)
        assignment.errors.add(:base, "Discord policy-managed principals may only receive reviewed Discord policy roles")
        return
      end

      roles = principal.roles.to_a
      roles << role if assignment.new_record? && !roles.any? { |candidate| same_record?(candidate, role) }
      if roles.length != 1
        assignment.errors.add(:base, "Discord policy-managed principals must receive exactly one reviewed role")
      end
      add_errors(assignment, prefix_errors(role, policy_errors(role)))
    end

    # Used immediately before a proxy receives any credential. Model validations
    # block normal mutations; this is a final fail-closed guard for legacy state
    # or an out-of-band write that left a Discord role inconsistent.
    def credential_allowed_for_principal?(principal, credential)
      if managed_principal?(principal)
        roles = principal.roles.to_a
        return false unless roles.length == 1 && managed_role?(roles.first)
        return false unless role_grants_credential?(roles.first, credential)

        return role_allows_credential?(roles.first, credential)
      end

      roles = principal.roles.to_a.select do |role|
        managed_role?(role) && role_grants_credential?(role, credential)
      end
      return true if roles.empty?

      roles.all? { |role| role_allows_credential?(role, credential) }
    end

    # Backwards-compatible name for callers that render static secrets.
    def static_secret_allowed_for_principal?(principal, secret)
      credential_allowed_for_principal?(principal, secret)
    end

    private

    def add_errors(record, messages)
      messages.uniq.each { |message| record.errors.add(:base, message) }
    end

    def prefix_errors(role, messages)
      messages.map { |message| "Discord policy role #{role.foreign_id || role.oid}: #{message}" }
    end

    def managed_role?(role)
      role&.labels.to_h[MANAGED_ROLE_LABEL] == "true"
    end

    def managed_principal?(principal)
      principal&.discord_actor_principal?
    end

    def policy_errors(role, replacement_static_secret: nil, replacement_source: nil,
                      replacement_broker: nil, extra_static_secret: nil, replacement_rules: nil)
      return [] unless managed_role?(role)

      expected_scope, scope_error = repository_scope(
        role.labels.to_h[REPOSITORY_SCOPE_LABEL],
        "reviewed Discord role repository_scope"
      )
      return [ scope_error ] if scope_error

      secrets = static_secrets_for_role(
        role,
        replacement_static_secret: replacement_static_secret,
        extra_static_secret: extra_static_secret
      )
      github_secrets = secrets.select do |secret|
        github_related_secret?(
          secret,
          replacement_static_secret,
          replacement_source,
          replacement_broker,
          replacement_rules: replacement_rules
        )
      end
      return [] if github_secrets.empty?

      errors = github_secrets.flat_map do |secret|
        github_secret_errors(
          secret,
          expected_scope,
          replacement_static_secret,
          replacement_source,
          replacement_broker,
          replacement_rules: replacement_rules
        )
      end
      if github_secrets.length != 1
        errors << "must grant exactly one scoped GitHub App credential, found #{github_secrets.length}"
      end
      errors.uniq
    end

    def nonstatic_credential_errors(role, credential)
      _scope, scope_error = repository_scope(
        role.labels.to_h[REPOSITORY_SCOPE_LABEL],
        "reviewed Discord role repository_scope"
      )
      return [ scope_error ] if scope_error
      return [] unless github_targetable_credential?(credential)

      [ "may not grant #{credential.class.model_name.human.downcase} credentials that can target GitHub" ]
    end

    def static_secrets_for_role(role, replacement_static_secret:, extra_static_secret:)
      secrets = role.grants.includes(:static_secret).filter_map(&:static_secret)
      if replacement_static_secret&.persisted?
        secrets.map! do |secret|
          same_record?(secret, replacement_static_secret) ? replacement_static_secret : secret
        end
      end
      if extra_static_secret && !secrets.any? { |secret| same_record?(secret, extra_static_secret) }
        secrets << extra_static_secret
      end
      secrets.uniq { |secret| secret.id || secret.object_id }
    end

    def github_related_secret?(secret, replacement_static_secret, replacement_source, replacement_broker,
                               replacement_rules:)
      return true if secret.kind == CredentialProfiles::GithubToken::KIND
      return true if rules_for(secret, replacement_static_secret, replacement_rules).any? { |rule| github_targetable_rule?(rule) }

      broker = broker_for(
        source_for(secret, replacement_static_secret, replacement_source),
        replacement_broker
      )
      broker&.grant == GITHUB_APP_INSTALLATION_GRANT
    end

    def github_host_rule?(rule)
      host = rule.host.to_s
      CredentialProfiles::GithubToken::ALLOWED_HOSTS.any? do |github_host|
        File.fnmatch?(host, github_host)
      end
    end

    # GitHub's address space is not a stable authorization boundary. A CIDR
    # rule can cover an address GitHub serves now or later, so reviewed Discord
    # roles may only receive the canonical host-scoped GitHub App credential.
    def github_targetable_rule?(rule)
      rule.cidr.present? || github_host_rule?(rule)
    end

    def github_secret_errors(secret, expected_scope, replacement_static_secret,
                             replacement_source, replacement_broker, replacement_rules:)
      errors = []
      unless canonical_github_token?(secret, rules: rules_for(secret, replacement_static_secret, replacement_rules))
        errors << "GitHub App credential must use the canonical github_token static-secret profile"
      end

      source = source_for(secret, replacement_static_secret, replacement_source)
      unless source&.source_type == TOKEN_BROKER_SOURCE
        errors << "GitHub token must be sourced from a token broker"
        return errors
      end

      broker = broker_for(source, replacement_broker)
      unless broker&.grant == GITHUB_APP_INSTALLATION_GRANT
        errors << "GitHub token must be backed by a GitHub App installation credential"
        return errors
      end

      secret_scope, secret_scope_error = repository_scope(
        secret.labels.to_h[SECRET_REPOSITORIES_LABEL],
        "GitHub token repository declaration"
      )
      errors << secret_scope_error if secret_scope_error
      if secret_scope && secret_scope != expected_scope
        errors << "GitHub token repository declaration differs from the reviewed role scope"
      end

      broker_scope, broker_scope_error = repository_scope(
        broker.github_repositories,
        "GitHub App credential repository scope"
      )
      errors << broker_scope_error if broker_scope_error
      if broker_scope && broker_scope != expected_scope
        errors << "GitHub App credential repository scope differs from the reviewed role scope"
      end
      errors
    end

    def canonical_github_token?(secret, rules: secret.rules.to_a)
      return false unless secret.kind == CredentialProfiles::GithubToken::KIND
      return false unless secret.inject_config.blank? &&
                          secret.replace_config == CredentialProfiles::GithubToken::REPLACE_CONFIG

      rules.present? && rules.all? do |rule|
        CredentialProfiles::GithubToken::ALLOWED_HOSTS.include?(rule.host) && rule.cidr.blank?
      end
    end

    def rules_for(secret, replacement_static_secret, replacement_rules)
      return replacement_rules if replacement_rules && same_record?(secret, replacement_static_secret)

      secret.rules.to_a
    end

    def source_for(secret, replacement_static_secret, replacement_source)
      return replacement_source if replacement_source && same_record?(secret, replacement_static_secret)

      secret.source
    end

    def broker_for(source, replacement_broker)
      return nil unless source&.source_type == TOKEN_BROKER_SOURCE && source.config.is_a?(Hash)

      reference = source.config["credential_id"].to_s.strip
      return nil if reference.empty?
      return replacement_broker if replacement_broker && references_broker?(source, replacement_broker)

      if BrokerCredential.decode_oid(reference)
        BrokerCredential.find_by_oid(reference)
      else
        BrokerCredential.find_by(foreign_id: reference)
      end
    end

    def references_broker?(source, broker)
      reference = source.config.to_h["credential_id"].to_s.strip
      reference.present? && [ broker.oid, broker.foreign_id ].compact.include?(reference)
    end

    def role_allows_credential?(role, credential)
      if credential.is_a?(StaticSecret)
        policy_errors(role).empty?
      else
        nonstatic_credential_errors(role, credential).empty?
      end
    end

    def role_grants_credential?(role, credential)
      association = grantable_association_for(credential)
      association && role.grants.where(association => credential).exists?
    end

    def github_targetable_credential?(credential)
      credential.respond_to?(:rules) && credential.rules.to_a.any? { |rule| github_targetable_rule?(rule) }
    end

    def credential_for_rule(rule)
      RequestRule::OWNER_ASSOCIATIONS.filter_map { |association| rule.public_send(association) }.first
    end

    def grantable_association_for(credential)
      Grant::GRANTABLE_ASSOCIATIONS.find do |association|
        Grant.reflect_on_association(association).klass == credential.class
      end
    end

    def policy_roles_granting(credential)
      association = grantable_association_for(credential)
      return [] unless credential.persisted? && association

      Grant.where(association => credential).where.not(role_id: nil).includes(:role)
        .filter_map(&:role).select { |role| managed_role?(role) }.uniq(&:id)
    end

    def policy_roles_referencing(credential)
      SecretSource.referencing_broker_credential(credential).includes(static_secret: { grants: :role })
        .filter_map(&:static_secret).flat_map(&:grants).filter_map(&:role)
        .select { |role| managed_role?(role) }.uniq(&:id)
    end

    def repository_scope(value, label)
      entries = case value
      when String
        value.split(",").map(&:strip)
      when Array
        value
      else
        return [ nil, "#{label} must be a non-empty repository list" ]
      end
      return [ nil, "#{label} must contain between one and #{MAX_REPOSITORIES} repositories" ] if entries.empty? || entries.length > MAX_REPOSITORIES
      return [ nil, "#{label} must contain exact owner/repository names" ] unless entries.all? { |entry| entry.is_a?(String) && entry.match?(REPOSITORY_FORMAT) }

      normalized = entries.map(&:downcase)
      return [ nil, "#{label} contains duplicate repositories" ] unless normalized.uniq.length == normalized.length

      [ normalized.sort, nil ]
    end

    def same_record?(left, right)
      return false unless left && right

      left.equal?(right) || (left.persisted? && right.persisted? && left.id == right.id)
    end
  end
end
