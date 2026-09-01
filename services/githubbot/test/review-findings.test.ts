import { describe, expect, test } from "bun:test";
import {
  applyReviewFindingDispositionMarkers,
  findingSeverity,
  fingerprintReviewFinding,
  makeReviewFinding,
  mergeReviewFindings,
  parseReviewFindingDispositionMarkers,
} from "../src/review-findings";

function finding(overrides: Partial<Parameters<typeof makeReviewFinding>[0]> = {}) {
  return makeReviewFinding({
    body: "The unchecked value can escape the repository policy.",
    commentId: 71,
    diffHunk: "@@ -1 +1 @@\n-old\n+new",
    line: 14,
    path: "src/policy.ts",
    reviewId: 31,
    reviewerKey: "github-user:101",
    reviewedHeadSha: "abc1234",
    ...overrides,
  });
}

describe("review finding fingerprints", () => {
  test("are stable across reviewers, moved lines, mutable hunks, and URLs", () => {
    const first = fingerprintReviewFinding({
      body: "Check  https://example.test/one  before use",
      diffHunk: "+first implementation",
      line: 10,
      path: "./src/policy.ts",
    });
    const second = fingerprintReviewFinding({
      body: "check https://elsewhere.test/two before use",
      diffHunk: "+replacement implementation",
      line: 99,
      path: "src/policy.ts",
    });
    expect(second).toBe(first);
    expect(
      fingerprintReviewFinding({
        body: "check https://elsewhere.test/two before use",
        path: "src/other.ts",
      }),
    ).not.toBe(first);
  });

  test("requires structured impact and inline evidence for a budget interrupt", () => {
    const evidence = {
      diffHunk: "+untrusted(input)",
      line: 22,
      path: "src/auth.ts",
    };
    expect(
      findingSeverity({
        body: "This is a critical security problem.",
        ...evidence,
      }),
    ).toBe("normal");
    expect(
      findingSeverity({
        body:
          "Centaur-Severity: security\nImpact: crosses the repository allowlist\nEvidence: untrusted input reaches token minting",
        ...evidence,
      }),
    ).toBe("security");
    expect(
      findingSeverity({
        body:
          "Centaur-Severity: P0\nImpact: arbitrary deployment\nEvidence: scope is not checked",
      }),
    ).toBe("normal");
  });
});

describe("review finding ledger", () => {
  test("keeps pending repeats actionable but suppresses decided rediscovery", () => {
    const first = finding();
    const initial = mergeReviewFindings(undefined, [first], 1);
    expect(initial.newFindings).toHaveLength(1);
    expect(initial.ledger[first.fingerprint]?.disposition).toBe("pending");

    const repeated = finding({
      commentId: 88,
      line: 40,
      reviewId: 32,
      reviewerKey: "github-user:202",
    });
    expect(mergeReviewFindings(initial.ledger, [repeated], 1).newFindings).toHaveLength(
      1,
    );

    const marker = parseReviewFindingDispositionMarkers(
      `<!-- centaur-review-finding ${first.fingerprint} review:31 accepted -->`,
    );
    const decided = applyReviewFindingDispositionMarkers(initial.ledger, marker, {
      commentId: 72,
      replyToCommentId: 71,
    });
    expect(decided.changed).toBe(true);
    expect(decided.ledger[first.fingerprint]).toMatchObject({
      disposition: "accepted",
      dispositionCommentId: 72,
    });
    expect(mergeReviewFindings(decided.ledger, [repeated], 2).newFindings).toEqual(
      [],
    );
  });

  test("rejects a disposition detached from the original review thread", () => {
    const first = finding();
    const ledger = mergeReviewFindings(undefined, [first], 1).ledger;
    const wrongReview = parseReviewFindingDispositionMarkers(
      `<!-- centaur-review-finding ${first.fingerprint} review:99 rejected -->`,
    );
    const wrongThread = parseReviewFindingDispositionMarkers(
      `<!-- centaur-review-finding ${first.fingerprint} review:31 rejected -->`,
    );
    expect(
      applyReviewFindingDispositionMarkers(ledger, wrongReview, {
        replyToCommentId: 71,
      }).changed,
    ).toBe(false);
    expect(
      applyReviewFindingDispositionMarkers(ledger, wrongThread, {
        replyToCommentId: 999,
      }).changed,
    ).toBe(false);
  });
});
