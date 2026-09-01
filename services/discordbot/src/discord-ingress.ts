import type { Logger, Message, StateAdapter } from "chat";
import {
  parseDiscordThreadKey,
  resolveChannelAllowlist,
  resolveGuildAllowlist,
} from "./discord-allowlist";
import {
  resolveDiscordPermissionBundle,
  type DiscordPermissionBundle,
} from "./discord-policy";
import type { DiscordbotOptions } from "./types";

const DEFAULT_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CONTINUATION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_EVENT_AGE_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const SUPPORTED_MESSAGE_TYPES = new Set([0, 19]);

export type DiscordGatewayMessageEvent = {
  applicationId?: string;
  authorId: string;
  authorIsBot: boolean;
  authorIsSelf: boolean;
  channelId: string;
  content: string;
  createdTimestamp: number;
  gatewayIdentityVerified: boolean;
  guildId: string;
  isMentioned: boolean;
  messageId: string;
  messageType: number;
  roleIds: string[];
  threadId?: string;
  webhookId?: string;
};

export type DiscordIngressReason =
  | "accepted"
  | "approval_not_authorized"
  | "actor_mismatch"
  | "authorized_root_missing"
  | "bot_message"
  | "channel_not_allowlisted"
  | "direct_message"
  | "duplicate_delivery"
  | "future_delivery"
  | "gateway_identity_unverified"
  | "guild_not_allowlisted"
  | "invalid_event"
  | "invalid_approval_command"
  | "policy_changed_requires_root_trigger"
  | "role_not_authorized"
  | "role_policy_ambiguous"
  | "role_policy_missing"
  | "root_expired"
  | "root_trigger_required"
  | "self_message"
  | "stale_delivery"
  | "state_unavailable"
  | "unsupported_message_type"
  | "webhook_message";

export type DiscordAcceptedAdmission = {
  actorId: string;
  channelId: string;
  control?: "approve" | "stop";
  decision: "allow";
  guildId: string;
  messageId: string;
  policy: DiscordPermissionBundle;
  proposalFingerprint?: string;
  reason: "accepted";
  receivedAt: number;
  rootMessageId: string;
  roleIds: string[];
  threadId: string;
  version: 1;
};

type DiscordDeniedAdmission = {
  actorId: string;
  channelId: string;
  decision: "deny";
  guildId: string;
  messageId: string;
  reason: Exclude<DiscordIngressReason, "accepted">;
  receivedAt: number;
  threadId?: string;
  version: 1;
};

type DiscordAdmissionRecord = DiscordAcceptedAdmission | DiscordDeniedAdmission;

type AuthorizedRoot = {
  actorId: string;
  channelId: string;
  expiresAt: number;
  guildId: string;
  latestTriggerMessageId: string;
  policy: DiscordPermissionBundle;
  rootMessageId: string;
  threadId: string;
  version: 1;
};

/**
 * Authenticate and authorize one Gateway event before the adapter creates a
 * Discord thread or dispatches into Chat. The delivery claim is atomic and its
 * stable audit record is durable; state errors deny the event.
 */
export async function admitDiscordGatewayMessage(
  event: DiscordGatewayMessageEvent,
  options: DiscordbotOptions,
  state: StateAdapter,
  logger: Logger,
  now = Date.now(),
): Promise<DiscordAcceptedAdmission | null> {
  const pending: DiscordDeniedAdmission = {
    actorId: event.authorId,
    channelId: event.channelId,
    decision: "deny",
    guildId: event.guildId,
    messageId: event.messageId,
    reason: "state_unavailable",
    receivedAt: now,
    threadId: event.threadId,
    version: 1,
  };
  let claimed: boolean;
  try {
    claimed = await state.setIfNotExists(
      deliveryKey(event.messageId),
      pending,
      options.ingressDeliveryTtlMs ?? DEFAULT_DELIVERY_TTL_MS,
    );
  } catch {
    audit(logger, pending);
    return null;
  }
  if (!claimed) {
    audit(logger, { ...pending, reason: "duplicate_delivery" });
    return null;
  }

  let record: DiscordAdmissionRecord;
  try {
    record = await evaluateAdmission(event, options, state, now);
  } catch {
    record = { ...pending, reason: "state_unavailable" };
  }
  try {
    await state.set(
      deliveryKey(event.messageId),
      record,
      options.ingressDeliveryTtlMs ?? DEFAULT_DELIVERY_TTL_MS,
    );
  } catch {
    record = { ...pending, reason: "state_unavailable" };
  }
  audit(logger, record);
  return record.decision === "allow" ? record : null;
}

/** Load the immutable accepted admission that the Gateway persisted. */
export async function acceptedDiscordAdmissionForMessage(
  message: Message,
  state: StateAdapter,
): Promise<DiscordAcceptedAdmission | null> {
  const record = await state.get<unknown>(deliveryKey(message.id));
  if (!isAcceptedAdmission(record)) return null;
  const parsed = parseDiscordThreadKey(message.threadId);
  if (
    record.actorId !== message.author.userId ||
    record.guildId !== parsed.guildId ||
    record.channelId !== parsed.channelId ||
    record.threadId !== parsed.threadId
  ) {
    return null;
  }
  return record;
}

