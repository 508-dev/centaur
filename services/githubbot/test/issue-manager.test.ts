import { describe, expect, test } from "bun:test";
import {
  assigneeLogins,
  isAssignedToBot,
  isIssueOwned,
  isIssueWorkSignal,
  issueWorkThreadKey,
  labelNames,
} from "../src/issue-manager";

describe("isAssignedToBot", () => {
  test("true when the bot is among the assignees (case-insensitive)", () => {
    expect(isAssignedToBot(["someone", "Centaur-Bot"], "centaur-bot")).toBe(
      true,
    );
  });

  test("false when the bot is not an assignee", () => {
    expect(isAssignedToBot(["someone"], "centaur-bot")).toBe(false);
  });

  test("false with no assignees", () => {
    expect(isAssignedToBot([], "centaur-bot")).toBe(false);
  });
});

describe("assigneeLogins", () => {
  test("extracts logins, skipping malformed entries", () => {
    expect(
      assigneeLogins([
        { login: "alice" },
        null,
        {},
        { login: "" },
        { login: "bob" },
      ]),
    ).toEqual(["alice", "bob"]);
  });

  test("returns [] for non-array input", () => {
    expect(assigneeLogins(undefined)).toEqual([]);
    expect(assigneeLogins(null)).toEqual([]);
    expect(assigneeLogins("nope")).toEqual([]);
  });
});

describe("App-compatible issue ownership", () => {
  test("recognizes the configured label case-insensitively", () => {
    expect(
      isIssueOwned({
        assignees: [],
        labels: ["Centaur-Managed"],
        ownershipLabel: "centaur-managed",
        userName: "centaur-bot",
      }),
    ).toBe(true);
  });

  test("only a matching labeled event starts label-based work", () => {
    const base = {
      assignees: [] as string[],
      labels: ["centaur-managed"],
      ownershipLabel: "centaur-managed",
      userName: "centaur-bot",
    };
    expect(
      isIssueWorkSignal({
        ...base,
        action: "labeled",
        eventLabel: "Centaur-Managed",
      }),
    ).toBe(true);
    expect(
      isIssueWorkSignal({ ...base, action: "opened", eventLabel: "centaur-managed" }),
    ).toBe(false);
    expect(
      isIssueWorkSignal({ ...base, action: "labeled", eventLabel: "bug" }),
    ).toBe(false);
  });

  test("retains PAT assignment as an explicit work signal", () => {
    expect(
      isIssueWorkSignal({
        action: "assigned",
        assignees: ["Centaur-Bot"],
        labels: [],
        userName: "centaur-bot",
      }),
    ).toBe(true);
  });

  test("does not treat an App mention slug as an assignable account", () => {
    expect(
      isIssueWorkSignal({
        action: "assigned",
        assignees: ["centaur-bot"],
        botActorLogin: "centaur-bot[bot]",
        labels: [],
        userName: "centaur-bot",
      }),
    ).toBe(false);
  });
});

describe("labelNames", () => {
  test("accepts GitHub's string and object label shapes", () => {
    expect(labelNames(["bug", { name: "centaur-managed" }, null, {}])).toEqual([
      "bug",
      "centaur-managed",
    ]);
  });
});

describe("issueWorkThreadKey", () => {
  test("builds the isolated work-session key", () => {
    expect(issueWorkThreadKey("0xSplits", "centaur", 7)).toBe(
      "github-issue:0xSplits/centaur:7",
    );
  });
});
