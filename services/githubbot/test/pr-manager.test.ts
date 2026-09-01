import { describe, expect, test } from "bun:test";
import { drainBackgroundWork } from "../src/context";
import {
  decideMerge,
  handleCiEvent,
  handlePullRequestEvent,
  handleReviewFindingDispositionComment,
  handleReviewEvent,
  isBotAssignmentHandoff,
  isOwnedPr,
  type PrManagerContext,
} from "../src/pr-manager";
import { emitWorkflowEvent } from "../src/session-api";
import {
  evaluateCi,
  fetchCiEvaluation,
  type CiCheck,
} from "../src/workflow-events";

function makeState() {
  const values = new Map<string, unknown>();
  return {
    async get(key: string) {
      return values.get(key);
    },
    async set(key: string, value: unknown) {
      values.set(key, value);
    },
    async setIfNotExists(key: string, value: unknown) {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

function prPayload(input: {
  assignees?: { login: string }[];
  headRepoFullName: string;
  headSha?: string;
  mergeableState?: string;
  number?: number;
}) {
  return {
    assignees: input.assignees ?? [{ login: "centaur-bot" }],
    draft: false,
    head: {
      ref: "feature",
      repo: { full_name: input.headRepoFullName },
      sha: input.headSha ?? "abc123",
    },
    labels: [],
    mergeable_state: input.mergeableState ?? "clean",
    merged: false,
    number: input.number ?? 7,
    state: "open",
    title: "Test PR",
  };
}

describe("evaluateCi", () => {
  test("not settled while any check is in progress", () => {
    const checks: CiCheck[] = [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "in_progress", conclusion: null },
    ];
    expect(evaluateCi(checks, [])).toMatchObject({ settled: false });
  });

  test("settled + green when all checks succeed", () => {
    const checks: CiCheck[] = [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "skipped" },
    ];
    expect(evaluateCi(checks, [])).toEqual({
      settled: true,
      failed: false,
      failingNames: [],
    });
  });

  test("settled + red, collecting failing names from checks and statuses", () => {
    const checks: CiCheck[] = [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "failure" },
      { name: "e2e", status: "completed", conclusion: "timed_out" },
    ];
    const result = evaluateCi(checks, [
      { state: "success", context: "coverage" },
      { state: "error", context: "deploy-preview" },
    ]);
    expect(result.settled).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.failingNames.sort()).toEqual(["deploy-preview", "e2e", "lint"]);
  });

  test("pending legacy status keeps it unsettled", () => {
    const result = evaluateCi(
      [{ name: "build", status: "completed", conclusion: "success" }],
      [{ state: "pending", context: "deploy" }],
    );
    expect(result.settled).toBe(false);
  });
});

describe("isOwnedPr", () => {
  test("owned when the bot is an assignee (case-insensitive)", () => {
    expect(
      isOwnedPr({
        assignees: ["someone-else", "Centaur-Bot"],
        userName: "centaur-bot",
      }),
    ).toBe(true);
  });

  test("not owned when the bot is not an assignee", () => {
    expect(
      isOwnedPr({
        assignees: ["someone-else"],
        userName: "centaur-bot",
      }),
    ).toBe(false);
  });

  test("not owned when there are no assignees", () => {
    expect(isOwnedPr({ assignees: [], userName: "centaur-bot" })).toBe(false);
  });

  test("owned when an App-authored PR uses the separate bot actor login", () => {
    expect(
      isOwnedPr({
        assignees: [],
        author: "centaur-bot[bot]",
        botActorLogin: "centaur-bot[bot]",
        userName: "centaur-bot",
      }),
    ).toBe(true);
  });

  test("does not confuse an App mention slug with its actor login", () => {
    expect(
      isOwnedPr({
        assignees: [],
        author: "centaur-bot",
        botActorLogin: "centaur-bot[bot]",
        userName: "centaur-bot",
      }),
    ).toBe(false);
  });

  test("does not treat an App mention slug as an assignable account", () => {
    expect(
      isOwnedPr({
        assignees: ["centaur-bot"],
        botActorLogin: "centaur-bot[bot]",
        userName: "centaur-bot",
      }),
    ).toBe(false);
  });

  test("owned when the configured handoff label is present", () => {
    expect(
      isOwnedPr({
        assignees: [],
        labels: ["bug", "Centaur-Managed"],
        ownershipLabel: "centaur-managed",
        userName: "centaur-bot",
      }),
    ).toBe(true);
  });
});

describe("isBotAssignmentHandoff", () => {
  test("accepts only an assignment of the PAT bot itself", () => {
    expect(
      isBotAssignmentHandoff({
        action: "assigned",
        assignee: "Centaur-Bot",
        userName: "centaur-bot",
      }),
    ).toBe(true);
    expect(
      isBotAssignmentHandoff({
        action: "assigned",
        assignee: "alice",
        userName: "centaur-bot",
      }),
    ).toBe(false);
  });

  test("does not treat assignments as App-mode handoffs", () => {
    expect(
      isBotAssignmentHandoff({
        action: "assigned",
        assignee: "centaur-bot",
        botActorLogin: "centaur-bot[bot]",
        userName: "centaur-bot",
      }),
    ).toBe(false);
  });
});

describe("decideMerge", () => {
  const base = {
    autoMerge: true,
    draft: false,
    holdLabel: "do-not-merge",
    labels: [] as string[],
    merged: false,
    mergeableState: "clean",
    state: "open",
  };

  test("merges a clean, open, non-draft PR", () => {
    expect(decideMerge(base)).toBe("merge");
  });

  test("respects the global disable switch", () => {
    expect(decideMerge({ ...base, autoMerge: false })).toBe("skip_disabled");
  });

  test("respects the per-PR hold label (case-insensitive)", () => {
    expect(decideMerge({ ...base, labels: ["Do-Not-Merge"] })).toBe("skip_hold");
  });

  test("does not merge drafts or closed/merged PRs", () => {
    expect(decideMerge({ ...base, draft: true })).toBe("skip_draft");
    expect(decideMerge({ ...base, merged: true })).toBe("skip_closed");
    expect(decideMerge({ ...base, state: "closed" })).toBe("skip_closed");
  });

  test("routes dirty -> conflict and behind -> update", () => {
    expect(decideMerge({ ...base, mergeableState: "dirty" })).toBe("resolve_conflict");
    expect(decideMerge({ ...base, mergeableState: "behind" })).toBe("update_branch");
  });

  test("waits on blocked/unstable/unknown states", () => {
    expect(decideMerge({ ...base, mergeableState: "blocked" })).toBe("wait");
    expect(decideMerge({ ...base, mergeableState: "unstable" })).toBe("wait");
    expect(decideMerge({ ...base, mergeableState: "unknown" })).toBe("wait");
  });
});

describe("PR management webhooks", () => {
  test("does not delete a base-repo branch after merging a fork PR", async () => {
    let deleteRefCalls = 0;
    let mergeCalls = 0;
    const ctx = {
      octokit: {
        rest: {
          pulls: {
            get: async () => ({
              data: prPayload({ headRepoFullName: "contributor/repo" }),
            }),
            merge: async () => {
              mergeCalls += 1;
              return { data: {} };
            },
          },
          git: {
            deleteRef: async () => {
              deleteRefCalls += 1;
              return { data: {} };
            },
          },
        },
      },
      options: {
        apiUrl: "http://localhost",
        logger: { debug() {}, warn() {}, error() {}, info() {} },
      },
      state: makeState(),
      userName: "centaur-bot",
    } as unknown as PrManagerContext;

    await handleReviewEvent(
      ctx,
      JSON.stringify({
        action: "submitted",
        repository: { full_name: "base/repo" },
        pull_request: { number: 7 },
        review: {
          author_association: "COLLABORATOR",
          id: 123,
          state: "approved",
          user: { login: "reviewer" },
        },
      }),
    );

    expect(mergeCalls).toBe(1);
    expect(deleteRefCalls).toBe(0);
  });

  test("routes legacy status webhooks through associated PRs", async () => {
    let associatedCommitSha: string | undefined;
    let mergeCalls = 0;
    const ctx = {
      octokit: {
        graphql: async () => ({
          repository: {
            object: {
              statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } },
            },
          },
        }),
        rest: {
          pulls: {
            get: async () => ({
              data: prPayload({
                headRepoFullName: "base/repo",
                headSha: "abc123",
              }),
            }),
            merge: async () => {
              mergeCalls += 1;
              return { data: {} };
            },
          },
          repos: {
            listPullRequestsAssociatedWithCommit: async (input: {
              commit_sha: string;
            }) => {
              associatedCommitSha = input.commit_sha;
              return { data: [{ number: 7 }] };
            },
          },
          git: {
            deleteRef: async () => ({ data: {} }),
          },
        },
      },
      options: {
        apiUrl: "http://localhost",
        deleteBranchOnMerge: false,
        logger: { debug() {}, warn() {}, error() {}, info() {} },
      },
      state: makeState(),
      userName: "centaur-bot",
    } as unknown as PrManagerContext;

    await handleCiEvent(
      ctx,
      "status",
      JSON.stringify({
        repository: { full_name: "base/repo" },
        sha: "abc123",
        state: "success",
      }),
    );

    expect(associatedCommitSha).toBe("abc123");
    expect(mergeCalls).toBe(1);
  });
});

