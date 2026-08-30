require "test_helper"
require "tempfile"

module Broker
  class GithubAppInstallationClientTest < ActiveSupport::TestCase
    CLIENT_ID = "Iv1.0123456789abcdef".freeze
    INSTALLATION_ID = "12345678".freeze
    NOW = Time.utc(2026, 8, 23, 12, 0, 0).freeze

    def with_private_key
      key = OpenSSL::PKey::RSA.generate(2048)
      Tempfile.create([ "github-app", ".pem" ]) do |file|
        file.write(key.to_pem)
        file.flush
        yield file.path, key
      end
    end

    test "mints an installation token with a Client ID JWT issuer" do
      with_private_key do |path, key|
        http = expect_http_call(
          status: 201,
          body: { token: "ghs_installation_token", expires_at: (NOW + 1.hour).iso8601 }.to_json
        ) do |request|
          assert_equal :post, request[:method]
          assert_equal "https://api.github.com/app/installations/#{INSTALLATION_ID}/access_tokens", request[:url]
          assert_equal "application/vnd.github+json", request[:headers]["Accept"]
          assert_equal "centaur-console", request[:headers]["User-Agent"]
          assert_equal "2022-11-28", request[:headers]["X-GitHub-Api-Version"]
          assert_equal 17, request[:timeout]

          jwt = request[:headers].fetch("Authorization").delete_prefix("Bearer ")
          # The injected clock intentionally makes the payload deterministic;
          # validate its signature and claims without comparing it to wall time.
          payload, header = JWT.decode(
            jwt,
            key.public_key,
            true,
            algorithms: [ "RS256" ],
            verify_expiration: false
          )
          assert_equal "RS256", header["alg"]
          assert_equal CLIENT_ID, payload["iss"]
          assert_equal NOW.to_i - GithubAppInstallationClient::JWT_BACKDATE_SECONDS, payload["iat"]
          assert_equal payload["iat"] + GithubAppInstallationClient::JWT_LIFETIME_SECONDS, payload["exp"]
        end

        client = GithubAppInstallationClient.new(
          http: http, private_key_path: path, clock: -> { NOW }
        )
        result = client.refresh(client_id: CLIENT_ID, installation_id: INSTALLATION_ID, timeout: 17)

        http.verify
        assert_equal "ghs_installation_token", result.access_token
        assert_nil result.refresh_token
        assert_equal 3600, result.expires_in
      end
    end

    test "does not call GitHub when the private key is unavailable" do
      client = GithubAppInstallationClient.new(private_key_path: "/missing/github-app.pem", clock: -> { NOW })

      error = assert_raises(RefreshError) do
        client.refresh(client_id: CLIENT_ID, installation_id: INSTALLATION_ID)
      end

      refute error.retryable?
      assert_equal "github_app_private_key", error.code
      assert_equal "configuration", error.stage
    end

    test "treats a rejected installation token request as unrecoverable" do
      with_private_key do |path, _key|
        http = expect_http_call(status: 401, body: { message: "Bad credentials" }.to_json)
        client = GithubAppInstallationClient.new(
          http: http, private_key_path: path, clock: -> { NOW }
        )

        error = assert_raises(RefreshError) do
          client.refresh(client_id: CLIENT_ID, installation_id: INSTALLATION_ID)
        end

        http.verify
        refute error.retryable?
        assert_equal "http_401", error.code
      end
    end

    test "retries GitHub server failures" do
      with_private_key do |path, _key|
        http = expect_http_call(status: 503, body: "temporarily unavailable")
        client = GithubAppInstallationClient.new(
          http: http, private_key_path: path, clock: -> { NOW }
        )

        error = assert_raises(RefreshError) do
          client.refresh(client_id: CLIENT_ID, installation_id: INSTALLATION_ID)
        end

        http.verify
        assert error.retryable?
        assert_equal "http_503", error.code
      end
    end

    test "retries an invalid GitHub response without exposing its body" do
      with_private_key do |path, _key|
        http = expect_http_call(status: 201, body: { token: "ghs_installation_token" }.to_json)
        client = GithubAppInstallationClient.new(
          http: http, private_key_path: path, clock: -> { NOW }
        )

        error = assert_raises(RefreshError) do
          client.refresh(client_id: CLIENT_ID, installation_id: INSTALLATION_ID)
        end

        http.verify
        assert error.retryable?
        assert_equal "github_app_response", error.code
      end
    end
  end
end
