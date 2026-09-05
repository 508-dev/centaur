import { createHash } from "node:crypto";
import type {
  DiscordbotOptions,
  DiscordRoleBinding,
  DiscordTriggerBotBinding,
} from "./types";

const CAPABILITY_CLASS = /^[a-z][a-z0-9:_-]{0,63}$/;
const PRINCIPAL_ROLE = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_SCOPE_ENTRIES = 64;
const DISCORD_SNOWFLAKE = /^\d{16,22}$/;

export type DiscordPermissionBundle = {
  canApprove: boolean;
  capabilityClass: string;
  fingerprint: string;
  principalRole: string;
  projectScope: string[];
  repositoryScope: string[];
  sourceRoleId: string;
};

export type DiscordPolicyResolution =
  | { decision: "allow"; bundle: DiscordPermissionBundle }
  | { decision: "deny"; reason: "role_policy_ambiguous" | "role_policy_missing" | "role_not_authorized" };

/**
 * Parse and validate reviewed role policy. Numeric Discord IDs and exact
 * repository names are mandatory; wildcards and duplicate role mappings are
 * rejected at startup rather than interpreted at runtime.
 */
export function parseDiscordRoleBindings(
  raw: string | undefined,
): DiscordRoleBinding[] | undefined {
  if (!raw?.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("DISCORDBOT_ROLE_BINDINGS_JSON must be valid JSON");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("DISCORDBOT_ROLE_BINDINGS_JSON must be a non-empty array");
  }
  const roleIds = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Discord role binding ${index} must be an object`);
    }
    const record = item as Record<string, unknown>;
    const roleId = requiredString(record.role_id, `binding ${index} role_id`);
    const capabilityClass = requiredString(
      record.capability_class,
      `binding ${index} capability_class`,
    );
    const principalRole = requiredString(
      record.principal_role,
      `binding ${index} principal_role`,
    );
    if (!DISCORD_SNOWFLAKE.test(roleId)) {
      throw new Error(`binding ${index} role_id must be a numeric Discord ID`);
    }
    if (roleIds.has(roleId)) {
      throw new Error(`Discord role ${roleId} has more than one binding`);
    }
    roleIds.add(roleId);
    if (!CAPABILITY_CLASS.test(capabilityClass)) {
      throw new Error(`binding ${index} capability_class is invalid`);
    }
    if (!PRINCIPAL_ROLE.test(principalRole)) {
      throw new Error(`binding ${index} principal_role is invalid`);
    }
    const priority = optionalPriority(record.priority, index);
    const canApprove = optionalBoolean(record.can_approve, index, "can_approve");
    return {
      canApprove,
      capabilityClass,
      principalRole,
      priority,
      projectScope: projectArray(record.project_scope, index),
      repositoryScope: repositoryArray(record.repository_scope, index),
      roleId,
    };
  });
}

/**
 * Parse exact non-human identity bindings. The referenced role is reused as
 * the capability bundle, rather than treating a bot/webhook as a member with
 * caller-supplied roles. Bot identities cannot receive proposal approval.
 */
export function parseDiscordTriggerBotBindings(
  raw: string | undefined,
  roleBindings: readonly DiscordRoleBinding[] | undefined,
): DiscordTriggerBotBinding[] | undefined {
  if (!raw?.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("DISCORDBOT_TRIGGER_BOT_BINDINGS_JSON must be valid JSON");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      "DISCORDBOT_TRIGGER_BOT_BINDINGS_JSON must be a non-empty array",
    );
  }
  const roleById = new Map(roleBindings?.map((binding) => [binding.roleId, binding]));
  if (roleById.size === 0) {
    throw new Error("trigger bot bindings require reviewed Discord role bindings");
  }
  const identityIds = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`trigger bot binding ${index} must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      !Object.hasOwn(record, "identity_id") ||
      !Object.hasOwn(record, "role_id")
    ) {
      throw new Error(
        `trigger bot binding ${index} must contain only identity_id and role_id`,
      );
    }
    const identityId = requiredString(
      record.identity_id,
      `trigger bot binding ${index} identity_id`,
    );
    const roleId = requiredString(
      record.role_id,
      `trigger bot binding ${index} role_id`,
    );
    if (!DISCORD_SNOWFLAKE.test(identityId) || !DISCORD_SNOWFLAKE.test(roleId)) {
      throw new Error(`trigger bot binding ${index} must use numeric Discord IDs`);
    }
    if (identityIds.has(identityId)) {
      throw new Error(`Discord trigger bot identity ${identityId} has more than one binding`);
    }
    identityIds.add(identityId);
    const policy = roleById.get(roleId);
    if (!policy) {
      throw new Error(
        `trigger bot binding ${index} references an unknown reviewed role`,
      );
    }
    if (policy.canApprove) {
      throw new Error("trigger bot bindings cannot authorize proposal approval");
    }
    return { identityId, roleId };
  });
}

/**
 * Resolve multiple Discord roles with explicit precedence, never an implicit
 * union. Equal-priority matches must describe the exact same bundle or the
 * event fails closed as ambiguous.
 */
