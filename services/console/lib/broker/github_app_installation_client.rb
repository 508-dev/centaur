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

    def refresh(client_id:, installation_id:, timeout: Broker::RefreshClient::DEFAULT_TIMEOUT)
      validate_inputs!(client_id, installation_id)
      signed_jwt = app_jwt(client_id)
      response = http_client_for(timeout).post(
        "#{API_ENDPOINT}/app/installations/#{installation_id}/access_tokens",
        headers: {
          "Accept" => "application/vnd.github+json",
          "Authorization" => "Bearer #{signed_jwt}",
          "User-Agent" => USER_AGENT,
          "X-GitHub-Api-Version" => API_VERSION
        }
      )

      classify_error!(response) unless response.success?
      parse_success(response)
    rescue Broker::RefreshError
      raise
    rescue OpenSSL::PKey::PKeyError, OpenSSL::OpenSSLError, Errno::ENOENT, Errno::EACCES
      raise RefreshError.new("GitHub App private key is unavailable or invalid",
                             stage: "configuration", code: "github_app_private_key", retryable: false)
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

    def validate_inputs!(client_id, installation_id)
      unless client_id.to_s.match?(/\A[A-Za-z][A-Za-z0-9._-]*\z/)
        raise RefreshError.new("GitHub App client ID is missing or invalid",
                               stage: "configuration", code: "github_app_client_id", retryable: false)
      end
      unless installation_id.to_s.match?(/\A[1-9]\d*\z/)
        raise RefreshError.new("GitHub App installation ID is invalid",
                               stage: "configuration", code: "github_app_installation_id", retryable: false)
      end
      if @private_key_path.blank?
        raise RefreshError.new("GitHub App private key path is not configured",
                               stage: "configuration", code: "github_app_private_key", retryable: false)
      end
    end

    def app_jwt(client_id)
      private_key = OpenSSL::PKey.read(File.binread(@private_key_path))
      unless private_key.is_a?(OpenSSL::PKey::RSA) && private_key.private?
        raise RefreshError.new("GitHub App private key is invalid",
                               stage: "configuration", code: "github_app_private_key", retryable: false)
      end

      issued_at = @clock.call.to_i - JWT_BACKDATE_SECONDS
      JWT.encode(
        { iat: issued_at, exp: issued_at + JWT_LIFETIME_SECONDS, iss: client_id },
        private_key,
        "RS256"
      )
    end

    def classify_error!(response)
      retryable = response.status == 429 || response.status / 100 == 5
      raise RefreshError.new(
        "GitHub App installation token request failed (HTTP #{response.status})",
        stage: "http",
        code: "http_#{response.status}",
        status: response.status,
        retryable: retryable
      )
    end

    def parse_success(response)
      parsed = response.json
      access_token = parsed.fetch("token")
      expires_at = Time.iso8601(parsed.fetch("expires_at"))
      if access_token.blank? || expires_at <= @clock.call
        raise KeyError
      end

      RefreshClient::Result.new(
        access_token: access_token,
        refresh_token: nil,
        expires_in: [ (expires_at - @clock.call).floor, 1 ].max
      )
    rescue JSON::ParserError, KeyError, ArgumentError, TypeError
      raise RefreshError.new("GitHub App installation token response was invalid",
                             stage: "parse", code: "github_app_response", retryable: true)
    end
  end
end