/** Build the same authenticated event shape for tests/direct Chat dispatch. */
export function discordGatewayEventFromMessage(
  message: Message,
  options: DiscordbotOptions,
): DiscordGatewayMessageEvent | null {
  const raw = message.raw && typeof message.raw === "object"
    ? (message.raw as Record<string, unknown>)
    : {};
  const parsed = parseDiscordThreadKey(message.threadId);
  if (!parsed.guildId || !parsed.channelId) return null;
  const member = raw.member && typeof raw.member === "object"
    ? (raw.member as Record<string, unknown>)
    : {};
  const roles = Array.isArray(member.roles)
    ? member.roles.filter((role): role is string => typeof role === "string")
    : [];
  return {
    applicationId:
      typeof raw.application_id === "string" ? raw.application_id : undefined,
    authorId: message.author.userId,
    authorIsBot: message.author.isBot === true,
    authorIsSelf: message.author.isMe === true,
    channelId: parsed.channelId,
    content: message.text,
    createdTimestamp: message.metadata.dateSent.getTime(),
    gatewayIdentityVerified: true,
    guildId: parsed.guildId,
    isMentioned: message.isMention === true,
    messageId: message.id,
    messageType: typeof raw.type === "number" ? raw.type : 0,
    roleIds: roles,
    threadId: parsed.threadId,
    webhookId: typeof raw.webhook_id === "string" ? raw.webhook_id : undefined,
  };
}

function baseDenied(
  event: DiscordGatewayMessageEvent,
  reason: DiscordDeniedAdmission["reason"],
  now: number,
): DiscordDeniedAdmission {
  return {
    actorId: event.authorId,
    channelId: event.channelId,
    decision: "deny",
    guildId: event.guildId,
    messageId: event.messageId,
    reason,
    receivedAt: now,
    threadId: event.threadId,
    version: 1,
  };
}

async function evaluateAdmission(
  event: DiscordGatewayMessageEvent,
  options: DiscordbotOptions,
  state: StateAdapter,
  now: number,
): Promise<DiscordAdmissionRecord> {
  const deny = (reason: DiscordDeniedAdmission["reason"]) =>
    baseDenied(event, reason, now);
  if (event.guildId === "@me") return deny("direct_message");
  if (!validEventIds(event)) return deny("invalid_event");
  if (!event.gatewayIdentityVerified) return deny("gateway_identity_unverified");
  if (event.createdTimestamp > now + MAX_CLOCK_SKEW_MS) return deny("future_delivery");
  if (
    now - event.createdTimestamp >
    (options.ingressMaxEventAgeMs ?? DEFAULT_MAX_EVENT_AGE_MS)
  ) {
    return deny("stale_delivery");
  }
  if (event.authorIsSelf) return deny("self_message");
  if (event.webhookId) return deny("webhook_message");
  if (event.authorIsBot) return deny("bot_message");
  if (!SUPPORTED_MESSAGE_TYPES.has(event.messageType)) {
    return deny("unsupported_message_type");
  }
  if (!resolveGuildAllowlist(options).includes(event.guildId)) {
    return deny("guild_not_allowlisted");
  }
  if (!resolveChannelAllowlist(options).includes(event.channelId)) {
    return deny("channel_not_allowlisted");
  }
  const resolution = resolveDiscordPermissionBundle(event.roleIds, options);
  if (resolution.decision === "deny") return deny(resolution.reason);
  const policy = resolution.bundle;
  const threadId = event.threadId ?? event.messageId;
  const key = rootKey(event.guildId, event.channelId, threadId);
  const existing = await state.get<unknown>(key);
  const root = isAuthorizedRoot(existing) ? existing : undefined;
  const control = event.isMentioned ? controlCommand(event.content) : undefined;
  if (control && "invalid" in control) return deny("invalid_approval_command");
  if (control?.type === "approve" && !policy.canApprove) {
    return deny("approval_not_authorized");
  }

  if (control?.type === "stop") {
    if (!root) return deny("authorized_root_missing");
    if (root.expiresAt < now) return deny("root_expired");
    if (root.actorId !== event.authorId) return deny("actor_mismatch");
    if (root.policy.fingerprint !== policy.fingerprint) {
      return deny("policy_changed_requires_root_trigger");
    }
    return accepted(event, root, policy, now, { type: "stop" });
  }

  if (!event.isMentioned) {
    if (!event.threadId) return deny("root_trigger_required");
    if (!root) return deny("authorized_root_missing");
    if (root.expiresAt < now) return deny("root_expired");
    if (root.actorId !== event.authorId) return deny("actor_mismatch");
    if (root.policy.fingerprint !== policy.fingerprint) {
      return deny("policy_changed_requires_root_trigger");
    }
    return accepted(event, root, policy, now);
  }

  // A mention inside an arbitrary existing thread is not a new authority
  // root. Production roots arrive in the explicitly allowlisted parent
  // channel; the adapter then creates a thread whose immutable id is the root
  // message id. Every later thread event must find that durable root.
  if (event.threadId) {
    if (!root) return deny("authorized_root_missing");
    if (root.expiresAt < now) return deny("root_expired");
  }

  if (root && root.actorId !== event.authorId && root.expiresAt >= now) {
    return deny("actor_mismatch");
  }
  const continuationTtlMs =
    options.continuationTtlMs ?? DEFAULT_CONTINUATION_TTL_MS;
  const nextRoot: AuthorizedRoot = {
    actorId: event.authorId,
    channelId: event.channelId,
    expiresAt: now + continuationTtlMs,
    guildId: event.guildId,
    latestTriggerMessageId: event.messageId,
    policy,
    rootMessageId: root?.rootMessageId ?? event.messageId,
    threadId,
    version: 1,
  };
  if (root) {
    await state.set(key, nextRoot, continuationTtlMs);
  } else {
    const claimed = await state.setIfNotExists(
      key,
      nextRoot,
      continuationTtlMs,
    );
    if (!claimed) return deny("state_unavailable");
  }
  return accepted(event, nextRoot, policy, now, control);
}

