import type { GithubbotOptions } from "./types";

/**
 * Authorization gate for the conversational (comment) path. A comment that
 * @-mentions the bot drives an agent turn in a write-capable sandbox and posts a
 * transcript back, so only sufficiently-trusted authors may trigger it —
 * otherwise any commenter (anyone on a public repo) could steer the agent and
 * read back its tool output. The lifecycle paths (assignment, review-request)
 * are already gated by GitHub permissions, so this applies only to comment
 * mentions and their follow-ups.
 *
 * GitHub stamps every comment with an `author_association` (OWNER / MEMBER /
 * COLLABORATOR / CONTRIBUTOR / FIRST_TIME_CONTRIBUTOR / NONE / …). We trust the
 * collaborator-and-up set by default; a deployment can widen or narrow it, and
 * the sentinel "*" allows everyone (e.g. a fully-private repo where every
 * commenter is already trusted).
 */
export const DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
] as const;

const TRUSTED_REVIEW_AUTHOR_ASSOCIATIONS = new Set<string>(
  DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS,
);

const ALLOW_ALL = "*";

/** Pull the canonical owner/repository name out of a GitHub webhook payload. */
export function repositoryFullNameFromRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const repository = (raw as { repository?: unknown }).repository;
  if (!repository || typeof repository !== "object") return undefined;
  const value = (repository as { full_name?: unknown }).full_name;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Normalize an exact repository allowlist without supporting wildcards. */
export function resolveRepositoryAllowlist(
  configured: readonly string[] | undefined,
): string[] {
  return (configured ?? [])
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => {
      const segments = entry.split("/");
      return (
        segments.length === 2 &&
        segments.every(Boolean) &&
        !entry.includes("*") &&
        !/\s/.test(entry)
      );
    });
}

/** Normalize startup policy and reject an inert or wildcard-only allowlist. */
export function requireRepositoryAllowlist(
  configured: readonly string[] | undefined,
): string[] {
  const repositories = resolveRepositoryAllowlist(configured);
  if (!repositories.length) {
    throw new Error(
      "GITHUBBOT_REPOSITORY_ALLOWLIST must contain at least one exact owner/repository",
    );
  }
  return repositories;
}

/** Whether a webhook targets an explicitly configured repository. */
export function isRepositoryAllowed(
  raw: unknown,
  options: Pick<GithubbotOptions, "repositoryAllowlist">,
): boolean {
  const repository = repositoryFullNameFromRaw(raw)?.toLowerCase();
  if (!repository) return false;
  return resolveRepositoryAllowlist(options.repositoryAllowlist).includes(
    repository,
  );
}

/** Pull `author_association` out of the adapter's raw comment message. */
export function authorAssociationFromRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const comment = (raw as { comment?: unknown }).comment;
  if (!comment || typeof comment !== "object") return undefined;
  const value = (comment as { author_association?: unknown }).author_association;
  return typeof value === "string" ? value : undefined;
}

/** Pull the author identity out of a submitted-review webhook payload. */
export function reviewAuthorFromRaw(raw: unknown):
  | { association?: string; login?: string }
  | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const review = (raw as { review?: unknown }).review;
  if (!review || typeof review !== "object") return undefined;
  const association = (review as { author_association?: unknown })
    .author_association;
  const user = (review as { user?: unknown }).user;
  const login =
    user && typeof user === "object"
      ? (user as { login?: unknown }).login
      : undefined;
  return {
    association: typeof association === "string" ? association : undefined,
    login: typeof login === "string" ? login : undefined,
  };
}

/** Normalize exact trusted reviewer-bot logins; wildcards fail closed. */
export function resolveReviewAuthorAllowlist(
  configured: readonly string[] | undefined,
): string[] {
  return (configured ?? [])
    .map((entry) => entry.trim().toLowerCase())
    .filter(
      (entry) =>
        Boolean(entry) &&
        !entry.includes("*") &&
        !entry.includes("/") &&
        !/\s/.test(entry),
    );
}

/**
 * Whether a submitted review may drive an owned-PR management turn. Public
 * users fail closed; installed reviewer bots with association NONE require an
 * exact configured login instead of widening the association policy.
 */
export function isReviewAuthorAllowed(
  raw: unknown,
  options: Pick<GithubbotOptions, "reviewAuthorAllowlist">,
): boolean {
  const author = reviewAuthorFromRaw(raw);
  if (!author?.login) return false;
  if (
    author.association &&
    TRUSTED_REVIEW_AUTHOR_ASSOCIATIONS.has(author.association.toUpperCase())
  ) {
    return true;
  }
  return resolveReviewAuthorAllowlist(options.reviewAuthorAllowlist).includes(
    author.login.toLowerCase(),
  );
}

/** Normalize the configured allowlist, defaulting when unset or empty. */
export function resolveAllowedAuthorAssociations(
  configured: readonly string[] | undefined,
): string[] {
  const list = (configured ?? DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.toUpperCase());
  return list.length ? list : [...DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS];
}

/**
 * Whether a comment's author is allowed to drive a turn. Fails closed: an
 * association we can't read (an unexpected payload shape) is treated as
 * untrusted rather than waved through.
 */
export function isCommentAuthorAllowed(
  raw: unknown,
  options: Pick<GithubbotOptions, "allowedAuthorAssociations">,
): boolean {
  const allowed = resolveAllowedAuthorAssociations(
    options.allowedAuthorAssociations,
  );
  if (allowed.includes(ALLOW_ALL)) return true;
  const association = authorAssociationFromRaw(raw);
  if (!association) return false;
  return allowed.includes(association.toUpperCase());
}
