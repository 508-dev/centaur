import { describe, expect, it } from "bun:test";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Logger, StateAdapter } from "chat";
import {
  admitDiscordGatewayMessage,
  type DiscordGatewayMessageEvent,
} from "../src/discord-ingress";
import type { DiscordbotOptions, DiscordRoleBinding } from "../src/types";

const NOW = Date.now();
const APP = "900000000000000001";
const USER = "100000000000000001";
const OTHER_USER = "100000000000000002";
const GUILD = "200000000000000001";
const CHANNEL = "300000000000000001";
const THREAD = "400000000000000001";
const ROLE = "500000000000000001";
const WRITE_ROLE = "500000000000000002";

type Audit = { message: string; data: Record<string, unknown> };

function binding(
  overrides: Partial<DiscordRoleBinding> = {},
): DiscordRoleBinding {
  return {
    canApprove: false,
    capabilityClass: "github:observe",
    principalRole: "discord-observer",
    priority: 0,
    projectScope: ["operations"],
    repositoryScope: ["508-dev/centaur"],
    roleId: ROLE,
    ...overrides,
  };
}

function options(overrides: Partial<DiscordbotOptions> = {}): DiscordbotOptions {
  return {
    apiUrl: "http://api.test",
    applicationId: APP,
    botToken: "token",
    channelAllowlist: [CHANNEL],
    continuationTtlMs: 1_000,
    guildAllowlist: [GUILD],
    publicKey: "a".repeat(64),
    roleBindings: [binding()],
    ...overrides,
  };
}

function event(
  messageId: string,
  overrides: Partial<DiscordGatewayMessageEvent> = {},
): DiscordGatewayMessageEvent {
  return {
    authorId: USER,
    authorIsBot: false,
    authorIsSelf: false,
    channelId: CHANNEL,
    content: `<@${APP}> diagnose`,
    createdTimestamp: NOW,
    gatewayIdentityVerified: true,
    guildId: GUILD,
    isMentioned: true,
    messageId,
    messageType: 0,
    roleIds: [ROLE],
    ...overrides,
  };
}

async function harness(): Promise<{
  audits: Audit[];
  logger: Logger;
  state: StateAdapter;
}> {
  const audits: Audit[] = [];
  const logger: Logger = {
    child: () => logger,
    debug: () => undefined,
    error: () => undefined,
    info: (message, data) => {
      audits.push({
        data: (data ?? {}) as Record<string, unknown>,
        message,
      });
    },
    warn: () => undefined,
  };
  const state = createMemoryState();
  await state.connect();
  return { audits, logger, state };
}

async function reasonFor(
  value: DiscordGatewayMessageEvent,
  configured = options(),
  now = NOW,
): Promise<string> {
  const { audits, logger, state } = await harness();
  await admitDiscordGatewayMessage(value, configured, state, logger, now);
  return String(audits.at(-1)?.data.reason);
}

