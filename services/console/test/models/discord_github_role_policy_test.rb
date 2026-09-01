require "test_helper"

class DiscordGithubRolePolicyTest < ActiveSupport::TestCase
  SCOPE = [ "508-dev/centaur" ].freeze

  def build_policy_binding
    admin = users(:acme_admin)
    credential = BrokerCredential.create!(
      foreign_id: "discord-github-#{SecureRandom.hex(4)}",
      name: "Discord GitHub App",
      grant: "github_app_installation",
      client_id: "Iv1.0123456789abcdef",
      github_installation_id: "12345678",
      github_repositories: SCOPE,
      created_by: admin
    )
    credential.update!(
      access_token: "scoped-token",
      expires_at: 1.hour.from_now,
      last_refresh: Time.current
    )

    github_token_wrapper = StaticSecret.new(
      foreign_id: "discord-github-token-#{SecureRandom.hex(4)}",
      name: "Discord GitHub token",
      kind: CredentialProfiles::GithubToken::KIND,
      labels: { "repositories" => SCOPE.join(",") },
      replace_config: CredentialProfiles::GithubToken::REPLACE_CONFIG.deep_dup,
      created_by: admin
    )
    github_token_wrapper.build_source(
      source_type: "token_broker",
      config: { "credential_id" => credential.foreign_id }
    )
    CredentialProfiles::GithubToken::RULE_ATTRIBUTES.each do |attributes|
      github_token_wrapper.rules.build(attributes)
    end
    github_token_wrapper.save!

    role = Role.create!(
      foreign_id: "discord-policy-#{SecureRandom.hex(4)}",
      name: "Discord policy",
      labels: {
        "centaur_discord_policy_managed" => "true",
        "repository_scope" => SCOPE.join(",")
      },
      created_by: admin
    )
    Grant.create!(role: role, static_secret_id: github_token_wrapper.id, created_by: admin)

    principal = Principal.create!(
      foreign_id: "discord-user-1336096360772141148-#{SecureRandom.random_number(10**18)}",
      kind: "discord_user",
      labels: { "centaur_discord_policy_managed" => "true" },
      created_by: admin
    )
    PrincipalRole.create!(principal: principal, role: role)

    [ principal.reload, role, github_token_wrapper, credential ]
  end

  test "rejects a custom wrapper around a GitHub App credential" do
    _principal, role, _secret, credential = build_policy_binding
    custom = StaticSecret.new(
      foreign_id: "discord-custom-wrapper-#{SecureRandom.hex(4)}",
      name: "Unreviewed wrapper",
      kind: "custom",
      labels: { "repositories" => SCOPE.join(",") },
      inject_config: { "header" => "X-Unreviewed", "formatter" => "{{ .Value }}" },
      created_by: users(:acme_admin)
    )
    custom.build_source(
      source_type: "token_broker",
      config: { "credential_id" => credential.foreign_id }
    )
    custom.rules.build(host: "unreviewed.example", position: 0)
    custom.save!

    grant = Grant.new(role: role, static_secret: custom, created_by: users(:acme_admin))

    assert_not grant.valid?
    assert grant.errors[:base].any? { |message| message.include?("canonical github_token") }
  end

  test "policy-managed Discord actors do not inherit default roles" do
    principal = Principal.create!(
      foreign_id: "discord-user-1336096360772141148-#{SecureRandom.random_number(10**18)}",
      kind: "discord_user",
      labels: { "centaur_discord_policy_managed" => "true" },
      created_by: users(:acme_admin)
    )

    assert_empty principal.reload.roles
  end

  test "rejects widening a broker used by an assigned Discord policy role" do
    _principal, _role, _secret, credential = build_policy_binding
    credential.github_repositories = SCOPE + [ "508-dev/508-infra" ]

    assert_not credential.valid?
    assert credential.errors[:base].any? { |message| message.include?("scope differs") }
  end

  test "rejects adding an unreviewed role to an authorized Discord actor" do
    principal, _role, _secret, _credential = build_policy_binding
    assignment = PrincipalRole.new(principal: principal, role: roles(:acme_infra))

    assert_not assignment.valid?
    assert assignment.errors[:base].any? { |message| message.include?("only receive reviewed") }
  end

  test "rejects direct grants to an authorized Discord actor" do
    principal, _role, _secret, _credential = build_policy_binding
    grant = Grant.new(
      principal: principal,
      static_secret: static_secrets(:acme_prod_api_key),
      created_by: users(:acme_admin)
    )

    assert_not grant.valid?
    assert grant.errors[:base].any? { |message| message.include?("may not receive direct grants") }
  end

  test "Discord actor identity preserves the managed marker across label replacement" do
    principal, _role, _secret, _credential = build_policy_binding

    principal.update!(labels: { "operator-note" => "reviewed" })

    assert_equal "true", principal.reload.labels["centaur_discord_policy_managed"]
    direct_grant = Grant.new(
      principal: principal,
      static_secret: static_secrets(:acme_prod_api_key),
      created_by: users(:acme_admin)
    )
    assert_not direct_grant.valid?
    assert direct_grant.errors[:base].any? { |message| message.include?("may not receive direct grants") }
  end

  test "Discord actor foreign ID remains fail-closed after a legacy marker removal" do
    principal, _role, _secret, _credential = build_policy_binding
    principal.update_columns(labels: {}, kind: "unknown")
    principal.reload

    assert_not DiscordGithubRolePolicy.static_secret_allowed_for_principal?(principal, static_secrets(:acme_prod_api_key))
    direct_grant = Grant.new(
      principal: principal,
      static_secret: static_secrets(:acme_prod_api_key),
      created_by: users(:acme_admin)
    )
    assert_not direct_grant.valid?
    assert direct_grant.errors[:base].any? { |message| message.include?("may not receive direct grants") }
  end

  test "rejects changing the wrapper declaration or policy role scope after assignment" do
    _principal, role, secret, _credential = build_policy_binding
    secret.labels = secret.labels.merge("repositories" => "508-dev/508-infra")

    assert_not secret.valid?
    assert secret.errors[:base].any? { |message| message.include?("declaration differs") }

    role.labels = role.labels.merge("repository_scope" => "508-dev/508-infra")

    assert_not role.valid?
    assert role.errors[:base].any? { |message| message.include?("scope differs") }
  end

  test "proxy rendering excludes legacy widened Discord GitHub credentials" do
    principal, _role, secret, credential = build_policy_binding
    assert secret.source.deliverable?
    assert DiscordGithubRolePolicy.static_secret_allowed_for_principal?(principal, secret)
    legacy = StaticSecret.new(
      foreign_id: "discord-legacy-direct-#{SecureRandom.hex(4)}",
      name: "Legacy direct secret",
      inject_config: { "header" => "X-Legacy", "formatter" => "{{ .Value }}" },
      created_by: users(:acme_admin)
    )
    legacy.build_source(source_type: "control_plane", secret: "legacy-token")
    legacy.rules.build(host: "legacy.example", position: 0)
    legacy.save!
    Grant.new(
      principal: principal,
      static_secret: legacy,
      priority: Grant::DEFAULT_DIRECT_PRIORITY,
      created_by: users(:acme_admin)
    ).save!(validate: false)

    scoped = PrincipalSyncConfigSnapshot.config_for(principal)
    assert_equal [ "scoped-token" ], scoped.fetch("secrets").map { |entry| entry.dig("source", "value") }

    credential.update_columns(github_repositories: SCOPE + [ "508-dev/508-infra" ])

    config = PrincipalSyncConfigSnapshot.config_for(principal)

    assert_empty config.fetch("secrets")
  end
end
