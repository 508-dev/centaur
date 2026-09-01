import type { ReviewFindingLedger } from "./review-findings";

export const DEFAULT_REVIEW_MAX_ROUNDS_PER_EPOCH = 3;
export const DEFAULT_REVIEW_MAX_TOTAL_ROUNDS_PER_EPOCH = 6;
export const DEFAULT_REVIEW_MAX_EPOCHS = 3;
export const DEFAULT_REVIEW_MAX_SECURITY_INTERRUPTS_PER_PR = 1;
export const MAX_REVIEW_SECURITY_INTERRUPTS_PER_PR = 16;
export const DEFAULT_REVIEW_MATERIAL_CHANGE_LINES = 200;
export const DEFAULT_REVIEW_MATERIAL_CHANGE_FILES = 8;
export const DEFAULT_REVIEW_RESET_LABEL = "centaur-review-reset";

export type ReviewChangeFile = {
  additions?: number;
  changes?: number;
  deletions?: number;
  filename: string;
  patch?: string;
  status?: string;
};

export type ReviewChangeAssessment = {
  changeClass: "maintenance" | "new_risk" | "repair" | "unknown";
  changedFiles: number;
  changedLines: number;
  kind: "material" | "minor" | "unknown";
  reasons: string[];
  runtimeFiles: number;
};

export type ReviewEpochState = {
  anchorHeadSha: string;
  automationPendingFromHeadSha?: string;
  consumedResetApprovalId?: string;
  epoch: number;
  findingLedger?: ReviewFindingLedger;
  lastReviewedHeadSha: string;
  pausedHeadSha?: string;
  pauseReason?: ReviewPauseReason;
  reviewerRoundsUsed?: Record<string, number>;
  roundsUsed: number;
  securityInterruptFingerprints?: string[];
  version: 1;
};

export type ReviewChangeActor = "automation" | "human" | "unknown";

export type ReviewPauseReason =
  | "automation_material_change_requires_reset"
  | "change_actor_unknown"
  | "change_significance_unknown"
  | "epoch_budget_exhausted"
  | "aggregate_round_budget_exhausted"
  | "reviewer_round_budget_exhausted"
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
  maxSecurityInterruptsPerPr?: number;
  maxTotalRoundsPerEpoch: number;
  reviewerKey: string;
  securityInterruptFingerprint?: string;
  startsRepairTurn: boolean;
  state?: ReviewEpochState;
};

const DEPENDENCY_OR_BUILD_FILE = /(^|\/)(?:Cargo\.(?:toml|lock)|Dockerfile(?:\.[^/]+)?|Gemfile(?:\.lock)?|go\.(?:mod|sum)|package(?:-lock)?\.json|pnpm-lock\.yaml|pyproject\.toml|requirements[^/]*\.txt|uv\.lock|yarn\.lock)$/i;
const MIGRATION_PATH = /(^|\/)(?:migrations?|schema)(?:[._\/-]|$)/i;
const AUTH_DATA_API_PATH = /(^|\/)(?:api|auth(?:entication|orization)?|data|permissions?|polic(?:y|ies)|security)(?:[._\/-]|$)/i;
const DEPLOYMENT_PATH = /(^|\/)(?:\.github\/workflows|charts?|contrib\/chart|deploy|helm|k8s|kubernetes)(?:\/|$)/i;
const API_CONTRACT_FILE = /(^|\/)(?:openapi|asyncapi|[^/]+\.proto)(?:[._\/-]|$)/i;
const NON_RUNTIME_PATH = /(^|\/)(?:docs?|examples?|fixtures?|generated|snapshots?|tests?|testdata|vendor)(?:\/|$)|(?:\.md|\.mdx|\.rst|\.snap)$|(?:^|\.)test\.[^/]+$|(?:^|\.)spec\.[^/]+$/i;

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
    MIGRATION_PATH.test(filename) ||
    AUTH_DATA_API_PATH.test(filename) ||
    DEPLOYMENT_PATH.test(filename) ||
    API_CONTRACT_FILE.test(filename)
  );
}

