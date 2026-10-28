import { ActorTurnSide } from "@repo/app/shared/lib/actor-color-domain";
import { describe, expect, it } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import { buildActorColorDomain } from "../branch-actor-domain";
import {
  BranchTimelineGrouping,
  buildSessionTimeline,
} from "../branch-session-buckets";

function timelineOf(
  detail: ReturnType<typeof makeBranchDetail>,
  grouping: BranchTimelineGrouping = BranchTimelineGrouping.SessionOwner
) {
  // The production human domain keys actors by stable user ID, with a normalized
  // legacy label only when an older producer has no ID. Mirror that identity
  // contract here so duplicate display names cannot collapse actor colors.
  return buildSessionTimeline(
    detail,
    buildActorColorDomain(detail.sessions.map(sessionActorIdentity)),
    grouping
  );
}

describe("buildSessionTimeline (FEA-3576: per-user cost)", () => {
  it("distributes a session's COST across the hours its burst spans", () => {
    const detail = makeBranchDetail({
      estimatedCostUsd: 10,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T12:00:00.000Z",
          estimatedCostUsd: 10,
          ownerUserName: "Cosimo",
          // Tokens are still carried in the split; they are NOT the segment size.
          inputTokens: 1000,
        }),
      ],
    });
    const { columns, maxTotal, startMs, endMs } = timelineOf(detail);
    // 2h burst → hours 10 and 11; cost split evenly ($5/$5), NOT tokens.
    expect(columns).toHaveLength(2);
    expect(columns.map((c) => Math.round(c.total * 100) / 100)).toEqual([5, 5]);
    expect(maxTotal).toBe(5);
    expect(startMs).toBe(Date.parse("2026-06-10T10:00:00.000Z"));
    expect(endMs).toBe(Date.parse("2026-06-10T12:00:00.000Z"));
    // The segment value is cost; the token split stays available for the tooltip.
    const segment = columns[0]?.segments[0];
    expect(segment?.owner).toBe("Cosimo");
    expect(Math.round((segment?.value ?? 0) * 100) / 100).toBe(5);
    expect(Math.round(segment?.input ?? 0)).toBe(500);
    expect(segment?.color).toBe(
      buildActorColorDomain(["legacy:cosimo"]).colorForTurn(
        "Cosimo",
        ActorTurnSide.Human,
        "legacy:cosimo"
      )
    );
  });

  it("synthesizes gap hours between sessions", () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 2,
          ownerUserName: "Cosimo",
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T13:00:00.000Z",
          endedAt: "2026-06-10T14:00:00.000Z",
          estimatedCostUsd: 1,
          ownerUserName: "Cosimo",
        }),
      ],
    });
    const { columns } = timelineOf(detail);
    // Hours 10, 11, 12, 13 → 11 & 12 are gaps.
    expect(columns).toHaveLength(4);
    expect(columns.filter((c) => c.isGap)).toHaveLength(2);
  });

  it("segments an hour by USER and marks concurrent (multi-user) hours", () => {
    const detail = makeBranchDetail({
      estimatedCostUsd: 10,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 6,
          ownerUserName: "Cosimo",
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 4,
          ownerUserName: "Tamsin",
        }),
      ],
    });
    const { columns } = timelineOf(detail);
    expect(columns).toHaveLength(1);
    const column = columns[0];
    expect(column?.hasConcurrency).toBe(true);
    // Two user segments, sized by cost and sorted cost-desc.
    expect(column?.segments.map((s) => s.owner)).toEqual(["Cosimo", "Tamsin"]);
    expect(column?.segments.map((s) => s.value)).toEqual([6, 4]);
    expect(column?.total).toBe(10);
  });

  it("sums multiple sessions of the SAME user into one segment for the hour", () => {
    const detail = makeBranchDetail({
      estimatedCostUsd: 5,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 3,
          ownerUserName: "Cosimo",
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 2,
          ownerUserName: "Cosimo",
        }),
      ],
    });
    const { columns } = timelineOf(detail);
    expect(columns).toHaveLength(1);
    expect(columns[0]?.segments).toHaveLength(1);
    expect(columns[0]?.segments[0]?.owner).toBe("Cosimo");
    expect(columns[0]?.segments[0]?.value).toBe(5);
    expect(columns[0]?.hasConcurrency).toBe(false);
  });

  it("folds sessions with no resolvable user into a null 'unattributed' segment", () => {
    const detail = makeBranchDetail({
      estimatedCostUsd: 8,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 5,
          ownerUserName: null,
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 3,
          // Empty string coalesces to the same unattributed bucket as null.
          ownerUserName: "",
        }),
      ],
    });
    const { columns } = timelineOf(detail);
    expect(columns).toHaveLength(1);
    // Both fold into one null-owner segment (unattributed), summed.
    expect(columns[0]?.segments).toHaveLength(1);
    expect(columns[0]?.segments[0]?.owner).toBeNull();
    expect(columns[0]?.segments[0]?.value).toBe(8);
  });

  it("renders a costed user and an unattributed session as two segments", () => {
    const detail = makeBranchDetail({
      estimatedCostUsd: 9,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 7,
          ownerUserName: "Cosimo",
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 2,
          ownerUserName: null,
        }),
      ],
    });
    const { columns } = timelineOf(detail);
    expect(columns[0]?.segments.map((s) => s.owner)).toEqual(["Cosimo", null]);
    expect(columns[0]?.segments.map((s) => s.value)).toEqual([7, 2]);
  });

  it("keeps unavailable-cost human activity visible instead of presenting it as idle", () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          // Un-priced session: activity is known even though cost is not.
          estimatedCostUsd: null,
          ownerUserName: "Cosimo",
          inputTokens: 500,
        }),
      ],
    });
    const { columns, maxTotal } = timelineOf(detail);
    expect(columns).toHaveLength(1);
    expect(columns[0]?.segments).toEqual([
      expect.objectContaining({
        costUnavailable: true,
        owner: "Cosimo",
        value: 0,
      }),
    ]);
    expect(columns[0]?.isGap).toBe(false);
    expect(columns[0]?.total).toBe(0);
    expect(maxTotal).toBe(0);
  });

  it("keeps explicit zero-cost human activity visible with a complete zero", () => {
    const detail = makeBranchDetail({
      estimatedCostUsd: 0,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 0,
          ownerUserName: "Cosimo",
        }),
      ],
    });
    const { columns } = timelineOf(detail);
    expect(columns[0]).toEqual(
      expect.objectContaining({ isGap: false, total: 0 })
    );
    expect(columns[0]?.segments[0]).toEqual(
      expect.objectContaining({ costUnavailable: false, value: 0 })
    );
  });

  it("scales per-session cost to the branch even-split total so bars reconcile with the header", () => {
    // Two sessions, full cost $6 + $2 = $8, but the branch's even-split cost stat
    // is only $4 (each session shared with one other branch). The bars must sum to
    // $4 (the header stat), scaling each session by 4/8 = 0.5, preserving the 3:1
    // per-user proportion (Cosimo $3, Tamsin $1).
    const detail = makeBranchDetail({
      estimatedCostUsd: 4,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 6,
          ownerUserName: "Cosimo",
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 2,
          ownerUserName: "Tamsin",
        }),
      ],
    });
    const { columns } = timelineOf(detail);
    expect(columns).toHaveLength(1);
    expect(columns[0]?.total).toBe(4);
    expect(columns[0]?.segments.map((s) => [s.owner, s.value])).toEqual([
      ["Cosimo", 3],
      ["Tamsin", 1],
    ]);
  });

  it("uses the canonical attributed total for fallback scaling", () => {
    const detail = makeBranchDetail({
      attributedCostUsd: 25,
      estimatedCostUsd: 100,
      sessions: [
        makeBranchSession({
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 100,
          ownerUserName: "Cosimo",
        }),
      ],
    });

    const { columns } = timelineOf(detail);
    expect(columns[0]?.total).toBe(25);
  });

  it("preserves an explicit zero attributed total in the fallback scale", () => {
    const detail = makeBranchDetail({
      attributedCostUsd: 0,
      estimatedCostUsd: 100,
      sessions: [
        makeBranchSession({
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 100,
        }),
      ],
    });

    const { columns } = timelineOf(detail);
    expect(columns[0]?.total).toBe(0);
    expect(columns[0]?.segments[0]?.costUnavailable).toBe(false);
  });

  it("keeps raw session bars unavailable when attributed cost is explicitly null", () => {
    const detail = makeBranchDetail({
      attributedCostUsd: null,
      estimatedCostUsd: 100,
      sessions: [
        makeBranchSession({
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 100,
        }),
      ],
    });

    const { columns } = timelineOf(detail);
    expect(columns[0]?.total).toBe(0);
    expect(columns[0]?.segments[0]).toEqual(
      expect.objectContaining({ costUnavailable: true, value: 0 })
    );
  });

  it("uses the priced Session subtotal for a legacy payload with null top-level cost", () => {
    const detail = makeBranchDetail({
      estimatedCostUsd: null,
      sessions: [
        makeBranchSession({
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 100,
        }),
      ],
    });

    const { columns } = timelineOf(detail);
    expect(columns[0]?.total).toBe(100);
    expect(columns[0]?.segments[0]).toEqual(
      expect.objectContaining({ costUnavailable: false, value: 100 })
    );
  });

  it("conserves total cost: a session's spend is distributed ONCE, not double-counted", () => {
    // Thread A: cost is split by active-time fraction across the hours a burst
    // touches, keyed by the session's single owner. It must NOT be split again
    // per user — the sum of every segment across every hour must equal the
    // session's own cost (here $10), attributed entirely to its one owner.
    const detail = makeBranchDetail({
      estimatedCostUsd: 10,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T13:00:00.000Z",
          estimatedCostUsd: 10,
          ownerUserName: "Cosimo",
        }),
      ],
    });
    const { columns } = timelineOf(detail);
    const summed = columns
      .flatMap((column) => column.segments)
      .reduce((total, segment) => total + segment.value, 0);
    // Conserved to the cent — the burst spanned 3 hours but the $10 is spread,
    // not multiplied, across them.
    expect(Math.round(summed * 100) / 100).toBe(10);
    // All of it lands on the one owner (no phantom second per-user split).
    const chrisTotal = columns
      .flatMap((column) => column.segments)
      .filter((segment) => segment.owner === "Cosimo")
      .reduce((total, segment) => total + segment.value, 0);
    expect(Math.round(chrisTotal * 100) / 100).toBe(10);
  });

  it("conserves cost across MULTIPLE users without cross-attributing between them", () => {
    // Two users, each their own session; each user's segments must sum to exactly
    // that user's own spend, and the grand total to the sum of both.
    const detail = makeBranchDetail({
      estimatedCostUsd: 10,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T12:00:00.000Z",
          estimatedCostUsd: 8,
          ownerUserName: "Cosimo",
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 2,
          ownerUserName: "Tamsin",
        }),
      ],
    });
    const { columns } = timelineOf(detail);
    const all = columns.flatMap((column) => column.segments);
    const sumFor = (owner: string) =>
      Math.round(
        all
          .filter((segment) => segment.owner === owner)
          .reduce((total, segment) => total + segment.value, 0) * 100
      ) / 100;
    expect(sumFor("Cosimo")).toBe(8);
    expect(sumFor("Tamsin")).toBe(2);
    expect(
      Math.round(all.reduce((total, s) => total + s.value, 0) * 100) / 100
    ).toBe(10);
  });

  it("re-cuts the same hourly cost by activity phase without changing totals", () => {
    const start = Date.parse("2026-06-10T10:00:00.000Z");
    const detail = makeBranchDetail({
      estimatedCostUsd: 10,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 10,
          ownerUserName: "Cosimo",
          activitySegments: [
            {
              confidence: 1,
              costUsd: 5,
              inputTokens: 500,
              outputTokens: 0,
              phase: "implement",
              startMs: start,
              endMs: start + 30 * 60_000,
            },
            {
              confidence: 1,
              costUsd: 5,
              inputTokens: 500,
              outputTokens: 0,
              phase: "review",
              startMs: start + 30 * 60_000,
              endMs: start + 60 * 60_000,
            },
          ],
        }),
      ],
    });

    const ownerColumn = timelineOf(detail).columns[0];
    const phaseColumn = timelineOf(detail, BranchTimelineGrouping.ActivityPhase)
      .columns[0];

    expect(ownerColumn?.total).toBe(10);
    expect(phaseColumn?.total).toBe(ownerColumn?.total);
    expect(phaseColumn?.segments.map((segment) => segment.label)).toEqual([
      "Implement",
      "Review",
    ]);
    expect(phaseColumn?.segments.map((segment) => segment.owner)).toEqual([
      null,
      null,
    ]);
    expect(phaseColumn?.segments.map((segment) => segment.value)).toEqual([
      5, 5,
    ]);
  });

  it("uses priced activity phase evidence instead of elapsed duration", () => {
    const start = Date.parse("2026-06-10T10:00:00.000Z");
    const detail = makeBranchDetail({
      estimatedCostUsd: 10,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 10,
          inputTokens: 1000,
          ownerUserName: "Cosimo",
          activitySegments: [
            {
              confidence: 1,
              costUsd: 1,
              inputTokens: 100,
              outputTokens: 0,
              phase: "implement",
              startMs: start,
              endMs: start + 50 * 60_000,
            },
            {
              confidence: 1,
              costUsd: 9,
              inputTokens: 900,
              outputTokens: 0,
              phase: "review",
              startMs: start + 50 * 60_000,
              endMs: start + 60 * 60_000,
            },
          ],
        }),
      ],
    });

    const phaseColumn = timelineOf(detail, BranchTimelineGrouping.ActivityPhase)
      .columns[0];

    expect(phaseColumn?.total).toBe(10);
    expect(phaseColumn?.segments.map((segment) => segment.label)).toEqual([
      "Implement",
      "Review",
    ]);
    expect(phaseColumn?.segments.map((segment) => segment.value)).toEqual([
      1, 9,
    ]);
    expect(phaseColumn?.segments.map((segment) => segment.input)).toEqual([
      100, 900,
    ]);
  });

  it("does not add duration fallback to a metric that already has phase evidence", () => {
    const start = Date.parse("2026-06-10T10:00:00.000Z");
    const detail = makeBranchDetail({
      estimatedCostUsd: 10,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 10,
          inputTokens: 1000,
          ownerUserName: "Cosimo",
          activitySegments: [
            {
              confidence: 1,
              costUsd: 1,
              inputTokens: 100,
              outputTokens: 0,
              phase: "implement",
              startMs: start,
              endMs: start + 40 * 60_000,
            },
            {
              confidence: 1,
              costUsd: 9,
              inputTokens: 900,
              outputTokens: 0,
              phase: "review",
              startMs: start + 40 * 60_000,
              endMs: start + 50 * 60_000,
            },
          ],
        }),
      ],
    });

    const phaseColumn = timelineOf(detail, BranchTimelineGrouping.ActivityPhase)
      .columns[0];
    const segmentValues =
      phaseColumn?.segments.map((segment) => segment.value) ?? [];

    expect(phaseColumn?.total).toBe(10);
    expect(phaseColumn?.segments.map((segment) => segment.label)).toEqual([
      "Implement",
      "Review",
    ]);
    expect(segmentValues).toEqual([1, 9]);
    expect(segmentValues.reduce((total, value) => total + value, 0)).toBe(10);
  });

  it("scales priced activity phase evidence to the branch's even-split session share", () => {
    const start = Date.parse("2026-06-10T10:00:00.000Z");
    const detail = makeBranchDetail({
      estimatedCostUsd: 5,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 10,
          evenSplitCostUsd: 5,
          ownerUserName: "Cosimo",
          activitySegments: [
            {
              confidence: 1,
              costUsd: 1,
              inputTokens: 100,
              outputTokens: 0,
              phase: "implement",
              startMs: start,
              endMs: start + 50 * 60_000,
            },
            {
              confidence: 1,
              costUsd: 9,
              inputTokens: 900,
              outputTokens: 0,
              phase: "review",
              startMs: start + 50 * 60_000,
              endMs: start + 60 * 60_000,
            },
          ],
        }),
      ],
    });

    const phaseColumn = timelineOf(detail, BranchTimelineGrouping.ActivityPhase)
      .columns[0];

    expect(phaseColumn?.total).toBe(5);
    expect(phaseColumn?.segments.map((segment) => segment.value)).toEqual([
      0.5, 4.5,
    ]);
  });

  it("uses the server's per-session even-split share (mixed branch counts) so bars match the header exactly", () => {
    // Thread 1 (PRRT_kwDOQ4gDpM6TAbzr): the server even-splits PER SESSION (full
    // cost ÷ that session's OWN branch count), NOT with one branch-wide ratio.
    // Session s1: $100 full, 1 branch → $100 share. Session s2: $100 full, shared
    // across 4 branches → $25 share. The server-matching branch even-split total is
    // $125. A single branch-wide scale (125/200 = 0.625) would wrongly attribute
    // $62.50 each; the per-session shares stamped by the server must be used, so
    // Cosimo keeps $100 and Tamsin $25 and the bars sum to the header $125.
    const detail = makeBranchDetail({
      estimatedCostUsd: 125,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 100,
          evenSplitCostUsd: 100, // 100 / 1 branch
          ownerUserName: "Cosimo",
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 100,
          evenSplitCostUsd: 25, // 100 / 4 branches
          ownerUserName: "Tamsin",
        }),
      ],
    });
    const { columns } = timelineOf(detail);
    expect(columns).toHaveLength(1);
    expect(columns[0]?.segments.map((s) => [s.owner, s.value])).toEqual([
      ["Cosimo", 100],
      ["Tamsin", 25],
    ]);
    // Cost conservation: bars sum to the header even-split cost stat, to the cent.
    expect(columns[0]?.total).toBe(125);
    const summed = columns
      .flatMap((column) => column.segments)
      .reduce((total, segment) => total + segment.value, 0);
    expect(Math.round(summed * 100) / 100).toBe(detail.estimatedCostUsd);
  });

  it("scales only the unstamped residual when per-session shares are mixed", () => {
    const detail = makeBranchDetail({
      attributedCostUsd: 15,
      estimatedCostUsd: 20,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 10,
          evenSplitCostUsd: 10,
          ownerUserName: "Cosimo",
        }),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 10,
          ownerUserName: "Tamsin",
        }),
      ],
    });
    const { columns } = timelineOf(detail);
    expect(columns[0]?.segments.map((s) => [s.owner, s.value])).toEqual([
      ["Cosimo", 10],
      ["Tamsin", 5],
    ]);
    expect(columns[0]?.total).toBe(15);
  });

  it("prefers the per-session even-split share over the branch-wide fallback scale", () => {
    // With a per-session share present, the branch-wide scale must NOT be applied
    // on top of it (that would double-discount). Header $30, one session whose
    // even-split share is already $30 (full $30, 1 branch): the bar is exactly $30.
    const detail = makeBranchDetail({
      attributedCostUsd: 30,
      estimatedCostUsd: 120,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 30,
          evenSplitCostUsd: 30,
          ownerUserName: "Cosimo",
        }),
      ],
    });
    const { columns } = timelineOf(detail);
    expect(columns[0]?.total).toBe(30);
  });

  it("does NOT double-count cost when a branch carries DUPLICATE session rows", () => {
    // Thread 2 (PRRT_kwDOQ4gDpM6TAb0t): a session artifact can be pushed onto a
    // branch's `sessions` more than once (one row per link). The divisor dedups by
    // id, so the accumulation MUST dedup too — otherwise the duplicated session's
    // spend is counted N times in the bars. Here s1 appears TWICE (identical rows);
    // its $10 must be attributed ONCE, not $20.
    const dup = {
      sessionId: "s1",
      startedAt: "2026-06-10T10:00:00.000Z",
      endedAt: "2026-06-10T11:00:00.000Z",
      estimatedCostUsd: 10,
      ownerUserName: "Cosimo",
    } as const;
    const detail = makeBranchDetail({
      // Even-split header is the deduped $10 (single branch), so the bars must
      // reconcile to $10 — a double-count would show $20.
      estimatedCostUsd: 10,
      sessions: [makeBranchSession(dup), makeBranchSession(dup)],
    });
    const { columns } = timelineOf(detail);
    expect(columns).toHaveLength(1);
    expect(columns[0]?.segments).toHaveLength(1);
    expect(columns[0]?.segments[0]?.owner).toBe("Cosimo");
    expect(columns[0]?.segments[0]?.value).toBe(10);
    expect(columns[0]?.total).toBe(10);
    const summed = columns
      .flatMap((column) => column.segments)
      .reduce((total, segment) => total + segment.value, 0);
    expect(summed).toBe(10);
  });

  it("dedups duplicate per-session even-split rows (numerator uses the same deduped set as the header)", () => {
    // Duplicate rows also carry the same per-session even-split share; summing them
    // would over-attribute. s1 (share $25, shared 4 branches) appears twice, s2
    // (share $100, single branch) once. Server even-split header = 25 + 100 = 125.
    // The bars must sum to $125, NOT 25 + 25 + 100.
    const s1 = {
      sessionId: "s1",
      startedAt: "2026-06-10T10:00:00.000Z",
      endedAt: "2026-06-10T11:00:00.000Z",
      estimatedCostUsd: 100,
      evenSplitCostUsd: 25,
      ownerUserName: "Tamsin",
    } as const;
    const detail = makeBranchDetail({
      estimatedCostUsd: 125,
      sessions: [
        makeBranchSession(s1),
        makeBranchSession(s1),
        makeBranchSession({
          sessionId: "s2",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 100,
          evenSplitCostUsd: 100,
          ownerUserName: "Cosimo",
        }),
      ],
    });
    const { columns } = timelineOf(detail);
    const summed = columns
      .flatMap((column) => column.segments)
      .reduce((total, segment) => total + segment.value, 0);
    expect(Math.round(summed * 100) / 100).toBe(detail.estimatedCostUsd);
    // Tamsin's duplicated session is counted once ($25), not twice ($50).
    const tamsin = columns
      .flatMap((column) => column.segments)
      .filter((segment) => segment.owner === "Tamsin")
      .reduce((total, segment) => total + segment.value, 0);
    expect(Math.round(tamsin * 100) / 100).toBe(25);
  });

  it("retains loaded non-bucketable Session identity and reconciles chartable cost", () => {
    const detail = makeBranchDetail({
      estimatedCostUsd: 12,
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          slug: "SES-1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T11:00:00.000Z",
          estimatedCostUsd: 5,
        }),
        makeBranchSession({
          sessionId: "s2",
          slug: "SES-2",
          startedAt: "2026-06-10T12:00:00.000Z",
          endedAt: "2026-06-10T12:00:00.000Z",
          estimatedCostUsd: 7,
        }),
      ],
    });

    const timeline = timelineOf(detail);

    expect(timeline.chartableCostUsd).toBe(5);
    expect(
      timeline.columns.reduce((total, column) => total + column.total, 0)
    ).toBe(5);
    expect(timeline.nonBucketableSessions).toEqual([
      {
        name: null,
        navigableRef: undefined,
        sessionId: "s2",
        slug: "SES-2",
      },
    ]);
    expect(timeline.distinctSessionCount).toBe(2);
  });

  it("reconciles chartable cost and identifies Sessions truncated by the global span cap", () => {
    const timeline = timelineOf(
      makeBranchDetail({
        estimatedCostUsd: 12,
        sessions: [
          makeBranchSession({
            sessionId: "early",
            startedAt: "2026-01-01T10:00:00.000Z",
            endedAt: "2026-01-01T11:00:00.000Z",
            estimatedCostUsd: 5,
          }),
          makeBranchSession({
            sessionId: "late",
            startedAt: "2026-05-01T10:00:00.000Z",
            endedAt: "2026-05-01T11:00:00.000Z",
            estimatedCostUsd: 7,
          }),
        ],
      })
    );
    const renderedCost = timeline.columns.reduce(
      (total, column) => total + column.total,
      0
    );

    expect(timeline.chartableCostUsd).toBe(5);
    expect(timeline.chartableCostUsd).toBe(renderedCost);
    expect(
      timeline.truncatedSessions.map((session) => session.sessionId)
    ).toEqual(["late"]);
    expect(timeline.nonBucketableSessions).toEqual([]);
  });

  it("retains known rendered cost when one owner-hour also has unpriced activity", () => {
    const timeline = timelineOf(
      makeBranchDetail({
        estimatedCostUsd: 8,
        sessions: [
          makeBranchSession({
            sessionId: "priced",
            startedAt: "2026-06-10T10:00:00.000Z",
            endedAt: "2026-06-10T11:00:00.000Z",
            estimatedCostUsd: 5,
            evenSplitCostUsd: 5,
            ownerUserName: "Cosimo",
          }),
          makeBranchSession({
            sessionId: "unpriced",
            startedAt: "2026-06-10T10:00:00.000Z",
            endedAt: "2026-06-10T11:00:00.000Z",
            estimatedCostUsd: null,
            ownerUserName: "Cosimo",
          }),
          makeBranchSession({
            sessionId: "untimed",
            startedAt: "2026-06-10T12:00:00.000Z",
            endedAt: "2026-06-10T12:00:00.000Z",
            estimatedCostUsd: 3,
          }),
        ],
      })
    );

    expect(timeline.chartableCostUsd).toBe(5);
    expect(timeline.columns[0]?.segments[0]).toEqual(
      expect.objectContaining({
        costUnavailable: true,
        hasKnownCost: true,
        value: 5,
      })
    );
  });

  it("does not fabricate a zero chartable cost when no loaded Session is bucketable", () => {
    const instant = "2026-06-10T10:00:00.000Z";
    const timeline = timelineOf(
      makeBranchDetail({
        estimatedCostUsd: 9,
        sessions: [
          makeBranchSession({
            sessionId: "s1",
            slug: "SES-1",
            startedAt: instant,
            endedAt: instant,
            estimatedCostUsd: 9,
          }),
        ],
      })
    );

    expect(timeline.columns).toEqual([]);
    expect(timeline.chartableCostUsd).toBeNull();
    expect(
      timeline.nonBucketableSessions.map((session) => session.slug)
    ).toEqual(["SES-1"]);
  });

  it("returns an empty timeline when there are no sessions", () => {
    const { chartableCostUsd, columns, startMs } = timelineOf(
      makeBranchDetail({ sessions: [] })
    );
    expect(columns).toEqual([]);
    expect(startMs).toBeNull();
    expect(chartableCostUsd).toBeNull();
  });
});

function sessionActorIdentity(
  session: ReturnType<typeof makeBranchSession>
): string | null {
  const label = session.ownerUserName?.trim();
  return (
    session.ownerUserId?.trim() ||
    (label ? `legacy:${label.toLocaleLowerCase()}` : null)
  );
}
