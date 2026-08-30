import { describe, expect, test } from "bun:test";
import { resolveGithubAdapterAuth } from "../src/index";

describe("GitHub authentication", () => {
  test("keeps the existing PAT mode", () => {
    expect(resolveGithubAdapterAuth({ token: " token " })).toEqual({
      token: "token",
    });
  });

  test("accepts a fixed App installation using the recommended Client ID", () => {
    expect(
      resolveGithubAdapterAuth({
        githubAppClientId: "Iv1.example",
        githubAppInstallationId: 123,
        githubAppPrivateKey: " private-key ",
      }),
    ).toEqual({
      appId: "Iv1.example",
      installationId: 123,
      privateKey: "private-key",
    });
  });

  test("rejects mixed PAT and App credentials", () => {
    expect(() =>
      resolveGithubAdapterAuth({
        token: "token",
        githubAppClientId: "Iv1.example",
        githubAppInstallationId: 123,
        githubAppPrivateKey: "private-key",
      }),
    ).toThrow("mutually exclusive");
  });

  test("fails closed for partial or invalid App credentials", () => {
    expect(() =>
      resolveGithubAdapterAuth({ githubAppClientId: "Iv1.example" }),
    ).toThrow("complete GitHub App");
    expect(() =>
      resolveGithubAdapterAuth({
        githubAppClientId: "Iv1.example",
        githubAppInstallationId: 0,
        githubAppPrivateKey: "private-key",
      }),
    ).toThrow("complete GitHub App");
    expect(() => resolveGithubAdapterAuth({})).toThrow(
      "GitHub authentication requires",
    );
  });
});
