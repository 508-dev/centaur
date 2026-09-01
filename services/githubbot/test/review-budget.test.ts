import { describe, expect, test } from "bun:test";
import {
  assessReviewChange,
  decideReviewAdmission,
  type ReviewEpochState,
} from "../src/review-budget";

const DEFAULT_REVIEWER_KEY = "github-user:101";

const epoch = (overrides: Partial<ReviewEpochState> = {}): ReviewEpochState => {
  const state: ReviewEpochState = {
    anchorHeadSha: "head-1",
    automationPendingFromHeadSha: "head-1",
    epoch: 1,
    lastReviewedHeadSha: "head-1",
    roundsUsed: 1,
    version: 1,
    ...overrides,
  };
  state.reviewerRoundsUsed = overrides.reviewerRoundsUsed ?? {
    [DEFAULT_REVIEWER_KEY]: state.roundsUsed,
  };
  return state;
};

describe("assessReviewChange", () => {
  test("treats a small semantic runtime change as new behavior", () => {
    expect(
      assessReviewChange({
        comparisonStatus: "ahead",
        files: [{ changes: 12, filename: "services/githubbot/src/turn.ts" }],
      }),
    ).toMatchObject({
      changeClass: "new_risk",
      changedLines: 12,
      kind: "material",
      reasons: ["runtime_behavior_changed"],
      runtimeFiles: 1,
    });
  });

  test("does not let docs and tests inflate runtime thresholds", () => {
    expect(
      assessReviewChange({
        comparisonStatus: "ahead",
        fileThreshold: 1,
        lineThreshold: 1,
        files: [
          { changes: 500, filename: "docs/review-policy.md" },
          { changes: 500, filename: "services/githubbot/test/review.test.ts" },
        ],
      }),
    ).toMatchObject({
      changeClass: "maintenance",
      changedLines: 0,
      kind: "minor",
      runtimeFiles: 0,
    });
  });

  test("treats authorization, migration, dependency, and deployment files as material", () => {
    for (const filename of [
      "services/api/src/authorization.ts",
      "db/migrations/0042_policy.sql",
      "package.json",
      ".github/workflows/ci.yml",
    ]) {
      expect(
        assessReviewChange({
          comparisonStatus: "ahead",
          files: [{ changes: 1, filename }],
        }).kind,
      ).toBe("material");
    }
  });

  test("uses runtime size thresholds for the reviewed delta", () => {
    const assessment = assessReviewChange({
      comparisonStatus: "ahead",
      files: [
        { changes: 120, filename: "src/one.ts" },
        { changes: 90, filename: "src/two.ts" },
      ],
      lineThreshold: 200,
    });
    expect(assessment.kind).toBe("material");
    expect(assessment.reasons).toContain("runtime_lines:210>=200");
  });

  test("keeps formatting-only patches in the current epoch", () => {
    expect(
      assessReviewChange({
        comparisonStatus: "ahead",
        files: [
          {
            changes: 2,
            filename: "src/one.ts",
            patch: "@@ -1 +1 @@\n-const answer = 42;   \n+const answer = 42;",
          },
        ],
      }),
    ).toMatchObject({
      changeClass: "maintenance",
      kind: "minor",
      reasons: ["formatting_only"],
    });
  });

  test("does not mistake whitespace inside a string for formatting", () => {
    expect(
      assessReviewChange({
        comparisonStatus: "ahead",
        files: [
          {
            changes: 2,
            filename: "src/one.ts",
            patch: '-const label = "a b";\n+const label = "ab";',
          },
        ],
      }),
    ).toMatchObject({ changeClass: "new_risk", kind: "material" });
  });

  test("keeps a tree-identical rebase in the current epoch", () => {
    expect(
      assessReviewChange({
        comparisonStatus: "diverged",
        files: [{ changes: 40, filename: "src/one.ts" }],
        treeUnchanged: true,
      }),
    ).toMatchObject({
      changeClass: "maintenance",
      kind: "minor",
      reasons: ["tree_unchanged"],
    });
  });

  test("keeps a bounded accepted-finding repair in the current epoch", () => {
    expect(
      assessReviewChange({
        acceptedFindingPaths: new Set(["src/one.ts"]),
        comparisonStatus: "ahead",
        files: [
          {
            changes: 2,
            filename: "src/one.ts",
            patch: "@@ -1 +1 @@\n-return unsafe;\n+return checked;",
            status: "modified",
          },
        ],
      }),
    ).toMatchObject({
      changeClass: "repair",
      kind: "minor",
      reasons: ["accepted_finding_repair"],
    });
  });

  test("does not disguise widened or boundary-changing work as a repair", () => {
    for (const files of [
      [
        { changes: 2, filename: "src/one.ts", patch: "-old\n+new" },
        { changes: 2, filename: "src/two.ts", patch: "-old\n+new" },
      ],
      [
        {
          changes: 2,
          filename: "src/auth/policy.ts",
          patch: "-old\n+new",
        },
      ],
    ]) {
      expect(
        assessReviewChange({
          acceptedFindingPaths: new Set([files[0]!.filename]),
          comparisonStatus: "ahead",
          files,
        }),
      ).toMatchObject({ changeClass: "new_risk", kind: "material" });
    }
  });

  test("requires human judgment for a non-linear comparison", () => {
    expect(
      assessReviewChange({
        comparisonStatus: "diverged",
        files: [{ changes: 1, filename: "src/one.ts" }],
      }),
    ).toMatchObject({
      changeClass: "unknown",
      kind: "unknown",
      reasons: ["non_linear_comparison:diverged"],
    });
  });

  test("fails closed when GitHub's comparison file list is capped", () => {
    expect(
      assessReviewChange({
        comparisonStatus: "ahead",
        files: Array.from({ length: 300 }, (_, index) => ({
          changes: 1,
          filename: `generated/file-${index}.ts`,
        })),
      }),
    ).toMatchObject({
      changeClass: "unknown",
      kind: "unknown",
      reasons: ["github_comparison_file_cap"],
    });
  });
});