const approvedReview = (reviewId: number) =>
  JSON.stringify({
    action: "submitted",
    repository: { full_name: "base/repo" },
    pull_request: { number: 7 },
    review: {
      author_association: "COLLABORATOR",
      id: reviewId,
      state: "approved",
      user: { login: "reviewer" },
    },
  });

const quietLogger = { debug() {}, warn() {}, error() {}, info() {} };

describe("merge claim lifecycle", () => {
  function mergeCtx(merge: () => Promise<unknown>) {
    return {
      octokit: {
        rest: {
          pulls: {
            get: async () => ({
              data: prPayload({ headRepoFullName: "base/repo" }),
            }),
            merge,
          },
          git: { deleteRef: async () => ({ data: {} }) },
        },
      },
      options: {
        apiUrl: "http://localhost",
        deleteBranchOnMerge: false,
        logger: quietLogger,
      },
      state: makeState(),
      userName: "centaur-bot",
    } as unknown as PrManagerContext;
  }

  test("releases the claim when merge fails, so a later event retries", async () => {
    let mergeCalls = 0;
    const ctx = mergeCtx(async () => {
      mergeCalls += 1;
      if (mergeCalls === 1) throw new Error("Base branch was modified");
      return { data: {} };
    });
    await handleReviewEvent(ctx, approvedReview(1));
    await handleReviewEvent(ctx, approvedReview(2));
    expect(mergeCalls).toBe(2);
  });

  test("keeps the claim on success, so the same head sha is not re-merged", async () => {
    let mergeCalls = 0;
    const ctx = mergeCtx(async () => {
      mergeCalls += 1;
      return { data: {} };
    });
    await handleReviewEvent(ctx, approvedReview(1));
    await handleReviewEvent(ctx, approvedReview(2));
    expect(mergeCalls).toBe(1);
  });
});

describe("CI fix counter and escalation", () => {
  const redCheckRun = JSON.stringify({
    repository: { full_name: "base/repo" },
    check_run: { head_sha: "abc123", pull_requests: [{ number: 7 }] },
  });

  function ciCtx(
    state: ReturnType<typeof makeState>,
    comments: string[],
  ): PrManagerContext {
    return {
      octokit: {
        graphql: async () => ({
          repository: {
            object: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "build",
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                    },
                  ],
                },
              },
            },
          },
        }),
        rest: {
          repos: {
            getCommit: async () => ({
              data: { author: { login: "centaur-bot" } },
            }),
          },
          pulls: {
            get: async () => ({
              data: prPayload({ headRepoFullName: "base/repo" }),
            }),
          },
          issues: {
            createComment: async (input: { body: string }) => {
              comments.push(input.body);
              return { data: {} };
            },
          },
        },
      },
      options: {
        apiUrl: "http://localhost",
        ciFixMaxAttempts: 3,
        escalationHandle: "maintainer",
        logger: quietLogger,
        // Non-retryable so the backgrounded fix turn settles off the network.
        fetch: () => Promise.resolve(new Response("no", { status: 400 })),
      },
      state,
      userName: "centaur-bot",
    } as unknown as PrManagerContext;
  }

  test("increments the consecutive-fix counter below the cap", async () => {
    const state = makeState();
    await handleCiEvent(ciCtx(state, []), "check_run", redCheckRun);
    expect(await state.get("centaur-githubbot:pr:base/repo#7")).toMatchObject({
      consecutiveCiFixes: 1,
    });
  });

  test("escalates and fires no fix turn once the cap is reached", async () => {
    const state = makeState();
    await state.set("centaur-githubbot:pr:base/repo#7", {
      consecutiveCiFixes: 3,
    });
    const comments: string[] = [];
    await handleCiEvent(ciCtx(state, comments), "check_run", redCheckRun);
    expect(comments.length).toBe(1);
    expect(comments[0]).toContain("@maintainer");
    // The counter is not bumped past the cap.
    expect(await state.get("centaur-githubbot:pr:base/repo#7")).toMatchObject({
      consecutiveCiFixes: 3,
    });
  });
});

