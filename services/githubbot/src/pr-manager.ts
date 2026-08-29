import type { GitHubAdapter } from "@chat-adapter/github";
import type { StateAdapter } from "chat";
import { isReviewAuthorAllowed } from "./authorization";
import { backgroundWaitUntil, runExclusive } from "./context";
import { reactWorkingOnReview, settleReviewReaction } from "./reactions";
import {
  assessReviewChange,
  decideReviewAdmission,
  DEFAULT_REVIEW_MATERIAL_CHANGE_FILES,
  DEFAULT_REVIEW_MATERIAL_CHANGE_LINES,
  DEFAULT_REVIEW_MAX_EPOCHS,
  DEFAULT_REVIEW_MAX_ROUNDS_PER_EPOCH,
  DEFAULT_REVIEW_MAX_TOTAL_ROUNDS_PER_EPOCH,
  DEFAULT_REVIEW_RESET_LABEL,
  type ReviewAdmission,
  type ReviewChangeActor,
  type ReviewChangeAssessment,
  type ReviewChangeFile,
  type ReviewEpochState,
} from "./review-budget";
import { runTurnStream } from "./turn";
import {
  fetchCiEvaluation,
  maybeEmitReviewSubmitted,
  prepareCiCompleted,
  type CiEvaluation,
} from "./workflow-events";
import type {
  ForwardSessionInput,
  GithubbotApiMessage,
  GithubbotOptions,
  GithubbotTrace,
} from "./types";
import { errorMessage, noopLogger, nowMs, stringValue, traceLog } from "./utils";

/**
 * v2: PR self-management for PRs the bot owns (it authored them, or they carry
 * the managed label). Reacts to PR/review/CI lifecycle webhooks to drive an
 * owned PR toward merge:
 *  - Fix CI    — once *all* checks for a head SHA are settled and red, run a
 *                bounded fix turn (the agent diagnoses + pushes via gh).
 *  - Address review — one holistic turn per submitted review.
 *  - Merge     — deterministic: when GitHub reports the PR mergeable (clean),
 *                the bot merges it directly (no agent — branch protection is the
 *                source of truth). dirty -> conflict turn; behind -> update.
 * Escalation tags a human and stops; the bot backs off human-authored commits.
 */
/** The Octokit instance the GitHub adapter exposes (its `.octokit` getter). */
type Octokit = GitHubAdapter["octokit"];

export type PrManagerContext = {
  octokit: Octokit;
  options: GithubbotOptions;
  state: StateAdapter;
  userName: string;
};

const STATE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CI_FIX_MAX_ATTEMPTS = 3;
const REVIEW_STATE_RETRY_DELAYS_MS = [0, 100, 500, 1_000, 5_000, 10_000, 30_000];

// ---------------------------------------------------------------------------
// Pure decision helpers (unit-tested without GitHub).
// ---------------------------------------------------------------------------

/**
 * A PR is bot-owned when the bot is one of its assignees. Ownership is purely an
 * assignment mechanism: assign the PR to the bot to have it manage the PR toward
 * merge (and unassign to hand it back).
 */
export function isOwnedPr(input: {
  assignees: string[];
  userName: string;
}): boolean {
  const target = input.userName.toLowerCase();
  return input.assignees.some((login) => login.toLowerCase() === target);
}

export type MergeDecision =
  | "merge"
  | "resolve_conflict"
  | "update_branch"
  | "wait"
  | "skip_disabled"
  | "skip_hold"
  | "skip_draft"
  | "skip_closed";

/**
 * Whether (and how) to act on merge-readiness. Branch protection is the source
 * of truth, surfaced as mergeable_state: only "clean" merges; "dirty" needs a
 * conflict turn; "behind" needs a branch update; everything else waits.
 */
export function decideMerge(input: {
  autoMerge: boolean;
  draft: boolean;
  holdLabel: string;
  labels: string[];
  merged: boolean;
  mergeableState: string;
  state: string;
}): MergeDecision {
  if (!input.autoMerge) return "skip_disabled";
  if (input.merged || input.state !== "open") return "skip_closed";
  if (input.draft) return "skip_draft";
  if (input.labels.map((l) => l.toLowerCase()).includes(input.holdLabel.toLowerCase())) {
    return "skip_hold";
  }
  if (input.mergeableState === "dirty") return "resolve_conflict";
  if (input.mergeableState === "behind") return "update_branch";
  if (input.mergeableState === "clean") return "merge";
  // blocked / unstable / unknown / has_hooks -> not cleanly mergeable yet.
  return "wait";
}

// ---------------------------------------------------------------------------
// Per-PR state (stored as a JSON blob in the shared KV).
// ---------------------------------------------------------------------------

type PrState = {
  consecutiveCiFixes?: number;
};

function prKey(ctx: PrManagerContext, owner: string, repo: string, n: number): string {
  return `${ctx.options.stateKeyPrefix ?? "centaur-githubbot"}:pr:${owner}/${repo}#${n}`;
}

function reviewBudgetKey(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  n: number,
): string {
  return `${ctx.options.stateKeyPrefix ?? "centaur-githubbot"}:review-budget:${owner}/${repo}#${n}`;
}

function reviewBudgetLockKey(owner: string, repo: string, n: number): string {
  return `review-budget:${owner}/${repo}#${n}`;
}

function reviewResetApprovalKey(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  n: number,
  headSha: string,
): string {
  return `${ctx.options.stateKeyPrefix ?? "centaur-githubbot"}:review-reset:${owner}/${repo}#${n}:${headSha}`;
}

export function managementThreadKey(
  owner: string,
  repo: string,
  n: number,
): string {
  return `github-manage:${owner}/${repo}:${n}`;
}

async function loadState(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  n: number,
): Promise<PrState> {
  try {
    return (await ctx.state.get<PrState>(prKey(ctx, owner, repo, n))) ?? {};
  } catch {
    return {};
  }
}

async function saveState(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  n: number,
  value: PrState,
): Promise<void> {
  try {
    await ctx.state.set(prKey(ctx, owner, repo, n), value, STATE_TTL_MS);
  } catch (error) {
    logger(ctx).debug("githubbot_pr_state_save_failed", {
      error: errorMessage(error),
    });
  }
}

type ReviewResetApproval = {
  approvalId: string;
  approvedBy: string;
  headSha: string;
};

type ReviewBudgetLoadResult =
  | { ok: true; state?: ReviewEpochState }
  | { ok: false };

function isReviewEpochState(value: unknown): value is ReviewEpochState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ReviewEpochState>;
  const reviewerRounds = candidate.reviewerRoundsUsed;
  const validReviewerRounds =
    reviewerRounds === undefined ||
    (reviewerRounds !== null &&
      typeof reviewerRounds === "object" &&
      !Array.isArray(reviewerRounds) &&
      Object.entries(reviewerRounds).every(
        ([key, rounds]) =>
          key.length > 0 &&
          typeof rounds === "number" &&
          Number.isInteger(rounds) &&
          rounds > 0,
      ) &&
      Object.values(reviewerRounds).reduce((sum, rounds) => sum + rounds, 0) ===
        candidate.roundsUsed);
  return (
    candidate.version === 1 &&
    typeof candidate.anchorHeadSha === "string" &&
    typeof candidate.lastReviewedHeadSha === "string" &&
    typeof candidate.epoch === "number" &&
    Number.isInteger(candidate.epoch) &&
    candidate.epoch > 0 &&
    typeof candidate.roundsUsed === "number" &&
    Number.isInteger(candidate.roundsUsed) &&
    candidate.roundsUsed > 0 &&
    (candidate.automationPendingFromHeadSha === undefined ||
      typeof candidate.automationPendingFromHeadSha === "string") &&
    (candidate.consumedResetApprovalId === undefined ||
      typeof candidate.consumedResetApprovalId === "string") &&
    (candidate.pausedHeadSha === undefined ||
      typeof candidate.pausedHeadSha === "string") &&
    validReviewerRounds &&
    (candidate.pauseReason === undefined ||
      [
        "aggregate_round_budget_exhausted",
        "automation_material_change_requires_reset",
        "change_actor_unknown",
        "change_significance_unknown",
        "epoch_budget_exhausted",
        "reviewer_round_budget_exhausted",
        "round_budget_exhausted",
      ].includes(candidate.pauseReason))
  );
}

