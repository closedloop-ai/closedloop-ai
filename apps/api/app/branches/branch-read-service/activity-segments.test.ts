import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { describe, expect, it, vi } from "vitest";
import { attachBranchActivitySegments } from "./activity-segments";

describe("attachBranchActivitySegments", () => {
  it("uses fixed request-wide row budgets regardless of session count", async () => {
    const segmentFindMany = vi.fn().mockResolvedValue([]);
    const eventFindMany = vi.fn().mockResolvedValue([]);
    const sessions = [session("session-1"), session("session-2")];

    await attachBranchActivitySegments(
      {
        agentSessionActivitySegment: { findMany: segmentFindMany },
        agentSessionTokenEvent: { findMany: eventFindMany },
      },
      "org-1",
      sessions
    );

    expect(segmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50_000 })
    );
    expect(eventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10_000 })
    );
  });
});

function session(sessionId: string): BranchPageDetail["sessions"][number] {
  return {
    sessionId,
    slug: null,
    name: null,
    harness: "codex",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:01:00.000Z",
    isPrimary: false,
    estimatedCostUsd: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ownerUserName: null,
  };
}