describe("bounded review epochs", () => {
  const submittedReview = (
    reviewId: number,
    headSha: string,
    reviewer: { id: number; login: string } = {
      id: 101,
      login: "reviewer",
    },
    authorAssociation = "COLLABORATOR",
  ) =>
    JSON.stringify({
      action: "submitted",
      repository: { full_name: "base/repo" },
      pull_request: { head: { sha: headSha }, number: 7 },
      review: {
        author_association: authorAssociation,
        commit_id: headSha,
        id: reviewId,
        state: "commented",
        user: reviewer,
      },
    });

  function budgetCtx(input?: {
    actor?: "bot" | "human";
    comparisonCommitMessage?: string | (() => string);
    comparisonFile?: string;
    comments?: string[];
    headSha?: string;
    merges?: { count: number };
    maxRoundsPerEpoch?: number;
    maxTotalRoundsPerEpoch?: number;
    permission?: string;
    removedLabels?: string[];
    reviewAuthorAllowlist?: string[];
    reviewFindings?: Record<
      number,
      Array<{
        body: string;
        diff_hunk?: string;
        id: number;
        line?: number;
        path?: string;
      }>
    >;
    state?: ReturnType<typeof makeState>;
  }): PrManagerContext {
    let headSha = input?.headSha ?? "head-1";
    const actor = input?.actor ?? "bot";
    const comments = input?.comments ?? [];
    const removedLabels = input?.removedLabels ?? [];
    const ctx = {
      octokit: {
        rest: {
          issues: {
            createComment: async (request: { body: string }) => {
              comments.push(request.body);
              return { data: {} };
            },
            removeLabel: async (request: { name: string }) => {
              removedLabels.push(request.name);
              return { data: {} };
            },
          },
          pulls: {
            get: async () => ({
              data: prPayload({
                headRepoFullName: "base/repo",
                headSha,
              }),
            }),
            merge: async () => {
              if (input?.merges) input.merges.count += 1;
              return { data: {} };
            },
            listCommentsForReview: async (request: { review_id: number }) => ({
              data: input?.reviewFindings?.[request.review_id] ?? [
                {
                  body: `finding-${request.review_id}`,
                  diff_hunk: "@@ -1 +1 @@\n-old\n+new",
                  id: request.review_id * 10,
                  line: 10,
                  path: "src/implementation.ts",
                },
              ],
            }),
          },
          repos: {
            compareCommitsWithBasehead: async (request: {
              basehead: string;
            }) => {
              headSha = request.basehead.split("...").at(-1) ?? headSha;
              return {
                data: {
                  commits: [
                    {
                      author:
                        actor === "bot"
                          ? { login: "centaur-bot", type: "Bot" }
                          : { login: "alice", type: "User" },
                      commit: {
                        message:
                          typeof input?.comparisonCommitMessage === "function"
                            ? input.comparisonCommitMessage()
                            : input?.comparisonCommitMessage ??
                              (actor === "bot"
                                ? "fix review\n\nCentaur-Automation: true"
                                : "revise implementation"),
                      },
                    },
                  ],
                  files: [
                    {
                      additions: 5,
                      changes: 5,
                      deletions: 0,
                      filename: input?.comparisonFile ?? "src/implementation.ts",
                      status: "modified",
                    },
                  ],
                  status: "ahead",
                  total_commits: 1,
                },
              };
            },
            getCollaboratorPermissionLevel: async () => ({
              data: { permission: input?.permission ?? "write" },
            }),
          },
        },
      },
      options: {
        apiUrl: "http://localhost",
        deleteBranchOnMerge: false,
        escalationHandle: "maintainer",
        fetch: () => Promise.resolve(new Response("no", { status: 400 })),
        logger: quietLogger,
        reviewMaxRoundsPerEpoch: input?.maxRoundsPerEpoch,
        reviewMaxTotalRoundsPerEpoch: input?.maxTotalRoundsPerEpoch,
        reviewAuthorAllowlist: input?.reviewAuthorAllowlist,
      },
      state: input?.state ?? makeState(),
      userName: "centaur-bot",
    } as unknown as PrManagerContext;
    Object.defineProperty(ctx, "setHeadSha", {
      value: (value: string) => {
        headSha = value;
      },
    });
    return ctx;
  }

  function setHeadSha(ctx: PrManagerContext, headSha: string): void {
    (ctx as PrManagerContext & { setHeadSha(value: string): void }).setHeadSha(
      headSha,
    );
  }

  test("denies an untrusted public reviewer before claiming work", async () => {
    const durableState = makeState();
    let claimAttempts = 0;
    const state = {
      ...durableState,
      async setIfNotExists(key: string, value: unknown) {
        claimAttempts += 1;
        return durableState.setIfNotExists(key, value);
      },
    };
    const ctx = budgetCtx({ state });

    await handleReviewEvent(
      ctx,
      submittedReview(
        30,
        "head-1",
        { id: 999, login: "public-user" },
        "NONE",
      ),
    );

    expect(claimAttempts).toBe(0);
    expect(
      await durableState.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toBeUndefined();
  });

  test("admits an exact allowlisted reviewer bot", async () => {
    const state = makeState();
    const ctx = budgetCtx({
      reviewAuthorAllowlist: ["trusted-reviewer[bot]"],
      state,
    });

    await handleReviewEvent(
      ctx,
      submittedReview(
        31,
        "head-1",
        { id: 998, login: "trusted-reviewer[bot]" },
        "NONE",
      ),
    );
    await drainBackgroundWork(5_000);

    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({ roundsUsed: 1 });
  });

  test("does not spend another round rediscovering an evidence-rejected finding", async () => {
    const state = makeState();
    const sharedFinding = {
      body: "The repository allowlist is not checked before token minting.",
      diff_hunk: "@@ -1 +1 @@\n-unchecked\n+checked",
      line: 20,
      path: "src/policy.ts",
    };
    const ctx = budgetCtx({
      reviewFindings: {
        40: [{ ...sharedFinding, id: 400 }],
        41: [{ ...sharedFinding, id: 410, line: 25 }],
      },
      state,
    });

    await handleReviewEvent(ctx, submittedReview(40, "head-1"));
    const initial = (await state.get(
      "centaur-githubbot:review-budget:base/repo#7",
    )) as { findingLedger: Record<string, unknown>; roundsUsed: number };
    const fingerprint = Object.keys(initial.findingLedger)[0];
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    if (!fingerprint) throw new Error("missing finding fingerprint");

    expect(
      await handleReviewFindingDispositionComment(
        ctx,
        JSON.stringify({
          action: "created",
          comment: {
            body:
              "Centaur-Finding-Evidence: repository-token broker middleware rejects every unlisted repository ID.\n\n" +
              `<!-- centaur-review-finding ${fingerprint} review:40 rejected -->`,
            id: 401,
            in_reply_to_id: 400,
            user: { login: "centaur-bot" },
          },
          pull_request: { number: 7 },
          repository: { full_name: "base/repo" },
        }),
      ),
    ).toBe(true);

    await handleReviewEvent(
      ctx,
      submittedReview(41, "head-1", {
        id: 202,
        login: "second-reviewer",
      }),
    );
    await drainBackgroundWork(5_000);

    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      findingLedger: {
        [fingerprint]: {
          disposition: "rejected",
          dispositionCommentId: 401,
        },
      },
      reviewerRoundsUsed: { "github-user:101": 1 },
      roundsUsed: 1,
    });
  });

  test("ignores an accepted marker until a descendant repair is proven", async () => {
    const state = makeState();
    const ctx = budgetCtx({ state });
    await handleReviewEvent(ctx, submittedReview(42, "head-1"));
    const initial = (await state.get(
      "centaur-githubbot:review-budget:base/repo#7",
    )) as { findingLedger: Record<string, { disposition: string }> };
    const fingerprint = Object.keys(initial.findingLedger)[0];
    if (!fingerprint) throw new Error("missing finding fingerprint");

    expect(
      await handleReviewFindingDispositionComment(
        ctx,
        JSON.stringify({
          action: "created",
          comment: {
            body: `<!-- centaur-review-finding ${fingerprint} review:42 accepted -->`,
            id: 421,
            in_reply_to_id: 420,
            user: { login: "centaur-bot" },
          },
          pull_request: { number: 7 },
          repository: { full_name: "base/repo" },
        }),
      ),
    ).toBe(true);
    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      findingLedger: { [fingerprint]: { disposition: "pending" } },
    });
  });

  test("accepts a finding only after an exact-path repair with its trailer", async () => {
    const state = makeState();
    let fingerprint = "";
    const ctx = budgetCtx({
      comparisonCommitMessage: () =>
        `fix review\n\nCentaur-Automation: true\nCentaur-Review-Finding: ${fingerprint}`,
      comparisonFile: "src/implementation.ts",
      state,
    });
    await handleReviewEvent(ctx, submittedReview(43, "head-1"));
    const initial = (await state.get(
      "centaur-githubbot:review-budget:base/repo#7",
    )) as { findingLedger: Record<string, { disposition: string }> };
    fingerprint = Object.keys(initial.findingLedger)[0] ?? "";
    if (!fingerprint) throw new Error("missing finding fingerprint");
    setHeadSha(ctx, "head-2");

    await handleReviewFindingDispositionComment(
      ctx,
      JSON.stringify({
        action: "created",
        comment: {
          body: `<!-- centaur-review-finding ${fingerprint} review:43 accepted -->`,
          id: 431,
          in_reply_to_id: 430,
          user: { login: "centaur-bot" },
        },
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
      }),
    );

    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      findingLedger: {
        [fingerprint]: {
          disposition: "accepted",
          dispositionCommentId: 431,
        },
      },
    });
  });

  test("admits the final review round but pauses merge before its descendant", async () => {
    const comments: string[] = [];
    const merges = { count: 0 };
    const state = makeState();
    const ctx = budgetCtx({ comments, merges, state });

    await handleReviewEvent(ctx, submittedReview(1, "head-1"));
    await handleReviewEvent(ctx, submittedReview(2, "head-1"));
    setHeadSha(ctx, "head-2");
    await handleReviewEvent(ctx, submittedReview(3, "head-2"));
    setHeadSha(ctx, "head-3");
    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "synchronize",
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
      }),
      "post-final-round-push",
    );
    await drainBackgroundWork(5_000);

    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      epoch: 1,
      lastReviewedHeadSha: "head-2",
      pausedHeadSha: "head-2",
      pauseReason: "reviewer_round_budget_exhausted",
      reviewerRoundsUsed: { "github-user:101": 3 },
      roundsUsed: 3,
    });
    expect(merges.count).toBe(0);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("round_budget_exhausted");
    expect(comments[0]).toContain("centaur-review-reset");
  });

  test("stores an active handoff pause without expiration", async () => {
    const durableState = makeState();
    await durableState.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-1",
      epoch: 1,
      lastReviewedHeadSha: "head-1",
      reviewerRoundsUsed: { "github-user:101": 2 },
      roundsUsed: 2,
      version: 1,
    });
    const budgetTtls: Array<number | undefined> = [];
    const state = {
      ...durableState,
      async set(key: string, value: unknown, ttlMs?: number) {
        if (key.includes(":review-budget:")) budgetTtls.push(ttlMs);
        await durableState.set(key, value);
      },
    };
    const ctx = budgetCtx({ state });

    await handleReviewEvent(ctx, submittedReview(32, "head-1"));
    await drainBackgroundWork(5_000);

    expect(budgetTtls).toEqual([undefined]);
    expect(
      await durableState.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({ pausedHeadSha: "head-1" });
  });

  test("separates reviewer budgets while enforcing the epoch aggregate cap", async () => {
    const comments: string[] = [];
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-3",
      epoch: 1,
      lastReviewedHeadSha: "head-3",
      pausedHeadSha: "head-3",
      pauseReason: "reviewer_round_budget_exhausted",
      reviewerRoundsUsed: { "github-user:101": 3 },
      roundsUsed: 3,
      version: 1,
    });
    const ctx = budgetCtx({
      comments,
      headSha: "head-4",
      maxTotalRoundsPerEpoch: 4,
      state,
    });

    await handleReviewEvent(
      ctx,
      submittedReview(18, "head-4", {
        id: 202,
        login: "second-reviewer[bot]",
      }),
    );
    await handleReviewEvent(
      ctx,
      submittedReview(19, "head-4", {
        id: 303,
        login: "third-reviewer[bot]",
      }),
    );
    await drainBackgroundWork(5_000);

    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      pausedHeadSha: "head-4",
      pauseReason: "aggregate_round_budget_exhausted",
      reviewerRoundsUsed: {
        "github-user:101": 3,
        "github-user:202": 1,
      },
      roundsUsed: 4,
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("reviewer round 1/3");
    expect(comments[0]).toContain("epoch total 4/4");
  });

  test("keeps a reviewer budget stable across login changes", async () => {
    const state = makeState();
    const ctx = budgetCtx({ state });

    await handleReviewEvent(
      ctx,
      submittedReview(20, "head-1", { id: 404, login: "old-name[bot]" }),
    );
    await handleReviewEvent(
      ctx,
      submittedReview(21, "head-1", { id: 404, login: "new-name[bot]" }),
    );
    await drainBackgroundWork(5_000);

    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      reviewerRoundsUsed: { "github-user:404": 2 },
      roundsUsed: 2,
    });
  });

  test("retries a transient durable review-claim failure", async () => {
    const durableState = makeState();
    let reviewClaimAttempts = 0;
    const state = {
      ...durableState,
      async setIfNotExists(key: string, value: unknown) {
        if (key.includes(":review-handled:")) {
          reviewClaimAttempts += 1;
          if (reviewClaimAttempts === 1) {
            throw new Error("temporary Postgres interruption");
          }
        }
        return durableState.setIfNotExists(key, value);
      },
    };
    const ctx = budgetCtx({ state });

    await handleReviewEvent(ctx, submittedReview(5, "head-1"));
    await drainBackgroundWork(5_000);

    expect(reviewClaimAttempts).toBe(2);
    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({ epoch: 1, roundsUsed: 1 });
  });

  test("retries a transient budget read after claiming a review", async () => {
    const durableState = makeState();
    let budgetReadAttempts = 0;
    const state = {
      ...durableState,
      async get(key: string) {
        if (key.includes(":review-budget:")) {
          budgetReadAttempts += 1;
          if (budgetReadAttempts === 1) {
            throw new Error("temporary Postgres interruption");
          }
        }
        return durableState.get(key);
      },
    };
    const ctx = budgetCtx({ state });

    await handleReviewEvent(ctx, submittedReview(6, "head-1"));
    await drainBackgroundWork(5_000);

    expect(budgetReadAttempts).toBe(2);
    expect(
      await durableState.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({ epoch: 1, roundsUsed: 1 });
  });

  test("retries a transient budget write after claiming a review", async () => {
    const durableState = makeState();
    let budgetWriteAttempts = 0;
    const state = {
      ...durableState,
      async set(key: string, value: unknown) {
        if (key.includes(":review-budget:")) {
          budgetWriteAttempts += 1;
          if (budgetWriteAttempts === 1) {
            throw new Error("temporary Postgres interruption");
          }
        }
        await durableState.set(key, value);
      },
    };
    const ctx = budgetCtx({ state });

    await handleReviewEvent(ctx, submittedReview(7, "head-1"));
    await drainBackgroundWork(5_000);

    expect(budgetWriteAttempts).toBe(2);
    expect(
      await durableState.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({ epoch: 1, roundsUsed: 1 });
  });

  test("starts a new epoch for a material human-authored change", async () => {
    const state = makeState();
    const ctx = budgetCtx({
      actor: "human",
      comparisonFile: "src/authorization.ts",
      state,
    });
    await handleReviewEvent(ctx, submittedReview(1, "head-1"));
    setHeadSha(ctx, "head-2");
    await handleReviewEvent(ctx, submittedReview(2, "head-2"));
    await drainBackgroundWork(5_000);

    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      anchorHeadSha: "head-2",
      epoch: 2,
      roundsUsed: 1,
    });
  });

  test("uses the latest reviewed range for risk and authorship", async () => {
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-2",
      epoch: 1,
      lastReviewedHeadSha: "head-2",
      roundsUsed: 2,
      version: 1,
    });
    const ctx = budgetCtx({ headSha: "head-3", state });
    const compared: string[] = [];
    ctx.octokit.rest.repos.compareCommitsWithBasehead = (async (request: {
      basehead: string;
    }) => {
      compared.push(request.basehead);
      const latestRange = request.basehead === "head-2...head-3";
      const humanCommit = {
        author: { login: "alice", type: "User" },
        commit: { message: "material human revision" },
      };
      return {
        data: {
          commits: latestRange
            ? [humanCommit]
            : [
                {
                  author: { login: "centaur-bot", type: "Bot" },
                  commit: {
                    message: "review fix\n\nCentaur-Automation: true",
                  },
                },
                humanCommit,
              ],
          files: [
            {
              additions: 5,
              changes: 5,
              deletions: 0,
              filename: "src/authorization.ts",
              status: "modified",
            },
          ],
          status: "ahead",
          total_commits: latestRange ? 1 : 2,
        },
      };
    }) as unknown as typeof ctx.octokit.rest.repos.compareCommitsWithBasehead;

    await handleReviewEvent(ctx, submittedReview(8, "head-3"));
    await drainBackgroundWork(5_000);

    expect(compared).toEqual(["head-2...head-3"]);
    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({ anchorHeadSha: "head-3", epoch: 2, roundsUsed: 1 });
  });

  test("records an approved repair head before later authorship checks", async () => {
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-1",
      epoch: 1,
      lastReviewedHeadSha: "head-1",
      reviewerRoundsUsed: { "github-user:101": 1 },
      roundsUsed: 1,
      version: 1,
    });
    const ctx = budgetCtx({ headSha: "head-2", state });
    const compared: string[] = [];
    ctx.octokit.rest.repos.compareCommitsWithBasehead = (async (request: {
      basehead: string;
    }) => {
      compared.push(request.basehead);
      const latestRange = request.basehead === "head-2...head-3";
      const humanCommit = {
        author: { login: "alice", type: "User" },
        commit: { message: "material human revision" },
      };
      return {
        data: {
          commits: latestRange
            ? [humanCommit]
            : [
                {
                  author: { login: "centaur-bot", type: "Bot" },
                  commit: {
                    message: "review fix\n\nCentaur-Automation: true",
                  },
                },
                humanCommit,
              ],
          files: [
            {
              additions: 5,
              changes: 5,
              deletions: 0,
              filename: "src/authorization.ts",
              status: "modified",
            },
          ],
          status: "ahead",
          total_commits: latestRange ? 1 : 2,
        },
      };
    }) as unknown as typeof ctx.octokit.rest.repos.compareCommitsWithBasehead;

    await handleReviewEvent(
      ctx,
      JSON.stringify({
        action: "submitted",
        pull_request: { head: { sha: "head-2" }, number: 7 },
        repository: { full_name: "base/repo" },
        review: {
          author_association: "COLLABORATOR",
          commit_id: "head-2",
          id: 33,
          state: "approved",
          user: { id: 101, login: "reviewer" },
        },
      }),
    );
    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({ lastReviewedHeadSha: "head-2" });

    setHeadSha(ctx, "head-3");
    await handleReviewEvent(ctx, submittedReview(34, "head-3"));
    await drainBackgroundWork(5_000);

    expect(compared).toEqual(["head-2...head-3"]);
    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({ anchorHeadSha: "head-3", epoch: 2, roundsUsed: 1 });
  });

  test("serializes merge evaluation behind an in-flight review admission", async () => {
    const merges = { count: 0 };
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-1",
      epoch: 1,
      lastReviewedHeadSha: "head-1",
      roundsUsed: 3,
      version: 1,
    });
    const ctx = budgetCtx({ headSha: "head-2", merges, state });
    const originalCompare =
      ctx.octokit.rest.repos.compareCommitsWithBasehead;
    let comparisonStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      comparisonStarted = resolve;
    });
    let releaseComparison!: () => void;
    const comparisonGate = new Promise<void>((resolve) => {
      releaseComparison = resolve;
    });
    ctx.octokit.rest.repos.compareCommitsWithBasehead = (async (request: {
      basehead: string;
    }) => {
      comparisonStarted();
      await comparisonGate;
      return originalCompare(request as never);
    }) as unknown as typeof ctx.octokit.rest.repos.compareCommitsWithBasehead;

    const review = handleReviewEvent(ctx, submittedReview(9, "head-2"));
    await started;
    const lifecycle = handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "synchronize",
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
      }),
      "sync-delivery",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(merges.count).toBe(0);

    releaseComparison();
    await Promise.all([review, lifecycle]);
    await drainBackgroundWork(5_000);
    expect(merges.count).toBe(0);
    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      pausedHeadSha: "head-2",
      pauseReason: "automation_material_change_requires_reset",
    });
  });

  test("consumes a write-authorized human reset for a bot-authored material change", async () => {
    const removedLabels: string[] = [];
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-3",
      epoch: 3,
      lastReviewedHeadSha: "head-3",
      pausedHeadSha: "head-4",
      pauseReason: "automation_material_change_requires_reset",
      roundsUsed: 3,
      version: 1,
    });
    const ctx = budgetCtx({
      comparisonFile: "src/authorization.ts",
      headSha: "head-4",
      removedLabels,
      state,
    });
    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "labeled",
        label: { name: "centaur-review-reset" },
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
        sender: { login: "alice", type: "User" },
      }),
      "reset-delivery-1",
    );
    await handleReviewEvent(ctx, submittedReview(6, "head-4"));
    await drainBackgroundWork(5_000);

    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      anchorHeadSha: "head-4",
      epoch: 4,
      roundsUsed: 1,
    });
    expect(
      await state.get("centaur-githubbot:review-reset:base/repo#7:head-4"),
    ).toBeUndefined();
    expect(removedLabels).toEqual(["centaur-review-reset"]);
  });

  test("serializes an in-flight reset label ahead of concurrent review admission", async () => {
    const removedLabels: string[] = [];
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-3",
      epoch: 1,
      lastReviewedHeadSha: "head-3",
      pausedHeadSha: "head-4",
      pauseReason: "round_budget_exhausted",
      roundsUsed: 3,
      version: 1,
    });
    const ctx = budgetCtx({ headSha: "head-4", removedLabels, state });
    let permissionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      permissionStarted = resolve;
    });
    let releasePermission!: () => void;
    const permissionGate = new Promise<void>((resolve) => {
      releasePermission = resolve;
    });
    ctx.octokit.rest.repos.getCollaboratorPermissionLevel = (async () => {
      permissionStarted();
      await permissionGate;
      return { data: { permission: "write" } };
    }) as unknown as typeof ctx.octokit.rest.repos.getCollaboratorPermissionLevel;

    const label = handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "labeled",
        label: { name: "centaur-review-reset" },
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
        sender: { login: "alice", type: "User" },
      }),
      "concurrent-reset",
    );
    await started;
    const review = handleReviewEvent(ctx, submittedReview(7, "head-4"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({ pausedHeadSha: "head-4", roundsUsed: 3 });

    releasePermission();
    await Promise.all([label, review]);
    await drainBackgroundWork(5_000);

    const budget = await state.get(
      "centaur-githubbot:review-budget:base/repo#7",
    );
    expect(budget).toMatchObject({
      anchorHeadSha: "head-4",
      epoch: 2,
      roundsUsed: 1,
    });
    expect(budget).not.toHaveProperty("pausedHeadSha");
    expect(removedLabels).toEqual(["centaur-review-reset"]);
  });

  test("retries a transient reset-approval write before admitting review", async () => {
    const durableState = makeState();
    await durableState.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-3",
      epoch: 1,
      lastReviewedHeadSha: "head-3",
      pausedHeadSha: "head-4",
      pauseReason: "round_budget_exhausted",
      roundsUsed: 3,
      version: 1,
    });
    let approvalWriteAttempts = 0;
    const state = {
      ...durableState,
      async set(key: string, value: unknown) {
        if (key.includes(":review-reset:")) {
          approvalWriteAttempts += 1;
          if (approvalWriteAttempts === 1) {
            throw new Error("temporary approval write failure");
          }
        }
        await durableState.set(key, value);
      },
    };
    const ctx = budgetCtx({ headSha: "head-4", state });

    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "labeled",
        label: { name: "centaur-review-reset" },
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
        sender: { login: "alice", type: "User" },
      }),
      "retry-reset-save",
    );
    await handleReviewEvent(ctx, submittedReview(15, "head-4"));
    await drainBackgroundWork(5_000);

    expect(approvalWriteAttempts).toBe(2);
    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      consumedResetApprovalId: "retry-reset-save",
      epoch: 2,
      roundsUsed: 1,
    });
  });

  test("retries a transient reset permission lookup before recording approval", async () => {
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-3",
      epoch: 1,
      lastReviewedHeadSha: "head-3",
      pausedHeadSha: "head-4",
      pauseReason: "reviewer_round_budget_exhausted",
      roundsUsed: 3,
      version: 1,
    });
    const removedLabels: string[] = [];
    const ctx = budgetCtx({ headSha: "head-4", removedLabels, state });
    let permissionAttempts = 0;
    ctx.octokit.rest.repos.getCollaboratorPermissionLevel = (async () => {
      permissionAttempts += 1;
      if (permissionAttempts === 1) {
        throw Object.assign(new Error("temporary GitHub failure"), {
          status: 503,
        });
      }
      return { data: { permission: "write" } };
    }) as unknown as typeof ctx.octokit.rest.repos.getCollaboratorPermissionLevel;

    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "labeled",
        label: { name: "centaur-review-reset" },
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
        sender: { login: "alice", type: "User" },
      }),
      "retry-reset-permission",
    );

    expect(permissionAttempts).toBe(2);
    expect(
      await state.get("centaur-githubbot:review-reset:base/repo#7:head-4"),
    ).toMatchObject({ approvalId: "retry-reset-permission" });
    expect(removedLabels).toEqual([]);
  });

  test("stores a head-pinned reset approval without expiration", async () => {
    const durableState = makeState();
    await durableState.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-3",
      epoch: 1,
      lastReviewedHeadSha: "head-3",
      pausedHeadSha: "head-4",
      pauseReason: "reviewer_round_budget_exhausted",
      roundsUsed: 3,
      version: 1,
    });
    const approvalTtls: Array<number | undefined> = [];
    const state = {
      ...durableState,
      async set(key: string, value: unknown, ttlMs?: number) {
        if (key.includes(":review-reset:")) approvalTtls.push(ttlMs);
        await durableState.set(key, value);
      },
    };
    const ctx = budgetCtx({ headSha: "head-4", state });

    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "labeled",
        label: { name: "centaur-review-reset" },
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
        sender: { login: "alice", type: "User" },
      }),
      "durable-reset-approval",
    );

    expect(approvalTtls).toEqual([undefined]);
    expect(
      await durableState.get(
        "centaur-githubbot:review-reset:base/repo#7:head-4",
      ),
    ).toMatchObject({ approvalId: "durable-reset-approval" });
  });

  test("retries a transient reset-approval read before admitting review", async () => {
    const durableState = makeState();
    await durableState.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-3",
      epoch: 1,
      lastReviewedHeadSha: "head-3",
      pausedHeadSha: "head-4",
      pauseReason: "round_budget_exhausted",
      roundsUsed: 3,
      version: 1,
    });
    let approvalReadAttempts = 0;
    const state = {
      ...durableState,
      async get(key: string) {
        if (key.includes(":review-reset:")) {
          approvalReadAttempts += 1;
          if (approvalReadAttempts === 1) {
            throw new Error("temporary approval read failure");
          }
        }
        return durableState.get(key);
      },
    };
    const removedLabels: string[] = [];
    const ctx = budgetCtx({ headSha: "head-4", removedLabels, state });

    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "labeled",
        label: { name: "centaur-review-reset" },
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
        sender: { login: "alice", type: "User" },
      }),
      "retry-reset-load",
    );
    await handleReviewEvent(ctx, submittedReview(18, "head-4"));
    await drainBackgroundWork(5_000);

    expect(approvalReadAttempts).toBe(2);
    expect(
      await durableState.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      consumedResetApprovalId: "retry-reset-load",
      epoch: 2,
      roundsUsed: 1,
    });
    expect(
      await durableState.get(
        "centaur-githubbot:review-reset:base/repo#7:head-4",
      ),
    ).toBeUndefined();
    expect(removedLabels).toEqual(["centaur-review-reset"]);
  });

  test("retries consumed reset-label removal before deleting approval", async () => {
    const removedLabels: string[] = [];
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-3",
      epoch: 1,
      lastReviewedHeadSha: "head-3",
      pausedHeadSha: "head-4",
      pauseReason: "reviewer_round_budget_exhausted",
      roundsUsed: 3,
      version: 1,
    });
    const ctx = budgetCtx({ headSha: "head-4", removedLabels, state });
    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "labeled",
        label: { name: "centaur-review-reset" },
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
        sender: { login: "alice", type: "User" },
      }),
      "retry-reset-label-remove",
    );
    let removalAttempts = 0;
    ctx.octokit.rest.issues.removeLabel = (async (request: {
      name: string;
    }) => {
      removalAttempts += 1;
      if (removalAttempts === 1) {
        throw new Error("temporary GitHub failure");
      }
      removedLabels.push(request.name);
      return { data: {} };
    }) as unknown as typeof ctx.octokit.rest.issues.removeLabel;

    await handleReviewEvent(ctx, submittedReview(35, "head-4"));
    await drainBackgroundWork(5_000);

    expect(removalAttempts).toBe(2);
    expect(removedLabels).toEqual(["centaur-review-reset"]);
    expect(
      await state.get("centaur-githubbot:review-reset:base/repo#7:head-4"),
    ).toBeUndefined();
  });

  test("invalidates a head-pinned reset approval on synchronize", async () => {
    const removedLabels: string[] = [];
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-1",
      epoch: 1,
      lastReviewedHeadSha: "head-1",
      pausedHeadSha: "head-1",
      pauseReason: "reviewer_round_budget_exhausted",
      roundsUsed: 3,
      version: 1,
    });
    await state.set("centaur-githubbot:review-reset:base/repo#7:head-1", {
      approvalId: "old-head-reset",
      approvedBy: "alice",
      headSha: "head-1",
    });
    const ctx = budgetCtx({ headSha: "head-2", removedLabels, state });

    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "synchronize",
        before: "head-1",
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
      }),
      "invalidate-old-reset",
    );

    expect(
      await state.get("centaur-githubbot:review-reset:base/repo#7:head-1"),
    ).toBeUndefined();
    expect(removedLabels).toEqual(["centaur-review-reset"]);
  });

  test("rejects a reset label while the review epoch is active", async () => {
    const removedLabels: string[] = [];
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-1",
      epoch: 1,
      lastReviewedHeadSha: "head-1",
      roundsUsed: 1,
      version: 1,
    });
    const ctx = budgetCtx({ removedLabels, state });

    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "labeled",
        label: { name: "centaur-review-reset" },
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
        sender: { login: "alice", type: "User" },
      }),
      "early-reset",
    );
    await handleReviewEvent(ctx, submittedReview(16, "head-1"));
    await drainBackgroundWork(5_000);

    expect(
      await state.get("centaur-githubbot:review-reset:base/repo#7:head-1"),
    ).toBeUndefined();
    expect(removedLabels).toEqual(["centaur-review-reset"]);
    const budget = await state.get(
      "centaur-githubbot:review-budget:base/repo#7",
    );
    expect(budget).toMatchObject({ epoch: 1, roundsUsed: 2 });
    expect(budget).not.toHaveProperty("consumedResetApprovalId");
  });

  test("rejects reset labels added by the managed bot", async () => {
    const removedLabels: string[] = [];
    const state = makeState();
    const ctx = budgetCtx({ headSha: "head-4", removedLabels, state });
    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "labeled",
        label: { name: "centaur-review-reset" },
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
        sender: { login: "centaur-bot", type: "Bot" },
      }),
      "reset-delivery-bot",
    );
    expect(
      await state.get("centaur-githubbot:review-reset:base/repo#7:head-4"),
    ).toBeUndefined();
    expect(removedLabels).toEqual(["centaur-review-reset"]);
  });

  test("rejects reset labels from users without write permission", async () => {
    const removedLabels: string[] = [];
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-3",
      epoch: 1,
      lastReviewedHeadSha: "head-3",
      pausedHeadSha: "head-4",
      pauseReason: "round_budget_exhausted",
      roundsUsed: 3,
      version: 1,
    });
    const ctx = budgetCtx({
      headSha: "head-4",
      permission: "read",
      removedLabels,
      state,
    });
    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "labeled",
        label: { name: "centaur-review-reset" },
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
        sender: { login: "outside-reviewer", type: "User" },
      }),
      "reset-delivery-reader",
    );
    expect(
      await state.get("centaur-githubbot:review-reset:base/repo#7:head-4"),
    ).toBeUndefined();
    expect(removedLabels).toEqual(["centaur-review-reset"]);
  });

  test("rejects an authorized reset label without a delivery id", async () => {
    const removedLabels: string[] = [];
    const state = makeState();
    const ctx = budgetCtx({ headSha: "head-4", removedLabels, state });
    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "labeled",
        label: { name: "centaur-review-reset" },
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
        sender: { login: "alice", type: "User" },
      }),
    );
    expect(
      await state.get("centaur-githubbot:review-reset:base/repo#7:head-4"),
    ).toBeUndefined();
    expect(removedLabels).toEqual(["centaur-review-reset"]);
  });

  test("uses one reset delivery only once when approval cleanup fails", async () => {
    const durableState = makeState();
    const state = {
      ...durableState,
      async delete(key: string) {
        if (key.includes(":review-reset:")) {
          throw new Error("temporary delete failure");
        }
        await durableState.delete(key);
      },
    };
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-3",
      epoch: 3,
      lastReviewedHeadSha: "head-3",
      pausedHeadSha: "head-4",
      pauseReason: "round_budget_exhausted",
      roundsUsed: 3,
      version: 1,
    });
    const ctx = budgetCtx({ headSha: "head-4", state });
    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "labeled",
        label: { name: "centaur-review-reset" },
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
        sender: { login: "alice", type: "User" },
      }),
      "one-shot-reset",
    );

    await handleReviewEvent(ctx, submittedReview(10, "head-4"));
    await handleReviewEvent(ctx, submittedReview(11, "head-4"));
    await drainBackgroundWork(5_000);

    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      consumedResetApprovalId: "one-shot-reset",
      epoch: 4,
      roundsUsed: 2,
    });
  });

  test("retries an approved-reset budget write in the same delivery", async () => {
    const durableState = makeState();
    await durableState.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-3",
      epoch: 1,
      lastReviewedHeadSha: "head-3",
      pausedHeadSha: "head-4",
      pauseReason: "round_budget_exhausted",
      roundsUsed: 3,
      version: 1,
    });
    let budgetWriteAttempts = 0;
    const state = {
      ...durableState,
      async set(key: string, value: unknown) {
        if (key.includes(":review-budget:")) {
          budgetWriteAttempts += 1;
          if (budgetWriteAttempts === 1) {
            throw new Error("temporary budget write failure");
          }
        }
        await durableState.set(key, value);
      },
    };
    const merges = { count: 0 };
    const removedLabels: string[] = [];
    const ctx = budgetCtx({
      headSha: "head-4",
      merges,
      removedLabels,
      state,
    });
    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "labeled",
        label: { name: "centaur-review-reset" },
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
        sender: { login: "alice", type: "User" },
      }),
      "reset-survives-budget-failure",
    );
    const review = JSON.stringify({
      action: "submitted",
      pull_request: { head: { sha: "head-4" }, number: 7 },
      repository: { full_name: "base/repo" },
      review: {
        author_association: "COLLABORATOR",
        commit_id: "head-4",
        id: 14,
        state: "approved",
        user: { login: "reviewer" },
      },
    });

    await handleReviewEvent(ctx, review);

    expect(budgetWriteAttempts).toBe(2);
    expect(merges.count).toBe(1);
    expect(removedLabels).toEqual(["centaur-review-reset"]);
    expect(
      await state.get("centaur-githubbot:review-reset:base/repo#7:head-4"),
    ).toBeUndefined();
    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      consumedResetApprovalId: "reset-survives-budget-failure",
      epoch: 2,
      roundsUsed: 1,
    });
  });

  test("retries a transient human-handoff claim before acknowledging", async () => {
    const comments: string[] = [];
    const durableState = makeState();
    await durableState.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-1",
      epoch: 1,
      lastReviewedHeadSha: "head-1",
      roundsUsed: 2,
      version: 1,
    });
    let pauseClaimAttempts = 0;
    const state = {
      ...durableState,
      async setIfNotExists(key: string, value: unknown) {
        if (key.includes(":review-paused:")) {
          pauseClaimAttempts += 1;
          if (pauseClaimAttempts === 1) {
            throw new Error("temporary handoff claim failure");
          }
        }
        return durableState.setIfNotExists(key, value);
      },
    };
    const ctx = budgetCtx({ comments, state });

    await handleReviewEvent(ctx, submittedReview(19, "head-1"));
    await drainBackgroundWork(5_000);

    expect(pauseClaimAttempts).toBe(2);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("reviewer_round_budget_exhausted");
  });

  test("retries a failed handoff on descendants without duplicate comments", async () => {
    const comments: string[] = [];
    const durableState = makeState();
    await durableState.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-1",
      epoch: 1,
      lastReviewedHeadSha: "head-1",
      reviewerRoundsUsed: { "github-user:101": 2 },
      roundsUsed: 2,
      version: 1,
    });
    const pauseClaimKeys: string[] = [];
    const state = {
      ...durableState,
      async setIfNotExists(key: string, value: unknown) {
        if (key.includes(":review-paused:")) pauseClaimKeys.push(key);
        return durableState.setIfNotExists(key, value);
      },
    };
    const ctx = budgetCtx({ comments, state });
    let attempts = 0;
    ctx.octokit.rest.issues.createComment = (async (request: {
      body: string;
    }) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary GitHub failure");
      comments.push(request.body);
      return { data: {} };
    }) as unknown as typeof ctx.octokit.rest.issues.createComment;

    await handleReviewEvent(ctx, submittedReview(20, "head-1"));
    setHeadSha(ctx, "head-2");
    await handleReviewEvent(
      ctx,
      submittedReview(21, "head-2", { id: 202, login: "second-reviewer" }),
    );
    setHeadSha(ctx, "head-3");
    await handleReviewEvent(
      ctx,
      submittedReview(22, "head-3", { id: 303, login: "third-reviewer" }),
    );
    await drainBackgroundWork(5_000);

    expect(attempts).toBe(2);
    expect(pauseClaimKeys).toHaveLength(3);
    expect(new Set(pauseClaimKeys).size).toBe(1);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("reviewer_round_budget_exhausted");
    expect(
      await durableState.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({ pausedHeadSha: "head-1", roundsUsed: 5 });
  });

  test("does not consume a stale reset approval on an active epoch", async () => {
    const merges = { count: 0 };
    const removedLabels: string[] = [];
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-1",
      epoch: 1,
      lastReviewedHeadSha: "head-1",
      roundsUsed: 1,
      version: 1,
    });
    await state.set("centaur-githubbot:review-reset:base/repo#7:head-1", {
      approvalId: "legacy-early-reset",
      approvedBy: "alice",
      headSha: "head-1",
    });
    const ctx = budgetCtx({ merges, removedLabels, state });

    await handleReviewEvent(
      ctx,
      JSON.stringify({
        action: "submitted",
        pull_request: { head: { sha: "head-1" }, number: 7 },
        repository: { full_name: "base/repo" },
        review: {
          author_association: "COLLABORATOR",
          commit_id: "head-1",
          id: 17,
          state: "approved",
          user: { login: "reviewer" },
        },
      }),
    );

    expect(merges.count).toBe(1);
    expect(removedLabels).toEqual(["centaur-review-reset"]);
    expect(
      await state.get("centaur-githubbot:review-reset:base/repo#7:head-1"),
    ).toBeUndefined();
    const budget = await state.get(
      "centaur-githubbot:review-budget:base/repo#7",
    );
    expect(budget).toMatchObject({ epoch: 1, roundsUsed: 1 });
    expect(budget).not.toHaveProperty("consumedResetApprovalId");
  });

  test("keeps deterministic auto-merge paused for an exhausted review head", async () => {
    const merges = { count: 0 };
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-3",
      epoch: 1,
      lastReviewedHeadSha: "head-3",
      pausedHeadSha: "head-4",
      pauseReason: "round_budget_exhausted",
      roundsUsed: 3,
      version: 1,
    });
    const ctx = budgetCtx({ headSha: "head-4", merges, state });
    await handleReviewEvent(
      ctx,
      JSON.stringify({
        action: "submitted",
        pull_request: { head: { sha: "head-4" }, number: 7 },
        repository: { full_name: "base/repo" },
        review: {
          author_association: "COLLABORATOR",
          commit_id: "head-4",
          id: 9,
          state: "approved",
          user: { login: "reviewer" },
        },
      }),
    );
    expect(merges.count).toBe(0);
  });

  test("keeps the handoff pause across a descendant automation head", async () => {
    const merges = { count: 0 };
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-3",
      epoch: 1,
      lastReviewedHeadSha: "head-3",
      pausedHeadSha: "head-4",
      pauseReason: "round_budget_exhausted",
      roundsUsed: 3,
      version: 1,
    });
    const ctx = budgetCtx({ headSha: "head-5", merges, state });

    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "synchronize",
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
      }),
      "descendant-head",
    );

    expect(merges.count).toBe(0);
    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      pausedHeadSha: "head-4",
      pauseReason: "round_budget_exhausted",
    });
  });

  test("keeps an approved reset mergeable at one-round caps", async () => {
    const merges = { count: 0 };
    const removedLabels: string[] = [];
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-3",
      epoch: 1,
      lastReviewedHeadSha: "head-3",
      pausedHeadSha: "head-3",
      pauseReason: "round_budget_exhausted",
      roundsUsed: 3,
      version: 1,
    });
    const ctx = budgetCtx({
      headSha: "head-4",
      maxRoundsPerEpoch: 1,
      maxTotalRoundsPerEpoch: 1,
      merges,
      removedLabels,
      state,
    });
    await handlePullRequestEvent(
      ctx,
      JSON.stringify({
        action: "labeled",
        label: { name: "centaur-review-reset" },
        pull_request: { number: 7 },
        repository: { full_name: "base/repo" },
        sender: { login: "alice", type: "User" },
      }),
      "reset-delivery-approval",
    );
    await handleReviewEvent(
      ctx,
      JSON.stringify({
        action: "submitted",
        pull_request: { head: { sha: "head-4" }, number: 7 },
        repository: { full_name: "base/repo" },
        review: {
          author_association: "COLLABORATOR",
          commit_id: "head-4",
          id: 10,
          state: "approved",
          user: { login: "reviewer" },
        },
      }),
    );

    expect(merges.count).toBe(1);
    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      anchorHeadSha: "head-4",
      epoch: 2,
      roundsUsed: 1,
    });
    const budget = await state.get(
      "centaur-githubbot:review-budget:base/repo#7",
    );
    expect(budget).not.toHaveProperty("pausedHeadSha");
    expect(budget).not.toHaveProperty("pauseReason");
    expect(
      await state.get("centaur-githubbot:review-reset:base/repo#7:head-4"),
    ).toBeUndefined();
    expect(removedLabels).toEqual(["centaur-review-reset"]);
  });
});

