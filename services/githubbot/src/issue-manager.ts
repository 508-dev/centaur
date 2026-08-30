import { backgroundWaitUntil } from "./context";
import { DEFAULT_ISSUE_PROMPT } from "./issue-prompt";
import {
  DEFAULT_OWNERSHIP_LABEL,
  type PrManagerContext,
} from "./pr-manager";
import { reactWorkingOnSubject, settleSubjectReaction } from "./reactions";
import { runTurnStream } from "./turn";
import type {
  ForwardSessionInput,
  GithubbotApiMessage,
  GithubbotTrace,
} from "./types";
import { errorMessage, noopLogger, nowMs, stringValue, traceLog } from "./utils";

/**
 * Issues, like PRs, are worked after an explicit ownership handoff: assignment
 * to a PAT-backed teammate or the configured App-compatible ownership label.
 * The bot runs an autonomous work turn — read the issue, implement a fix, and
 * open a PR marked with that ownership label so PR management continues it.
 * The methodology is the bundled
 * DEFAULT_ISSUE_PROMPT unless the deployment fully replaces it via
 * options.issuePrompt.
 *
 * The work runs on its own isolated session thread (`github-issue:{owner}/{repo}:
 * {n}`), kept separate from the issue's conversation thread so a work run never
 * shares a sandbox with chit-chat — but persistent per issue, so a fresh handoff
 * builds on the prior attempt. The agent does all GitHub I/O via `gh`, so the bot
 * does not post through the adapter.
 */

// Reuse the PR manager's context shape (octokit + options + state + userName);
// the two managers share the same GitHub credentials and KV store.
type IssueManagerContext = PrManagerContext;

// Assignment webhooks are de-duplicated by delivery id for a week — long enough
// to cover GitHub's redelivery window without growing state unboundedly.
const ISSUE_WORK_DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OWNED_CACHE_TTL_MS = 10 * 60 * 1000;

export function issueWorkThreadKey(
  owner: string,
  repo: string,
  n: number,
): string {
  return `github-issue:${owner}/${repo}:${n}`;
}

