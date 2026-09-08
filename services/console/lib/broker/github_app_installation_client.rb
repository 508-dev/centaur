require "openssl"
require "time"

module Broker
  # Mints GitHub App installation access tokens. GitHub's flow is deliberately
  # separate from OAuth: an App JWT (signed with the App PEM) authenticates a
  # POST to a fixed GitHub API endpoint, which returns a short-lived token for a
  # particular installation.
  #
  # SECURITY: the PEM is read only by the Console worker from a read-only
  # filesystem mount. It is never persisted, returned by the API, delivered to
  # iron-proxy, or logged. Neither the signed JWT nor GitHub's response body is
  # logged here.
  class GithubAppInstallationClient
    PRIVATE_KEY_PATH_ENV = "CENTAUR_GITHUB_APP_PRIVATE_KEY_PATH".freeze
    API_ENDPOINT = CredentialGrants::GITHUB_API_ENDPOINT
    API_VERSION = "2022-11-28".freeze
    USER_AGENT = "centaur-console".freeze
    JWT_BACKDATE_SECONDS = 60
    JWT_LIFETIME_SECONDS = 9 * 60

    def initialize(http_client: nil, http: nil,
                   private_key_path: ENV.fetch(PRIVATE_KEY_PATH_ENV, nil),
                   clock: -> { Time.current })
      @http_client = http_client
      @http = http
      @private_key_path = private_key_path
      @clock = clock
    end

    def refresh(client_id:, installation_id:, repositories: [],
                timeout: Broker::RefreshClient::DEFAULT_TIMEOUT)
      validate_inputs!(client_id, installation_id, repositories)
      signed_jwt = app_jwt(client_id)
      request_body = repositories.present? ? { repositories: repositories.map { |name| name.split("/", 2).last } } : nil
      response = http_client_for(timeout).post(
        "#{API_ENDPOINT}/app/installations/#{installation_id}/access_tokens",
        json: request_body,
        headers: {
          "Accept" => "application/vnd.github+json",
          "Authorization" => "Bearer #{signed_jwt}",
          "User-Agent" => USER_AGENT,
          "X-GitHub-Api-Version" => API_VERSION
        }
      )

      classify_error!(response) unless response.success?
      parse_success(response, repositories: repositories)
    rescue Broker::RefreshError
      raise
    rescue OpenSSL::PKey::PKeyError, OpenSSL::OpenSSLError, Errno::ENOENT, Errno::EACCES
      # The PEM is an external worker mount. Missing/invalid bytes can be
      # repaired without changing this credential, so retain it in the refresh
      # loop with normal exponential backoff instead of marking it dead.
      raise RefreshError.new("GitHub App private key is unavailable or invalid",
                             stage: "configuration", code: "github_app_private_key", retryable: true)
    rescue StandardError => e
      # The endpoint is fixed, so unexpected transport errors are transient.
      # Do not include error text: libraries may embed request context in it.
      raise RefreshError.new("GitHub App installation token request failed: #{e.class}",
                             stage: "network", retryable: true)
    end

    private

    def http_client_for(timeout)
      return @http_client if @http_client

      HttpClient.new(
        http: @http,
        open_timeout: timeout,
        read_timeout: timeout,
        max_body_bytes: RefreshClient::MAX_BODY_BYTES
      )
    end

    def validate_inputs!(client_id, installation_id, repositories)
      unless client_id.to_s.match?(/\A[A-Za-z][A-Za-z0-9._-]*\z/)
        raise RefreshError.new("GitHub App client ID is missing or invalid",
                               stage: "configuration", code: "github_app_client_id", retryable: false)
      end
      unless installation_id.to_s.match?(/\A[1-9]\d*\z/)
        raise RefreshError.new("GitHub App installation ID is invalid",
                               stage: "configuration", code: "github_app_installation_id", retryable: false)
      end
      unless repositories.is_a?(Array) && repositories.length <= BrokerCredential::GITHUB_REPOSITORY_LIMIT &&
             repositories.all? { |repository| repository.is_a?(String) &&
               repository.match?(BrokerCredential::GITHUB_REPOSITORY_FORMAT) } &&
             repositories.map(&:downcase).uniq.length == repositories.length &&
             repositories.map { |repository| repository.split("/", 2).first.downcase }.uniq.length <= 1
        raise RefreshError.new("GitHub App repository scope is invalid",
                               stage: "configuration", code: "github_app_repositories", retryable: false)
      end
      if @private_key_path.blank?
        raise RefreshError.new("GitHub App private key path is not configured",
                               stage: "configuration", code: "github_app_private_key", retryable: true)
      end
    end

    def app_jwt(client_id)
      private_key = OpenSSL::PKey.read(File.binread(@private_key_path))
      unless private_key.is_a?(OpenSSL::PKey::RSA) && private_key.private?
        raise RefreshError.new("GitHub App private key is invalid",
                               stage: "configuration", code: "github_app_private_key", retryable: true)
      end

      issued_at = @clock.call.to_i - JWT_BACKDATE_SECONDS
      JWT.encode(
        { iat: issued_at, exp: issued_at + JWT_LIFETIME_SECONDS, iss: client_id },
        private_key,
        "RS256"
      )
    end

    def classify_error!(response)
      retryable = rate_limited?(response) || response.status / 100 == 5
      raise RefreshError.new(
        "GitHub App installation token request failed (HTTP #{response.status})",
        stage: "http",
        code: "http_#{response.status}",
        status: response.status,
        retryable: retryable
      )
    end

    # GitHub uses 403 as well as 429 for rate limiting. Restrict the 403 case
    # to explicit rate-limit headers so a structural permission/configuration
    # error still marks the credential dead and asks for operator attention.
    def rate_limited?(response)
      return true if response.status == 429
      return false unless response.status == 403

      response["retry-after"].present? || response["x-ratelimit-remaining"].to_s == "0"
    end

    def parse_success(response, repositories:)
      parsed = response.json
      access_token = parsed.fetch("token")
      expires_at = Time.iso8601(parsed.fetch("expires_at"))
      if access_token.blank? || expires_at <= @clock.call
        raise KeyError
      end

      verify_repository_scope!(parsed, repositories) if repositories.present?

      RefreshClient::Result.new(
        access_token: access_token,
        refresh_token: nil,
        expires_in: [ (expires_at - @clock.call).floor, 1 ].max
      )
    rescue JSON::ParserError, KeyError, ArgumentError, TypeError
      raise RefreshError.new("GitHub App installation token response was invalid",
                             stage: "parse", code: "github_app_response", retryable: true)
    end

    def verify_repository_scope!(parsed, requested)
      returned = parsed.fetch("repositories").map { |repository| repository.fetch("full_name") }
      return if returned.map(&:downcase).sort == requested.map(&:downcase).sort

      raise RefreshError.new("GitHub App installation token repository scope did not match the request",
                             stage: "parse", code: "github_app_repository_scope", retryable: false)
    rescue KeyError, NoMethodError, TypeError
      raise RefreshError.new("GitHub App installation token repository scope was missing or invalid",
                             stage: "parse", code: "github_app_repository_scope", retryable: false)
    end
  end
end