export function resolveDiscordPermissionBundle(
  roleIds: readonly string[],
  options: Pick<DiscordbotOptions, "roleBindings">,
): DiscordPolicyResolution {
  const bindings = options.roleBindings;
  if (!bindings?.length) return { decision: "deny", reason: "role_policy_missing" };
  const held = new Set(roleIds);
  const matches = bindings.filter((binding) => held.has(binding.roleId));
  if (matches.length === 0) {
    return { decision: "deny", reason: "role_not_authorized" };
  }
  const highestPriority = Math.max(...matches.map((binding) => binding.priority));
  const winners = matches.filter(
    (binding) => binding.priority === highestPriority,
  );
  const semantic = new Set(winners.map(bindingSemanticKey));
  if (semantic.size !== 1) {
    return { decision: "deny", reason: "role_policy_ambiguous" };
  }
  const selected = [...winners].sort((a, b) =>
    a.roleId.localeCompare(b.roleId),
  )[0];
  if (!selected) return { decision: "deny", reason: "role_not_authorized" };
  const canonical = {
    can_approve: selected.canApprove,
    capability_class: selected.capabilityClass,
    principal_role: selected.principalRole,
    project_scope: normalized(selected.projectScope),
    repository_scope: normalized(selected.repositoryScope, true),
  };
  return {
    decision: "allow",
    bundle: {
      canApprove: canonical.can_approve,
      capabilityClass: canonical.capability_class,
      fingerprint: `sha256:${createHash("sha256")
        .update(JSON.stringify(canonical))
        .digest("hex")}`,
      principalRole: canonical.principal_role,
      projectScope: canonical.project_scope,
      repositoryScope: canonical.repository_scope,
      sourceRoleId: selected.roleId,
    },
  };
}

/**
 * Resolve a verified bot/application/webhook identity through a reviewed,
 * static binding. Its empty `member.roles` data is never treated as authority.
 */
export function resolveDiscordTriggerBotPermissionBundle(
  identities: {
    applicationId?: string;
    authorId: string;
    webhookId?: string;
  },
  options: Pick<DiscordbotOptions, "roleBindings" | "triggerBotBindings">,
): DiscordPolicyResolution {
  const held = new Set(
    [identities.authorId, identities.applicationId, identities.webhookId]
      .filter((identity): identity is string =>
        typeof identity === "string" && DISCORD_SNOWFLAKE.test(identity),
      ),
  );
  const matches = options.triggerBotBindings?.filter((binding) =>
    held.has(binding.identityId),
  ) ?? [];
  if (matches.length === 0) {
    return { decision: "deny", reason: "role_not_authorized" };
  }
  // Runtime callers may construct options without the server parser. Never
  // infer an identity policy from overlapping bindings in that case.
  if (matches.length !== 1) {
    return { decision: "deny", reason: "role_policy_ambiguous" };
  }
  const selected = matches[0];
  if (!selected) return { decision: "deny", reason: "role_not_authorized" };
  const resolution = resolveDiscordPermissionBundle([selected.roleId], options);
  if (resolution.decision === "allow" && resolution.bundle.canApprove) {
    return { decision: "deny", reason: "role_not_authorized" };
  }
  return resolution;
}

export function configuredDiscordRoleIds(
  options: Pick<DiscordbotOptions, "roleBindings">,
): string[] {
  return options.roleBindings?.map((binding) => binding.roleId) ?? [];
}

/** Exact transport identities that may reach the durable bot-policy gate. */
export function configuredDiscordTriggerBotIds(
  options: Pick<DiscordbotOptions, "triggerBotBindings">,
): string[] {
  return [
    ...new Set(options.triggerBotBindings?.map((binding) => binding.identityId) ?? []),
  ].sort();
}

function bindingSemanticKey(binding: DiscordRoleBinding): string {
  return JSON.stringify({
    canApprove: binding.canApprove,
    capabilityClass: binding.capabilityClass,
    principalRole: binding.principalRole,
    projectScope: normalized(binding.projectScope),
    repositoryScope: normalized(binding.repositoryScope, true),
  });
}

function optionalBoolean(value: unknown, index: number, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new Error(`binding ${index} ${name} must be a boolean`);
  }
  return value;
}

function normalized(values: readonly string[], lower = false): string[] {
  return [...new Set(values.map((value) => (lower ? value.toLowerCase() : value)))]
    .sort();
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalPriority(value: unknown, index: number): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`binding ${index} priority must be a non-negative integer`);
  }
  return value as number;
}

function stringArray(value: unknown, index: number, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`binding ${index} ${name} must be an array`);
  }
  if (value.length > MAX_SCOPE_ENTRIES) {
    throw new Error(
      `binding ${index} ${name} must contain at most ${MAX_SCOPE_ENTRIES} entries`,
    );
  }
  const output = value.map((item) => requiredString(item, `${name} entry`));
  if (new Set(output).size !== output.length) {
    throw new Error(`binding ${index} ${name} contains duplicates`);
  }
  return output;
}

function projectArray(value: unknown, index: number): string[] {
  const projects = stringArray(value, index, "project_scope");
  if (projects.some((project) => !PROJECT.test(project))) {
    throw new Error(
      `binding ${index} project_scope must contain stable project identifiers`,
    );
  }
  return projects;
}

function repositoryArray(value: unknown, index: number): string[] {
  const repositories = stringArray(value, index, "repository_scope");
  if (repositories.length === 0) {
    throw new Error(`binding ${index} repository_scope must not be empty`);
  }
  for (const repository of repositories) {
    if (
      repository.length > 128 ||
      !REPOSITORY.test(repository) ||
      repository.includes("*")
    ) {
      throw new Error(
        `binding ${index} repository_scope must contain exact owner/repository names`,
      );
    }
  }
  if (
    new Set(repositories.map((repository) => repository.toLowerCase())).size !==
    repositories.length
  ) {
    throw new Error(
      `binding ${index} repository_scope contains case-insensitive duplicates`,
    );
  }
  return repositories;
}
