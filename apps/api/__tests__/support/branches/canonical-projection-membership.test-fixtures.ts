import type { BranchSession } from "@repo/api/src/types/branch";

/** Minimal detail row for canonical Branch membership projection tests. */
export function membershipSessionRow(id: string): BranchSession {
  return {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    endedAt: null,
    estimatedCostUsd: null,
    harness: "claude",
    inputTokens: 0,
    isPrimary: false,
    name: id,
    outputTokens: 0,
    ownerUserName: null,
    sessionId: id,
    slug: id,
    startedAt: "2026-08-09T00:00:00.000Z",
  };
}