describe("Discord Gateway admission", () => {
  it("atomically deduplicates a verified parent-channel root before side effects", async () => {
    const { audits, logger, state } = await harness();
    const root = event("600000000000000001");
    const first = await admitDiscordGatewayMessage(
      root,
      options(),
      state,
      logger,
      NOW,
    );
    const duplicate = await admitDiscordGatewayMessage(
      root,
      options(),
      state,
      logger,
      NOW,
    );

    expect(first).toEqual(
      expect.objectContaining({
        actorId: USER,
        decision: "allow",
        rootMessageId: root.messageId,
        threadId: root.messageId,
      }),
    );
    expect(duplicate).toBeNull();
    expect(audits.map((audit) => audit.data.reason)).toEqual([
      "accepted",
      "duplicate_delivery",
    ]);
  });

  it("releases only its provisional delivery claim after transient state failures", async () => {
    for (const failure of ["evaluation", "final_write"] as const) {
      const { audits, logger, state } = await harness();
      let failOnce = true;
      const flaky = new Proxy(state, {
        get(target, property) {
          if (property === "get") {
            return async (key: string) => {
              if (
                failure === "evaluation" &&
                failOnce &&
                key.startsWith("discordbot:ingress:root:")
              ) {
                failOnce = false;
                throw new Error("transient read failure");
              }
              return target.get(key);
            };
          }
          if (property === "set") {
            return async (key: string, value: unknown, ttlMs?: number) => {
              if (
                failure === "final_write" &&
                failOnce &&
                key.startsWith("discordbot:ingress:delivery:")
              ) {
                failOnce = false;
                throw new Error("transient write failure");
              }
              return target.set(key, value, ttlMs);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as StateAdapter;
      const message = event(
        failure === "evaluation"
          ? "600000000000000002"
          : "600000000000000003",
      );

      expect(
        await admitDiscordGatewayMessage(message, options(), flaky, logger, NOW),
      ).toBeNull();
      expect(audits.at(-1)?.data.reason).toBe("state_unavailable");
      expect(
        await admitDiscordGatewayMessage(message, options(), flaky, logger, NOW),
      ).toEqual(expect.objectContaining({ decision: "allow" }));
      expect(audits.at(-1)?.data.reason).toBe("accepted");
    }
  });

  it("rejects unauthenticated, stale, replay-like, DM, and malformed transport data", async () => {
    const cases: Array<[string, Partial<DiscordGatewayMessageEvent>, number?]> = [
      ["gateway_identity_unverified", { gatewayIdentityVerified: false }],
      ["stale_delivery", { createdTimestamp: NOW - 10_000 }],
      ["future_delivery", { createdTimestamp: NOW + 61_000 }],
      ["direct_message", { guildId: "@me" }],
      ["invalid_event", { authorId: "mutable-user-name" }],
    ];
    let suffix = 10;
    for (const [reason, overrides] of cases) {
      expect(
        await reasonFor(
          event(`6000000000000000${suffix++}`, overrides),
          options({ ingressMaxEventAgeMs: 5_000 }),
        ),
      ).toBe(reason);
    }
  });

  it("records stable default-deny reasons for every rejected actor context", async () => {
    const cases: Array<[string, Partial<DiscordGatewayMessageEvent>]> = [
      ["guild_not_allowlisted", { guildId: "200000000000000099" }],
      ["channel_not_allowlisted", { channelId: "300000000000000099" }],
      ["role_not_authorized", { roleIds: [] }],
      ["bot_message", { authorIsBot: true }],
      ["self_message", { authorIsSelf: true }],
      ["webhook_message", { webhookId: "700000000000000001" }],
      ["unsupported_message_type", { messageType: 7 }],
    ];
    let suffix = 30;
    for (const [reason, overrides] of cases) {
      expect(
        await reasonFor(event(`6000000000000000${suffix++}`, overrides)),
      ).toBe(reason);
    }
  });

  it("requires both an explicit bot identity and a reviewed role capability", async () => {
    const configured = options({ triggerBotAllowlist: [USER] });
    expect(
      await reasonFor(
        event("600000000000000045", { authorIsBot: true }),
        configured,
      ),
    ).toBe("accepted");
    expect(
      await reasonFor(
        event("600000000000000046", {
          authorIsBot: true,
          roleIds: [],
        }),
        configured,
      ),
    ).toBe("role_not_authorized");
    expect(
      await reasonFor(
        event("600000000000000047", {
          authorIsBot: true,
          webhookId: "700000000000000001",
        }),
        options({ triggerBotAllowlist: ["700000000000000001"] }),
      ),
    ).toBe("accepted");
  });

  it("requires a mention root in the parent and never roots an unrelated thread", async () => {
    expect(
      await reasonFor(
        event("600000000000000050", {
          content: "sounds actionable",
          isMentioned: false,
        }),
      ),
    ).toBe("root_trigger_required");
    expect(
      await reasonFor(
        event("600000000000000051", {
          threadId: THREAD,
        }),
      ),
    ).toBe("authorized_root_missing");
  });

  it("binds continuation to the same actor, thread, current role policy, and TTL", async () => {
    const { audits, logger, state } = await harness();
    const configured = options({
      roleBindings: [
        binding(),
        binding({
          capabilityClass: "github:act",
          principalRole: "discord-operator",
          priority: 10,
          roleId: WRITE_ROLE,
        }),
      ],
    });
    await admitDiscordGatewayMessage(
      event(THREAD),
      configured,
      state,
      logger,
      NOW,
    );

    const follow = (id: string, overrides = {}) =>
      event(id, {
        content: "continue",
        isMentioned: false,
        threadId: THREAD,
        ...overrides,
      });
    expect(
      await admitDiscordGatewayMessage(
        follow("600000000000000060"),
        configured,
        state,
        logger,
        NOW + 999,
      ),
    ).toEqual(expect.objectContaining({ decision: "allow", actorId: USER }));

    const denied: Array<[DiscordGatewayMessageEvent, string, number]> = [
      [
        follow("600000000000000061", { authorId: OTHER_USER }),
        "actor_mismatch",
        NOW + 100,
      ],
      [
        follow("600000000000000062", { roleIds: [] }),
        "role_not_authorized",
        NOW + 100,
      ],
      [
        follow("600000000000000063", { roleIds: [ROLE, WRITE_ROLE] }),
        "policy_changed_requires_root_trigger",
        NOW + 100,
      ],
      [follow("600000000000000064"), "root_expired", NOW + 1_001],
    ];
    for (const [candidate, expected, now] of denied) {
      expect(
        await admitDiscordGatewayMessage(
          candidate,
          configured,
          state,
          logger,
          now,
        ),
      ).toBeNull();
      expect(audits.at(-1)?.data.reason).toBe(expected);
    }
  });

  it("accepts only an actor-scoped, idempotent stop control", async () => {
    const { audits, logger, state } = await harness();
    const configured = options();
    await admitDiscordGatewayMessage(
      event(THREAD),
      configured,
      state,
      logger,
      NOW,
    );
    const stop = event("600000000000000070", {
      content: `<@${APP}> stop`,
      threadId: THREAD,
    });
    const accepted = await admitDiscordGatewayMessage(
      stop,
      configured,
      state,
      logger,
      NOW + 100,
    );
    expect(accepted).toEqual(
      expect.objectContaining({ control: "stop", actorId: USER }),
    );
    expect(
      await admitDiscordGatewayMessage(
        stop,
        configured,
        state,
        logger,
        NOW + 100,
      ),
    ).toBeNull();
    expect(audits.at(-1)?.data.reason).toBe("duplicate_delivery");

    const outsider = event("600000000000000071", {
      authorId: OTHER_USER,
      content: `<@${APP}> cancel`,
      threadId: THREAD,
    });
    expect(
      await admitDiscordGatewayMessage(
        outsider,
        configured,
        state,
        logger,
        NOW + 100,
      ),
    ).toBeNull();
    expect(audits.at(-1)?.data.reason).toBe("actor_mismatch");
  });

  it("accepts an exact proposal approval only for a reviewed approval role", async () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const { audits, logger, state } = await harness();
    const configured = options({
      roleBindings: [binding({ canApprove: true })],
    });
    const approval = event("600000000000000080", {
      content: `<@${APP}> approve ${fingerprint}`,
    });

    const accepted = await admitDiscordGatewayMessage(
      approval,
      configured,
      state,
      logger,
      NOW,
    );

    expect(accepted).toEqual(
      expect.objectContaining({
        control: "approve",
        proposalFingerprint: fingerprint,
        rootMessageId: approval.messageId,
        threadId: approval.messageId,
      }),
    );
    expect(audits.at(-1)?.data).toMatchObject({
      control: "approve",
      decision: "allow",
      reason: "accepted",
    });
  });

  it("rejects unauthorized and malformed approval commands", async () => {
    expect(
      await reasonFor(
        event("600000000000000081", {
          content: `<@${APP}> approve sha256:${"a".repeat(64)}`,
        }),
      ),
    ).toBe("approval_not_authorized");
    expect(
      await reasonFor(
        event("600000000000000082", {
          content: `<@${APP}> approve not-a-fingerprint`,
        }),
        options({ roleBindings: [binding({ canApprove: true })] }),
      ),
    ).toBe("invalid_approval_command");
  });
});
