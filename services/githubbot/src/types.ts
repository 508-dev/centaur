import type { RustSessionStreamEvent } from "@centaur/harness-events";
import type { CodexAppServerToChatStreamOptions } from "@centaur/rendering";
import type { Attachment, Chat, Logger, StateAdapter } from "chat";
import type { Hono } from "hono";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type GithubbotApiAuthor = {
  fullName: string;
  isBot: boolean | "unknown";
  isMe: boolean;
  userId: string;
  userName: string;
};

export type GithubbotApiAttachment = {
  dataBase64?: string;
  dataBase64Omitted?: string;
  fetchError?: string;
  fetchMetadata?: Record<string, string>;
  height?: number;
  mimeType?: string;
  name?: string;
  size?: number;
  type: Attachment["type"];
  url?: string;
  width?: number;
};

// GitHub scopes by repository (owner/repo), resolved from the thread id. The
// controller uses one fixed GitHub identity (a preferred App installation or a
// compatibility PAT), so sessions are keyed by thread id alone (no
// per-workspace token like Slack's teamId).
export type GithubbotApiMessage = {
  attachments: GithubbotApiAttachment[];
  author: GithubbotApiAuthor;
  id: string;
  isMention: boolean;
  raw: unknown;
  text: string;
  threadId: string;
  timestamp: string;
};

export type GithubbotSessionMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool";

export type GithubbotSessionMessage = {
  client_message_id?: string;
  metadata: JsonObject;
  parts: JsonValue[];
  role: GithubbotSessionMessageRole;
};

export type GithubbotAppendMessagesRequest = {
  messages: GithubbotSessionMessage[];
};

export type GithubbotCreateSessionRequest = {
  harness_type: string;
  metadata: JsonObject;
  /** 'restart': switch the thread to harness_type if it's pinned to another harness. */
  on_harness_conflict?: "reject" | "restart";
};

export type GithubbotExecuteSessionRequest = {
  idempotency_key?: string;
  idle_timeout_ms?: number;
  input_lines: string[];
  max_duration_ms?: number;
  metadata: JsonObject;
};

export type GithubbotExecuteSessionResponse = {
  execution_id: string;
  ok: boolean;
  status: string;
  thread_key: string;
};

export type GithubbotFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type GithubbotOptions = {
  apiKey?: string;
  apiUrl: string;
  /**
   * Bot's GitHub user id (numeric, as a string). Used by the adapter for
   * self-message detection; auto-detected from the token when omitted.
   */
  botUserId?: string;
  /**
   * Connect the Postgres state (and initialize the adapter) at startup.
   * Defaults to true; tests pass false to skip the live connect against mock
   * backends.
   */
  connectStateOnStart?: boolean;
  /**
   * Harness for new threads when no --claude/--amp/--codex flag is given
   * (HarnessType wire value: codex | amp | claudecode). Defaults to codex.
   */
  defaultHarnessType?: string;
  fetch?: GithubbotFetch;
  /** Override the GitHub REST API base URL (GitHub Enterprise / emulation). */
  githubApiUrl?: string;
  idleTimeoutMs?: number;
  logger?: Logger;
  mapper?: CodexAppServerToChatStreamOptions;
  maxDurationMs?: number;
  postgresUrl?: string;
  state?: StateAdapter;
  stateKeyPrefix?: string;
  /**
   * Full review methodology used on review-request turns. Defaults to the
   * bundled DEFAULT_REVIEW_PROMPT; a deployment can fully replace it via
   * GITHUBBOT_REVIEW_PROMPT(_FILE) so org conventions override ours wholesale.
   */
  reviewPrompt?: string;
  /**
   * Full issue-work methodology used when an issue is assigned to the bot.
   * Defaults to the bundled DEFAULT_ISSUE_PROMPT; a deployment can fully replace
   * it via GITHUBBOT_ISSUE_PROMPT(_FILE) so org playbooks override ours wholesale.
   */
  issuePrompt?: string;
  /**
   * Extra guidance prepended to every owned-PR management turn (CI-fix, conflict
   * resolution, address-review) — the riskiest autonomous surface, where a
   * deployment may want to constrain how the agent edits and pushes (e.g. "never
   * force-push", "always run the suite first") without forking the per-action
   * instructions. Unset -> just the built-in per-action preamble. Set via
   * GITHUBBOT_MANAGEMENT_PROMPT(_FILE).
   */
  managementPrompt?: string;
  /**
   * v2 PR self-management: auto-merge owned PRs when GitHub reports them
   * mergeable (branch protection is the source of truth). Defaults to true.
   */
  autoMerge?: boolean;
  /** Max consecutive CI-fix attempts on an owned PR before escalating. Default 3. */
  ciFixMaxAttempts?: number;
  /** Review passes allowed per reviewer in one epoch. Default 3. */
  reviewMaxRoundsPerEpoch?: number;
  /** Aggregate review passes allowed across all reviewers in one epoch. Default 6. */
  reviewMaxTotalRoundsPerEpoch?: number;
  /** Material-change epochs allowed before human continuation is required. Default 3. */
  reviewMaxEpochs?: number;
  /** Cumulative changed runtime lines that make a review change material. Default 200. */
  reviewMaterialChangeLines?: number;
  /** Cumulative changed runtime files that make a review change material. Default 8. */
  reviewMaterialChangeFiles?: number;
  /** Exact GitHub logins for trusted reviewer bots whose association is NONE. */
  reviewAuthorAllowlist?: readonly string[];
  /** Write-authorized human label that explicitly starts another review epoch. */
  reviewResetLabel?: string;
  /** Delay before confirming a settled-green rollup. Default 15000ms. */
  ciSettleConfirmMs?: number;
  /** Emit settled CI and submitted-review workflow events. Default false. */
  workflowEvents?: boolean;
  /** Delete the head branch after the bot merges an owned PR. Default true. */
  deleteBranchOnMerge?: boolean;
  /** Fallback @handle to tag when the bot gives up and escalates. */
  escalationHandle?: string;
  /** Label that pauses auto-merge on a PR. Default "do-not-merge". */
  holdLabel?: string;
  /** Merge method for auto-merge: "merge" | "squash" | "rebase". Default "squash". */
  mergeMethod?: "merge" | "squash" | "rebase";
  /** Personal access token for the bot's GitHub teammate account. */
  token?: string;
  /**
   * GitHub App Client ID used as the JWT issuer. GitHub and Octokit recommend
   * the Client ID over the legacy numeric App ID.
   */
  githubAppClientId?: string;
  /** Fixed organization/repository installation used by this bot instance. */
  githubAppInstallationId?: number;
  /** GitHub App PEM contents. Mount a Secret and read it at process startup. */
  githubAppPrivateKey?: string;
  /**
   * Login GitHub records for actions by this identity. In App mode this is the
   * App slug with `[bot]`; `userName` remains the mention slug.
   */
  botActorLogin?: string;
  /**
   * Label that explicitly hands a PR or issue to lifecycle automation. Defaults
   * to `centaur-managed`; useful for Apps, which cannot be assignees.
   */
  ownershipLabel?: string;
  userName?: string;
  /**
   * GitHub `author_association` values allowed to drive the conversational
   * (comment-mention) path. Defaults to OWNER/MEMBER/COLLABORATOR; the sentinel
   * "*" allows everyone (e.g. a fully-private repo where every commenter is
   * already trusted). Lifecycle paths (assignment, review-request) are gated by
   * GitHub permissions and are not affected by this.
   */
  allowedAuthorAssociations?: string[];
  /**
   * Exact owner/repository names whose signed webhooks may reach the bot.
   * Empty or unset is fail-closed.
   */
  repositoryAllowlist?: readonly string[];
  /** Webhook signing secret configured on the GitHub repo/org webhook. */
  webhookSecret: string;
};

