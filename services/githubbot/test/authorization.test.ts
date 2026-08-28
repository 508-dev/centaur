import { describe, expect, test } from "bun:test";
import {
  authorAssociationFromRaw,
  DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS,
  isCommentAuthorAllowed,
  isRepositoryAllowed,
  requireRepositoryAllowlist,
  repositoryFullNameFromRaw,
  resolveAllowedAuthorAssociations,
  resolveRepositoryAllowlist,
} from "../src/authorization";

function raw(association: unknown): unknown {
  return {
    type: "issue_comment",
    comment: { author_association: association },
  };
}

describe("authorAssociationFromRaw", () => {
  test("reads author_association from the raw comment", () => {
    expect(authorAssociationFromRaw(raw("MEMBER"))).toBe("MEMBER");
  });

  test("undefined for a non-comment / malformed shape", () => {
    expect(authorAssociationFromRaw({ type: "x" })).toBeUndefined();
    expect(authorAssociationFromRaw({ comment: {} })).toBeUndefined();
    expect(authorAssociationFromRaw(null)).toBeUndefined();
    expect(authorAssociationFromRaw("nope")).toBeUndefined();
  });
});

describe("resolveAllowedAuthorAssociations", () => {
  test("defaults when unset, empty, or blank", () => {
    const want = [...DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS];
    expect(resolveAllowedAuthorAssociations(undefined)).toEqual(want);
    expect(resolveAllowedAuthorAssociations([])).toEqual(want);
    expect(resolveAllowedAuthorAssociations(["  "])).toEqual(want);
  });

  test("uppercases and trims configured values", () => {
    expect(resolveAllowedAuthorAssociations([" owner ", "Member"])).toEqual([
      "OWNER",
      "MEMBER",
    ]);
  });
});

describe("isCommentAuthorAllowed", () => {
  test("allows the default collaborator-and-up set", () => {
    for (const assoc of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(isCommentAuthorAllowed(raw(assoc), {})).toBe(true);
    }
  });

  test("denies contributors and outsiders by default", () => {
    for (const assoc of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"]) {
      expect(isCommentAuthorAllowed(raw(assoc), {})).toBe(false);
    }
  });

  test("matches case-insensitively", () => {
    expect(isCommentAuthorAllowed(raw("member"), {})).toBe(true);
  });

  test("fails closed when the association can't be read", () => {
    expect(isCommentAuthorAllowed({ comment: {} }, {})).toBe(false);
    expect(isCommentAuthorAllowed(null, {})).toBe(false);
  });

  test("the '*' sentinel allows everyone (incl. unreadable)", () => {
    const opts = { allowedAuthorAssociations: ["*"] };
    expect(isCommentAuthorAllowed(raw("NONE"), opts)).toBe(true);
    expect(isCommentAuthorAllowed(null, opts)).toBe(true);
  });

  test("honors a custom allowlist", () => {
    const opts = { allowedAuthorAssociations: ["contributor"] };
    expect(isCommentAuthorAllowed(raw("CONTRIBUTOR"), opts)).toBe(true);
    expect(isCommentAuthorAllowed(raw("MEMBER"), opts)).toBe(false);
  });
});

describe("repository allowlist", () => {
  const payload = (fullName: unknown): unknown => ({
    repository: { full_name: fullName },
  });

  test("reads and normalizes owner/repository names", () => {
    expect(repositoryFullNameFromRaw(payload("acme/widgets"))).toBe(
      "acme/widgets",
    );
    expect(
      resolveRepositoryAllowlist([" ACME/Widgets ", "bad", "acme/*"]),
    ).toEqual(["acme/widgets"]);
  });

  test("matches exact repository names case-insensitively", () => {
    expect(
      isRepositoryAllowed(payload("acme/Widgets"), {
        repositoryAllowlist: ["ACME/widgets"],
      }),
    ).toBe(true);
    expect(
      isRepositoryAllowed(payload("acme/interview-exercise"), {
        repositoryAllowlist: ["acme/widgets"],
      }),
    ).toBe(false);
  });

  test("fails closed for empty, wildcard, or malformed configuration", () => {
    expect(isRepositoryAllowed(payload("acme/widgets"), {})).toBe(false);
    expect(
      isRepositoryAllowed(payload("acme/widgets"), {
        repositoryAllowlist: ["*"],
      }),
    ).toBe(false);
    expect(
      isRepositoryAllowed({}, { repositoryAllowlist: ["acme/widgets"] }),
    ).toBe(false);
  });

  test("fails startup unless normalization leaves an exact repository", () => {
    expect(() => requireRepositoryAllowlist(undefined)).toThrow(
      "must contain at least one exact owner/repository",
    );
    expect(() => requireRepositoryAllowlist(["*", "owner"])).toThrow(
      "must contain at least one exact owner/repository",
    );
    expect(() =>
      requireRepositoryAllowlist(["/repository", "owner/", "owner/re po"]),
    ).toThrow("must contain at least one exact owner/repository");
    expect(
      requireRepositoryAllowlist(["*", " ACME/Widgets "]),
    ).toEqual(["acme/widgets"]);
  });
});