async function readReviewBudget(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  n: number,
): Promise<ReviewBudgetLoadResult> {
  const value = await ctx.state.get<unknown>(
    reviewBudgetKey(ctx, owner, repo, n),
  );
  if (value === undefined || value === null) return { ok: true };
  if (!isReviewEpochState(value)) {
    logger(ctx).warn("githubbot_review_budget_invalid", {
      pr: `${owner}/${repo}#${n}`,
    });
    return { ok: false };
  }
  return { ok: true, state: value };
}

async function loadReviewBudget(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  n: number,
): Promise<ReviewBudgetLoadResult> {
  try {
    return await readReviewBudget(ctx, owner, repo, n);
  } catch (error) {
    logger(ctx).warn("githubbot_review_budget_load_failed", {
      error: errorMessage(error),
      pr: `${owner}/${repo}#${n}`,
    });
    return { ok: false };
  }
}

async function readReviewResetApproval(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  n: number,
  headSha: string,
): Promise<ReviewResetApproval | undefined> {
  const value = await ctx.state.get<unknown>(
    reviewResetApprovalKey(ctx, owner, repo, n, headSha),
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const approval = value as Partial<ReviewResetApproval>;
  if (
    approval.headSha !== headSha ||
    typeof approval.approvalId !== "string" ||
    !approval.approvalId ||
    typeof approval.approvedBy !== "string"
  ) {
    return undefined;
  }
  return {
    approvalId: approval.approvalId,
    approvedBy: approval.approvedBy,
    headSha,
  };
}

async function retryingReviewStateOperation<T>(
  ctx: PrManagerContext,
  event: string,
  pr: string,
  operation: () => Promise<T>,
): Promise<T> {
  let failureCount = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      const delayMs =
        REVIEW_STATE_RETRY_DELAYS_MS[
          Math.min(failureCount, REVIEW_STATE_RETRY_DELAYS_MS.length - 1)
        ] ?? 30_000;
      failureCount += 1;
      logger(ctx).warn(event, {
        attempt: failureCount,
        error: errorMessage(error),
        pr,
        retry_in_ms: delayMs,
      });
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        await Promise.resolve();
      }
    }
  }
}

function githubErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  return numberValue((error as { status?: unknown }).status);
}

function isTransientGithubError(error: unknown): boolean {
  const status = githubErrorStatus(error);
  return (
    status === undefined ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

async function retryingReviewBudgetLoad(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  n: number,
): Promise<ReviewBudgetLoadResult> {
  return retryingReviewStateOperation(
    ctx,
    "githubbot_review_budget_load_retry",
    `${owner}/${repo}#${n}`,
    () => readReviewBudget(ctx, owner, repo, n),
  );
}

async function retryingReviewBudgetSave(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  n: number,
  state: ReviewEpochState,
): Promise<void> {
  await retryingReviewStateOperation(
    ctx,
    "githubbot_review_budget_save_retry",
    `${owner}/${repo}#${n}`,
    () =>
      ctx.state.set(
        reviewBudgetKey(ctx, owner, repo, n),
        state,
        state.pausedHeadSha ? undefined : STATE_TTL_MS,
      ),
  );
}

async function retryingReviewResetApprovalLoad(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  n: number,
  headSha: string,
): Promise<ReviewResetApproval | undefined> {
  return retryingReviewStateOperation(
    ctx,
    "githubbot_review_reset_load_retry",
    `${owner}/${repo}#${n}`,
    () => readReviewResetApproval(ctx, owner, repo, n, headSha),
  );
}

async function retryingReviewClaim(
  ctx: PrManagerContext,
  key: string,
  pr: string,
): Promise<boolean> {
  return retryingReviewStateOperation(
    ctx,
    "githubbot_review_claim_retry",
    pr,
    () => ctx.state.setIfNotExists(key, "1", CLAIM_TTL_MS),
  );
}

async function claim(ctx: PrManagerContext, key: string): Promise<boolean> {
  try {
    return await ctx.state.setIfNotExists(key, "1", CLAIM_TTL_MS);
  } catch {
    // If the claim store is unavailable, proceed (better to act than to silently
    // drop work); the in-turn idempotency keys still guard double execution.
    return true;
  }
}

/**
 * Release a claim so the action it guarded can be retried on a later event.
 * Used when an irreversible side effect (the merge) fails after the claim is
 * taken — otherwise the stale claim would suppress every future attempt.
 */
async function release(ctx: PrManagerContext, key: string): Promise<void> {
  try {
    await ctx.state.delete(key);
  } catch {
    // best-effort; the claim's TTL eventually expires if delete fails.
  }
}

function logger(ctx: PrManagerContext) {
  return ctx.options.logger ?? noopLogger;
}

// ---------------------------------------------------------------------------
// Webhook handlers.
// ---------------------------------------------------------------------------

type PullRequestSummary = {
  assignees: string[];
  draft: boolean;
  headRef: string;
  headRepoFullName: string | null;
  headSha: string;
  labels: string[];
  mergeableState: string;
  merged: boolean;
  number: number;
  state: string;
  title: string;
};

function assigneeLogins(
  value: ({ login?: string } | null)[] | null | undefined,
): string[] {
  if (!value) return [];
  return value.map((a) => a?.login ?? "").filter(Boolean);
}

function summarizePr(pr: {
  draft?: boolean | null;
  head: { ref: string; repo?: { full_name?: string | null } | null; sha: string };
  labels: { name?: string }[];
  mergeable_state?: string;
  merged?: boolean;
  number: number;
  state: string;
  title: string;
  assignees?: ({ login?: string } | null)[] | null;
}): PullRequestSummary {
  return {
    assignees: assigneeLogins(pr.assignees),
    draft: pr.draft === true,
    headRef: pr.head.ref,
    headRepoFullName: pr.head.repo?.full_name ?? null,
    headSha: pr.head.sha,
    labels: pr.labels.map((l) => l.name ?? "").filter(Boolean),
    mergeableState: pr.mergeable_state ?? "unknown",
    merged: pr.merged === true,
    number: pr.number,
    state: pr.state,
    title: pr.title,
  };
}

async function fetchPr(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  n: number,
): Promise<PullRequestSummary | null> {
  try {
    const { data } = await ctx.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: n,
    });
    return summarizePr(data as Parameters<typeof summarizePr>[0]);
  } catch (error) {
    logger(ctx).warn("githubbot_pr_fetch_failed", {
      error: errorMessage(error),
      pr: `${owner}/${repo}#${n}`,
    });
    return null;
  }
}

const OWNED_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Whether a PR is bot-owned, cached briefly so the conversational path doesn't
 * hit the API on every comment. Ownership rarely changes, and a stale "owned"
 * only affects which session a reply shares context with — low stakes.
 */