export type Githubbot = {
  app: Hono;
  chat: Chat;
};

export type GithubbotThreadState = {
  /** Set once the thread's first turn has run (gates follow-up ingestion). */
  historyForwarded?: boolean;
  /** Codex provider pinned for this thread. Null clears a previous selection. */
  provider?: string | null;
  /**
   * Set once the full PR/issue context (with body) has ridden a turn's execute;
   * later turns prepend only the compact header instead.
   */
  contextSeeded?: boolean;
  /** Highest session-event id seen, used as the replay watermark. */
  lastEventId?: number;
  /**
   * For an owned PR, the management session key (`github-manage:…`) this
   * conversation thread routes turns to — resolved once on the first mention
   * so follow-ups don't re-look-up ownership.
   */
  managementSessionKey?: string;
  /**
   * Ids of comments this thread has already answered, so a webhook redelivery
   * never double-replies. Capped FIFO.
   */
  repliedMessageIds?: string[];
  /**
   * Ids of non-mention comments this thread has already appended to its session
   * as context, so a redelivery never double-appends. Separate from
   * repliedMessageIds so the high-volume follow-up stream can't evict mention
   * ids from their dedup window. Capped FIFO.
   */
  ingestedMessageIds?: string[];
  /**
   * Delivery ids of review-request webhooks this thread has already run a review
   * turn for, so a redelivered pull_request webhook doesn't re-review. Capped FIFO.
   */
  reviewedDeliveryIds?: string[];
};

export type GithubbotRendererSource = RustSessionStreamEvent | JsonObject;

export type GithubbotTrace = {
  includeContext: boolean;
  messageId: string;
  mode: "execute";
  openStream: boolean;
  startedAtMs: number;
  threadId: string;
};

export type ForwardSessionInput = {
  afterEventId: number;
  /**
   * Human-readable conversation name (owner/repo#N: title) carried in the
   * create-session metadata as `github_conversation_name`; api-rs uses it as the
   * session principal's display name.
   */
  conversationName?: string;
  /**
   * Prepended to the execute message content as a text part. Set when a harness
   * restart discards the previous harness's conversation state so the new
   * harness still sees the PR/issue + comment history.
   */
  contextPreamble?: string;
  executionId?: string;
  executeMessage?: GithubbotApiMessage;
  /** Harness override parsed from message flags (--claude/--amp/--codex). */
  harnessType?: string;
  messages: GithubbotApiMessage[];
  /** Per-turn model override parsed from message flags (--model/--opus/...). */
  model?: string;
  /** Effective model provider selected by a message flag; codex only. */
  provider?: string;
  onEventId(eventId: number): void;
  openStream: boolean;
  threadId: string;
  trace?: GithubbotTrace;
};
