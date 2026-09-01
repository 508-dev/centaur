import { createHash } from "node:crypto";

export const MAX_REVIEW_FINDINGS = 256;

export type ReviewFindingDisposition = "accepted" | "pending" | "rejected";

export type ReviewFinding = {
  body: string;
  commentId?: number;
  diffHunk?: string;
  fingerprint: string;
  line?: number;
  path?: string;
  reviewId: number;
  reviewerKey: string;
  reviewedHeadSha: string;
  severity: "normal" | "p0" | "security";
  url?: string;
};

export type ReviewFindingRecord = {
  commentId?: number;
  dispositionCommentId?: number;
  disposition: ReviewFindingDisposition;
  firstSeenEpoch: number;
  path?: string;
  reviewId: number;
  reviewerKey: string;
  reviewedHeadSha: string;
  severity: ReviewFinding["severity"];
};

export type ReviewFindingLedger = Record<string, ReviewFindingRecord>;

export type ReviewFindingDispositionMarker = {
  disposition: Exclude<ReviewFindingDisposition, "pending">;
  fingerprint: string;
  reviewId: number;
};

const DISPOSITION_MARKER_SOURCE =
  "<!--\\s*centaur-review-finding\\s+(sha256:[0-9a-f]{64})\\s+review:(\\d+)\\s+(accepted|rejected)\\s*-->";
const EXPLICIT_P0 = /^\s*centaur-severity\s*:\s*p0\s*$/im;
const EXPLICIT_SECURITY =
  /^\s*centaur-severity\s*:\s*security\s*$/im;
const EXPLICIT_IMPACT = /^\s*impact\s*:\s*\S.+$/im;
const EXPLICIT_EVIDENCE = /^\s*evidence\s*:\s*\S.+$/im;

/**
 * Build a reviewer-independent semantic fingerprint. Exact reviewer identity,
 * line number, and mutable diff context are intentionally excluded so a bot
 * cannot reopen the same normalized finding merely by changing accounts or
 * pointing at a nearby line after a repair.
 */
