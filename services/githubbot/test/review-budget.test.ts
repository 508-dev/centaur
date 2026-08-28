import { describe, expect, test } from "bun:test";
import {
  assessReviewChange,
  decideReviewAdmission,
  type ReviewEpochState,
} from "../src/review-budget";

const epoch = (overrides: Partial<ReviewEpochState> = {}): ReviewEpochState => ({
  anchorHeadSha: "head-1",
  automationPendingFromHeadSha: "head-1",
  epoch: 1,
  lastReviewedHeadSha: "head-1",
  roundsUsed: 1,
  version: 1,
  ...overrides,
});

describe("assessReviewChange", () => {
  test("keeps a small runtime change in the current epoch", () => {
    expect(
      assessReviewChange({
        comparisonStatus: "ahead",
        files: [{ changes: 12, filename: "services/githubbot/src/turn.ts" }],
      }),
    ).toMatchObject({
      changedLines: 12,
      kind: "minor",
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

  test("uses cumulative runtime size thresholds", () => {
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

  test("requires human judgment for a non-linear comparison", () => {
    expect(
      assessReviewChange({
        comparisonStatus: "diverged",
        files: [{ changes: 1, filename: "src/one.ts" }],
      }),
    ).toMatchObject({
      kind: "unknown",
      reasons: ["non_linear_comparison:diverged"],
    });
  });
});

describe("decideReviewAdmission", () => {
  const minor = assessReviewChange({
    comparisonStatus: "ahead",
    files: [{ changes: 5, filename: "src/one.ts" }],
  });
  const material = assessReviewChange({
    comparisonStatus: "ahead",
    files: [{ changes: 5, filename: "src/authorization.ts" }],
  });
  const base = {
    actor: "automation" as const,
    assessment: minor,
    headSha: "head-2",
    manualReset: false,
    maxEpochs: 3,
    maxRoundsPerEpoch: 3,
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
        roundsUsed: 1,
        version: 1,
      },
    });
  });

  test("counts repeated reviews of the same head against the bounded epoch", () => {
    expect(
      decideReviewAdmission({ ...base, headSha: "head-1", state: epoch() }),
    ).toMatchObject({ decision: "allow", state: { roundsUsed: 2 } });
  });

  test("allows two repair-validation rounds then pauses", () => {
    const roundTwo = decideReviewAdmission({ ...base, state: epoch() });
    expect(roundTwo).toMatchObject({
      decision: "allow",
      resetEpoch: false,
      state: { epoch: 1, roundsUsed: 2 },
    });
    expect(
      decideReviewAdmission({
        ...base,
        headSha: "head-4",
        state: epoch({ lastReviewedHeadSha: "head-3", roundsUsed: 3 }),
      }),
    ).toMatchObject({
      decision: "pause",
      reason: "round_budget_exhausted",
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
      state: { epoch: 1, roundsUsed: 3 },
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