/** `issues` lifecycle: on an explicit ownership handoff, run an autonomous turn. */
export function handleIssueEvent(
  ctx: IssueManagerContext,
  rawBody: string,
  deliveryId: string,
): Promise<void> | null {
  const payload = parseJson(rawBody);
  if (!payload) return null;
  const action = stringValue(payload.action);
  const issue = isRecord(payload.issue) ? payload.issue : null;
  const repo = repoFromPayload(payload);
  if (!issue || !repo) return null;
  const number = numberValue(issue.number);
  if (number === undefined) return null;
  if (stringValue(issue.state) !== "open") return null;
  const ownershipLabel =
    ctx.options.ownershipLabel ?? DEFAULT_OWNERSHIP_LABEL;
  const eventLabel = stringValue(
    isRecord(payload.label) ? payload.label.name : undefined,
  );
  if (
    !isIssueWorkSignal({
      action,
      assignees: assigneeLogins(issue.assignees),
      botActorLogin: ctx.botActorLogin,
      eventLabel,
      labels: labelNames(issue.labels),
      ownershipLabel,
      userName: ctx.userName,
    })
  ) {
    return null;
  }

  const { options, state } = ctx;
  const title = stringValue(issue.title) ?? `#${number}`;
  const url =
    stringValue(issue.html_url) ??
    `https://github.com/${repo.owner}/${repo.repo}/issues/${number}`;
  const requester =
    stringValue(isRecord(payload.sender) ? payload.sender.login : undefined) ??
    "a teammate";
  const threadKey = issueWorkThreadKey(repo.owner, repo.repo, number);
  const trace: GithubbotTrace = {
    includeContext: false,
    messageId: `issue-${threadKey}-${deliveryId}`,
    mode: "execute",
    openStream: true,
    startedAtMs: nowMs(),
    threadId: threadKey,
  };

  return (async () => {
    const logger = options.logger ?? noopLogger;
    // Claim the delivery before the background run so a redelivery never
    // double-works. State-keyed (not Chat-thread-keyed) because the work thread
    // is synthetic and never touches the adapter.
    const dedupKey = `${options.stateKeyPrefix ?? "centaur-githubbot"}:issue-delivery:${threadKey}:${deliveryId}`;
    let claimed = true;
    try {
      claimed = await state.setIfNotExists(
        dedupKey,
        "1",
        ISSUE_WORK_DEDUP_TTL_MS,
      );
    } catch (error) {
      logger.debug("githubbot_issue_dedup_failed", {
        error: errorMessage(error),
      });
    }
    if (!claimed) {
      traceLog(options, "githubbot_issue_duplicate_skipped", trace, {
        delivery_id: deliveryId,
      });
      return;
    }
    traceLog(options, "githubbot_issue_work_requested", trace, {
      issue: `${repo.owner}/${repo.repo}#${number}`,
      requester,
      signal: action,
    });
    // No triggering comment on a lifecycle handoff, so ack on the issue itself —
    // instant 👀, settled to 🚀/😕 when the work turn finishes.
    await reactWorkingOnSubject(ctx.octokit, repo.owner, repo.repo, number, logger);

    let lastEventId = 0;
    const forwardInput: ForwardSessionInput = {
      afterEventId: 0,
      // The full issue-work methodology rides as the context preamble; a
      // deployment can fully replace it via options.issuePrompt.
      contextPreamble: options.issuePrompt ?? DEFAULT_ISSUE_PROMPT,
      conversationName: `${repo.owner}/${repo.repo}#${number}: ${title}`,
      executeMessage: issueTriggerMessage({
        deliveryId,
        number,
        ownershipLabel,
        owner: repo.owner,
        repo: repo.repo,
        requester,
        threadKey,
        title,
        url,
      }),
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

    backgroundWaitUntil(
      runTurnStream(options, forwardInput)
        .then(async (result) => {
          traceLog(options, "githubbot_issue_turn_complete", trace, {
            failed: result.failed,
          });
          await settleSubjectReaction(
            ctx.octokit,
            repo.owner,
            repo.repo,
            number,
            result.failed,
            logger,
          );
        })
        .catch(async (error) => {
          logger.warn("githubbot_issue_turn_failed", {
            error: errorMessage(error),
          });
          await settleSubjectReaction(
            ctx.octokit,
            repo.owner,
            repo.repo,
            number,
            true,
            logger,
          );
        }),
    );
  })();
}

/**
 * Whether an issue is owned by the bot, cached briefly so the conversational
 * path doesn't hit the API on every comment. Mirrors the PR manager's isPrOwned;
 * a stale result only affects which session a reply shares context with.
 */
export async function isIssueOwnedByBot(
  ctx: IssueManagerContext,
  owner: string,
  repo: string,
  number: number,
): Promise<boolean> {
  const cacheKey = `${ctx.options.stateKeyPrefix ?? "centaur-githubbot"}:issue-owned-cache:${owner}/${repo}#${number}`;
  try {
    const cached = await ctx.state.get<string>(cacheKey);
    if (cached === "1") return true;
    if (cached === "0") return false;
  } catch {
    // fall through to a live lookup
  }
  let owned = false;
  try {
    const { data } = await ctx.octokit.rest.issues.get({
      owner,
      repo,
      issue_number: number,
    });
    owned = isIssueOwned({
      assignees: assigneeLogins(data.assignees),
      botActorLogin: ctx.botActorLogin,
      labels: labelNames(data.labels),
      ownershipLabel: ctx.options.ownershipLabel,
      userName: ctx.userName,
    });
  } catch (error) {
    (ctx.options.logger ?? noopLogger).debug(
      "githubbot_issue_ownership_lookup_failed",
      { error: errorMessage(error) },
    );
    return false;
  }
  try {
    await ctx.state.set(cacheKey, owned ? "1" : "0", OWNED_CACHE_TTL_MS);
  } catch {
    // best-effort cache
  }
  return owned;
}

function issueTriggerMessage(input: {
  deliveryId: string;
  number: number;
  ownershipLabel: string;
  owner: string;
  repo: string;
  requester: string;
  threadKey: string;
  title: string;
  url: string;
}): GithubbotApiMessage {
  const text =
    `Centaur work was requested for GitHub issue ${input.owner}/${input.repo}#${input.number} — ` +
    `"${input.title}" (${input.url}) by @${input.requester}. Work it now, following ` +
    `your guidance above, using the gh CLI and git in your sandbox. Mark the resulting ` +
    `pull request with the exact ownership label ${JSON.stringify(input.ownershipLabel)}.`;
  return {
    attachments: [],
    author: {
      fullName: "GitHub",
      isBot: false,
      isMe: false,
      userId: "github-issue",
      userName: "github-issue",
    },
    // Keyed by delivery id so a fresh handoff re-executes (the state claim
    // dedupes a redelivery of the same lifecycle event).
    id: `issue-${input.threadKey}-${input.deliveryId}`,
    isMention: true,
    raw: { githubbotIssueWork: true, url: input.url },
    text,
    threadId: input.threadKey,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Payload parsing helpers (kept local so the issue manager is self-contained).
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

export function isAssignedToBot(assignees: string[], userName: string): boolean {
  const target = userName.toLowerCase();
  return assignees.some((login) => login.toLowerCase() === target);
}

export function isIssueOwned(input: {
  assignees: string[];
  botActorLogin?: string;
  labels: string[];
  ownershipLabel?: string;
  userName: string;
}): boolean {
  const ownershipLabel = (
    input.ownershipLabel ?? DEFAULT_OWNERSHIP_LABEL
  ).toLowerCase();
  const assignmentSupported =
    (input.botActorLogin ?? input.userName).toLowerCase() ===
    input.userName.toLowerCase();
  return (
    (assignmentSupported &&
      isAssignedToBot(input.assignees, input.userName)) ||
    input.labels.some((label) => label.toLowerCase() === ownershipLabel)
  );
}

export function isIssueWorkSignal(input: {
  action?: string;
  assignees: string[];
  botActorLogin?: string;
  eventLabel?: string;
  labels: string[];
  ownershipLabel?: string;
  userName: string;
}): boolean {
  if (
    input.action === "assigned" &&
    (input.botActorLogin ?? input.userName).toLowerCase() ===
      input.userName.toLowerCase() &&
    isAssignedToBot(input.assignees, input.userName)
  ) {
    return true;
  }
  const ownershipLabel =
    input.ownershipLabel ?? DEFAULT_OWNERSHIP_LABEL;
  return (
    input.action === "labeled" &&
    input.eventLabel?.toLowerCase() === ownershipLabel.toLowerCase() &&
    isIssueOwned(input)
  );
}

export function assigneeLogins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const logins: string[] = [];
  for (const entry of value) {
    const login = isRecord(entry) ? stringValue(entry.login) : undefined;
    if (login) logins.push(login);
  }
  return logins;
}

export function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry) {
      labels.push(entry);
      continue;
    }
    const name = isRecord(entry) ? stringValue(entry.name) : undefined;
    if (name) labels.push(name);
  }
  return labels;
}

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