export async function isPrOwned(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  number: number,
): Promise<boolean> {
  const cacheKey = `${ctx.options.stateKeyPrefix ?? "centaur-githubbot"}:owned-cache:${owner}/${repo}#${number}`;
  try {
    const cached = await ctx.state.get<string>(cacheKey);
    if (cached === "1") return true;
    if (cached === "0") return false;
  } catch {
    // fall through to a live lookup
  }
  const pr = await fetchPr(ctx, owner, repo, number);
  const owned = pr ? owns(ctx, pr) : false;
  try {
    await ctx.state.set(cacheKey, owned ? "1" : "0", OWNED_CACHE_TTL_MS);
  } catch {
    // best-effort cache
  }
  return owned;
}

function owns(ctx: PrManagerContext, pr: PullRequestSummary): boolean {
  return isOwnedPr({ assignees: pr.assignees, userName: ctx.userName });
}

function reviewBudgetReviewerKey(user?: JsonRecord): string {
  const id = numberValue(user?.id);
  if (id !== undefined && Number.isSafeInteger(id) && id > 0) {
    return `github-user:${id}`;
  }
  const login = stringValue(user?.login)?.trim().toLowerCase();
  return login ? `github-login:${login}` : "github-reviewer:unknown";
}

/** `pull_request` lifecycle (non-review_requested actions). */
export async function handlePullRequestEvent(
  ctx: PrManagerContext,
  rawBody: string,
  deliveryId = "",
): Promise<void> {
  const payload = parseJson(rawBody);
  if (!payload) return;
  const action = stringValue(payload.action);
  if (!action || action === "review_requested") return; // review_requested is v1's.
  const repo = repoFromPayload(payload);
  const prNode = payload.pull_request;
  if (!repo || !isRecord(prNode)) return;
  const number = numberValue(prNode.number);
  if (number === undefined) return;
  if (action === "closed") return; // nothing to drive once closed/merged.

  const labelNode = payload.label;
  const label = isRecord(labelNode) ? stringValue(labelNode.name) : undefined;
  const resetLabel = ctx.options.reviewResetLabel ?? DEFAULT_REVIEW_RESET_LABEL;
  if (
    action === "labeled" &&
    label?.toLowerCase() === resetLabel.toLowerCase()
  ) {
    // Enter the per-PR queue before fetching the PR or checking the labeler's
    // permission. A review webhook delivered concurrently after this label
    // event must not overtake the durable reset approval.
    await runExclusive(reviewBudgetLockKey(repo.owner, repo.repo, number), async () => {
      const pr = await fetchPr(ctx, repo.owner, repo.repo, number);
      if (!pr || !owns(ctx, pr)) return;
      await maybeRecordReviewResetApproval(
        ctx,
        repo.owner,
        repo.repo,
        pr,
        payload,
        deliveryId,
      );
    });
    return;
  }

  const pr = await fetchPr(ctx, repo.owner, repo.repo, number);
  if (!pr || !owns(ctx, pr)) return;
  const previousHeadSha = stringValue(payload.before);
  if (
    action === "synchronize" &&
    previousHeadSha &&
    previousHeadSha !== pr.headSha
  ) {
    await runExclusive(
      reviewBudgetLockKey(repo.owner, repo.repo, number),
      async () => {
        const approval = await retryingReviewResetApprovalLoad(
          ctx,
          repo.owner,
          repo.repo,
          number,
          previousHeadSha,
        );
        if (approval) {
          await cleanupReviewResetApproval(
            ctx,
            repo.owner,
            repo.repo,
            { ...pr, headSha: previousHeadSha },
            true,
          );
        }
        await tryMergeLocked(ctx, repo.owner, repo.repo, number);
      },
    );
    return;
  }
  // Being assigned the PR is the explicit signal to take it over: evaluate CI now
  // (forcing past the human-commit back-off — the assignment is a human handing
  // it to us) so an already-red or already-green PR is acted on immediately,
  // rather than only on the next lifecycle event. processCi fixes red CI or merges
  // when green.
  if (action === "assigned") {
    await processCi(ctx, repo.owner, repo.repo, number, pr.headSha, true);
    return;
  }
  // Any other state change that could flip mergeability re-evaluates the merge
  // gate; it's deterministic and idempotent, so over-calling is harmless.
  await tryMerge(ctx, repo.owner, repo.repo, number);
}

/** `pull_request_review` submitted -> address review, or merge on approval. */
export async function handleReviewEvent(
  ctx: PrManagerContext,
  rawBody: string,
): Promise<void> {
  const payload = parseJson(rawBody);
  if (!payload) return;
  if (stringValue(payload.action) !== "submitted") return;
  const repo = repoFromPayload(payload);
  const prNode = payload.pull_request;
  const reviewNode = payload.review;
  if (!repo || !isRecord(prNode) || !isRecord(reviewNode)) return;
  const number = numberValue(prNode.number);
  const reviewId = numberValue(reviewNode.id);
  if (number === undefined || reviewId === undefined) return;
  const reviewerNode = isRecord(reviewNode.user) ? reviewNode.user : undefined;
  const reviewer = stringValue(reviewerNode?.login);
  const reviewerKey = reviewBudgetReviewerKey(reviewerNode);
  const reviewState = stringValue(reviewNode.state)?.toLowerCase();
  // Submitted reviews on public repositories are not collaborator-only by
  // default. Gate before workflow emission, claims, or write-capable turns.
  if (reviewer && reviewer.toLowerCase() === ctx.userName.toLowerCase()) return;
  if (!isReviewAuthorAllowed(payload, ctx.options)) {
    logger(ctx).warn("githubbot_review_author_denied", {
      pr: `${repo.owner}/${repo.repo}#${number}`,
      reviewer,
    });
    return;
  }

  // A review is tied to review.commit_id. The PR head can advance before this
  // webhook is handled, so a live PR lookup would correlate the review to the
  // wrong push.
  const reviewedHeadSha =
    stringValue(reviewNode.commit_id) ??
    stringValue(isRecord(prNode.head) ? prNode.head.sha : undefined);
  if (reviewedHeadSha) {
    backgroundWaitUntil(
      maybeEmitReviewSubmitted(
        ctx,
        repo,
        number,
        reviewedHeadSha,
        reviewer,
        reviewState,
        reviewId,
      ),
    );
  }

  const pr = await fetchPr(ctx, repo.owner, repo.repo, number);
  if (!pr || !owns(ctx, pr)) return;

  const reviewClaimKey = `${ctx.options.stateKeyPrefix ?? "centaur-githubbot"}:review-handled:${repo.owner}/${repo.repo}#${number}:${reviewId}`;
  if (
    !(await retryingReviewClaim(
      ctx,
      reviewClaimKey,
      `${repo.owner}/${repo.repo}#${number}`,
    ))
  ) {
    return;
  }

  if (reviewState === "approved") {
    const effectiveHeadSha = reviewedHeadSha ?? pr.headSha;
    if (
      effectiveHeadSha === pr.headSha &&
      !(await runExclusive(
        reviewBudgetLockKey(repo.owner, repo.repo, number),
        () =>
          recordApprovedReview(
            ctx,
            repo.owner,
            repo.repo,
            pr,
            effectiveHeadSha,
            reviewerKey,
          ),
      ))
    ) {
      await release(ctx, reviewClaimKey);
      return;
    }
    await tryMerge(ctx, repo.owner, repo.repo, number);
    return;
  }
  if (reviewState === "changes_requested" || reviewState === "commented") {
    const effectiveHeadSha = reviewedHeadSha ?? pr.headSha;
    if (effectiveHeadSha !== pr.headSha) {
      traceLog(
        ctx.options,
        "githubbot_review_stale_head_skipped",
        makeTrace(
          managementThreadKey(repo.owner, repo.repo, number),
          `review-stale-${reviewId}`,
        ),
        { current_head_sha: pr.headSha, reviewed_head_sha: effectiveHeadSha },
      );
      return;
    }
    const admission = await runExclusive(
      reviewBudgetLockKey(repo.owner, repo.repo, number),
      () =>
        admitReviewResponse(
          ctx,
          repo.owner,
          repo.repo,
          pr,
          effectiveHeadSha,
          reviewerKey,
        ),
    );
    if (!admission) {
      await release(ctx, reviewClaimKey);
      return;
    }
    if (admission.decision === "pause") {
      await escalateReviewBudget(
        ctx,
        repo.owner,
        repo.repo,
        pr,
        admission,
        reviewerKey,
      );
      return;
    }
    fireAddressReviewTurn(ctx, repo.owner, repo.repo, pr, {
      budget: admission.state,
      reviewer: reviewer ?? "the reviewer",
      reviewerKey,
      reviewId,
      reviewNodeId: stringValue(reviewNode.node_id),
    });
    if (admission.state.pausedHeadSha && admission.state.pauseReason) {
      await escalateReviewBudget(
        ctx,
        repo.owner,
        repo.repo,
        pr,
        {
          assessment: admission.assessment,
          decision: "pause",
          reason: admission.state.pauseReason,
          state: admission.state,
        },
        reviewerKey,
      );
    }
  }
}

