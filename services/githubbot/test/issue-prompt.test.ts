import { describe, expect, test } from "bun:test";
import { DEFAULT_ISSUE_PROMPT } from "../src/issue-prompt";

describe("DEFAULT_ISSUE_PROMPT", () => {
  test("resolves and explicitly targets the repository default branch", () => {
    expect(DEFAULT_ISSUE_PROMPT).toContain("gh repo view --json defaultBranchRef");
    expect(DEFAULT_ISSUE_PROMPT).toContain("gh pr create --base");
    expect(DEFAULT_ISSUE_PROMPT).toContain("Do not infer `main`");
  });
});