export function fingerprintReviewFinding(input: {
  body: string;
  diffHunk?: string;
  line?: number;
  path?: string;
}): string {
  const canonical = JSON.stringify({
    body: normalizeFindingText(input.body),
    path: normalizePath(input.path),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function makeReviewFinding(input: {
  body: string;
  commentId?: number;
  diffHunk?: string;
  line?: number;
  path?: string;
  reviewId: number;
  reviewerKey: string;
  reviewedHeadSha: string;
  url?: string;
}): ReviewFinding {
  const body = input.body.trim().slice(0, 16_000);
  const path = normalizePath(input.path) || undefined;
  const diffHunk = input.diffHunk?.trim().slice(0, 16_000) || undefined;
  const line = positiveInteger(input.line);
  return {
    body,
    commentId: positiveInteger(input.commentId),
    diffHunk,
    fingerprint: fingerprintReviewFinding({ body, diffHunk, line, path }),
    line,
    path,
    reviewId: input.reviewId,
    reviewerKey: input.reviewerKey,
    reviewedHeadSha: input.reviewedHeadSha,
    severity: findingSeverity({ body, diffHunk, line, path }),
    url: input.url?.trim().slice(0, 2_000) || undefined,
  };
}

/**
 * A budget interrupt needs a strict machine-readable severity declaration,
 * bounded impact/evidence statements, and concrete inline code evidence.
 * Ordinary prose containing words such as "critical" is never enough.
 */
export function findingSeverity(input: {
  body: string;
  diffHunk?: string;
  line?: number;
  path?: string;
}): ReviewFinding["severity"] {
  const hasCodeEvidence =
    Boolean(normalizePath(input.path)) &&
    (Boolean(input.diffHunk?.trim()) || positiveInteger(input.line) !== undefined);
  if (
    !hasCodeEvidence ||
    !EXPLICIT_IMPACT.test(input.body) ||
    !EXPLICIT_EVIDENCE.test(input.body)
  ) {
    return "normal";
  }
  if (EXPLICIT_P0.test(input.body)) return "p0";
  if (EXPLICIT_SECURITY.test(input.body)) return "security";
  return "normal";
}

export function mergeReviewFindings(
  ledger: ReviewFindingLedger | undefined,
  findings: readonly ReviewFinding[],
  epoch: number,
): {
  ledger: ReviewFindingLedger;
  newFindings: ReviewFinding[];
} {
  const next: ReviewFindingLedger = { ...(ledger ?? {}) };
  const actionableFindings: ReviewFinding[] = [];
  for (const finding of findings) {
    const existing = next[finding.fingerprint];
    if (
      existing?.disposition === "accepted" ||
      existing?.disposition === "rejected"
    ) {
      continue;
    }
    // A repeated pending finding remains actionable. Only an evidence-backed
    // accepted/rejected decision suppresses rediscovery.
    actionableFindings.push(finding);
    if (existing) continue;
    next[finding.fingerprint] = {
      commentId: finding.commentId,
      disposition: "pending",
      firstSeenEpoch: epoch,
      path: finding.path,
      reviewId: finding.reviewId,
      reviewerKey: finding.reviewerKey,
      reviewedHeadSha: finding.reviewedHeadSha,
      severity: finding.severity,
    };
  }

  const entries = Object.entries(next);
  if (entries.length <= MAX_REVIEW_FINDINGS) {
    return { ledger: next, newFindings: actionableFindings };
  }
  // Retain all decided findings first, then the newest pending findings. This
  // bounds durable state without letting noisy pending reviews evict decisions.
  const decided = entries.filter(
    ([, finding]) => finding.disposition !== "pending",
  );
  const pending = entries.filter(
    ([, finding]) => finding.disposition === "pending",
  );
  const retainedDecided = decided.slice(-MAX_REVIEW_FINDINGS);
  const remaining = MAX_REVIEW_FINDINGS - retainedDecided.length;
  const retained = [
    ...retainedDecided,
    ...(remaining > 0 ? pending.slice(-remaining) : []),
  ];
  const retainedLedger = Object.fromEntries(retained);
  return {
    ledger: retainedLedger,
    newFindings: actionableFindings.filter(
      (finding) => retainedLedger[finding.fingerprint] !== undefined,
    ),
  };
}

export function parseReviewFindingDispositionMarkers(
  body: string,
): ReviewFindingDispositionMarker[] {
  const markers: ReviewFindingDispositionMarker[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(new RegExp(DISPOSITION_MARKER_SOURCE, "gi"))) {
    const fingerprint = match[1]?.toLowerCase();
    const reviewId = Number.parseInt(match[2] ?? "", 10);
    const disposition = match[3]?.toLowerCase();
    if (
      !fingerprint ||
      !Number.isSafeInteger(reviewId) ||
      reviewId <= 0 ||
      (disposition !== "accepted" && disposition !== "rejected")
    ) {
      continue;
    }
    const key = `${fingerprint}:${reviewId}:${disposition}`;
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push({ fingerprint, reviewId, disposition });
  }
  return markers;
}

export function applyReviewFindingDispositionMarkers(
  ledger: ReviewFindingLedger | undefined,
  markers: readonly ReviewFindingDispositionMarker[],
  source?: { commentId?: number; replyToCommentId?: number },
): { changed: boolean; ledger: ReviewFindingLedger } {
  const next: ReviewFindingLedger = { ...(ledger ?? {}) };
  let changed = false;
  for (const marker of markers) {
    const existing = next[marker.fingerprint];
    if (
      !existing ||
      existing.reviewId !== marker.reviewId ||
      (existing.commentId !== undefined &&
        source?.replyToCommentId !== existing.commentId) ||
      existing.disposition === marker.disposition
    ) {
      continue;
    }
    next[marker.fingerprint] = {
      ...existing,
      dispositionCommentId: positiveInteger(source?.commentId),
      disposition: marker.disposition,
    };
    changed = true;
  }
  return { changed, ledger: next };
}

export function acceptedFindingPaths(
  ledger: ReviewFindingLedger | undefined,
  fingerprints?: ReadonlySet<string>,
): Set<string> {
  return new Set(
    Object.entries(ledger ?? {})
      .filter(
        ([fingerprint, finding]) =>
          finding.disposition === "accepted" &&
          finding.path &&
          (!fingerprints || fingerprints.has(fingerprint)),
      )
      .map(([, finding]) => finding.path as string),
  );
}

export function isReviewFindingLedger(
  value: unknown,
): value is ReviewFindingLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > MAX_REVIEW_FINDINGS) return false;
  return entries.every(([fingerprint, raw]) => {
    if (!/^sha256:[0-9a-f]{64}$/.test(fingerprint)) return false;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const finding = raw as Partial<ReviewFindingRecord>;
    return (
      ["accepted", "pending", "rejected"].includes(
        finding.disposition ?? "",
      ) &&
      typeof finding.firstSeenEpoch === "number" &&
      Number.isInteger(finding.firstSeenEpoch) &&
      finding.firstSeenEpoch > 0 &&
      typeof finding.reviewId === "number" &&
      Number.isInteger(finding.reviewId) &&
      finding.reviewId > 0 &&
      typeof finding.reviewerKey === "string" &&
      finding.reviewerKey.length > 0 &&
      typeof finding.reviewedHeadSha === "string" &&
      finding.reviewedHeadSha.length > 0 &&
      finding.reviewedHeadSha.length <= 100 &&
      ["normal", "p0", "security"].includes(finding.severity ?? "") &&
      (finding.commentId === undefined ||
        (Number.isInteger(finding.commentId) && finding.commentId > 0)) &&
      (finding.dispositionCommentId === undefined ||
        (Number.isInteger(finding.dispositionCommentId) &&
          finding.dispositionCommentId > 0)) &&
      (finding.path === undefined ||
        (typeof finding.path === "string" && finding.path.length > 0))
    );
  });
}

function normalizeFindingText(value: string): string {
  return value
    .replace(new RegExp(DISPOSITION_MARKER_SOURCE, "gi"), " ")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 16_000);
}

function normalizePath(value: string | undefined): string {
  return (value ?? "").trim().replace(/^\.\//, "").slice(0, 1_000);
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}