async function maybeRecordReviewResetApproval(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  pr: PullRequestSummary,
  payload: JsonRecord,
  deliveryId: string,
): Promise<boolean> {
  const labelNode = payload.label;
  const label = isRecord(labelNode) ? stringValue(labelNode.name) : undefined;
  const resetLabel = ctx.options.reviewResetLabel ?? DEFAULT_REVIEW_RESET_LABEL;
  if (!label || label.toLowerCase() !== resetLabel.toLowerCase()) return false;

  const senderNode = payload.sender;
  const sender = isRecord(senderNode)
    ? stringValue(senderNode.login)
    : undefined;
  const senderType = isRecord(senderNode)
    ? stringValue(senderNode.type)?.toLowerCase()
    : undefined;
  if (
    !sender ||
    senderType !== "user" ||
    sender.toLowerCase() === ctx.userName.toLowerCase()
  ) {
    logger(ctx).warn("githubbot_review_reset_denied", {
      pr: `${owner}/${repo}#${pr.number}`,
      reason: "non_human_sender",
      sender,
    });
    await cleanupReviewResetApproval(ctx, owner, repo, pr);
    return true;
  }

  const permission = await retryingReviewStateOperation(
    ctx,
    "githubbot_review_reset_permission_retry",
    `${owner}/${repo}#${pr.number}`,
    async () => {
      try {
        const { data } =
          await ctx.octokit.rest.repos.getCollaboratorPermissionLevel({
            owner,
            repo,
            username: sender,
          });
        return data.permission;
      } catch (error) {
        if (isTransientGithubError(error)) throw error;
        logger(ctx).warn("githubbot_review_reset_permission_failed", {
          error: errorMessage(error),
          pr: `${owner}/${repo}#${pr.number}`,
          sender,
        });
        return undefined;
      }
    },
  );
  if (!permission) {
    await cleanupReviewResetApproval(ctx, owner, repo, pr);
    return true;
  }
  if (permission !== "admin" && permission !== "write") {
    logger(ctx).warn("githubbot_review_reset_denied", {
      permission,
      pr: `${owner}/${repo}#${pr.number}`,
      reason: "insufficient_repository_permission",
      sender,
    });
    await cleanupReviewResetApproval(ctx, owner, repo, pr);
    return true;
  }
  if (!deliveryId) {
    logger(ctx).warn("githubbot_review_reset_denied", {
      pr: `${owner}/${repo}#${pr.number}`,
      reason: "missing_delivery_id",
      sender,
    });
    await cleanupReviewResetApproval(ctx, owner, repo, pr);
    return true;
  }

  const budget = await retryingReviewBudgetLoad(ctx, owner, repo, pr.number);
  if (!budget.ok) {
    await cleanupReviewResetApproval(ctx, owner, repo, pr);
    return true;
  }
  if (!budget.state?.pausedHeadSha) {
    logger(ctx).warn("githubbot_review_reset_denied", {
      pr: `${owner}/${repo}#${pr.number}`,
      reason: "review_budget_not_paused",
      sender,
    });
    // Do not leave a visible reset label that was never accepted. Deleting an
    // old approval also prevents an early label from becoming usable later.
    await cleanupReviewResetApproval(ctx, owner, repo, pr);
    return true;
  }

  await retryingReviewStateOperation(
    ctx,
    "githubbot_review_reset_save_retry",
    `${owner}/${repo}#${pr.number}`,
    () =>
      ctx.state.set(
        reviewResetApprovalKey(ctx, owner, repo, pr.number, pr.headSha),
        {
          approvalId: deliveryId,
          approvedBy: sender,
          headSha: pr.headSha,
        } satisfies ReviewResetApproval,
      ),
  );
  traceLog(
    ctx.options,
    "githubbot_review_reset_approved",
    makeTrace(
      managementThreadKey(owner, repo, pr.number),
      `review-reset-${pr.headSha}`,
    ),
    { approved_by: sender, head_sha: pr.headSha },
  );
  return true;
}

type ReviewComparisonEvidence = {
  actor: ReviewChangeActor;
  assessment: ReviewChangeAssessment;
};

function commitActorKind(
  value: unknown,
  botUserName: string,
): ReviewChangeActor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const commit = value as {
    author?: { login?: string | null; type?: string | null } | null;
    commit?: { message?: string | null } | null;
    committer?: { login?: string | null; type?: string | null } | null;
  };
  if (commit.commit?.message?.includes("Centaur-Automation: true")) {
    return "automation";
  }
  const account = commit.author ?? commit.committer;
  const login = account?.login?.toLowerCase();
  if (
    account?.type?.toLowerCase() === "bot" ||
    login?.endsWith("[bot]") ||
    login === botUserName.toLowerCase()
  ) {
    return "automation";
  }
  return login ? "human" : "unknown";
}

async function compareReviewChange(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  baseHeadSha: string,
  currentHeadSha: string,
): Promise<ReviewComparisonEvidence> {
  try {
    const { data } = await ctx.octokit.rest.repos.compareCommitsWithBasehead({
      basehead: `${baseHeadSha}...${currentHeadSha}`,
      owner,
      per_page: 100,
      repo,
    });
    const rawFiles = Array.isArray(data.files) ? data.files : undefined;
    const files: ReviewChangeFile[] | undefined = rawFiles?.map((file) => ({
      additions: file.additions,
      changes: file.changes,
      deletions: file.deletions,
      filename: file.filename,
      status: file.status,
    }));
    const assessment = assessReviewChange({
      comparisonStatus: data.status,
      files,
      fileThreshold:
        ctx.options.reviewMaterialChangeFiles ??
        DEFAULT_REVIEW_MATERIAL_CHANGE_FILES,
      lineThreshold:
        ctx.options.reviewMaterialChangeLines ??
        DEFAULT_REVIEW_MATERIAL_CHANGE_LINES,
    });
    const commits = Array.isArray(data.commits) ? data.commits : [];
    const totalCommits =
      typeof data.total_commits === "number" ? data.total_commits : commits.length;
    const kinds = new Set(
      commits.map((commit) => commitActorKind(commit, ctx.userName)),
    );
    let actor: ReviewChangeActor = "unknown";
    if (totalCommits === commits.length && !kinds.has("unknown")) {
      if (kinds.size === 1) actor = kinds.values().next().value ?? "unknown";
    }
    return { actor, assessment };
  } catch (error) {
    logger(ctx).warn("githubbot_review_compare_failed", {
      base_head_sha: baseHeadSha,
      current_head_sha: currentHeadSha,
      error: errorMessage(error),
      pr: `${owner}/${repo}`,
    });
    return {
      actor: "unknown",
      assessment: assessReviewChange({ files: undefined }),
    };
  }
}

