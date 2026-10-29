import type { BranchPageDetail } from "@repo/api/src/types/branch";
// biome-ignore lint/performance/noNamespaceImport: Vitest spies on the actual exported tiler.
import * as attribution from "@repo/lib/branches/activity-attribution";
import { describe, expect, it, vi } from "vitest";
import { attachBranchActivitySegments } from "./activity-segments";

describe("attachBranchActivitySegments", () => {
  it("tiles shared Session evidence once and gives every membership the same segments (ISS-11589)", async () => {
    const tile = vi.spyOn(attribution, "attributeBranchSessionActivity");
    const sessions = [session("shared"), session("shared"), session("other")];
    const segmentFindMany = vi.fn().mockResolvedValue([
      {
        agentSessionId: "shared",
        phase: "implementation",
        startMs: 1,
        endMs: 10,
        confidence: 1,
      },
      {
        agentSessionId: "other",
        phase: "implementation",
        startMs: 1,
        endMs: 10,
        confidence: 1,
      },
    ]);
    const eventFindMany = vi.fn().mockResolvedValue([]);
    const reasons = await attachBranchActivitySegments(
      {
        agentSessionActivitySegment: { findMany: segmentFindMany },
        agentSessionTokenEvent: { findMany: eventFindMany },
      },
      "org-1",
      sessions
    );
    expect(tile).toHaveBeenCalledTimes(2);
    expect(reasons).toEqual([]);
    expect(sessions[0].activitySegments).toEqual(sessions[1].activitySegments);
    // One array per Session, not per membership: phase attribution reuses its
    // per-array work only when it sees the same array again.
    expect(sessions[0].activitySegments).toBe(sessions[1].activitySegments);
    expect(sessions[0].activitySegments).not.toBe(sessions[2].activitySegments);
    expect(segmentFindMany).toHaveBeenCalledOnce();
    expect(eventFindMany).toHaveBeenCalledOnce();
    tile.mockRestore();
  });
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