describe("decideReviewAdmission", () => {
  const maintenance = assessReviewChange({
    comparisonStatus: "ahead",
    files: [{ changes: 5, filename: "docs/review.md" }],
  });
  const material = assessReviewChange({
    comparisonStatus: "ahead",
    files: [{ changes: 5, filename: "src/authorization.ts" }],
  });
  const base = {
    actor: "automation" as const,
    assessment: maintenance,
    headSha: "head-2",
    manualReset: false,
    maxEpochs: 3,
    maxRoundsPerEpoch: 3,
    maxTotalRoundsPerEpoch: 6,
    reviewerKey: DEFAULT_REVIEWER_KEY,
    startsRepairTurn: true,
  };

  test("starts the first epoch and counts its broad review", () => {
    expect(decideReviewAdmission({ ...base, state: undefined })).toEqual({
      decision: "allow",
      resetEpoch: false,
      state: {
        anchorHeadSha: "head-2",
        automationPendingFromHeadSha: "head-2",
        epoch: 1,
        lastReviewedHeadSha: "head-2",
        reviewerRoundsUsed: { [DEFAULT_REVIEWER_KEY]: 1 },
        roundsUsed: 1,
        version: 1,
      },
    });
  });

  test("counts repeated reviews against both reviewer and aggregate budgets", () => {
    expect(
      decideReviewAdmission({ ...base, headSha: "head-1", state: epoch() }),
    ).toMatchObject({
      decision: "allow",
      state: {
        reviewerRoundsUsed: { [DEFAULT_REVIEWER_KEY]: 2 },
        roundsUsed: 2,
      },
    });
  });

  test("keeps separate reviewer budgets without clearing an existing handoff", () => {
    expect(
      decideReviewAdmission({
        ...base,
        reviewerKey: "github-user:202",
        state: epoch({
          pauseReason: "reviewer_round_budget_exhausted",
          pausedHeadSha: "head-1",
          reviewerRoundsUsed: { [DEFAULT_REVIEWER_KEY]: 3 },
          roundsUsed: 3,
        }),
      }),
    ).toMatchObject({
      decision: "allow",
      state: {
        pausedHeadSha: "head-1",
        reviewerRoundsUsed: {
          [DEFAULT_REVIEWER_KEY]: 3,
          "github-user:202": 1,
        },
        roundsUsed: 4,
      },
    });
  });

  test("enforces the aggregate cap even when a new reviewer has budget", () => {
    const finalAggregateRound = decideReviewAdmission({
      ...base,
      headSha: "head-6",
      reviewerKey: "github-user:303",
      state: epoch({
        lastReviewedHeadSha: "head-5",
        pauseReason: "reviewer_round_budget_exhausted",
        pausedHeadSha: "head-3",
        reviewerRoundsUsed: {
          [DEFAULT_REVIEWER_KEY]: 3,
          "github-user:202": 2,
        },
        roundsUsed: 5,
      }),
    });
    expect(finalAggregateRound).toMatchObject({
      decision: "allow",
      state: {
        pausedHeadSha: "head-6",
        pauseReason: "aggregate_round_budget_exhausted",
        reviewerRoundsUsed: { "github-user:303": 1 },
        roundsUsed: 6,
      },
    });
    expect(
      decideReviewAdmission({
        ...base,
        headSha: "head-7",
        reviewerKey: "github-user:404",
        state: finalAggregateRound.state,
      }),
    ).toMatchObject({
      decision: "pause",
      reason: "aggregate_round_budget_exhausted",
    });
  });

  test("marks the final allowed repair round as a merge-blocking handoff", () => {
    const roundTwo = decideReviewAdmission({ ...base, state: epoch() });
    expect(roundTwo).toMatchObject({
      decision: "allow",
      resetEpoch: false,
      state: { epoch: 1, roundsUsed: 2 },
    });

    const finalRound = decideReviewAdmission({
      ...base,
      headSha: "head-4",
      state: epoch({ lastReviewedHeadSha: "head-3", roundsUsed: 2 }),
    });
    expect(finalRound).toMatchObject({
      decision: "allow",
      resetEpoch: false,
      state: {
        pausedHeadSha: "head-4",
        pauseReason: "reviewer_round_budget_exhausted",
        roundsUsed: 3,
      },
    });
    expect(
      decideReviewAdmission({
        ...base,
        headSha: "head-5",
        state: finalRound.state,
      }),
    ).toMatchObject({
      decision: "pause",
      reason: "reviewer_round_budget_exhausted",
    });
  });

  test("marks the first review as a handoff when the configured limit is one", () => {
    expect(
      decideReviewAdmission({
        ...base,
        maxRoundsPerEpoch: 1,
        state: undefined,
      }),
    ).toMatchObject({
      decision: "allow",
      state: {
        pausedHeadSha: "head-2",
        pauseReason: "reviewer_round_budget_exhausted",
        roundsUsed: 1,
      },
    });
  });

  test("resets for a material human change within the PR epoch cap", () => {
    expect(
      decideReviewAdmission({
        ...base,
        actor: "human",
        assessment: material,
        state: epoch({ roundsUsed: 3 }),
      }),
    ).toMatchObject({
      decision: "allow",
      resetEpoch: true,
      state: { anchorHeadSha: "head-2", epoch: 2, roundsUsed: 1 },
    });
  });

  test("does not let automation award itself a fresh epoch", () => {
    expect(
      decideReviewAdmission({
        ...base,
        assessment: material,
        state: epoch({ roundsUsed: 2 }),
      }),
    ).toMatchObject({
      decision: "allow",
      resetEpoch: false,
      state: {
        epoch: 1,
        pausedHeadSha: "head-2",
        pauseReason: "reviewer_round_budget_exhausted",
        roundsUsed: 3,
      },
    });
    expect(
      decideReviewAdmission({
        ...base,
        assessment: material,
        state: epoch({ roundsUsed: 3 }),
      }),
    ).toMatchObject({
      decision: "pause",
      reason: "automation_material_change_requires_reset",
    });
  });

  test("preserves finding decisions across a new epoch", () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const findingLedger = {
      [fingerprint]: {
        disposition: "rejected" as const,
        firstSeenEpoch: 1,
        reviewId: 31,
        reviewerKey: DEFAULT_REVIEWER_KEY,
        reviewedHeadSha: "head-1",
        severity: "normal" as const,
      },
    };
    expect(
      decideReviewAdmission({
        ...base,
        actor: "human",
        assessment: material,
        state: epoch({ findingLedger }),
      }),
    ).toMatchObject({
      decision: "allow",
      resetEpoch: true,
      state: { epoch: 2, findingLedger },
    });
  });

  test("allows one evidence-fingerprinted security interrupt without resetting", () => {
    const fingerprint = `sha256:${"b".repeat(64)}`;
    const interrupted = decideReviewAdmission({
      ...base,
      headSha: "head-4",
      securityInterruptFingerprint: fingerprint,
      state: epoch({ roundsUsed: 3 }),
    });
    expect(interrupted).toMatchObject({
      decision: "allow",
      resetEpoch: false,
      state: {
        epoch: 1,
        pausedHeadSha: "head-4",
        pauseReason: "reviewer_round_budget_exhausted",
        roundsUsed: 4,
        securityInterruptFingerprints: [fingerprint],
      },
    });
    expect(
      decideReviewAdmission({
        ...base,
        headSha: "head-5",
        securityInterruptFingerprint: fingerprint,
        state: interrupted.state,
      }),
    ).toMatchObject({
      decision: "pause",
      reason: "reviewer_round_budget_exhausted",
    });
  });

  test("allows the bounded security interrupt when change evidence is inconclusive", () => {
    const fingerprint = `sha256:${"c".repeat(64)}`;
    expect(
      decideReviewAdmission({
        ...base,
        assessment: {
          changeClass: "unknown",
          changedFiles: 0,
          changedLines: 0,
          kind: "unknown",
          reasons: ["comparison_files_unavailable"],
          runtimeFiles: 0,
        },
        securityInterruptFingerprint: fingerprint,
        state: epoch({ roundsUsed: 2 }),
      }),
    ).toMatchObject({
      decision: "allow",
      resetEpoch: false,
      state: {
        pausedHeadSha: "head-2",
        pauseReason: "change_significance_unknown",
        roundsUsed: 3,
        securityInterruptFingerprints: [fingerprint],
      },
    });
  });

  test("pauses when a human material change exceeds the PR epoch cap", () => {
    expect(
      decideReviewAdmission({
        ...base,
        actor: "human",
        assessment: material,
        state: epoch({ epoch: 3, roundsUsed: 3 }),
      }),
    ).toMatchObject({
      decision: "pause",
      reason: "epoch_budget_exhausted",
    });
  });

  test("lets an explicit human reset start another epoch, even on the same head", () => {
    expect(
      decideReviewAdmission({
        ...base,
        headSha: "head-1",
        manualReset: true,
        state: epoch({ epoch: 3, roundsUsed: 3 }),
      }),
    ).toMatchObject({
      decision: "allow",
      resetEpoch: true,
      state: { epoch: 4, roundsUsed: 1 },
    });
  });

  test("keeps an approval-only reset mergeable at either one-round cap", () => {
    for (const limits of [
      { maxRoundsPerEpoch: 1, maxTotalRoundsPerEpoch: 6 },
      { maxRoundsPerEpoch: 3, maxTotalRoundsPerEpoch: 1 },
    ]) {
      const result = decideReviewAdmission({
        ...base,
        ...limits,
        headSha: "head-4",
        manualReset: true,
        startsRepairTurn: false,
        state: epoch({
          lastReviewedHeadSha: "head-3",
          pausedHeadSha: "head-4",
          pauseReason: "reviewer_round_budget_exhausted",
          roundsUsed: 3,
        }),
      });

      expect(result).toMatchObject({
        decision: "allow",
        resetEpoch: true,
        state: { epoch: 2, roundsUsed: 1 },
      });
      expect(result.state).not.toHaveProperty("pausedHeadSha");
      expect(result.state).not.toHaveProperty("pauseReason");
    }
  });

  test("pauses when significance or authorship cannot be established", () => {
    expect(
      decideReviewAdmission({
        ...base,
        assessment: undefined,
        state: epoch(),
      }),
    ).toMatchObject({
      decision: "pause",
      reason: "change_significance_unknown",
    });
    expect(
      decideReviewAdmission({
        ...base,
        actor: "unknown",
        assessment: material,
        state: epoch(),
      }),
    ).toMatchObject({
      decision: "pause",
      reason: "change_actor_unknown",
    });
  });
});
