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
 * line number and hunk coordinates are intentionally excluded so a bot cannot
 * reopen the same normalized finding merely by changing accounts or pointing
 * at a moved line. The coordinate-free hunk body remains part of the identity
 * so identical prose at two distinct code sites cannot collapse into one row.
 */
export function fingerprintReviewFinding(input: {
  body: string;
  diffHunk?: string;
  line?: number;
  path?: string;
  side?: string;
}): string {
  const side = normalizeDiffSide(input.side);
  const canonical = JSON.stringify({
    body: normalizeFindingText(input.body),
    context: normalizeDiffContext(input.diffHunk),
    path: normalizePath(input.path),
    site: relativeDiffLine(input.diffHunk, input.line, side),
    // Preserve existing right-side fingerprints while distinguishing a
    // finding attached to the removed side of the same replacement hunk.
    ...(side === "left" ? { side } : {}),
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
  side?: string;
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
    fingerprint: fingerprintReviewFinding({
      body,
      diffHunk,
      line,
      path,
      side: input.side,
    }),
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
  droppedFindings: number;
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
    if (existing) {
      next[finding.fingerprint] = {
        ...existing,
        commentId: finding.commentId,
        path: finding.path,
        reviewId: finding.reviewId,
        reviewerKey: finding.reviewerKey,
        reviewedHeadSha: finding.reviewedHeadSha,
        severity: highestSeverity(existing.severity, finding.severity),
      };
      continue;
    }
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
    return { droppedFindings: 0, ledger: next, newFindings: actionableFindings };
  }
  // Current actionable findings must not disappear behind a full historical
  // ledger. Retain them first, then older pending work, then the newest decided
  // fingerprints. Old decisions are the safest entries to evict: rediscovery
  // spends bounded budget, while dropping a current finding silently skips it.
  const actionableFingerprints = [
    ...new Set(actionableFindings.map((finding) => finding.fingerprint)),
  ];
  const actionableFingerprintSet = new Set(actionableFingerprints);
  const actionable: Array<[string, ReviewFindingRecord]> =
    actionableFingerprints.flatMap((fingerprint) => {
    const record = next[fingerprint];
      return record ? [[fingerprint, record]] : [];
    });
  const decided = entries.filter(
    ([fingerprint, finding]) =>
      finding.disposition !== "pending" &&
      !actionableFingerprintSet.has(fingerprint),
  );
  const pending = entries.filter(
    ([fingerprint, finding]) =>
      finding.disposition === "pending" &&
      !actionableFingerprintSet.has(fingerprint),
  );
  const retained = actionable.slice(0, MAX_REVIEW_FINDINGS);
  let remaining = MAX_REVIEW_FINDINGS - retained.length;
  if (remaining > 0) {
    const retainedPending = pending.slice(-remaining);
    retained.push(...retainedPending);
    remaining -= retainedPending.length;
  }
  if (remaining > 0) retained.push(...decided.slice(-remaining));
  const retainedLedger = Object.fromEntries(retained);
  const retainedNewFindings = actionableFindings.filter(
    (finding) => retainedLedger[finding.fingerprint] !== undefined,
  );
  return {
    droppedFindings: actionableFindings.length - retainedNewFindings.length,
    ledger: retainedLedger,
    newFindings: retainedNewFindings,
  };
}

function normalizeDiffContext(value: string | undefined): string {
  return (value ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^@@(?:\s|$)/.test(line))
    .join("\n")
    .trim();
}

function relativeDiffLine(
  diffHunk: string | undefined,
  line: number | undefined,
  side: "left" | "right" | undefined,
): number | undefined {
  const normalizedLine = positiveInteger(line);
  if (normalizedLine === undefined) return undefined;
  const header = diffHunk?.split(/\r?\n/, 1)[0];
  const starts = header?.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)/);
  const start = side === "left" ? starts?.[1] : starts?.[2];
  if (!start) return normalizedLine;
  return normalizedLine - Number.parseInt(start, 10);
}

function normalizeDiffSide(
  value: string | undefined,
): "left" | "right" | undefined {
  const side = value?.trim().toLowerCase();
  return side === "left" || side === "right" ? side : undefined;
}

function highestSeverity(
  left: ReviewFinding["severity"],
  right: ReviewFinding["severity"],
): ReviewFinding["severity"] {
  const rank = { normal: 0, security: 1, p0: 2 } as const;
  return rank[left] >= rank[right] ? left : right;
}

export function parseReviewFindingDispositionMarkers(
  body: string,
): ReviewFindingDispositionMarker[] {
  const markers: ReviewFindingDispositionMarker[] = [];
  const byFinding = new Map<
    string,
    ReviewFindingDispositionMarker | "conflict"
  >();
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
    const key = `${fingerprint}:${reviewId}`;
    const marker: ReviewFindingDispositionMarker = {
      disposition,
      fingerprint,
      reviewId,
    };
    const existing = byFinding.get(key);
    if (existing === "conflict") continue;
    if (existing && existing.disposition !== disposition) {
      byFinding.set(key, "conflict");
      continue;
    }
    if (!existing) byFinding.set(key, marker);
  }
  for (const marker of byFinding.values()) {
    if (marker !== "conflict") markers.push(marker);
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