export function assessReviewChange(input: {
  acceptedFindingPaths?: ReadonlySet<string>;
  comparisonStatus?: string;
  files?: ReviewChangeFile[];
  fileThreshold?: number;
  lineThreshold?: number;
  treeUnchanged?: boolean;
}): ReviewChangeAssessment {
  const files = input.files;
  if (input.treeUnchanged === true) {
    return {
      changeClass: "maintenance",
      changedFiles: files?.length ?? 0,
      changedLines: 0,
      kind: "minor",
      reasons: ["tree_unchanged"],
      runtimeFiles: 0,
    };
  }
  if (!files) {
    return {
      changeClass: "unknown",
      changedFiles: 0,
      changedLines: 0,
      kind: "unknown",
      reasons: ["comparison_files_unavailable"],
      runtimeFiles: 0,
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

  // GitHub caps comparison files at 300. The visible prefix cannot prove that
  // an omitted file did not add a risk boundary, so this is inconclusive.
  if (files.length >= 300) {
    return {
      changeClass: "unknown",
      changedFiles: files.length,
      changedLines,
      kind: "unknown",
      reasons: ["github_comparison_file_cap"],
      runtimeFiles: runtime.length,
    };
  }

  const comparisonStatus = input.comparisonStatus?.toLowerCase();
  if (comparisonStatus && !["ahead", "identical"].includes(comparisonStatus)) {
    return {
      changeClass: "unknown",
      changedFiles: files.length,
      changedLines,
      kind: "unknown",
      reasons: [`non_linear_comparison:${comparisonStatus}`],
      runtimeFiles: runtime.length,
    };
  }

  if (runtime.length === 0) {
    return {
      changeClass: "maintenance",
      changedFiles: files.length,
      changedLines: 0,
      kind: "minor",
      reasons: ["non_runtime_or_generated_only"],
      runtimeFiles: runtime.length,
    };
  }

  const semanticRuntime = runtime.filter((file) => !isFormattingOnly(file));
  if (semanticRuntime.length === 0) {
    return {
      changeClass: "maintenance",
      changedFiles: files.length,
      changedLines,
      kind: "minor",
      reasons: ["formatting_only"],
      runtimeFiles: runtime.length,
    };
  }

  const criticalFiles = semanticRuntime
    .map((file) => file.filename)
    .filter(isCriticalBoundary);
  const acceptedPaths = input.acceptedFindingPaths ?? new Set<string>();
  const boundedAcceptedRepair =
    semanticRuntime.every((file) => acceptedPaths.has(file.filename)) &&
    criticalFiles.length === 0 &&
    changedLines < lineThreshold &&
    runtime.length < fileThreshold &&
    !runtime.some((file) =>
      ["added", "removed", "renamed"].includes(file.status?.toLowerCase() ?? ""),
    );
  if (boundedAcceptedRepair) {
    return {
      changeClass: "repair",
      changedFiles: files.length,
      changedLines,
      kind: "minor",
      reasons: ["accepted_finding_repair"],
      runtimeFiles: runtime.length,
    };
  }

  const reasons: string[] = [];
  const dependencyFiles = criticalFiles.filter((file) =>
    DEPENDENCY_OR_BUILD_FILE.test(file),
  );
  const migrationFiles = criticalFiles.filter((file) =>
    MIGRATION_PATH.test(file),
  );
  const authDataApiFiles = criticalFiles.filter((file) =>
    AUTH_DATA_API_PATH.test(file) || API_CONTRACT_FILE.test(file),
  );
  const deploymentFiles = criticalFiles.filter((file) =>
    DEPLOYMENT_PATH.test(file),
  );
  if (dependencyFiles.length > 0) {
    reasons.push(`dependency_or_build:${dependencyFiles.slice(0, 3).join(",")}`);
  }
  if (migrationFiles.length > 0) {
    reasons.push(`migration_or_schema:${migrationFiles.slice(0, 3).join(",")}`);
  }
  if (authDataApiFiles.length > 0) {
    reasons.push(`auth_data_api_boundary:${authDataApiFiles.slice(0, 3).join(",")}`);
  }
  if (deploymentFiles.length > 0) {
    reasons.push(`deployment_boundary:${deploymentFiles.slice(0, 3).join(",")}`);
  }
  if (changedLines >= lineThreshold) {
    reasons.push(`runtime_lines:${changedLines}>=${lineThreshold}`);
  }
  if (runtime.length >= fileThreshold) {
    reasons.push(`runtime_files:${runtime.length}>=${fileThreshold}`);
  }
  if (
    runtime.some((file) =>
      ["added", "removed", "renamed"].includes(file.status?.toLowerCase() ?? ""),
    )
  ) {
    reasons.push("runtime_surface_changed");
  }
  if (reasons.length === 0) reasons.push("runtime_behavior_changed");

  return {
    changeClass: "new_risk",
    changedFiles: files.length,
    changedLines,
    kind: "material",
    reasons,
    runtimeFiles: runtime.length,
  };
}

function isFormattingOnly(file: ReviewChangeFile): boolean {
  if (!file.patch) return fileChanges(file) === 0;
  const added = new Map<string, number>();
  const removed = new Map<string, number>();
  for (const line of file.patch.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    const target = line.startsWith("+")
      ? added
      : line.startsWith("-")
        ? removed
        : undefined;
    if (!target) continue;
    // Only ignore blank lines and trailing whitespace. Leading indentation and
    // whitespace inside strings can be behavioral, so treating all whitespace
    // as cosmetic would allow real changes to masquerade as formatting.
    const normalized = line.slice(1).trimEnd();
    if (!normalized) continue;
    target.set(normalized, (target.get(normalized) ?? 0) + 1);
  }
  for (const [line, additions] of added) {
    const cancellations = Math.min(additions, removed.get(line) ?? 0);
    if (cancellations > 0) {
      added.set(line, additions - cancellations);
      removed.set(line, (removed.get(line) ?? 0) - cancellations);
    }
  }
  return (
    Array.from(added.values()).every((count) => count === 0) &&
    Array.from(removed.values()).every((count) => count === 0)
  );
}

function firstEpoch(
  headSha: string,
  reviewerKey: string,
  epoch = 1,
): ReviewEpochState {
  return {
    anchorHeadSha: headSha,
    automationPendingFromHeadSha: headSha,
    epoch,
    lastReviewedHeadSha: headSha,
    reviewerRoundsUsed: { [reviewerKey]: 1 },
    roundsUsed: 1,
    version: 1,
  };
}

function nextEpoch(
  state: ReviewEpochState,
  headSha: string,
  reviewerKey: string,
): ReviewEpochState {
  return {
    ...firstEpoch(headSha, reviewerKey, state.epoch + 1),
    findingLedger: state.findingLedger,
    securityInterruptFingerprints: state.securityInterruptFingerprints,
  };
}

function reviewerRounds(
  state: ReviewEpochState,
  reviewerKey: string,
): number {
  if (!state.reviewerRoundsUsed) return state.roundsUsed;
  return state.reviewerRoundsUsed[reviewerKey] ?? 0;
}

function nextRound(
  state: ReviewEpochState,
  headSha: string,
  reviewerKey: string,
): ReviewEpochState {
  const reviewerRoundsUsed = state.reviewerRoundsUsed
    ? { ...state.reviewerRoundsUsed }
    : { [reviewerKey]: state.roundsUsed };
  reviewerRoundsUsed[reviewerKey] =
    (reviewerRoundsUsed[reviewerKey] ?? 0) + 1;
  return {
    ...state,
    automationPendingFromHeadSha: headSha,
    lastReviewedHeadSha: headSha,
    reviewerRoundsUsed,
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

function withFinalRoundHandoff(
  state: ReviewEpochState,
  headSha: string,
  reviewerKey: string,
  maxRoundsPerEpoch: number,
  maxTotalRoundsPerEpoch: number,
  startsRepairTurn: boolean,
): ReviewEpochState {
  if (!startsRepairTurn) return state;
  if (state.roundsUsed >= maxTotalRoundsPerEpoch) {
    return paused(state, headSha, "aggregate_round_budget_exhausted");
  }
  if (reviewerRounds(state, reviewerKey) >= maxRoundsPerEpoch) {
    return state.pausedHeadSha
      ? state
      : paused(state, headSha, "reviewer_round_budget_exhausted");
  }
  return state;
}

function securityInterruptAdmission(
  input: ReviewAdmissionInput,
  state: ReviewEpochState,
  pauseReason: ReviewPauseReason,
): Extract<ReviewAdmission, { decision: "allow" }> | undefined {
  const fingerprint = input.securityInterruptFingerprint;
  if (!fingerprint) return undefined;
  const consumed = state.securityInterruptFingerprints ?? [];
  if (consumed.includes(fingerprint)) return undefined;
  if (
    consumed.length >=
    Math.min(
      input.maxSecurityInterruptsPerPr ??
        DEFAULT_REVIEW_MAX_SECURITY_INTERRUPTS_PER_PR,
      MAX_REVIEW_SECURITY_INTERRUPTS_PER_PR,
    )
  ) {
    return undefined;
  }
  const next = nextRound(state, input.headSha, input.reviewerKey);
  return {
    assessment: input.assessment,
    decision: "allow",
    resetEpoch: false,
    state: {
      ...next,
      pausedHeadSha: input.headSha,
      pauseReason,
      securityInterruptFingerprints: [...consumed, fingerprint],
    },
  };
}

function exhaustedAdmission(
  input: ReviewAdmissionInput,
  state: ReviewEpochState,
  reviewerReason: ReviewPauseReason = "reviewer_round_budget_exhausted",
): ReviewAdmission | undefined {
  if (state.roundsUsed >= input.maxTotalRoundsPerEpoch) {
    return (
      securityInterruptAdmission(
        input,
        state,
        "aggregate_round_budget_exhausted",
      ) ?? {
        assessment: input.assessment,
        decision: "pause",
        reason: "aggregate_round_budget_exhausted",
        state: paused(
          state,
          input.headSha,
          "aggregate_round_budget_exhausted",
        ),
      }
    );
  }
  if (reviewerRounds(state, input.reviewerKey) >= input.maxRoundsPerEpoch) {
    return (
      securityInterruptAdmission(input, state, reviewerReason) ?? {
        assessment: input.assessment,
        decision: "pause",
        reason: reviewerReason,
        state: paused(state, input.headSha, reviewerReason),
      }
    );
  }
  return undefined;
}

export function decideReviewAdmission(
  input: ReviewAdmissionInput,
): ReviewAdmission {
  const existing = input.state;
  if (!existing) {
    const state = firstEpoch(input.headSha, input.reviewerKey);
    return {
      decision: "allow",
      resetEpoch: false,
      state: withFinalRoundHandoff(
        state,
        input.headSha,
        input.reviewerKey,
        input.maxRoundsPerEpoch,
        input.maxTotalRoundsPerEpoch,
        input.startsRepairTurn,
      ),
    };
  }

  if (input.manualReset) {
    return {
      assessment: input.assessment,
      decision: "allow",
      resetEpoch: true,
      state: withFinalRoundHandoff(
        nextEpoch(existing, input.headSha, input.reviewerKey),
        input.headSha,
        input.reviewerKey,
        input.maxRoundsPerEpoch,
        input.maxTotalRoundsPerEpoch,
        input.startsRepairTurn,
      ),
    };
  }

  if (existing.lastReviewedHeadSha === input.headSha) {
    const exhausted = exhaustedAdmission(input, existing);
    if (exhausted) return exhausted;
    return {
      decision: "allow",
      resetEpoch: false,
      state: withFinalRoundHandoff(
        nextRound(existing, input.headSha, input.reviewerKey),
        input.headSha,
        input.reviewerKey,
        input.maxRoundsPerEpoch,
        input.maxTotalRoundsPerEpoch,
        input.startsRepairTurn,
      ),
    };
  }

  if (!input.assessment || input.assessment.kind === "unknown") {
    return (
      securityInterruptAdmission(
        input,
        existing,
        "change_significance_unknown",
      ) ?? {
        assessment: input.assessment,
        decision: "pause",
        reason: "change_significance_unknown",
        state: paused(existing, input.headSha, "change_significance_unknown"),
      }
    );
  }

  if (input.assessment.kind === "material") {
    if (input.actor === "human") {
      if (existing.epoch >= input.maxEpochs) {
        return (
          securityInterruptAdmission(
            input,
            existing,
            "epoch_budget_exhausted",
          ) ?? {
            assessment: input.assessment,
            decision: "pause",
            reason: "epoch_budget_exhausted",
            state: paused(existing, input.headSha, "epoch_budget_exhausted"),
          }
        );
      }
      return {
        assessment: input.assessment,
        decision: "allow",
        resetEpoch: true,
        state: withFinalRoundHandoff(
          nextEpoch(existing, input.headSha, input.reviewerKey),
          input.headSha,
          input.reviewerKey,
          input.maxRoundsPerEpoch,
          input.maxTotalRoundsPerEpoch,
          input.startsRepairTurn,
        ),
      };
    }
    if (input.actor === "unknown") {
      return (
        securityInterruptAdmission(input, existing, "change_actor_unknown") ?? {
          assessment: input.assessment,
          decision: "pause",
          reason: "change_actor_unknown",
          state: paused(existing, input.headSha, "change_actor_unknown"),
        }
      );
    }
    const exhausted = exhaustedAdmission(
      input,
      existing,
      "automation_material_change_requires_reset",
    );
    if (exhausted) return exhausted;
    return {
      assessment: input.assessment,
      decision: "allow",
      resetEpoch: false,
      state: withFinalRoundHandoff(
        nextRound(existing, input.headSha, input.reviewerKey),
        input.headSha,
        input.reviewerKey,
        input.maxRoundsPerEpoch,
        input.maxTotalRoundsPerEpoch,
        input.startsRepairTurn,
      ),
    };
  }

  const exhausted = exhaustedAdmission(input, existing);
  if (exhausted) return exhausted;

  return {
    assessment: input.assessment,
    decision: "allow",
    resetEpoch: false,
    state: withFinalRoundHandoff(
      nextRound(existing, input.headSha, input.reviewerKey),
      input.headSha,
      input.reviewerKey,
      input.maxRoundsPerEpoch,
      input.maxTotalRoundsPerEpoch,
      input.startsRepairTurn,
    ),
  };
}
