import { describe, expect, test } from "bun:test";
import {
  MAX_REVIEW_FINDINGS,
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
  test("are stable across reviewers, moved hunk coordinates, and URLs", () => {
    const first = fingerprintReviewFinding({
      body: "Check  https://example.test/one  before use",
      diffHunk: "@@ -1 +1 @@\n-old\n+same implementation",
      line: 10,
      path: "./src/policy.ts",
    });
    const second = fingerprintReviewFinding({
      body: "check https://elsewhere.test/two before use",
      diffHunk: "@@ -90 +99 @@\n-old\n+same implementation",
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
    expect(
      fingerprintReviewFinding({
        body: "check https://elsewhere.test/two before use",
        diffHunk: "@@ -90 +99 @@\n-old\n+different implementation",
        path: "src/policy.ts",
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
    const repeatedMerge = mergeReviewFindings(initial.ledger, [repeated], 1);
    expect(repeatedMerge.newFindings).toHaveLength(1);
    expect(repeatedMerge.ledger[first.fingerprint]).toMatchObject({
      commentId: 88,
      firstSeenEpoch: 1,
      reviewId: 32,
      reviewerKey: "github-user:202",
    });

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

  test("reconciles one moved rediscovery without collapsing simultaneous sites", () => {
    const first = finding({ diffHunk: "@@ -1 +1 @@\n-old one\n+new one" });
    const initial = mergeReviewFindings(undefined, [first], 1);
    const accepted = applyReviewFindingDispositionMarkers(
      initial.ledger,
      parseReviewFindingDispositionMarkers(
        `<!-- centaur-review-finding ${first.fingerprint} review:31 accepted -->`,
      ),
      { commentId: 72, replyToCommentId: 71 },
    );
    const moved = finding({
      commentId: 81,
      diffHunk: "@@ -80 +90 @@\n-partially repaired\n+still unsafe",
      line: 90,
      reviewId: 32,
    });
    expect(moved.fingerprint).not.toBe(first.fingerprint);
    const reconciled = mergeReviewFindings(accepted.ledger, [moved], 2);
    expect(reconciled.newFindings).toEqual([]);
    expect(Object.keys(reconciled.ledger)).toEqual([first.fingerprint]);

    const otherSite = finding({
      commentId: 82,
      diffHunk: "@@ -120 +120 @@\n-old other\n+new other",
      line: 120,
    });
    const simultaneous = mergeReviewFindings(undefined, [first, otherSite], 1);
    expect(simultaneous.newFindings).toHaveLength(2);
    expect(Object.keys(simultaneous.ledger)).toHaveLength(2);
  });

  test("preserves the highest severity when a pending finding is rediscovered", () => {
    const severe = finding({
      body:
        "Centaur-Severity: security\nImpact: repository scope can widen\nEvidence: exact unchecked call is shown",
    });
    const initial = mergeReviewFindings(undefined, [severe], 1);
    expect(initial.ledger[severe.fingerprint]?.severity).toBe("security");

    const downgraded = { ...severe, severity: "normal" as const, reviewId: 32 };
    const merged = mergeReviewFindings(initial.ledger, [downgraded], 1);
    expect(merged.ledger[severe.fingerprint]?.severity).toBe("security");
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

  test("discards contradictory dispositions for the same finding and review", () => {
    const first = finding();
    expect(
      parseReviewFindingDispositionMarkers(
        `<!-- centaur-review-finding ${first.fingerprint} review:31 accepted -->\n` +
          `<!-- centaur-review-finding ${first.fingerprint} review:31 rejected -->`,
      ),
    ).toEqual([]);
  });

  test("evicts old decisions before dropping a current finding", () => {
    const ledger = Object.fromEntries(
      Array.from({ length: MAX_REVIEW_FINDINGS }, (_, index) => {
        const item = finding({ body: `Historical finding ${index}` });
        return [
          item.fingerprint,
          {
            disposition: "rejected" as const,
            firstSeenEpoch: 1,
            reviewId: item.reviewId,
            reviewedHeadSha: item.reviewedHeadSha,
            reviewerKey: item.reviewerKey,
            severity: item.severity,
          },
        ];
      }),
    );
    const current = finding({ body: "A current actionable finding" });
    const merged = mergeReviewFindings(ledger, [current], 2);
    expect(Object.keys(merged.ledger)).toHaveLength(MAX_REVIEW_FINDINGS);
    expect(merged.ledger[current.fingerprint]?.disposition).toBe("pending");
    expect(merged.newFindings).toEqual([current]);
    expect(merged.droppedFindings).toBe(0);
  });
});
