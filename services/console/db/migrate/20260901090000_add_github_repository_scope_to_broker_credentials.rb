class AddGithubRepositoryScopeToBrokerCredentials < ActiveRecord::Migration[8.1]
  def change
    # Exact owner/repository names requested when minting a GitHub App
    # installation token. An empty list preserves installation-wide behavior
    # for existing credentials; security-sensitive roles can require a nonempty
    # list in their declarative policy and deployment preflight.
    add_column :broker_credentials, :github_repositories, :jsonb, null: false, default: []
  end
end