async function pendingReviewResetApproval(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  pr: PullRequestSummary,
  state?: ReviewEpochState,
): Promise<ReviewResetApproval | undefined> {
  const approval = await retryingReviewResetApprovalLoad(
    ctx,
    owner,
    repo,
    pr.number,
    pr.headSha,
  );
  if (!approval) return undefined;
  if (state?.consumedResetApprovalId === approval.approvalId) {
    // The budget write is the reset's durable commit point. Cleanup is only
    // hygiene and may be retried if a prior delete or label removal failed.
    await cleanupReviewResetApproval(ctx, owner, repo, pr, true);
    return undefined;
  }
  if (!state?.pausedHeadSha) {
    logger(ctx).warn("githubbot_review_reset_ignored", {
      pr: `${owner}/${repo}#${pr.number}`,
      reason: "review_budget_not_paused",
    });
    await cleanupReviewResetApproval(ctx, owner, repo, pr);
    return undefined;
  }
  return approval;
}

async function cleanupReviewResetApproval(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  pr: PullRequestSummary,
  consumed = false,
): Promise<void> {
  if (consumed) {
    const labelRemoved = await retryingReviewStateOperation(
      ctx,
      "githubbot_review_reset_label_remove_retry",
      `${owner}/${repo}#${pr.number}`,
      async () => {
        try {
          await ctx.octokit.rest.issues.removeLabel({
            issue_number: pr.number,
            name: ctx.options.reviewResetLabel ?? DEFAULT_REVIEW_RESET_LABEL,
            owner,
            repo,
          });
          return true;
        } catch (error) {
          if (githubErrorStatus(error) === 404) return true;
          if (isTransientGithubError(error)) throw error;
          logger(ctx).warn("githubbot_review_reset_label_remove_failed", {
            error: errorMessage(error),
            pr: `${owner}/${repo}#${pr.number}`,
          });
          return false;
        }
      },
    );
    // Preserve the approval marker on a permanent removal failure so another
    // lifecycle event can retry after repository permissions are repaired.
    if (!labelRemoved) return;
  }
  try {
    await ctx.state.delete(
      reviewResetApprovalKey(ctx, owner, repo, pr.number, pr.headSha),
    );
  } catch (error) {
    logger(ctx).debug("githubbot_review_reset_delete_failed", {
      error: errorMessage(error),
      pr: `${owner}/${repo}#${pr.number}`,
    });
  }
  if (!consumed) {
    try {
      await ctx.octokit.rest.issues.removeLabel({
        issue_number: pr.number,
        name: ctx.options.reviewResetLabel ?? DEFAULT_REVIEW_RESET_LABEL,
        owner,
        repo,
      });
    } catch (error) {
      logger(ctx).debug("githubbot_review_reset_label_remove_failed", {
        error: errorMessage(error),
        pr: `${owner}/${repo}#${pr.number}`,
      });
    }
  }
}

async function recordApprovedReview(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  pr: PullRequestSummary,
  headSha: string,
  reviewerKey: string,
): Promise<boolean> {
  const loaded = await retryingReviewBudgetLoad(ctx, owner, repo, pr.number);
  if (!loaded.ok) return false;
  const approval = await pendingReviewResetApproval(
    ctx,
    owner,
    repo,
    pr,
    loaded.state,
  );
  if (!approval) {
    if (loaded.state && loaded.state.lastReviewedHeadSha !== headSha) {
      const state = {
        ...loaded.state,
        automationPendingFromHeadSha: undefined,
        lastReviewedHeadSha: headSha,
      };
      await retryingReviewBudgetSave(ctx, owner, repo, pr.number, state);
      traceLog(
        ctx.options,
        "githubbot_review_approved_head_recorded",
        makeTrace(
          managementThreadKey(owner, repo, pr.number),
          `review-approved-${headSha}`,
        ),
        { epoch: state.epoch, head_sha: headSha },
      );
    }
    return true;
  }
  const admission = decideReviewAdmission({
    actor: "human",
    headSha,
    manualReset: true,
    maxEpochs: ctx.options.reviewMaxEpochs ?? DEFAULT_REVIEW_MAX_EPOCHS,
    maxRoundsPerEpoch:
      ctx.options.reviewMaxRoundsPerEpoch ??
      DEFAULT_REVIEW_MAX_ROUNDS_PER_EPOCH,
    maxTotalRoundsPerEpoch:
      ctx.options.reviewMaxTotalRoundsPerEpoch ??
      DEFAULT_REVIEW_MAX_TOTAL_ROUNDS_PER_EPOCH,
    reviewerKey,
    startsRepairTurn: false,
    state: loaded.state,
  });
  const state = {
    ...admission.state,
    automationPendingFromHeadSha: undefined,
    consumedResetApprovalId: approval.approvalId,
  };
  await retryingReviewBudgetSave(ctx, owner, repo, pr.number, state);
  traceLog(
    ctx.options,
    "githubbot_review_reset_consumed_by_approval",
    makeTrace(
      managementThreadKey(owner, repo, pr.number),
      `review-approved-${headSha}`,
    ),
    { approved_by: approval.approvedBy, epoch: state.epoch, head_sha: headSha },
  );
  await cleanupReviewResetApproval(ctx, owner, repo, pr, true);
  return true;
}

async function admitReviewResponse(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  pr: PullRequestSummary,
  headSha: string,
  reviewerKey: string,
): Promise<ReviewAdmission | null> {
  const loaded = await retryingReviewBudgetLoad(ctx, owner, repo, pr.number);
  if (!loaded.ok) return null;
  const approval = await pendingReviewResetApproval(
    ctx,
    owner,
    repo,
    pr,
    loaded.state,
  );
  const manualReset = approval !== undefined;

  let evidence: ReviewComparisonEvidence | undefined;
  if (loaded.state && (loaded.state.lastReviewedHeadSha !== headSha || manualReset)) {
    evidence = await compareReviewChange(
      ctx,
      owner,
      repo,
      loaded.state.anchorHeadSha,
      headSha,
    );
    if (
      evidence.assessment.kind === "material" &&
      loaded.state.anchorHeadSha !== loaded.state.lastReviewedHeadSha
    ) {
      const latestRange = await compareReviewChange(
        ctx,
        owner,
        repo,
        loaded.state.lastReviewedHeadSha,
        headSha,
      );
      evidence = { ...evidence, actor: latestRange.actor };
    }
    if (
      evidence.actor === "unknown" &&
      loaded.state.automationPendingFromHeadSha ===
        loaded.state.lastReviewedHeadSha
    ) {
      evidence = { ...evidence, actor: "automation" };
    }
  }

  const admission = decideReviewAdmission({
    actor: evidence?.actor ?? "unknown",
    assessment: evidence?.assessment,
    headSha,
    manualReset,
    maxEpochs: ctx.options.reviewMaxEpochs ?? DEFAULT_REVIEW_MAX_EPOCHS,
    maxRoundsPerEpoch:
      ctx.options.reviewMaxRoundsPerEpoch ??
      DEFAULT_REVIEW_MAX_ROUNDS_PER_EPOCH,
    maxTotalRoundsPerEpoch:
      ctx.options.reviewMaxTotalRoundsPerEpoch ??
      DEFAULT_REVIEW_MAX_TOTAL_ROUNDS_PER_EPOCH,
    reviewerKey,
    startsRepairTurn: true,
    state: loaded.state,
  });
  const state = approval
    ? { ...admission.state, consumedResetApprovalId: approval.approvalId }
    : admission.state;
  await retryingReviewBudgetSave(ctx, owner, repo, pr.number, state);
  if (admission.decision === "allow" && manualReset) {
    await cleanupReviewResetApproval(ctx, owner, repo, pr, true);
  }
  traceLog(
    ctx.options,
    "githubbot_review_budget_decision",
    makeTrace(
      managementThreadKey(owner, repo, pr.number),
      `review-budget-${headSha}`,
    ),
    {
      assessment: admission.assessment?.kind,
      assessment_reasons: admission.assessment?.reasons,
      decision: admission.decision,
      epoch: state.epoch,
      head_sha: headSha,
      reset_epoch:
        admission.decision === "allow" ? admission.resetEpoch : undefined,
      reviewer_key: reviewerKey,
      reviewer_rounds_used:
        state.reviewerRoundsUsed?.[reviewerKey] ?? state.roundsUsed,
      rounds_used: state.roundsUsed,
    },
  );
  return { ...admission, state };
}

