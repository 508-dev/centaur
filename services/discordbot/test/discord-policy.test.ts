import { describe, expect, it } from "bun:test";
import {
  parseDiscordRoleBindings,
  parseDiscordTriggerBotBindings,
  resolveDiscordPermissionBundle,
  resolveDiscordTriggerBotPermissionBundle,
} from "../src/discord-policy";
import type {
  DiscordbotOptions,
  DiscordRoleBinding,
  DiscordTriggerBotBinding,
} from "../src/types";

const ROLE_A = "500000000000000001";
const ROLE_B = "500000000000000002";
const BOT_ID = "600000000000000001";
const APPLICATION_ID = "600000000000000002";

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
    roleId: ROLE_A,
    ...overrides,
  };
}

function options(roleBindings?: readonly DiscordRoleBinding[]): DiscordbotOptions {
  return {
    apiUrl: "http://api.test",
    applicationId: "900000000000000001",
    botToken: "token",
    publicKey: "a".repeat(64),
    roleBindings,
  };
}

describe("parseDiscordRoleBindings", () => {
  it("parses reviewed numeric role policy with exact scopes", () => {
    expect(
      parseDiscordRoleBindings(
        JSON.stringify([
          {
            role_id: ROLE_A,
            capability_class: "github:observe",
            can_approve: true,
            principal_role: "discord-observer",
            priority: 10,
            project_scope: ["operations"],
            repository_scope: ["508-dev/centaur", "508-dev/508-infra"],
          },
        ]),
      ),
    ).toEqual([
      {
        canApprove: true,
        capabilityClass: "github:observe",
        principalRole: "discord-observer",
        priority: 10,
        projectScope: ["operations"],
        repositoryScope: ["508-dev/centaur", "508-dev/508-infra"],
        roleId: ROLE_A,
      },
    ]);
  });

  it("rejects malformed, duplicate, wildcard, and empty-scope policy", () => {
    const invalid = [
      "not-json",
      "[]",
      JSON.stringify([{ role_id: "Administrators" }]),
      JSON.stringify([
        {
          role_id: ROLE_A,
          capability_class: "github:observe",
          principal_role: "discord-observer",
          project_scope: [],
          repository_scope: ["508-dev/*"],
        },
      ]),
      JSON.stringify([
        {
          role_id: ROLE_A,
          capability_class: "github:observe",
          principal_role: "discord-observer",
          can_approve: "yes",
          project_scope: [],
          repository_scope: ["508-dev/centaur"],
        },
      ]),
      JSON.stringify([
        {
          role_id: ROLE_A,
          capability_class: "github:observe",
          principal_role: "discord-observer",
          project_scope: [],
          repository_scope: [],
        },
      ]),
      JSON.stringify([
        {
          role_id: ROLE_A,
          capability_class: "github:observe",
          principal_role: "discord-observer",
          project_scope: [],
          repository_scope: ["508-dev/centaur"],
        },
        {
          role_id: ROLE_A,
          capability_class: "github:act",
          principal_role: "discord-operator",
          project_scope: [],
          repository_scope: ["508-dev/centaur"],
        },
      ]),
    ];
    for (const raw of invalid) {
      expect(() => parseDiscordRoleBindings(raw)).toThrow();
    }
  });
});

