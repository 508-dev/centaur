import { describe, expect, test } from "bun:test";
import {
  resolveBotActorLogin,
  resolveGithubAdapterAuth,
} from "../src/index";
import { positiveIntegerValue } from "../src/utils";

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

describe("GitHub installation ID parsing", () => {
  test("accepts a complete safe positive decimal integer", () => {
    expect(positiveIntegerValue("157611530", "GITHUB_INSTALLATION_ID")).toBe(
      157611530,
    );
  });

  test("rejects prefixes, fractions, scientific notation, and unsafe values", () => {
    for (const value of [
      "123oops",
      "123.5",
      "1e3",
      "0",
      "-1",
      "9007199254740992",
    ]) {
      expect(() =>
        positiveIntegerValue(value, "GITHUB_INSTALLATION_ID"),
      ).toThrow("positive decimal integer");
    }
  });
});

describe("GitHub bot identity", () => {
  test("keeps mention and actor logins separate for Apps", () => {
    expect(
      resolveBotActorLogin(
        { githubAppClientId: "Iv1.example" },
        "centaur-bot",
      ),
    ).toBe("centaur-bot[bot]");
  });

  test("uses the PAT login directly and honors an explicit actor", () => {
    expect(resolveBotActorLogin({}, "centaur-bot")).toBe("centaur-bot");
    expect(
      resolveBotActorLogin(
        {
          botActorLogin: "custom-app[bot]",
          githubAppClientId: "Iv1.example",
        },
        "centaur-bot",
      ),
    ).toBe("custom-app[bot]");
  });

  test("rejects a suffixed App mention slug or unsuffixed actor login", () => {
    expect(() =>
      resolveBotActorLogin(
        { githubAppClientId: "Iv1.example" },
        "centaur-bot[bot]",
      ),
    ).toThrow("mention slug without the [bot] suffix");
    expect(() =>
      resolveBotActorLogin(
        {
          botActorLogin: "centaur-bot",
          githubAppClientId: "Iv1.example",
        },
        "centaur-bot",
      ),
    ).toThrow("botActorLogin must end in [bot]");
  });
});