async function escalateReviewBudget(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  pr: PullRequestSummary,
  admission: Extract<ReviewAdmission, { decision: "pause" }>,
  reviewerKey: string,
): Promise<void> {
  const pausedHeadSha = admission.state.pausedHeadSha ?? pr.headSha;
  const pauseClaim = `${ctx.options.stateKeyPrefix ?? "centaur-githubbot"}:review-paused:${owner}/${repo}#${pr.number}:${pausedHeadSha}:${admission.state.epoch}:${admission.reason}`;
  if (
    !(await retryingReviewClaim(
      ctx,
      pauseClaim,
      `${owner}/${repo}#${pr.number}`,
    ))
  ) {
    return;
  }
  const handle = ctx.options.escalationHandle?.replace(/^@/, "");
  const mention = handle ? `@${handle} ` : "";
  const resetLabel = ctx.options.reviewResetLabel ?? DEFAULT_REVIEW_RESET_LABEL;
  const evidence = admission.assessment?.reasons.join("; ") ?? "unavailable";
  const reviewerRounds =
    admission.state.reviewerRoundsUsed?.[reviewerKey] ??
    admission.state.roundsUsed;
  const maxReviewerRounds =
    ctx.options.reviewMaxRoundsPerEpoch ??
    DEFAULT_REVIEW_MAX_ROUNDS_PER_EPOCH;
  const maxTotalRounds =
    ctx.options.reviewMaxTotalRoundsPerEpoch ??
    DEFAULT_REVIEW_MAX_TOTAL_ROUNDS_PER_EPOCH;
  const body =
    `${mention}The bounded review budget reached its human-handoff boundary ` +
    `to prevent an open-ended review/fix loop (reason: ${admission.reason}; epoch ` +
    `${admission.state.epoch}, reviewer round ${reviewerRounds}/${maxReviewerRounds}, ` +
    `epoch total ${admission.state.roundsUsed}/${maxTotalRounds}). ` +
    `Change assessment: ${evidence}. No further automatic review response or ` +
    `merge will proceed until a write-authorized human adds the ` +
    `\`${resetLabel}\` label and re-requests review to explicitly start another ` +
    `epoch; otherwise adjudicate the finding or split the PR.`;
  try {
    await ctx.octokit.rest.issues.createComment({
      body,
      issue_number: pr.number,
      owner,
      repo,
    });
  } catch (error) {
    await release(ctx, pauseClaim);
    logger(ctx).warn("githubbot_review_budget_escalation_failed", {
      error: errorMessage(error),
      pr: `${owner}/${repo}#${pr.number}`,
    });
  }
}

/** check_run / check_suite / workflow_run completed -> CI-settled gate. */
export async function handleCiEvent(
  ctx: PrManagerContext,
  eventType: string,
  rawBody: string,
): Promise<void> {
  const payload = parseJson(rawBody);
  if (!payload) return;
  const repo = repoFromPayload(payload);
  if (!repo) return;
  const target = ciTarget(eventType, payload);
  if (!target) return;
  const { emission, evaluation } = await prepareCiCompleted(
    ctx,
    eventType,
    repo,
    payload,
    target.headSha,
  );
  if (emission) backgroundWaitUntil(emission);
  const prNumbers =
    target.prNumbers.length > 0
      ? target.prNumbers
      : await fetchPrNumbersForCommit(ctx, repo.owner, repo.repo, target.headSha);
  await Promise.all(
    prNumbers.map((number) =>
      processCi(ctx, repo.owner, repo.repo, number, target.headSha, false, evaluation),
    ),
  );
}

async function processCi(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  number: number,
  headSha: string,
  force = false,
  knownEvaluation?: CiEvaluation | null,
): Promise<void> {
  const pr = await fetchPr(ctx, owner, repo, number);
  if (!pr || !owns(ctx, pr)) return;
  // Ignore CI for a SHA that's already been superseded by a newer push.
  if (pr.headSha !== headSha) return;

  const evaluation =
    knownEvaluation ?? (await fetchCiEvaluation(ctx, owner, repo, headSha));
  if (!evaluation?.settled) return; // wait until *all* checks are done (and readable).
  // Act once per fully-settled SHA (the last-arriving check event wins).
  if (
    !(await claim(
      ctx,
      `${ctx.options.stateKeyPrefix ?? "centaur-githubbot"}:ci-settled:${owner}/${repo}#${number}:${headSha}`,
    ))
  ) {
    return;
  }

  const trace = makeTrace(managementThreadKey(owner, repo, number), `ci-${headSha}`);
  if (!evaluation.failed) {
    // Green: reset the fix counter and consider merging.
    const state = await loadState(ctx, owner, repo, number);
    if (state.consecutiveCiFixes) {
      await saveState(ctx, owner, repo, number, { ...state, consecutiveCiFixes: 0 });
    }
    traceLog(ctx.options, "githubbot_ci_green", trace, { pr: `${owner}/${repo}#${number}` });
    await tryMerge(ctx, owner, repo, number);
    return;
  }

  // Red: back off if a human pushed the failing commit (don't step on them) —
  // unless this is a forced takeover (the PR was just assigned to us, so the
  // human has explicitly handed it over and we fix it regardless of who pushed).
  if (!force) {
    const headAuthor = await commitAuthor(ctx, owner, repo, headSha);
    if (headAuthor && headAuthor.toLowerCase() !== ctx.userName.toLowerCase()) {
      traceLog(ctx.options, "githubbot_ci_human_commit_skipped", trace, {
        author: headAuthor,
      });
      return;
    }
  }

  const maxAttempts = ctx.options.ciFixMaxAttempts ?? DEFAULT_CI_FIX_MAX_ATTEMPTS;
  const state = await loadState(ctx, owner, repo, number);
  const attempts = state.consecutiveCiFixes ?? 0;
  if (attempts >= maxAttempts) {
    await escalate(ctx, owner, repo, number, evaluation.failingNames, maxAttempts);
    return;
  }
  await saveState(ctx, owner, repo, number, {
    ...state,
    consecutiveCiFixes: attempts + 1,
  });
  fireCiFixTurn(ctx, owner, repo, pr, evaluation.failingNames, attempts + 1, maxAttempts);
}

/** Deterministic merge gate — no agent; GitHub's mergeable_state decides. */
async function tryMerge(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  number: number,
): Promise<void> {
  await runExclusive(reviewBudgetLockKey(owner, repo, number), () =>
    tryMergeLocked(ctx, owner, repo, number),
  );
}

