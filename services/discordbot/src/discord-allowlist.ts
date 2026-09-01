import type { Logger, Message } from "chat";
import type { DiscordbotOptions } from "./types";
import { configuredDiscordRoleIds } from "./discord-policy";

export type DiscordIngressContext = {
  authorIsBot: boolean;
  channelId: string | undefined;
  guildId: string | undefined;
  roleIds: readonly string[];
};

export type DiscordIngressDenialReason =
  | "dm"
  | "guild_allowlist_empty"
  | "guild_not_allowlisted"
  | "channel_allowlist_empty"
  | "channel_not_allowlisted"
  | "role_allowlist_empty"
  | "role_not_allowlisted";

/**
 * Decode a Discord thread key `discord:{guildId}:{channelId}[:{threadId}]` into parts.
 * Returns an empty object if the id is not a Discord thread key.
 */
export function parseDiscordThreadKey(threadKey: string): {
  guildId?: string;
  channelId?: string;
  threadId?: string;
} {
  const parts = threadKey.split(":");
  if (parts[0] !== "discord") return {};
  return { guildId: parts[1], channelId: parts[2], threadId: parts[3] };
}

/**
 * Authorization gate for inbound Discord messages.
 *
 * Unlike the Slack allowlist (which is fail-open), this is intentionally **fail-closed**:
 * Direct messages are denied outright, and all three human ingress
 * allowlists (guild, parent channel, and trigger role) must be configured.
 */
export function isAllowedDiscordMessage(
  message: Message,
  options: DiscordbotOptions,
  logger: Logger,
): boolean {
  if (message.author.isMe === true) {
    return false;
  }
  // Discord delta (mirrors slackbotv2's trigger-bot allowlist semantics):
  // bot-authored messages are rejected unless the bot is explicitly
  // allowlisted. The gateway only forwards bot messages that pass the
  // adapter's `shouldForwardBotMessage` hook (wired at the adapter
  // construction site); this gate re-checks with the full payload, where
  // application_id/webhook_id matching is possible.
  if (message.author.isBot === true) {
    if (
      !isAllowedTriggerBotMessage(message, resolveTriggerBotAllowlist(options))
    ) {
      logger.warn("discordbot_message_ignored_bot_not_allowlisted", {
        message_id: message.id,
        thread_id: message.threadId,
        user_id: message.author.userId,
      });
      return false;
    }
  }

  const { channelId, guildId } = parseDiscordThreadKey(message.threadId);
  const denialReason = discordIngressDenialReason(
    {
      authorIsBot: message.author.isBot === true,
      channelId,
      guildId,
      roleIds: discordRoleIdsFromRaw(message.raw),
    },
    options,
  );
  if (denialReason) {
    logger.warn(`discordbot_message_ignored_${denialReason}`, {
      channel_id: channelId,
      guild_id: guildId,
      message_id: message.id,
      user_id: message.author.userId,
    });
    return false;
  }

  return true;
}

/**
 * Return the deterministic denial reason for a Discord ingress context.
 * Bot-authored messages still require guild + channel admission, but their
 * identity is controlled by the separate trigger-bot allowlist rather than a
 * human member role.
 */
export function discordIngressDenialReason(
  context: DiscordIngressContext,
  options: DiscordbotOptions,
): DiscordIngressDenialReason | undefined {
  if (!context.guildId || context.guildId === "@me") return "dm";

  const guildAllowlist = resolveGuildAllowlist(options);
  if (guildAllowlist.length === 0) return "guild_allowlist_empty";
  if (!guildAllowlist.includes(context.guildId)) {
    return "guild_not_allowlisted";
  }

  const channelAllowlist = resolveChannelAllowlist(options);
  if (channelAllowlist.length === 0) return "channel_allowlist_empty";
  if (!context.channelId || !channelAllowlist.includes(context.channelId)) {
    return "channel_not_allowlisted";
  }

  if (context.authorIsBot) return undefined;

  const roleAllowlist = resolveTriggerRoleAllowlist(options);
  if (roleAllowlist.length === 0) return "role_allowlist_empty";
  const memberRoles = new Set(context.roleIds);
  if (!roleAllowlist.some((roleId) => memberRoles.has(roleId))) {
    return "role_not_allowlisted";
  }

  return undefined;
}

