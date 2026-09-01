import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Logger, StateAdapter } from "chat";
import { resolveChannelAllowlist } from "./discord-allowlist";
import { DEFAULT_DISCORD_API_URL } from "./discord-threading";
import type { DiscordbotOptions } from "./types";

const MAX_DELIVERY_ID_LENGTH = 128;
const MAX_DELIVERY_TEXT_LENGTH = 1_900;
const DELIVERY_RESULT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DELIVERY_LEASE_TTL_MS = 60 * 1_000;

export type DiscordDeliveryInput = {
  channel_id: string;
  delivery_id: string;
  text: string;
};

export type DiscordDeliveryResult = {
  channel_id: string;
  delivery_id: string;
  message_id: string;
  ok: true;
};

export class DiscordDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 409 | 502 | 503,
  ) {
    super(code);
  }
}

export function authorizeDiscordDelivery(
  authorization: string | undefined,
  apiKey: string | undefined,
): void {
  const prefix = "Bearer ";
  const provided = authorization?.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : "";
  if (!apiKey || !provided || !constantTimeEqual(provided, apiKey)) {
    throw new DiscordDeliveryError("unauthorized", 401);
  }
}

export async function deliverDiscordNotification(
  raw: unknown,
  options: DiscordbotOptions,
  state: StateAdapter,
  logger: Logger,
): Promise<DiscordDeliveryResult> {
  const input = validateDeliveryInput(raw, options);
  const resultKey = `discordbot:delivery:result:${input.delivery_id}`;
  const leaseKey = `discordbot:delivery:lease:${input.delivery_id}`;

  let existing: unknown;
  try {
    existing = await state.get<unknown>(resultKey);
  } catch {
    throw new DiscordDeliveryError("state_unavailable", 503);
  }
  if (isDeliveryResult(existing, input)) return existing;

  const leaseToken = randomUUID();
  let claimed: boolean;
  try {
    claimed = await state.setIfNotExists(
      leaseKey,
      leaseToken,
      DELIVERY_LEASE_TTL_MS,
    );
  } catch {
    throw new DiscordDeliveryError("state_unavailable", 503);
  }
  if (!claimed) throw new DiscordDeliveryError("delivery_in_progress", 409);

  try {
    existing = await state.get<unknown>(resultKey);
    if (isDeliveryResult(existing, input)) return existing;

    const result = await postDiscordMessage(input, options);
    await state.set(resultKey, result, DELIVERY_RESULT_TTL_MS);
    logger.info("discordbot_delivery_audit", {
      channel_id: result.channel_id,
      delivery_id: result.delivery_id,
      message_id: result.message_id,
      reason: "delivered",
    });
    return result;
  } catch (error) {
    logger.warn("discordbot_delivery_audit", {
      channel_id: input.channel_id,
      delivery_id: input.delivery_id,
      reason:
        error instanceof DiscordDeliveryError ? error.code : "delivery_failed",
    });
    if (error instanceof DiscordDeliveryError) throw error;
    throw new DiscordDeliveryError("delivery_failed", 502);
  } finally {
    try {
      if ((await state.get<string>(leaseKey)) === leaseToken) {
        await state.delete(leaseKey);
      }
    } catch {
      // The short lease expires automatically. Never turn a successful,
      // durably recorded delivery into a retry solely because cleanup failed.
    }
  }
}

function validateDeliveryInput(
  raw: unknown,
  options: DiscordbotOptions,
): DiscordDeliveryInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DiscordDeliveryError("invalid_request", 400);
  }
  const value = raw as Record<string, unknown>;
  const channelId = value.channel_id;
  const deliveryId = value.delivery_id;
  const text = value.text;
  if (
    typeof channelId !== "string" ||
    !/^\d{16,22}$/.test(channelId) ||
    !resolveChannelAllowlist(options).includes(channelId)
  ) {
    throw new DiscordDeliveryError("channel_not_allowlisted", 400);
  }
  if (
    typeof deliveryId !== "string" ||
    deliveryId.length === 0 ||
    deliveryId.length > MAX_DELIVERY_ID_LENGTH ||
    !/^[A-Za-z0-9:_-]+$/.test(deliveryId)
  ) {
    throw new DiscordDeliveryError("invalid_delivery_id", 400);
  }
  if (
    typeof text !== "string" ||
    text.trim().length === 0 ||
    text.length > MAX_DELIVERY_TEXT_LENGTH
  ) {
    throw new DiscordDeliveryError("invalid_text", 400);
  }
  return { channel_id: channelId, delivery_id: deliveryId, text };
}

async function postDiscordMessage(
  input: DiscordDeliveryInput,
  options: DiscordbotOptions,
): Promise<DiscordDeliveryResult> {
  const apiBase = (options.discordApiUrl ?? DEFAULT_DISCORD_API_URL).replace(
    /\/$/,
    "",
  );
  const nonce = createHash("sha256")
    .update(input.delivery_id)
    .digest("hex")
    .slice(0, 24);
  const response = await (options.fetch ?? fetch)(
    `${apiBase}/channels/${input.channel_id}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bot ${options.botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        allowed_mentions: { parse: [] },
        content: input.text,
        enforce_nonce: true,
        flags: 1 << 2,
        nonce,
      }),
    },
  );
  if (!response.ok) throw new DiscordDeliveryError("discord_rejected", 502);
  const body = (await response.json()) as { id?: unknown };
  if (typeof body.id !== "string" || !/^\d{16,22}$/.test(body.id)) {
    throw new DiscordDeliveryError("discord_response_invalid", 502);
  }
  return {
    channel_id: input.channel_id,
    delivery_id: input.delivery_id,
    message_id: body.id,
    ok: true,
  };
}

function isDeliveryResult(
  value: unknown,
  input: DiscordDeliveryInput,
): value is DiscordDeliveryResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<DiscordDeliveryResult>;
  return (
    result.ok === true &&
    result.channel_id === input.channel_id &&
    result.delivery_id === input.delivery_id &&
    typeof result.message_id === "string"
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
