import type { MergedTraceItem } from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import {
  buildActorColorDomain,
  deriveActorsFromSessions,
} from "../branch-actor-domain";
import { buildSessionTimeline } from "../branch-session-buckets";

function startItem(
  sessionId: string,
  t: string,
  name: string | null
): MergedTraceItem {
  return { type: "sessionstart", sessionId, t, actor: { name, harness: null } };
}

function timelineOf(detail: ReturnType<typeof makeBranchDetail>) {
  return buildSessionTimeline(
    detail,
    buildActorColorDomain(deriveActorsFromSessions(detail))
  );
}

describe("buildSessionTimeline", () => {
  it("distributes a session's tokens across the hours its burst spans", () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T12:00:00.000Z",
          inputTokens: 1000,
        }),
      ],
    });
    const { columns, maxTotal, startMs, endMs } = timelineOf(detail);
    // 2h burst → hours 10 and 11, split evenly.
    expect(columns).toHaveLength(2);
    expect(columns.map((c) => Math.round(c.total))).toEqual([500, 500]);
    expect(maxTotal).toBe(500);
    expect(startMs).toBe(Date.parse("2026-06-10T10:00:00.000Z"));
    expect(endMs).toBe(Date.parse("2026-06-10T12:00:00.000Z"));
  });

  it("synthesizes gap hours between sessions", () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          inputTokens: 100,
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T13:00:00.000Z",
          endedAt: "2026-06-10T14:00:00.000Z",
          inputTokens: 50,
        }),
      ],
    });
    const { columns } = timelineOf(detail);
    // Hours 10, 11, 12, 13 → 11 & 12 are gaps.
    expect(columns).toHaveLength(4);
    expect(columns.filter((c) => c.isGap)).toHaveLength(2);
  });

  it("attributes by actor and marks concurrent hours", () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          inputTokens: 100,
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          inputTokens: 80,
        }),
      ],
      mergedTrace: [
        startItem("s1", "2026-06-10T10:00:00.000Z", "alice"),
        startItem("s2", "2026-06-10T10:00:00.000Z", "bob"),
      ],
    });
    const { columns } = timelineOf(detail);
    expect(columns).toHaveLength(1);
    expect(columns[0]?.hasConcurrency).toBe(true);
    expect(columns[0]?.segments.map((s) => s.owner).sort()).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("caps the span when a session has an outlier far-future end (no unbounded loop)", () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "9999-01-01T00:00:00.000Z",
          inputTokens: 1000,
        }),
      ],
    });
    const { columns, startMs, endMs } = timelineOf(detail);
    // Bounded to the 90-day hourly ceiling instead of millions of columns.
    const maxHours = 24 * 90;
    expect(columns).toHaveLength(maxHours);
    expect(startMs).toBe(Date.parse("2026-06-10T10:00:00.000Z"));
    expect(endMs).toBe((startMs ?? 0) + maxHours * 3_600_000);
  });

  it("returns an empty timeline when there are no sessions", () => {
    const { columns, startMs } = timelineOf(makeBranchDetail({ sessions: [] }));
    expect(columns).toEqual([]);
    expect(startMs).toBeNull();
  });
});