async function tryMergeLocked(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  number: number,
): Promise<void> {
  const pr = await fetchPr(ctx, owner, repo, number);
  if (!pr || !owns(ctx, pr)) return;
  const reviewBudget = await loadReviewBudget(ctx, owner, repo, number);
  if (!reviewBudget.ok) return;
  if (reviewBudget.state?.pausedHeadSha) {
    traceLog(
      ctx.options,
      "githubbot_merge_review_budget_paused",
      makeTrace(managementThreadKey(owner, repo, number), `merge-${pr.headSha}`),
      {
        epoch: reviewBudget.state.epoch,
        pause_started_at_head_sha: reviewBudget.state.pausedHeadSha,
        pause_reason: reviewBudget.state.pauseReason,
        pr: `${owner}/${repo}#${number}`,
      },
    );
    return;
  }
  const decision = decideMerge({
    autoMerge: ctx.options.autoMerge !== false,
    draft: pr.draft,
    holdLabel: ctx.options.holdLabel ?? "do-not-merge",
    labels: pr.labels,
    merged: pr.merged,
    mergeableState: pr.mergeableState,
    state: pr.state,
  });
  const trace = makeTrace(managementThreadKey(owner, repo, number), `merge-${pr.headSha}`);
  traceLog(ctx.options, "githubbot_merge_decision", trace, {
    decision,
    mergeable_state: pr.mergeableState,
    pr: `${owner}/${repo}#${number}`,
  });

  if (decision === "merge") {
    // The claim guards against two concurrent lifecycle events both calling
    // merge. It's released on failure (below) so a transient merge error — "Base
    // branch was modified", a secondary rate limit, a 5xx — is retried on the
    // next event instead of leaving a clean, approved PR permanently unmerged
    // behind a stale claim. On success the claim stays as the "merged" marker.
    const mergedClaimKey = `${ctx.options.stateKeyPrefix ?? "centaur-githubbot"}:merged:${owner}/${repo}#${number}:${pr.headSha}`;
    if (!(await claim(ctx, mergedClaimKey))) {
      return;
    }
    try {
      await ctx.octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: number,
        merge_method: ctx.options.mergeMethod ?? "squash",
      });
      traceLog(ctx.options, "githubbot_merged", trace, { pr: `${owner}/${repo}#${number}` });
      if (
        ctx.options.deleteBranchOnMerge !== false &&
        pr.headRepoFullName?.toLowerCase() === `${owner}/${repo}`.toLowerCase()
      ) {
        try {
          await ctx.octokit.rest.git.deleteRef({
            owner,
            repo,
            ref: `heads/${pr.headRef}`,
          });
        } catch (error) {
          logger(ctx).debug("githubbot_branch_delete_failed", {
            error: errorMessage(error),
          });
        }
      }
    } catch (error) {
      // Re-merging an already-merged PR is a no-op (decideMerge returns
      // skip_closed next time), so releasing on any failure is safe.
      await release(ctx, mergedClaimKey);
      logger(ctx).warn("githubbot_merge_failed", {
        error: errorMessage(error),
        pr: `${owner}/${repo}#${number}`,
      });
    }
    return;
  }
  if (decision === "update_branch") {
    try {
      await ctx.octokit.rest.pulls.updateBranch({ owner, repo, pull_number: number });
    } catch (error) {
      logger(ctx).debug("githubbot_update_branch_failed", {
        error: errorMessage(error),
      });
    }
    return;
  }
  if (decision === "resolve_conflict") {
    fireConflictTurn(ctx, owner, repo, pr);
  }
}