describe("workflow event emission", () => {
  type EmitCall = {
    url: string;
    body: { event_type?: string; correlation_id?: string; payload?: unknown };
  };

  // The PR is deliberately NOT bot-owned (no assignees): workflow events must
  // emit before the owned-PR gate, and the management path then no-ops, so no
  // merge/turn mocks are needed.
  type RollupStub = {
    state?: string;
    contexts?: (Record<string, unknown> | null)[];
    checkRunCountsByState?: { count: number; state: string }[];
    fail?: boolean;
    pageInfo?: { endCursor?: string | null; hasNextPage: boolean };
    partial?: boolean;
    statusContextCountsByState?: { count: number; state: string }[];
  };

  function emitCtx(
    emits: EmitCall[],
    options?: {
      rollupSequence?: RollupStub[];
      workflowEvents?: boolean;
    },
  ): PrManagerContext {
    const sequence = [...(options?.rollupSequence ?? [{ state: "SUCCESS" }])];
    return {
      octokit: {
        graphql: async () => {
          const next = sequence.length > 1 ? sequence.shift()! : sequence[0]!;
          if (next.fail) throw new Error("403 Forbidden");
          const result = {
            repository: {
              object: {
                statusCheckRollup: {
                  state: next.state ?? "SUCCESS",
                  contexts: {
                    nodes: next.contexts ?? [],
                    pageInfo: next.pageInfo,
                    checkRunCountsByState: next.checkRunCountsByState,
                    statusContextCountsByState: next.statusContextCountsByState,
                  },
                },
              },
            },
          };
          if (next.partial) {
            throw Object.assign(new Error("partial GraphQL result"), { data: result });
          }
          return result;
        },
        rest: {
          repos: {
            listPullRequestsAssociatedWithCommit: async () => ({ data: [] }),
          },
          pulls: {
            get: async () => ({
              data: prPayload({ assignees: [], headRepoFullName: "base/repo" }),
            }),
          },
        },
      },
      options: {
        apiUrl: "http://localhost",
        ciSettleConfirmMs: 0,
        logger: quietLogger,
        workflowEvents: options?.workflowEvents ?? true,
        fetch: (url: RequestInfo | URL, init?: RequestInit) => {
          emits.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")),
          });
          return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
        },
      },
      state: makeState(),
      userName: "centaur-bot",
    } as unknown as PrManagerContext;
  }

  const completedCheckRun = JSON.stringify({
    action: "completed",
    repository: { full_name: "base/repo" },
    check_run: {
      head_sha: "abc123",
      name: "build",
      conclusion: "success",
      html_url: "https://example.test/checks/1",
      pull_requests: [{ number: 7 }],
    },
  });

  test("emits ci-completed for a completed check run before ownership gating", async () => {
    const emits: EmitCall[] = [];
    await handleCiEvent(emitCtx(emits), "check_run", completedCheckRun);
    await drainBackgroundWork(1_000);
    expect(emits.length).toBe(1);
    const emit = emits[0]!;
    expect(emit.url).toBe("http://localhost/api/workflows/events");
    expect(emit.body).toEqual({
      event_type: "ci-completed",
      correlation_id: "base/repo:abc123",
      payload: { failed: false, failing: [] },
    });
  });

  test("lowercases correlation ids against repository full_name case drift", async () => {
    const emits: EmitCall[] = [];
    await handleCiEvent(
      emitCtx(emits),
      "check_run",
      JSON.stringify({
        action: "completed",
        repository: { full_name: "Base/Repo" },
        check_run: { head_sha: "ABC123", pull_requests: [{ number: 7 }] },
      }),
    );
    await drainBackgroundWork(1_000);
    expect(emits.length).toBe(1);
    expect(emits[0]!.body.correlation_id).toBe("base/repo:abc123");
  });

  test("emits ci-completed for a terminal legacy status", async () => {
    const emits: EmitCall[] = [];
    await handleCiEvent(
      emitCtx(emits, {
        rollupSequence: [
          {
            state: "FAILURE",
            contexts: [
              { __typename: "StatusContext", context: "deploy", state: "FAILURE" },
            ],
          },
        ],
      }),
      "status",
      JSON.stringify({
        repository: { full_name: "base/repo" },
        sha: "abc123",
        state: "failure",
        context: "deploy",
        target_url: "https://example.test/deploy/1",
      }),
    );
    await drainBackgroundWork(1_000);
    expect(emits.length).toBe(1);
    expect(emits[0]!.body).toEqual({
      event_type: "ci-completed",
      correlation_id: "base/repo:abc123",
      payload: { failed: true, failing: ["deploy"] },
    });
  });

  test("does not emit ci-completed while any check is still running", async () => {
    const emits: EmitCall[] = [];
    await handleCiEvent(
      emitCtx(emits, { rollupSequence: [{ state: "PENDING" }] }),
      "check_run",
      completedCheckRun,
    );
    expect(emits.length).toBe(0);
  });

  test("does not treat a failed aggregate as settled while another check is running", async () => {
    const emits: EmitCall[] = [];
    await handleCiEvent(
      emitCtx(emits, {
        rollupSequence: [
          {
            state: "FAILURE",
            contexts: [
              {
                __typename: "CheckRun",
                conclusion: "FAILURE",
                name: "lint",
                status: "COMPLETED",
              },
              {
                __typename: "CheckRun",
                conclusion: null,
                name: "test",
                status: "IN_PROGRESS",
              },
            ],
          },
        ],
      }),
      "check_run",
      completedCheckRun,
    );
    expect(emits.length).toBe(0);
  });

  test("uses the latest check run when a failed job is rerun successfully", async () => {
    const emits: EmitCall[] = [];
    const workflow = {
      workflowRun: { event: "pull_request", workflow: { name: "CI" } },
    };
    await handleCiEvent(
      emitCtx(emits, {
        rollupSequence: [
          {
            state: "SUCCESS",
            contexts: [
              {
                __typename: "CheckRun",
                checkSuite: workflow,
                conclusion: "FAILURE",
                name: "test",
                startedAt: "2026-08-01T10:00:00Z",
                status: "COMPLETED",
              },
              {
                __typename: "CheckRun",
                checkSuite: workflow,
                conclusion: "SUCCESS",
                name: "test",
                startedAt: "2026-08-01T10:05:00Z",
                status: "COMPLETED",
              },
            ],
          },
        ],
      }),
      "check_run",
      completedCheckRun,
    );
    await drainBackgroundWork(1_000);
    expect(emits[0]!.body.payload).toEqual({ failed: false, failing: [] });
  });

  test("fails closed on unreadable context detail while aggregate counts are pending", async () => {
    const emits: EmitCall[] = [];
    await handleCiEvent(
      emitCtx(emits, {
        rollupSequence: [
          {
            state: "FAILURE",
            contexts: [null],
            partial: true,
            checkRunCountsByState: [
              { count: 1, state: "FAILURE" },
              { count: 1, state: "IN_PROGRESS" },
            ],
            statusContextCountsByState: [],
          },
        ],
      }),
      "check_run",
      completedCheckRun,
    );
    expect(emits.length).toBe(0);
  });

  test("does not emit on a momentary green — the registration race", async () => {
    // Push lands, no-op checks complete first, the rollup reads SUCCESS for a
    // few seconds before the real suite registers. The confirm re-read must
    // catch it flipping PENDING and suppress the emission.
    const emits: EmitCall[] = [];
    await handleCiEvent(
      emitCtx(emits, { rollupSequence: [{ state: "SUCCESS" }, { state: "PENDING" }] }),
      "check_run",
      completedCheckRun,
    );
    await drainBackgroundWork(1_000);
    expect(emits.length).toBe(0);
  });

  test("does not emit ci-completed when the rollup is unreadable", async () => {
    // A failed read is UNKNOWN, not settled — emitting would manufacture a
    // green signal out of thin air (e.g. a token missing checks:read).
    const emits: EmitCall[] = [];
    await handleCiEvent(emitCtx(emits, { rollupSequence: [{ fail: true }] }), "check_run", completedCheckRun);
    expect(emits.length).toBe(0);
  });

  test("does not emit for an in-flight check run or a pending status", async () => {
    const emits: EmitCall[] = [];
    const ctx = emitCtx(emits);
    await handleCiEvent(
      ctx,
      "check_run",
      JSON.stringify({
        action: "created",
        repository: { full_name: "base/repo" },
        check_run: { head_sha: "abc123", pull_requests: [] },
      }),
    );
    await handleCiEvent(
      ctx,
      "status",
      JSON.stringify({
        repository: { full_name: "base/repo" },
        sha: "abc123",
        state: "pending",
      }),
    );
    expect(emits.length).toBe(0);
  });

  test("does not emit when workflowEvents is off", async () => {
    const emits: EmitCall[] = [];
    await handleCiEvent(
      emitCtx(emits, { workflowEvents: false }),
      "check_run",
      completedCheckRun,
    );
    expect(emits.length).toBe(0);
  });

  test("does not emit a workflow event for an untrusted public review", async () => {
    const emits: EmitCall[] = [];
    await handleReviewEvent(
      emitCtx(emits),
      JSON.stringify({
        action: "submitted",
        repository: { full_name: "base/repo" },
        pull_request: { number: 7 },
        review: {
          author_association: "NONE",
          commit_id: "reviewed-public",
          id: 122,
          state: "commented",
          user: { login: "public-user" },
        },
      }),
    );
    await drainBackgroundWork(1_000);

    expect(emits).toEqual([]);
  });

  test("emits review-submitted keyed by PR, head sha, and reviewer", async () => {
    const emits: EmitCall[] = [];
    await handleReviewEvent(
      emitCtx(emits),
      JSON.stringify({
        action: "submitted",
        repository: { full_name: "base/repo" },
        pull_request: { number: 7 },
        review: {
          author_association: "COLLABORATOR",
          commit_id: "reviewed456",
          id: 123,
          state: "commented",
          user: { login: "chatgpt-codex-connector" },
        },
      }),
    );
    await drainBackgroundWork(1_000);
    expect(emits.length).toBe(1);
    expect(emits[0]!.body).toEqual({
      event_type: "review-submitted",
      correlation_id: "base/repo:pr-7:reviewed456:chatgpt-codex-connector",
      payload: { review_id: 123, state: "commented" },
    });
  });

  test("reviews from different authors get independent rows, never collapsing", async () => {
    const emits: EmitCall[] = [];
    const submittedReview = (id: number, login: string) =>
      JSON.stringify({
        action: "submitted",
        repository: { full_name: "base/repo" },
        pull_request: { number: 7 },
        review: {
          author_association: "COLLABORATOR",
          commit_id: "abc123",
          id,
          state: "commented",
          user: { login },
        },
      });
    const ctx = emitCtx(emits);
    await handleReviewEvent(ctx, submittedReview(125, "human-reviewer"));
    await handleReviewEvent(ctx, submittedReview(126, "chatgpt-codex-connector"));
    await drainBackgroundWork(1_000);
    expect(emits.map((e) => e.body.correlation_id)).toEqual([
      "base/repo:pr-7:abc123:human-reviewer",
      "base/repo:pr-7:abc123:chatgpt-codex-connector",
    ]);
  });

  test("does not delay PR management while a review event is being delivered", async () => {
    let finishDelivery!: (response: Response) => void;
    const delivery = new Promise<Response>((resolve) => {
      finishDelivery = resolve;
    });
    const ctx = emitCtx([]);
    ctx.options.fetch = () => delivery;

    await handleReviewEvent(
      ctx,
      JSON.stringify({
        action: "submitted",
        repository: { full_name: "base/repo" },
        pull_request: { number: 7 },
        review: {
          author_association: "COLLABORATOR",
          commit_id: "abc123",
          id: 127,
          state: "commented",
          user: { login: "human-reviewer" },
        },
      }),
    );

    finishDelivery(new Response("", { status: 200 }));
    await drainBackgroundWork(1_000);
  });

  test("paginates rollup contexts before deduplicating reruns", async () => {
    const ctx = emitCtx([]);
    ctx.octokit.graphql = (async (_query: string, variables: { after?: string }) => ({
      repository: {
        object: {
          statusCheckRollup: {
            state: "SUCCESS",
            contexts:
              variables.after === "page-2"
                ? {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        conclusion: "SUCCESS",
                        name: "test",
                        startedAt: "2026-08-01T10:05:00Z",
                        status: "COMPLETED",
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  }
                : {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        conclusion: "FAILURE",
                        name: "test",
                        startedAt: "2026-08-01T10:00:00Z",
                        status: "COMPLETED",
                      },
                    ],
                    pageInfo: { hasNextPage: true, endCursor: "page-2" },
                  },
          },
        },
      },
    })) as typeof ctx.octokit.graphql;

    await expect(fetchCiEvaluation(ctx, "base", "repo", "abc123")).resolves.toEqual({
      failed: false,
      failingNames: [],
      settled: true,
    });
  });

  test("retries transient workflow event delivery", async () => {
    let attempts = 0;
    await emitWorkflowEvent(
      {
        apiUrl: "http://localhost",
        token: "test-token",
        webhookSecret: "test-secret",
        fetch: () => {
          attempts += 1;
          return Promise.resolve(
            new Response("", { status: attempts === 1 ? 503 : 200 }),
          );
        },
      },
      {
        correlationId: "base/repo:abc123",
        eventType: "ci-completed",
        payload: {},
      },
    );
    expect(attempts).toBe(2);
  });
});

