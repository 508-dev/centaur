export const DEFAULT_REVIEW_MAX_ROUNDS_PER_EPOCH = 3;
export const DEFAULT_REVIEW_MAX_EPOCHS = 3;
export const DEFAULT_REVIEW_MATERIAL_CHANGE_LINES = 200;
export const DEFAULT_REVIEW_MATERIAL_CHANGE_FILES = 8;
export const DEFAULT_REVIEW_RESET_LABEL = "centaur-review-reset";

export type ReviewChangeFile = {
  additions?: number;
  changes?: number;
  deletions?: number;
  filename: string;
  status?: string;
};

export type ReviewChangeAssessment = {
  changedFiles: number;
  changedLines: number;
  kind: "material" | "minor" | "unknown";
  reasons: string[];
  runtimeFiles: number;
};

export type ReviewEpochState = {
  anchorHeadSha: string;
  automationPendingFromHeadSha?: string;
  epoch: number;
  lastReviewedHeadSha: string;
  pausedHeadSha?: string;
  pauseReason?: ReviewPauseReason;
  roundsUsed: number;
  version: 1;
};

export type ReviewChangeActor = "automation" | "human" | "unknown";

export type ReviewPauseReason =
  | "automation_material_change_requires_reset"
  | "change_actor_unknown"
  | "change_significance_unknown"
  | "epoch_budget_exhausted"
  | "round_budget_exhausted";

export type ReviewAdmission =
  | {
      assessment?: ReviewChangeAssessment;
      decision: "allow";
      resetEpoch: boolean;
      state: ReviewEpochState;
    }
  | {
      assessment?: ReviewChangeAssessment;
      decision: "pause";
      reason: ReviewPauseReason;
      state: ReviewEpochState;
    };

type ReviewAdmissionInput = {
  actor: ReviewChangeActor;
  assessment?: ReviewChangeAssessment;
  headSha: string;
  manualReset: boolean;
  maxEpochs: number;
  maxRoundsPerEpoch: number;
  state?: ReviewEpochState;
};

const DEPENDENCY_OR_BUILD_FILE = /(^|\/)(?:Cargo\.(?:toml|lock)|Dockerfile(?:\.[^/]+)?|Gemfile(?:\.lock)?|go\.(?:mod|sum)|package(?:-lock)?\.json|pnpm-lock\.yaml|pyproject\.toml|requirements[^/]*\.txt|uv\.lock|yarn\.lock)$/i;
const CRITICAL_PATH = /(^|\/)(?:auth(?:entication|orization)?|permissions?|polic(?:y|ies)|security|migrations?|schema)(?:[._/-]|$)/i;
const DEPLOYMENT_PATH = /(^|\/)(?:\.github\/workflows|charts?|contrib\/chart|deploy|helm|k8s|kubernetes)(?:\/|$)/i;
const API_CONTRACT_FILE = /(^|\/)(?:openapi|asyncapi|[^/]+\.proto)(?:[._/-]|$)/i;
const NON_RUNTIME_PATH = /(^|\/)(?:docs?|examples?|fixtures?|snapshots?|tests?|testdata)(?:\/|$)|(?:\.md|\.mdx|\.rst|\.snap)$|(?:^|\.)test\.[^/]+$|(?:^|\.)spec\.[^/]+$/i;

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function fileChanges(file: ReviewChangeFile): number {
  const explicit = nonNegative(file.changes);
  if (explicit > 0) return explicit;
  return nonNegative(file.additions) + nonNegative(file.deletions);
}

function isCriticalBoundary(filename: string): boolean {
  return (
    DEPENDENCY_OR_BUILD_FILE.test(filename) ||
    CRITICAL_PATH.test(filename) ||
    DEPLOYMENT_PATH.test(filename) ||
    API_CONTRACT_FILE.test(filename)
  );
}

