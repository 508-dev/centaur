import { describe, expect, it } from "bun:test";
import type { Logger, Message } from "chat";
import {
  discordIngressDenialReason,
  discordRoleIdsFromRaw,
  isAllowedDiscordMessage,
  isAllowedTriggerBotIdentifiers,
  isAllowedTriggerBotMessage,
  isDiscordIngressAllowlistEmpty,
  isGuildAllowlistEmpty,
  parseDiscordThreadKey,
} from "../src/discord-allowlist";
import type { DiscordbotOptions, DiscordTriggerBotBinding } from "../src/types";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

function message(overrides: {
  threadId: string;
  isBot?: boolean | "unknown";
  isMe?: boolean;
  roleIds?: string[];
}): Message {
  return {
    id: "m1",
    threadId: overrides.threadId,
    isMention: true,
    author: {
      isBot: overrides.isBot ?? false,
      isMe: overrides.isMe ?? false,
      userId: "u1",
      userName: "alice",
      fullName: "Alice",
    },
    raw: { member: { roles: overrides.roleIds ?? ["R1"] } },
  } as unknown as Message;
}

function options(
  overrides: Partial<DiscordbotOptions> = {},
): DiscordbotOptions {
  return {
    apiUrl: "http://localhost",
    applicationId: "app",
    botToken: "token",
    publicKey: "key",
    channelAllowlist: ["C1"],
    guildAllowlist: ["G1", "G2"],
    triggerRoleAllowlist: ["R1"],
    ...overrides,
  };
}

function triggerBotBinding(
  identityId = "u1",
): DiscordTriggerBotBinding {
  return { identityId, roleId: "R1" };
}

describe("parseDiscordThreadKey", () => {
  it("decodes guild/channel/thread", () => {
    expect(parseDiscordThreadKey("discord:G1:C1:T1")).toEqual({
      guildId: "G1",
      channelId: "C1",
      threadId: "T1",
    });
  });

  it("handles missing thread segment", () => {
    expect(parseDiscordThreadKey("discord:G1:C1")).toEqual({
      guildId: "G1",
      channelId: "C1",
      threadId: undefined,
    });
  });

  it("returns empty for non-discord keys", () => {
    expect(parseDiscordThreadKey("slack:C1:123")).toEqual({});
  });
});

describe("isAllowedDiscordMessage", () => {
  it("allows an allowlisted guild from a human", () => {
    const allowed = isAllowedDiscordMessage(
      message({ threadId: "discord:G1:C1:T1" }),
      options(),
      silentLogger,
    );
    expect(allowed).toBe(true);
  });

  it("denies DMs (guildId @me)", () => {
    expect(
      isAllowedDiscordMessage(
        message({ threadId: "discord:@me:C1" }),
        options(),
        silentLogger,
      ),
    ).toBe(false);
  });

  it("denies a guild not on the allowlist", () => {
    expect(
      isAllowedDiscordMessage(
        message({ threadId: "discord:G9:C1:T1" }),
        options(),
        silentLogger,
      ),
    ).toBe(false);
  });

  it("denies a channel not on the allowlist", () => {
    expect(
      isAllowedDiscordMessage(
        message({ threadId: "discord:G1:C9:T1" }),
        options(),
        silentLogger,
      ),
    ).toBe(false);
  });

  it("is fail-closed when the channel allowlist is empty", () => {
    expect(
      isAllowedDiscordMessage(
        message({ threadId: "discord:G1:C1:T1" }),
        options({ channelAllowlist: [] }),
        silentLogger,
      ),
    ).toBe(false);
  });

  it("denies a human without an allowlisted role", () => {
    expect(
      isAllowedDiscordMessage(
        message({ threadId: "discord:G1:C1:T1", roleIds: ["R9"] }),
        options(),
        silentLogger,
      ),
    ).toBe(false);
  });

  it("is fail-closed when the role allowlist is empty", () => {
    expect(
      isAllowedDiscordMessage(
        message({ threadId: "discord:G1:C1:T1" }),
        options({ triggerRoleAllowlist: [] }),
        silentLogger,
      ),
    ).toBe(false);
  });

  it("is fail-closed: empty allowlist denies everything", () => {
    expect(
      isAllowedDiscordMessage(
        message({ threadId: "discord:G1:C1:T1" }),
        options({ guildAllowlist: [] }),
        silentLogger,
      ),
    ).toBe(false);
  });

  it("denies bot-authored messages", () => {
    expect(
      isAllowedDiscordMessage(
        message({ threadId: "discord:G1:C1:T1", isBot: true }),
        options(),
        silentLogger,
      ),
    ).toBe(false);
  });

  it("denies the bot’s own messages", () => {
    expect(
      isAllowedDiscordMessage(
        message({ threadId: "discord:G1:C1:T1", isMe: true }),
        options(),
        silentLogger,
      ),
    ).toBe(false);
  });

  it("allows a bot identity with a reviewed policy binding through the bot gate", () => {
    expect(
      isAllowedDiscordMessage(
        message({ threadId: "discord:G1:C1:T1", isBot: true }),
        options({ triggerBotBindings: [triggerBotBinding()] }),
        silentLogger,
      ),
    ).toBe(true);
  });

  it("still denies a bot without a reviewed identity binding", () => {
    expect(
      isAllowedDiscordMessage(
        message({ threadId: "discord:G1:C1:T1", isBot: true }),
        options({ triggerBotBindings: [triggerBotBinding("someone-else")] }),
        silentLogger,
      ),
    ).toBe(false);
  });

  it("still denies the bot’s own messages even when its identity is bound", () => {
    expect(
      isAllowedDiscordMessage(
        message({ threadId: "discord:G1:C1:T1", isBot: true, isMe: true }),
        options({ triggerBotBindings: [triggerBotBinding()] }),
        silentLogger,
      ),
    ).toBe(false);
  });
});