function accepted(
  event: DiscordGatewayMessageEvent,
  root: AuthorizedRoot,
  policy: DiscordPermissionBundle,
  now: number,
  control?: { fingerprint?: string; type: "approve" | "stop" },
): DiscordAcceptedAdmission {
  return {
    actorId: event.authorId,
    channelId: event.channelId,
    ...(control ? { control: control.type } : {}),
    decision: "allow",
    guildId: event.guildId,
    messageId: event.messageId,
    policy,
    ...(control?.fingerprint
      ? { proposalFingerprint: control.fingerprint }
      : {}),
    reason: "accepted",
    receivedAt: now,
    rootMessageId: root.rootMessageId,
    roleIds: [...new Set(event.roleIds)].sort(),
    threadId: root.threadId,
    version: 1,
  };
}

function controlCommand(content: string):
  | { fingerprint: string; type: "approve" }
  | { type: "stop" }
  | { invalid: true }
  | undefined {
  const command = content
    .replace(/<@!?\d+>/g, " ")
    .replace(/<@&\d+>/g, " ")
    .trim()
    .toLowerCase();
  if (command === "stop" || command === "cancel") return { type: "stop" };
  const approval = command.match(/^approve\s+(sha256:[0-9a-f]{64})$/);
  if (approval?.[1]) return { fingerprint: approval[1], type: "approve" };
  if (/^approve(?:\s|$)/.test(command)) return { invalid: true };
  return undefined;
}

function validEventIds(event: DiscordGatewayMessageEvent): boolean {
  const snowflake = /^\d{16,22}$/;
  return (
    [event.authorId, event.channelId, event.guildId, event.messageId].every(
      (value) => typeof value === "string" && snowflake.test(value),
    ) &&
    (event.threadId === undefined || snowflake.test(event.threadId)) &&
    Array.isArray(event.roleIds) &&
    event.roleIds.every((roleId) => snowflake.test(roleId)) &&
    typeof event.content === "string" &&
    Number.isFinite(event.createdTimestamp) &&
    Number.isSafeInteger(event.messageType)
  );
}

function deliveryKey(messageId: string): string {
  return `discordbot:ingress:delivery:${messageId}`;
}

function rootKey(guildId: string, channelId: string, threadId: string): string {
  return `discordbot:ingress:root:${guildId}:${channelId}:${threadId}`;
}

function audit(logger: Logger, record: DiscordAdmissionRecord): void {
  logger.info("discordbot_ingress_audit", {
    actor_id: record.actorId,
    channel_id: record.channelId,
    decision: record.decision,
    guild_id: record.guildId,
    message_id: record.messageId,
    reason: record.reason,
    thread_id: record.threadId,
    ...(record.decision === "allow"
      ? {
          capability_class: record.policy.capabilityClass,
          control: record.control,
          policy_fingerprint: record.policy.fingerprint,
          project_scope: record.policy.projectScope,
          repository_scope: record.policy.repositoryScope,
          role_ids: record.roleIds,
        }
      : {}),
  });
}

function isAcceptedAdmission(value: unknown): value is DiscordAcceptedAdmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<DiscordAcceptedAdmission>;
  return (
    record.version === 1 &&
    record.decision === "allow" &&
    record.reason === "accepted" &&
    typeof record.actorId === "string" &&
    typeof record.channelId === "string" &&
    typeof record.guildId === "string" &&
    typeof record.messageId === "string" &&
    typeof record.threadId === "string" &&
    record.policy !== undefined &&
    typeof record.policy.fingerprint === "string"
  );
}

function isAuthorizedRoot(value: unknown): value is AuthorizedRoot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const root = value as Partial<AuthorizedRoot>;
  return (
    root.version === 1 &&
    typeof root.actorId === "string" &&
    typeof root.channelId === "string" &&
    typeof root.expiresAt === "number" &&
    Number.isFinite(root.expiresAt) &&
    typeof root.guildId === "string" &&
    typeof root.rootMessageId === "string" &&
    typeof root.threadId === "string" &&
    root.policy !== undefined &&
    typeof root.policy.fingerprint === "string"
  );
}