export function assessReviewChange(input: {
  comparisonStatus?: string;
  files?: ReviewChangeFile[];
  fileThreshold?: number;
  lineThreshold?: number;
}): ReviewChangeAssessment {
  const files = input.files;
  if (!files) {
    return {
      changedFiles: 0,
      changedLines: 0,
      kind: "unknown",
      reasons: ["comparison_files_unavailable"],
      runtimeFiles: 0,
    };
  }

  const comparisonStatus = input.comparisonStatus?.toLowerCase();
  if (comparisonStatus && !["ahead", "identical"].includes(comparisonStatus)) {
    return {
      changedFiles: files.length,
      changedLines: files.reduce((sum, file) => sum + fileChanges(file), 0),
      kind: "unknown",
      reasons: [`non_linear_comparison:${comparisonStatus}`],
      runtimeFiles: files.filter((file) => !NON_RUNTIME_PATH.test(file.filename))
        .length,
    };
  }

  const lineThreshold =
    input.lineThreshold ?? DEFAULT_REVIEW_MATERIAL_CHANGE_LINES;
  const fileThreshold =
    input.fileThreshold ?? DEFAULT_REVIEW_MATERIAL_CHANGE_FILES;
  const runtime = files.filter((file) => !NON_RUNTIME_PATH.test(file.filename));
  const changedLines = runtime.reduce(
    (sum, file) => sum + fileChanges(file),
    0,
  );
  const criticalFiles = runtime
    .map((file) => file.filename)
    .filter(isCriticalBoundary);
  const reasons: string[] = [];

  if (files.length >= 300) reasons.push("github_comparison_file_cap");
  if (criticalFiles.length > 0) {
    reasons.push(`critical_boundary:${criticalFiles.slice(0, 3).join(",")}`);
  }
  if (changedLines >= lineThreshold) {
    reasons.push(`runtime_lines:${changedLines}>=${lineThreshold}`);
  }
  if (runtime.length >= fileThreshold) {
    reasons.push(`runtime_files:${runtime.length}>=${fileThreshold}`);
  }
  if (runtime.some((file) => file.status?.toLowerCase() === "removed")) {
    reasons.push("runtime_file_removed");
  }

  return {
    changedFiles: files.length,
    changedLines,
    kind: reasons.length > 0 ? "material" : "minor",
    reasons: reasons.length > 0 ? reasons : ["below_material_change_thresholds"],
    runtimeFiles: runtime.length,
  };
}

function nextEpoch(state: ReviewEpochState, headSha: string): ReviewEpochState {
  return {
    anchorHeadSha: headSha,
    automationPendingFromHeadSha: headSha,
    epoch: state.epoch + 1,
    lastReviewedHeadSha: headSha,
    roundsUsed: 1,
    version: 1,
  };
}

function nextRound(state: ReviewEpochState, headSha: string): ReviewEpochState {
  return {
    ...state,
    automationPendingFromHeadSha: headSha,
    lastReviewedHeadSha: headSha,
    pausedHeadSha: undefined,
    pauseReason: undefined,
    roundsUsed: state.roundsUsed + 1,
  };
}

function paused(
  state: ReviewEpochState,
  headSha: string,
  reason: ReviewPauseReason,
): ReviewEpochState {
  return { ...state, pausedHeadSha: headSha, pauseReason: reason };
}

export function decideReviewAdmission(
  input: ReviewAdmissionInput,
): ReviewAdmission {
  const existing = input.state;
  if (!existing) {
    return {
      decision: "allow",
      resetEpoch: false,
      state: {
        anchorHeadSha: input.headSha,
        automationPendingFromHeadSha: input.headSha,
        epoch: 1,
        lastReviewedHeadSha: input.headSha,
        roundsUsed: 1,
        version: 1,
      },
    };
  }

  if (input.manualReset) {
    return {
      assessment: input.assessment,
      decision: "allow",
      resetEpoch: true,
      state: nextEpoch(existing, input.headSha),
    };
  }

  if (existing.lastReviewedHeadSha === input.headSha) {
    if (existing.roundsUsed >= input.maxRoundsPerEpoch) {
      return {
        decision: "pause",
        reason: "round_budget_exhausted",
        state: paused(existing, input.headSha, "round_budget_exhausted"),
      };
    }
    return {
      decision: "allow",
      resetEpoch: false,
      state: nextRound(existing, input.headSha),
    };
  }

  if (!input.assessment || input.assessment.kind === "unknown") {
    return {
      assessment: input.assessment,
      decision: "pause",
      reason: "change_significance_unknown",
      state: paused(existing, input.headSha, "change_significance_unknown"),
    };
  }

  if (input.assessment.kind === "material") {
    if (input.actor === "human") {
      if (existing.epoch >= input.maxEpochs) {
        return {
          assessment: input.assessment,
          decision: "pause",
          reason: "epoch_budget_exhausted",
          state: paused(existing, input.headSha, "epoch_budget_exhausted"),
        };
      }
      return {
        assessment: input.assessment,
        decision: "allow",
        resetEpoch: true,
        state: nextEpoch(existing, input.headSha),
      };
    }
    if (input.actor === "unknown") {
      return {
        assessment: input.assessment,
        decision: "pause",
        reason: "change_actor_unknown",
        state: paused(existing, input.headSha, "change_actor_unknown"),
      };
    }
    if (existing.roundsUsed >= input.maxRoundsPerEpoch) {
      return {
        assessment: input.assessment,
        decision: "pause",
        reason: "automation_material_change_requires_reset",
        state: paused(
          existing,
          input.headSha,
          "automation_material_change_requires_reset",
        ),
      };
    }
    return {
      assessment: input.assessment,
      decision: "allow",
      resetEpoch: false,
      state: nextRound(existing, input.headSha),
    };
  }

  if (existing.roundsUsed >= input.maxRoundsPerEpoch) {
    return {
      assessment: input.assessment,
      decision: "pause",
      reason: "round_budget_exhausted",
      state: paused(existing, input.headSha, "round_budget_exhausted"),
    };
  }

  return {
    assessment: input.assessment,
    decision: "allow",
    resetEpoch: false,
    state: nextRound(existing, input.headSha),
  };
}
