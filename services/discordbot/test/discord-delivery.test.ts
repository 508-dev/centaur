import { describe, expect, it } from "bun:test";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Logger } from "chat";
import {
  authorizeDiscordDelivery,
  deliverDiscordNotification,
  DiscordDeliveryError,
} from "../src/discord-delivery";
import type { DiscordbotOptions } from "../src/types";

const CHANNEL_ID = "1542739830591459369";
const MESSAGE_ID = "1542739830591459999";

function options(fetchFn: typeof fetch): DiscordbotOptions {
  return {
    apiKey: "internal-key",
    apiUrl: "http://api-rs",
    applicationId: "900000000000000001",
    botToken: "bot-token",
    channelAllowlist: [CHANNEL_ID],
    discordApiUrl: "https://discord.invalid/api/v10",
    fetch: fetchFn,
    guildAllowlist: ["1336096360772141148"],
    publicKey: "a".repeat(64),
  };
}

function recordingLogger(records: Record<string, unknown>[]): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: () => undefined,
    error: () => undefined,
    info: (_message, data) => records.push(data as Record<string, unknown>),
    warn: (_message, data) => records.push(data as Record<string, unknown>),
  };
  return logger;
}

describe("Discord workflow delivery", () => {
  it("requires the configured internal bearer credential", () => {
    expect(() =>
      authorizeDiscordDelivery("Bearer internal-key", "internal-key"),
    ).not.toThrow();
    for (const authorization of [undefined, "internal-key", "Bearer wrong"]) {
      expect(() =>
        authorizeDiscordDelivery(authorization, "internal-key"),
      ).toThrow(DiscordDeliveryError);
    }
  });

  it("posts once to an allowlisted channel with safe Discord controls", async () => {
    const requests: { body: Record<string, unknown>; url: string }[] = [];
    const fetchFn = (async (input, init) => {
      requests.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        url: String(input),
      });
      return new Response(JSON.stringify({ id: MESSAGE_ID }), { status: 200 });
    }) as typeof fetch;
    const state = createMemoryState();
    await state.connect();
    const audits: Record<string, unknown>[] = [];
    const input = {
      channel_id: CHANNEL_ID,
      delivery_id: "weekly-ops:sha256:abc123",
      text: "Weekly operations review: one material proposal.",
    };

    const first = await deliverDiscordNotification(
      input,
      options(fetchFn),
      state,
      recordingLogger(audits),
    );
    const duplicate = await deliverDiscordNotification(
      input,
      options(fetchFn),
      state,
      recordingLogger(audits),
    );

    expect(first).toEqual(duplicate);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      `https://discord.invalid/api/v10/channels/${CHANNEL_ID}/messages`,
    );
    expect(requests[0]?.body).toEqual(
      expect.objectContaining({
        allowed_mentions: { parse: [] },
        content: input.text,
        enforce_nonce: true,
        flags: 4,
      }),
    );
    expect(String(requests[0]?.body.nonce)).toHaveLength(24);
    expect(audits).toHaveLength(1);
    expect(audits[0]).not.toHaveProperty("text");
  });

  it("rejects an unlisted destination before any Discord request", async () => {
    let requests = 0;
    const fetchFn = (async () => {
      requests += 1;
      return new Response(JSON.stringify({ id: MESSAGE_ID }), { status: 200 });
    }) as unknown as typeof fetch;
    const state = createMemoryState();
    await state.connect();

    const error = await deliverDiscordNotification(
      {
        channel_id: "1542739830591459000",
        delivery_id: "weekly-ops:blocked",
        text: "should not post",
      },
      options(fetchFn),
      state,
      recordingLogger([]),
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(DiscordDeliveryError);
    expect(error.code).toBe("channel_not_allowlisted");
    expect(requests).toBe(0);
  });
});