describe("resolveDiscordPermissionBundle", () => {
  it("is inert without policy and denies a missing immutable role id", () => {
    expect(resolveDiscordPermissionBundle([ROLE_A], options())).toEqual({
      decision: "deny",
      reason: "role_policy_missing",
    });
    expect(
      resolveDiscordPermissionBundle([ROLE_B], options([binding()])),
    ).toEqual({ decision: "deny", reason: "role_not_authorized" });
  });

  it("uses explicit priority instead of unioning capabilities", () => {
    const result = resolveDiscordPermissionBundle(
      [ROLE_A, ROLE_B],
      options([
        binding(),
        binding({
          capabilityClass: "github:act",
          principalRole: "discord-operator",
          priority: 20,
          repositoryScope: ["508-dev/508-infra"],
          roleId: ROLE_B,
        }),
      ]),
    );
    expect(result.decision).toBe("allow");
    if (result.decision === "allow") {
      expect(result.bundle).toEqual(
        expect.objectContaining({
          capabilityClass: "github:act",
          principalRole: "discord-operator",
          repositoryScope: ["508-dev/508-infra"],
          sourceRoleId: ROLE_B,
        }),
      );
      expect(result.bundle.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  it("allows equal-priority aliases only for the identical bundle", () => {
    const same = resolveDiscordPermissionBundle(
      [ROLE_A, ROLE_B],
      options([binding(), binding({ roleId: ROLE_B })]),
    );
    expect(same.decision).toBe("allow");

    const ambiguous = resolveDiscordPermissionBundle(
      [ROLE_A, ROLE_B],
      options([
        binding(),
        binding({
          capabilityClass: "github:act",
          principalRole: "discord-operator",
          roleId: ROLE_B,
        }),
      ]),
    );
    expect(ambiguous).toEqual({
      decision: "deny",
      reason: "role_policy_ambiguous",
    });
  });
});

describe("trigger bot policy bindings", () => {
  function triggerBinding(
    overrides: Partial<DiscordTriggerBotBinding> = {},
  ): DiscordTriggerBotBinding {
    return { identityId: BOT_ID, roleId: ROLE_A, ...overrides };
  }

  it("binds an exact non-human identity to one existing non-approver bundle", () => {
    const parsed = parseDiscordTriggerBotBindings(
      JSON.stringify([{ identity_id: BOT_ID, role_id: ROLE_A }]),
      [binding()],
    );
    expect(parsed).toEqual([triggerBinding()]);

    const resolution = resolveDiscordTriggerBotPermissionBundle(
      { applicationId: APPLICATION_ID, authorId: BOT_ID },
      { ...options([binding()]), triggerBotBindings: parsed },
    );
    expect(resolution).toEqual({
      decision: "allow",
      bundle: expect.objectContaining({
        principalRole: "discord-observer",
        sourceRoleId: ROLE_A,
      }),
    });
  });

  it("rejects malformed, ambiguous, unknown, and approver bot bindings", () => {
    const invalid = [
      "not-json",
      "[]",
      JSON.stringify([{ identity_id: BOT_ID, role_id: ROLE_B }]),
      JSON.stringify([{ identity_id: BOT_ID, role_id: ROLE_A, extra: true }]),
      JSON.stringify([
        { identity_id: BOT_ID, role_id: ROLE_A },
        { identity_id: BOT_ID, role_id: ROLE_A },
      ]),
    ];
    for (const raw of invalid) {
      expect(() => parseDiscordTriggerBotBindings(raw, [binding()])).toThrow();
    }
    expect(() =>
      parseDiscordTriggerBotBindings(
        JSON.stringify([{ identity_id: BOT_ID, role_id: ROLE_A }]),
        [binding({ canApprove: true })],
      ),
    ).toThrow(/cannot authorize proposal approval/);
    expect(
      resolveDiscordTriggerBotPermissionBundle(
        { authorId: BOT_ID, webhookId: APPLICATION_ID },
        {
          ...options([binding(), binding({ roleId: ROLE_B })]),
          triggerBotBindings: [
            triggerBinding(),
            triggerBinding({ identityId: APPLICATION_ID, roleId: ROLE_B }),
          ],
        },
      ),
    ).toEqual({ decision: "deny", reason: "role_policy_ambiguous" });
    expect(
      resolveDiscordTriggerBotPermissionBundle(
        { authorId: BOT_ID },
        {
          ...options([binding({ canApprove: true })]),
          triggerBotBindings: [triggerBinding()],
        },
      ),
    ).toEqual({ decision: "deny", reason: "role_not_authorized" });
  });
});