async function escalate(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  number: number,
  failingNames: string[],
  maxAttempts: number,
): Promise<void> {
  const handle = ctx.options.escalationHandle?.replace(/^@/, "");
  const mention = handle ? `@${handle} ` : "";
  const checks = failingNames.length ? failingNames.join(", ") : "the CI checks";
  const body =
    `${mention}I've tried to fix CI on this PR ${maxAttempts} times without ` +
    `success and am pausing automatic fixes. Still failing: ${checks}. ` +
    `Could a human take a look?`;
  try {
    await ctx.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body,
    });
    traceLog(
      ctx.options,
      "githubbot_ci_escalated",
      makeTrace(managementThreadKey(owner, repo, number), `escalate-${number}`),
      { pr: `${owner}/${repo}#${number}` },
    );
  } catch (error) {
    logger(ctx).warn("githubbot_escalation_failed", {
      error: errorMessage(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Agentic turns (run on the management thread; the agent does GitHub I/O via gh).
// ---------------------------------------------------------------------------

function fireCiFixTurn(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  pr: PullRequestSummary,
  failingNames: string[],
  attempt: number,
  maxAttempts: number,
): void {
  const handle = ctx.options.escalationHandle?.replace(/^@/, "");
  const fallback = handle
    ? `if you can't tell, @-mention @${handle}`
    : "if you can't tell, @-mention a maintainer";
  const preamble =
    `CI failed on pull request ${owner}/${repo}#${pr.number} at commit ` +
    `${pr.headSha}. Failing checks: ${failingNames.join(", ") || "unknown"}.\n\n` +
    `Fix it in your sandbox:\n` +
    `- Pull the failing logs (e.g. \`gh pr checks ${pr.number}\`, ` +
    `\`gh run view <run-id> --log-failed\`), understand the failure, fix it, and ` +
    `push to the PR's head branch (${pr.headRef}).\n` +
    `- If a check is flaky (infra/timeout, not your code), you may re-run it once ` +
    `instead of changing code.\n` +
    `- If you cannot confidently fix it, do NOT push a guess. Post a comment on ` +
    `the PR summarizing what's failing and what you tried, and @-mention the right ` +
    `human — find them via \`git blame\` on the affected files, recent authors ` +
    `(\`git log\`), or GitHub's suggested reviewers; ${fallback}.\n\n` +
    `This is fix attempt ${attempt} of ${maxAttempts}.`;
  fireManagementTurn(ctx, owner, repo, pr, preamble, {
    id: `fix-${owner}/${repo}#${pr.number}-${pr.headSha}-${attempt}`,
    label: "ci-fix",
    text: `Fix the failing CI on ${owner}/${repo}#${pr.number}.`,
  });
}

function fireAddressReviewTurn(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  pr: PullRequestSummary,
  review: {
    budget: ReviewEpochState;
    reviewer: string;
    reviewerKey: string;
    reviewId: number;
    reviewNodeId?: string;
  },
): void {
  const { budget, reviewer, reviewerKey, reviewId, reviewNodeId } = review;
  const maxReviewerRounds =
    ctx.options.reviewMaxRoundsPerEpoch ??
    DEFAULT_REVIEW_MAX_ROUNDS_PER_EPOCH;
  const maxTotalRounds =
    ctx.options.reviewMaxTotalRoundsPerEpoch ??
    DEFAULT_REVIEW_MAX_TOTAL_ROUNDS_PER_EPOCH;
  const reviewerRounds =
    budget.reviewerRoundsUsed?.[reviewerKey] ?? budget.roundsUsed;
  const preamble =
    `A review was submitted on pull request ${owner}/${repo}#${pr.number} ` +
    `(head ${pr.headSha}). This is review epoch ${budget.epoch}, reviewer round ` +
    `${reviewerRounds} of ${maxReviewerRounds}, and aggregate round ` +
    `${budget.roundsUsed} of ${maxTotalRounds}. Address it as the PR author, working ` +
    `in your sandbox. This is a bounded validation-and-repair turn, not a new ` +
    `open-ended review:\n` +
    `- Read all of the feedback: \`gh pr view ${pr.number} --comments\` and the ` +
    `pull-request review-comments API.\n` +
    `- Validate each finding before editing: identify the concrete code path, ` +
    `show that its preconditions are reachable under enforced types, schema, ` +
    `authorization, and deployment policy, and state the material impact. ` +
    `Classify duplicates, impossible-by-contract cases, optional nits, and ` +
    `speculation as non-blocking instead of manufacturing defensive machinery.\n` +
    `- Make only the smallest changes needed for validated, in-scope findings. ` +
    `Do not redesign adjacent systems or reopen resolved findings. If a fix ` +
    `would materially expand the PR, stop and ask for human approval.\n` +
    `- Put all agreed changes in one coherent commit on ${pr.headRef} and include ` +
    `the commit trailer \`Centaur-Automation: true\`, then push.\n` +
    `- Reply to every thread with the evidence and what changed. Where a finding ` +
    `is invalid, explain the enforcing contract briefly. Resolve addressed or ` +
    `evidence-rejected threads when authorized.\n` +
    `- Re-request review from @${reviewer} only if you pushed code.\n` +
    `- If a request is unclear or you can't address it, say so in the thread and ask.`;
  fireManagementTurn(
    ctx,
    owner,
    repo,
    pr,
    preamble,
    {
      id: `review-resp-${owner}/${repo}#${pr.number}-${reviewId}`,
      label: "address-review",
      text: `Address the review on ${owner}/${repo}#${pr.number} from @${reviewer}.`,
    },
    reviewNodeId,
  );
}

function fireConflictTurn(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  pr: PullRequestSummary,
): void {
  const preamble =
    `Pull request ${owner}/${repo}#${pr.number} has merge conflicts with its ` +
    `base branch. In your sandbox, update ${pr.headRef} against the base (rebase ` +
    `or merge), resolve the conflicts correctly, and push. If the conflicts are ` +
    `non-trivial or you're unsure of the right resolution, stop and @-mention a ` +
    `human instead of force-pushing a guess.`;
  fireManagementTurn(ctx, owner, repo, pr, preamble, {
    id: `conflict-${owner}/${repo}#${pr.number}-${pr.headSha}`,
    label: "resolve-conflict",
    text: `Resolve the merge conflicts on ${owner}/${repo}#${pr.number}.`,
  });
}

function fireManagementTurn(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  pr: PullRequestSummary,
  preamble: string,
  message: { id: string; label: string; text: string },
  reviewNodeId?: string,
): void {
  const threadKey = managementThreadKey(owner, repo, pr.number);
  const trace = makeTrace(threadKey, message.id);
  // A deployment can prepend its own constraints to the management methodology
  // (the per-action preamble still rides underneath).
  const guidance = ctx.options.managementPrompt;
  const contextPreamble = guidance ? `${guidance}\n\n${preamble}` : preamble;
  let lastEventId = 0;
  const forwardInput: ForwardSessionInput = {
    afterEventId: 0,
    contextPreamble,
    conversationName: `${owner}/${repo}#${pr.number}: ${pr.title}`,
    executeMessage: managementMessage(message.id, threadKey, message.text),
    messages: [],
    model: undefined,
    onEventId: (eventId) => {
      lastEventId = Math.max(lastEventId, eventId);
      forwardInput.afterEventId = lastEventId;
    },
    openStream: false,
    threadId: threadKey,
    trace,
  };
  traceLog(ctx.options, "githubbot_management_turn_started", trace, {
    pr: `${owner}/${repo}#${pr.number}`,
    work: message.label,
  });
  // Review-triggered turns ack on the reviewer's own review — instant 👀,
  // settled to 🚀/😕 when the turn finishes (same lifecycle as @-mention acks).
  // Not awaited: the ack must not delay the turn, and a failed reaction is only
  // a missing ack. Turns with no triggering review (CI-fix, conflicts) stay
  // silent — a reaction on the PR's top post isn't clearly tied to anything.
  if (reviewNodeId) {
    void reactWorkingOnReview(ctx.octokit, reviewNodeId, logger(ctx));
  }
  backgroundWaitUntil(
    runTurnStream(ctx.options, forwardInput)
      .then(async (result) => {
        traceLog(ctx.options, "githubbot_management_turn_complete", trace, {
          failed: result.failed,
          work: message.label,
        });
        if (reviewNodeId) {
          await settleReviewReaction(
            ctx.octokit,
            reviewNodeId,
            result.failed,
            logger(ctx),
          );
        }
      })
      .catch(async (error) => {
        logger(ctx).warn("githubbot_management_turn_failed", {
          error: errorMessage(error),
          work: message.label,
        });
        if (reviewNodeId) {
          await settleReviewReaction(ctx.octokit, reviewNodeId, true, logger(ctx));
        }
      }),
  );
}

function managementMessage(
  id: string,
  threadKey: string,
  text: string,
): GithubbotApiMessage {
  return {
    attachments: [],
    author: {
      fullName: "GitHub",
      isBot: false,
      isMe: false,
      userId: "github-pr-manager",
      userName: "github-pr-manager",
    },
    id,
    isMention: true,
    raw: { githubbotManagement: true },
    text,
    threadId: threadKey,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GitHub API reads.
// ---------------------------------------------------------------------------

async function commitAuthor(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  sha: string,
): Promise<string | undefined> {
  try {
    const { data } = await ctx.octokit.rest.repos.getCommit({ owner, repo, ref: sha });
    return data.author?.login ?? undefined;
  } catch {
    return undefined;
  }
}

async function fetchPrNumbersForCommit(
  ctx: PrManagerContext,
  owner: string,
  repo: string,
  sha: string,
): Promise<number[]> {
  try {
    const { data } =
      await ctx.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner,
        repo,
        commit_sha: sha,
      });
    return data.map((pr) => pr.number).filter((n) => typeof n === "number");
  } catch (error) {
    logger(ctx).debug("githubbot_commit_prs_fetch_failed", {
      error: errorMessage(error),
      ref: `${owner}/${repo}@${sha}`,
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Payload parsing helpers.
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJson(rawBody: string): JsonRecord | null {
  try {
    const value = JSON.parse(rawBody);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function repoFromPayload(
  payload: JsonRecord,
): { owner: string; repo: string } | null {
  const repository = payload.repository;
  if (!isRecord(repository)) return null;
  const fullName = stringValue(repository.full_name);
  if (!fullName) return null;
  const [owner, repo] = fullName.split("/", 2);
  if (!owner || !repo) return null;
  return { owner, repo };
}

function ciTarget(
  eventType: string,
  payload: JsonRecord,
): { headSha: string; prNumbers: number[] } | null {
  if (eventType === "status") {
    const headSha = stringValue(payload.sha);
    return headSha ? { headSha, prNumbers: [] } : null;
  }
  const node =
    eventType === "check_run"
      ? payload.check_run
      : eventType === "check_suite"
        ? payload.check_suite
        : eventType === "workflow_run"
          ? payload.workflow_run
          : undefined;
  if (!isRecord(node)) return null;
  const headSha = stringValue(node.head_sha);
  if (!headSha) return null;
  const prs = node.pull_requests;
  const prNumbers: number[] = [];
  if (Array.isArray(prs)) {
    for (const pr of prs) {
      const n = isRecord(pr) ? numberValue(pr.number) : undefined;
      if (n !== undefined) prNumbers.push(n);
    }
  }
  return { headSha, prNumbers };
}

function makeTrace(threadKey: string, messageId: string): GithubbotTrace {
  return {
    includeContext: false,
    messageId,
    mode: "execute",
    openStream: true,
    startedAtMs: nowMs(),
    threadId: threadKey,
  };
}
