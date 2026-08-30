class AddGithubAppInstallationToBrokerCredentials < ActiveRecord::Migration[8.1]
  def change
    # The App client ID is already stored in client_id. The numeric installation
    # ID is public configuration; the App PEM stays in a read-only worker mount.
    add_column :broker_credentials, :github_installation_id, :string
  end
end
