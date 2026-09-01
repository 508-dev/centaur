import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Logger, StateAdapter } from "chat";
import { resolveDiscordApiBase } from "./discord-api";
import { resolveChannelAllowlist } from "./discord-allowlist";
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
  request_fingerprint: string;
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
  const requestFingerprint = deliveryRequestFingerprint(input);
  const resultKey = `discordbot:delivery:result:${input.delivery_id}`;
  const leaseKey = `discordbot:delivery:lease:${input.delivery_id}`;

  let existing: unknown;
  try {
    existing = await state.get<unknown>(resultKey);
  } catch {
    throw new DiscordDeliveryError("state_unavailable", 503);
  }
  const existingResult = existingDeliveryResult(existing, requestFingerprint);
  if (existingResult) return existingResult;

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
    const claimedResult = existingDeliveryResult(existing, requestFingerprint);
    if (claimedResult) return claimedResult;

    const result = await postDiscordMessage(input, requestFingerprint, options);
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
  requestFingerprint: string,
  options: DiscordbotOptions,
): Promise<DiscordDeliveryResult> {
  let apiBase: string;
  try {
    apiBase = resolveDiscordApiBase(
      options.discordApiUrl,
      options.allowInProcessGatewayEmulation === true,
    );
  } catch {
    throw new DiscordDeliveryError("discord_api_url_invalid", 502);
  }
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
    request_fingerprint: requestFingerprint,
  };
}

function existingDeliveryResult(
  value: unknown,
  requestFingerprint: string,
): DiscordDeliveryResult | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DiscordDeliveryError("delivery_id_conflict", 409);
  }
  const result = value as Partial<DiscordDeliveryResult>;
  const valid =
    result.ok === true &&
    result.request_fingerprint === requestFingerprint &&
    typeof result.channel_id === "string" &&
    typeof result.delivery_id === "string" &&
    typeof result.message_id === "string";
  if (!valid) {
    throw new DiscordDeliveryError("delivery_id_conflict", 409);
  }
  return result as DiscordDeliveryResult;
}

function deliveryRequestFingerprint(input: DiscordDeliveryInput): string {
  const canonical = JSON.stringify([
    1,
    input.delivery_id,
    input.channel_id,
    input.text,
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