/** Whether a pre-dispatch context passes all deterministic ingress gates. */
export function isAllowedDiscordContext(
  context: DiscordIngressContext,
  options: DiscordbotOptions,
): boolean {
  return discordIngressDenialReason(context, options) === undefined;
}

/** Extract immutable role ids from Discord's raw MESSAGE_CREATE member data. */
export function discordRoleIdsFromRaw(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const member = (raw as { member?: unknown }).member;
  if (!member || typeof member !== "object") return [];
  const roles = (member as { roles?: unknown }).roles;
  if (!Array.isArray(roles)) return [];
  return roles.filter((roleId): roleId is string => typeof roleId === "string");
}

/**
 * Discord delta (mirrors slackbotv2's `isAllowedTriggerBotMessage`): whether a
 * bot-authored message may trigger the agent. The allowlist carries bot user
 * ids; the message's author id plus the raw payload's `application_id` and
 * `webhook_id` are all accepted as matches (webhook-style integrations post
 * under those identities).
 */
export function isAllowedTriggerBotMessage(
  message: Pick<Message, "author" | "raw">,
  allowlist: readonly string[] | undefined,
): boolean {
  if (!allowlist?.length) return false;
  const raw =
    message.raw && typeof message.raw === "object"
      ? (message.raw as { application_id?: unknown; webhook_id?: unknown })
      : {};
  const identifiers = new Set(
    [
      message.author.userId,
      typeof raw.application_id === "string" ? raw.application_id : undefined,
      typeof raw.webhook_id === "string" ? raw.webhook_id : undefined,
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  return allowlist.some((entry) => identifiers.has(entry.trim()));
}

/**
 * Guild-level slice of the allowlist check, usable from adapter hooks that run
 * before a full `Message` exists (e.g. `shouldHandleMention`, which gates
 * thread creation). Fail-closed like `isAllowedDiscordMessage`: DMs
 * (`guildId` unset or `@me`) and an empty allowlist are denied.
 */
export function isAllowedDiscordGuild(
  guildId: string | undefined,
  options: DiscordbotOptions,
): boolean {
  if (!guildId || guildId === "@me") return false;
  const allowlist =
    options.guildAllowlist ??
    splitEnvList(process.env.DISCORDBOT_GUILD_ALLOWLIST);
  return allowlist.length > 0 && new Set(allowlist).has(guildId);
}

/** Resolved parent-channel allowlist (options first, env fallback). */
export function resolveChannelAllowlist(options: DiscordbotOptions): string[] {
  return [
    ...(options.channelAllowlist ??
      splitEnvList(process.env.DISCORDBOT_CHANNEL_ALLOWLIST)),
  ];
}

/** Resolved guild allowlist (options first, env fallback). */
export function resolveGuildAllowlist(options: DiscordbotOptions): string[] {
  return [
    ...(options.guildAllowlist ??
      splitEnvList(process.env.DISCORDBOT_GUILD_ALLOWLIST)),
  ];
}

/** Resolved trigger-bot allowlist (options first, env fallback). */
export function resolveTriggerBotAllowlist(
  options: DiscordbotOptions,
): string[] {
  return [
    ...(options.triggerBotAllowlist ??
      splitEnvList(process.env.DISCORDBOT_TRIGGER_BOT_ALLOWLIST)),
  ];
}

/** Resolved human trigger-role allowlist (options first, env fallback). */
export function resolveTriggerRoleAllowlist(
  options: DiscordbotOptions,
): string[] {
  const policyRoleIds = configuredDiscordRoleIds(options);
  if (policyRoleIds.length > 0) return policyRoleIds;
  return [
    ...(options.triggerRoleAllowlist ??
      splitEnvList(process.env.DISCORDBOT_TRIGGER_ROLE_ALLOWLIST)),
  ];
}

/** True when the bot has no guild allowlist configured and will ignore every message. */
export function isGuildAllowlistEmpty(options: DiscordbotOptions): boolean {
  return resolveGuildAllowlist(options).length === 0;
}

/** True when any required human ingress allowlist is empty. */
export function isDiscordIngressAllowlistEmpty(
  options: DiscordbotOptions,
): boolean {
  return (
    resolveGuildAllowlist(options).length === 0 ||
    resolveChannelAllowlist(options).length === 0 ||
    configuredDiscordRoleIds(options).length === 0
  );
}

function splitEnvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
