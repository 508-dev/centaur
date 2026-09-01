import type { RustSessionStreamEvent } from "@centaur/harness-events";
import type { CodexAppServerToChatStreamOptions } from "@centaur/rendering";
import type { Attachment, Chat, Logger, StateAdapter } from "chat";
import type { Hono } from "hono";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type DiscordbotApiAuthor = {
  fullName: string;
  isBot: boolean | "unknown";
  isMe: boolean;
  userId: string;
  userName: string;
};

export type DiscordbotApiAttachment = {
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

export type DiscordbotApiMessage = {
  attachments: DiscordbotApiAttachment[];
  author: DiscordbotApiAuthor;
  id: string;
  isMention: boolean;
  raw: unknown;
  text: string;
  threadId: string;
  timestamp: string;
};

export type DiscordbotSessionMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool";

export type DiscordbotSessionMessage = {
  client_message_id?: string;
  metadata: JsonObject;
  parts: JsonValue[];
  role: DiscordbotSessionMessageRole;
};

export type DiscordbotAppendMessagesRequest = {
  messages: DiscordbotSessionMessage[];
};

export type DiscordbotCreateSessionRequest = {
  harness_type: string;
  metadata: JsonObject;
};

export type DiscordbotExecuteSessionRequest = {
  idempotency_key?: string;
  idle_timeout_ms?: number;
  input_lines: string[];
  max_duration_ms?: number;
  metadata: JsonObject;
};

export type DiscordbotExecuteSessionResponse = {
  execution_id: string;
  ok: boolean;
  status: string;
  thread_key: string;
};

export type DiscordbotInterruptSessionResponse = {
  execution_id?: string;
  interrupted: boolean;
  ok: boolean;
  thread_key: string;
};

export type DiscordbotApproveProposalResponse = {
  action_run_id: string;
  action_task_id: string;
  action_workflow: string;
  console_url?: string;
  created: boolean;
  fingerprint: string;
  ok: boolean;
};

export type DiscordbotFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type DiscordbotOptions = {
  /**
   * Discord delta: TTL after which a persisted `activeExecution` flag is
   * treated as stale (a crash between marking and clearing would otherwise
   * wedge the thread forever — Gateway ingress has no redelivery to kick it).
   */
  activeExecutionTtlMs?: number;
  /** Test-only escape hatch for the adapter's in-process event emulator. */
  allowInProcessGatewayEmulation?: boolean;
  /** Discord delta: edit cadence for the in-progress answer message. */
  answerEditIntervalMs?: number;
  apiKey?: string;
  apiUrl: string;
  applicationId: string;
  botToken: string;
  discordApiUrl?: string;
  fetch?: DiscordbotFetch;
  /**
   * Parent channel ids allowed to start or continue agent turns. Empty or
   * unset is fail-closed so a guild-wide bot cannot be activated accidentally.
   */
  channelAllowlist?: readonly string[];
  /** Maximum age of a Gateway MESSAGE_CREATE accepted at ingress. Default 5 minutes. */
  ingressMaxEventAgeMs?: number;
  /** Durable inbound-delivery dedup/audit retention. Default 7 days. */
  ingressDeliveryTtlMs?: number;
  /** Authorized root-to-follow-up lifetime. Default 24 hours. */
  continuationTtlMs?: number;
  guildAllowlist?: readonly string[];
  idleTimeoutMs?: number;
  /** Liveness probe for `/health`; reflects the Gateway connection state. */
  isGatewayActive?: () => boolean;
  logger?: Logger;
  mapper?: CodexAppServerToChatStreamOptions;
  /** Discord delta: per-guild cap on concurrently executing runs. Default 3. */
  maxConcurrentExecutionsPerGuild?: number;
  maxDurationMs?: number;
  mentionRoleIds?: string[];
  /** Rename auto-created threads to the message-derived title. Defaults to true. */
  nameThreads?: boolean;
  postgresUrl?: string;
  publicKey: string;
  recoverRenderObligationsOnStart?: boolean;
  /** Reviewed Discord role-to-Centaur permission bundles. Empty is inert. */
  roleBindings?: readonly DiscordRoleBinding[];
  state?: StateAdapter;
  stateKeyPrefix?: string;
  /**
   * Exact bot/application/webhook identities bound to an existing, non-approver
   * Discord permission bundle. Empty is deny-by-default.
   */
  triggerBotBindings?: readonly DiscordTriggerBotBinding[];
  /**
   * @deprecated An identity allowlist without a reviewed policy bundle never
   * authorizes bot work. Use `triggerBotBindings` instead.
   */
  triggerBotAllowlist?: readonly string[];
  /**
   * Discord role ids allowed to start or continue human-authored turns.
   * Numeric ids are used instead of mutable role names.
   */
  triggerRoleAllowlist?: readonly string[];
  userName?: string;
};

export type DiscordRoleBinding = {
  /** Whether this reviewed role may atomically consume action proposals. */
  canApprove: boolean;
  /** Stable, machine-readable capability class recorded on every run. */
  capabilityClass: string;
  /** Existing iron-control role foreign ID reconciled onto the actor principal. */
  principalRole: string;
  /** Higher wins; equal-priority, non-identical matches fail closed. */
  priority: number;
  /** Exact project identifiers this actor bundle may address. */
  projectScope: readonly string[];
  /** Exact owner/repository names; wildcards are forbidden. */
  repositoryScope: readonly string[];
  /** Immutable numeric Discord role ID. */
  roleId: string;
};

/** A verified non-human Discord identity bound to one existing role policy. */
export type DiscordTriggerBotBinding = {
  /** Immutable bot user, application, or webhook snowflake. */
  identityId: string;
  /** Existing reviewed Discord role binding that supplies the exact bundle. */
  roleId: string;
};

export type DiscordExecutionPolicy = {
  actorId: string;
  capabilityClass: string;
  channelId: string;
  guildId: string;
  policyFingerprint: string;
  principalRole: string;
  projectScope: string[];
  repositoryScope: string[];
  rootMessageId: string;
  threadId: string;
};

export type Discordbot = {
  app: Hono;
  chat: Chat;
  adapter: GatewayCapableAdapter;
};

export type DiscordbotThreadState = {
  activeExecution?: boolean;
  /**
   * Discord delta: epoch ms when `activeExecution` was last (re)confirmed;
   * the flag is ignored once this is older than the active-execution TTL.
   * Cleared (null) together with the flag.
   */
  activeExecutionStartedAt?: number | null;
  executedMessageIds?: string[];
  forwardedMessageIds?: string[];
  historyForwarded?: boolean;
  lastEventId?: number;
  renderObligation?: DiscordbotRenderObligation | null;
};

export type DiscordbotRenderObligation = {
  afterEventId: number;
  executionId: string;
  message: DiscordbotApiMessage;
};

export type DiscordbotMessageMode = "append" | "execute";

export type DiscordbotRendererSource = RustSessionStreamEvent | JsonObject;

export type DiscordbotTrace = {
  includeContext: boolean;
  messageId: string;
  mode: DiscordbotMessageMode;
  openStream: boolean;
  startedAtMs: number;
  threadId: string;
};

export type ForwardSessionInput = {
  afterEventId: number;
  /**
   * Human-readable channel name carried in the create-session metadata as
   * `discord_conversation_name`; api-rs uses it as the session principal's
   * display name.
   */
  conversationName?: string;
  executionId?: string;
  executeMessage?: DiscordbotApiMessage;
  messages: DiscordbotApiMessage[];
  onEventId(eventId: number): void;
  openStream: boolean;
  policy: DiscordExecutionPolicy;
  threadId: string;
  trace?: DiscordbotTrace;
};

/** Minimal slice of the Discord adapter the Gateway runner needs. */
export type GatewayCapableAdapter = {
  startGatewayListener(
    options: { waitUntil(promise: Promise<unknown>): void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string,
  ): Promise<unknown>;
};

/** Minimal slice of the Discord adapter used to send a typing indicator. */
export type TypingCapableAdapter = {
  startTyping?(threadId: string, status?: string): Promise<void>;
};
