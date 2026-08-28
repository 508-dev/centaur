import { describe, expect, test } from "bun:test";
import { drainBackgroundWork } from "../src/context";
import {
  decideMerge,
  handleCiEvent,
  handlePullRequestEvent,
  handleReviewEvent,
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
        review: { id: 123, state: "approved", user: { login: "reviewer" } },
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
    review: { id: reviewId, state: "approved", user: { login: "reviewer" } },
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
  const submittedReview = (reviewId: number, headSha: string) =>
    JSON.stringify({
      action: "submitted",
      repository: { full_name: "base/repo" },
      pull_request: { head: { sha: headSha }, number: 7 },
      review: {
        commit_id: headSha,
        id: reviewId,
        state: "commented",
        user: { login: "reviewer" },
      },
    });

  function budgetCtx(input?: {
    actor?: "bot" | "human";
    comparisonFile?: string;
    comments?: string[];
    headSha?: string;
    merges?: { count: number };
    permission?: string;
    removedLabels?: string[];
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
                          actor === "bot"
                            ? "fix review\n\nCentaur-Automation: true"
                            : "revise implementation",
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
      pauseReason: "round_budget_exhausted",
      roundsUsed: 3,
    });
    expect(merges.count).toBe(0);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("round_budget_exhausted");
    expect(comments[0]).toContain("centaur-review-reset");
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

  test("uses the latest reviewed range for authorship while keeping cumulative materiality", async () => {
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

    expect(compared).toEqual(["head-1...head-3", "head-2...head-3"]);
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
      pauseReason: "round_budget_exhausted",
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

  test("preserves an approved reset when the budget write fails", async () => {
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
    let failBudgetWrite = true;
    const state = {
      ...durableState,
      async set(key: string, value: unknown) {
        if (key.includes(":review-budget:") && failBudgetWrite) {
          failBudgetWrite = false;
          throw new Error("temporary budget write failure");
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
        commit_id: "head-4",
        id: 14,
        state: "approved",
        user: { login: "reviewer" },
      },
    });

    await handleReviewEvent(ctx, review);

    expect(merges.count).toBe(0);
    expect(removedLabels).toEqual([]);
    expect(
      await state.get("centaur-githubbot:review-reset:base/repo#7:head-4"),
    ).toMatchObject({ approvalId: "reset-survives-budget-failure" });
    expect(
      await state.get("centaur-githubbot:review-budget:base/repo#7"),
    ).toMatchObject({
      epoch: 1,
      pausedHeadSha: "head-4",
      roundsUsed: 3,
    });

    await handleReviewEvent(ctx, review);

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

  test("retries the human-handoff comment after a transient post failure", async () => {
    const comments: string[] = [];
    const state = makeState();
    await state.set("centaur-githubbot:review-budget:base/repo#7", {
      anchorHeadSha: "head-1",
      automationPendingFromHeadSha: "head-1",
      epoch: 1,
      lastReviewedHeadSha: "head-1",
      roundsUsed: 3,
      version: 1,
    });
    const ctx = budgetCtx({ comments, headSha: "head-2", state });
    let attempts = 0;
    ctx.octokit.rest.issues.createComment = (async (request: {
      body: string;
    }) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary GitHub failure");
      comments.push(request.body);
      return { data: {} };
    }) as unknown as typeof ctx.octokit.rest.issues.createComment;

    await handleReviewEvent(ctx, submittedReview(12, "head-2"));
    await handleReviewEvent(ctx, submittedReview(13, "head-2"));
    await drainBackgroundWork(5_000);

    expect(attempts).toBe(2);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("round_budget_exhausted");
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

  test("consumes an authorized reset before merging an approved head", async () => {
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

  test("emits review-submitted keyed by PR, head sha, and reviewer", async () => {
    const emits: EmitCall[] = [];
    await handleReviewEvent(
      emitCtx(emits),
      JSON.stringify({
        action: "submitted",
        repository: { full_name: "base/repo" },
        pull_request: { number: 7 },
        review: {
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
        review: { commit_id: "abc123", id, state: "commented", user: { login } },
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