describe("isAllowedTriggerBotMessage", () => {
  const botMessage = (raw?: unknown) =>
    ({
      author: {
        fullName: "Sentry",
        isBot: true,
        isMe: false,
        userId: "bot-1",
        userName: "sentry",
      },
      raw,
    }) as Parameters<typeof isAllowedTriggerBotMessage>[0];

  it("is fail-closed with no allowlist", () => {
    expect(isAllowedTriggerBotMessage(botMessage(), undefined)).toBe(false);
    expect(isAllowedTriggerBotMessage(botMessage(), [])).toBe(false);
  });

  it("matches the author user id", () => {
    expect(isAllowedTriggerBotMessage(botMessage(), ["bot-1"])).toBe(true);
    expect(isAllowedTriggerBotMessage(botMessage(), ["bot-2"])).toBe(false);
  });

  it("matches the raw application_id and webhook_id", () => {
    expect(
      isAllowedTriggerBotMessage(botMessage({ application_id: "app-9" }), [
        "app-9",
      ]),
    ).toBe(true);
    expect(
      isAllowedTriggerBotMessage(botMessage({ webhook_id: "hook-7" }), [
        "hook-7",
      ]),
    ).toBe(true);
    expect(
      isAllowedTriggerBotMessage(botMessage({ application_id: "app-9" }), [
        "other",
      ]),
    ).toBe(false);
  });

  it("tolerates entries and ids with surrounding whitespace", () => {
    expect(isAllowedTriggerBotMessage(botMessage(), [" bot-1 "])).toBe(true);
  });
});

describe("isAllowedTriggerBotIdentifiers", () => {
  it("uses the same author, application, and webhook identities at adapter forwarding", () => {
    const identifiers = {
      applicationId: "app-9",
      authorId: "bot-1",
      webhookId: "hook-7",
    };
    for (const allowed of ["bot-1", "app-9", "hook-7"]) {
      expect(isAllowedTriggerBotIdentifiers(identifiers, [allowed])).toBe(true);
    }
    expect(isAllowedTriggerBotIdentifiers(identifiers, ["other"])).toBe(false);
  });
});

describe("isGuildAllowlistEmpty", () => {
  it("is true when no guilds are configured", () => {
    expect(isGuildAllowlistEmpty(options({ guildAllowlist: [] }))).toBe(true);
  });

  it("is false when guilds are configured", () => {
    expect(isGuildAllowlistEmpty(options())).toBe(false);
  });
});

describe("Discord ingress context", () => {
  it("reports the first deterministic denial reason", () => {
    expect(
      discordIngressDenialReason(
        {
          authorIsBot: false,
          channelId: "C9",
          guildId: "G1",
          roleIds: ["R1"],
        },
        options(),
      ),
    ).toBe("channel_not_allowlisted");
  });

  it("extracts role ids only from Discord member data", () => {
    expect(discordRoleIdsFromRaw({ member: { roles: ["R1", 2, "R3"] } })).toEqual([
      "R1",
      "R3",
    ]);
    expect(discordRoleIdsFromRaw({ roles: ["R1"] })).toEqual([]);
  });

  it("treats any missing required human allowlist as inert", () => {
    // The legacy trigger-role allowlist is not a capability policy and cannot
    // activate production ingress by itself.
    expect(isDiscordIngressAllowlistEmpty(options())).toBe(true);
    const reviewedPolicy = {
      canApprove: false,
      capabilityClass: "github:observe",
      principalRole: "discord-observer",
      priority: 0,
      projectScope: [],
      repositoryScope: ["example/example"],
      roleId: "R1",
    };
    expect(
      isDiscordIngressAllowlistEmpty(
        options({ roleBindings: [reviewedPolicy] }),
      ),
    ).toBe(false);
    expect(
      isDiscordIngressAllowlistEmpty(
        options({ channelAllowlist: [], roleBindings: [reviewedPolicy] }),
      ),
    ).toBe(true);
    expect(
      isDiscordIngressAllowlistEmpty(options({ roleBindings: [] })),
    ).toBe(true);
  });

  it("does not let a legacy role reactivate an explicitly empty policy", () => {
    expect(
      discordIngressDenialReason(
        {
          authorIsBot: false,
          channelId: "C1",
          guildId: "G1",
          roleIds: ["R1"],
        },
        options({ roleBindings: [], triggerRoleAllowlist: ["R1"] }),
      ),
    ).toBe("role_allowlist_empty");
  });
});