describe("management turn reaction ack", () => {
  const submittedReview = (state: string, nodeId?: string) =>
    JSON.stringify({
      action: "submitted",
      repository: { full_name: "base/repo" },
      pull_request: { number: 7 },
      review: {
        author_association: "COLLABORATOR",
        id: 55,
        node_id: nodeId,
        state,
        user: { login: "reviewer" },
      },
    });

  function reviewCtx(reactions: { subjectId: string; content: string }[]) {
    return {
      octokit: {
        graphql: async (
          _query: string,
          vars: { subjectId: string; content: string },
        ) => {
          reactions.push({ subjectId: vars.subjectId, content: vars.content });
          return {};
        },
        rest: {
          pulls: {
            get: async () => ({
              data: prPayload({ headRepoFullName: "base/repo" }),
            }),
            listCommentsForReview: async () => ({
              data: [
                {
                  body: "A concrete review finding.",
                  diff_hunk: "@@ -1 +1 @@\n-old\n+new",
                  id: 550,
                  line: 1,
                  path: "src/implementation.ts",
                },
              ],
            }),
            merge: async () => ({ data: {} }),
          },
          git: { deleteRef: async () => ({ data: {} }) },
        },
      },
      options: {
        apiUrl: "http://localhost",
        deleteBranchOnMerge: false,
        logger: quietLogger,
        // Non-retryable so the backgrounded turn settles off the network.
        fetch: () => Promise.resolve(new Response("no", { status: 400 })),
      },
      state: makeState(),
      userName: "centaur-bot",
    } as unknown as PrManagerContext;
  }

  test("acks a changes-requested review with eyes on the review itself, settling when the turn fails", async () => {
    const reactions: { subjectId: string; content: string }[] = [];
    await handleReviewEvent(
      reviewCtx(reactions),
      submittedReview("changes_requested", "PRR_test55"),
    );
    // The working ack lands before the management turn runs.
    expect(reactions).toContainEqual({ subjectId: "PRR_test55", content: "EYES" });
    await drainBackgroundWork(5_000);
    expect(reactions).toContainEqual({
      subjectId: "PRR_test55",
      content: "CONFUSED",
    });
  });

  test("does not react on an approved review (deterministic merge, no work turn)", async () => {
    const reactions: { subjectId: string; content: string }[] = [];
    await handleReviewEvent(
      reviewCtx(reactions),
      submittedReview("approved", "PRR_test55"),
    );
    await drainBackgroundWork(5_000);
    expect(reactions).toEqual([]);
  });

  test("stays quiet when the payload carries no review node id", async () => {
    const reactions: { subjectId: string; content: string }[] = [];
    await handleReviewEvent(reviewCtx(reactions), submittedReview("changes_requested"));
    await drainBackgroundWork(5_000);
    expect(reactions).toEqual([]);
  });
});
