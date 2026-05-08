import type { ReviewFinding } from "@/lib/engineer/codex-review-parser";

// --- Findings persistence helpers ---

export function saveReviewFindings(
  ticketId: string,
  repoPath: string,
  provider: string,
  model: string,
  findings: ReviewFinding[]
): void {
  const url = `/api/gateway/codex/review-findings/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=${encodeURIComponent(provider)}`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, model, findings }),
  }).catch((err) => console.warn("[review-findings] Failed to save:", err));
}

export function markFindingCommented(
  ticketId: string,
  repoPath: string,
  provider: string,
  index: number
): void {
  const url = `/api/gateway/codex/review-findings/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=${encodeURIComponent(provider)}`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commentedIndex: index }),
  }).catch((err) =>
    console.warn("[review-findings] Failed to mark commented:", err)
  );
}

export async function postDeclineComment(
  repoPath: string,
  prNumber: number,
  reason: string
): Promise<void> {
  const body = `\u26D4 **Review Recommendation: Decline**\n\n${reason}`;
  const res = await fetch("/api/gateway/git/pr/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoPath, prNumber, body, requestChanges: true }),
  });
  if (!res.ok) {
    throw new Error("Failed to request changes");
  }
}

export async function markReviewDeclined(
  ticketId: string,
  repoPath: string,
  provider: string,
  reason: string
): Promise<void> {
  const url = `/api/gateway/codex/review-findings/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=${encodeURIComponent(provider)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ declined: true, declineReason: reason }),
  });
  if (!response.ok) {
    throw new Error(`Failed to persist decline (${response.status})`);
  }
}

// --- Status pre-check for review resumption ---

export type ExistingReviewState =
  | { kind: "none" }
  | { kind: "running"; log: string; sessionId?: string }
  | { kind: "completed"; log: string; sessionId?: string }
  | { kind: "terminal"; log: string; sessionId?: string };

export async function checkExistingReview(
  ticketId: string,
  repoPath: string,
  provider: string,
  signal: AbortSignal
): Promise<ExistingReviewState> {
  try {
    const url = `/api/gateway/codex/status/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=${encodeURIComponent(provider)}`;
    const res = await fetch(url, { signal });
    const data = await res.json();

    if (!data.hasReview) {
      return { kind: "none" };
    }

    const log: string = data.log || "";
    const sessionId: string | undefined = data.sessionId || undefined;

    if (data.status === "completed") {
      return { kind: "completed", log, sessionId };
    }
    if (data.status === "running") {
      return { kind: "running", log, sessionId };
    }
    if (data.status === "failed" || data.status === "stopped") {
      return { kind: "terminal", log, sessionId };
    }

    return { kind: "none" };
  } catch {
    // Fail-safe: fall through to POST
    return { kind: "none" };
  }
}

// --- PRBrowserDialog consolidated helpers ---

/**
 * Fetch the set of finding indices that have been marked as commented.
 * Throws on non-OK responses or malformed payloads — callers should
 * catch to handle errors appropriately.
 */
export async function fetchCommentedIndices(
  ticketId: string,
  repoPath: string,
  provider: string
): Promise<Set<number>> {
  const res = await fetch(
    `/api/gateway/codex/review-findings/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=${encodeURIComponent(provider)}`
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch commented indices (${res.status})`);
  }
  const data = await res.json();
  if (!Array.isArray(data.findings)) {
    throw new TypeError("Malformed response: findings is not an array");
  }
  const indices = new Set<number>();
  data.findings.forEach((f: { commented?: boolean }, i: number) => {
    if (f.commented) {
      indices.add(i);
    }
  });
  return indices;
}

/**
 * Fetch a provider's persisted findings for cross-provider dedup.
 * Non-throwing — returns empty array on failure (dedup is best-effort).
 */
export async function fetchProviderFindings(
  ticketId: string,
  repoPath: string,
  provider: string
): Promise<ReviewFinding[]> {
  try {
    const res = await fetch(
      `/api/gateway/codex/review-findings/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=${encodeURIComponent(provider)}`
    );
    const data = await res.json();
    return data.findings ?? [];
  } catch {
    return [];
  }
}
