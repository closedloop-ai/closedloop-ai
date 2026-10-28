import { describe, expect, it } from "vitest";
import {
  packTimelineMarkers,
  type TimelineMarkerInput,
} from "../timeline-marker-packing";
import { TimelineMarkerSemantic } from "../timeline-marker-semantics";

type Payload = { name: string };

describe("packTimelineMarkers", () => {
  it("reuses a lane for same-hour markers whose rendered hit targets do not overlap", () => {
    const result = packTimelineMarkers(
      [
        marker("a", "2026-06-10T10:05:00.000Z", 10),
        marker("b", "2026-06-10T10:15:00.000Z", 40),
      ],
      { railWidthPx: 320 }
    );

    expect(result.entries).toMatchObject([
      { id: "a", kind: "direct", laneIndex: 0, topPx: 0 },
      { id: "b", kind: "direct", laneIndex: 0, topPx: 0 },
    ]);
    expect(result.railHeightPx).toBe(24);
  });

  it("reuses a lane when rendered hit targets touch but do not overlap", () => {
    const result = packTimelineMarkers(
      [
        marker("a", "2026-06-10T10:00:00.000Z", 10),
        marker("b", "2026-06-10T10:01:00.000Z", 17.5),
      ],
      { railWidthPx: 320 }
    );

    expect(result.entries).toMatchObject([
      { id: "a", laneIndex: 0, topPx: 0 },
      { id: "b", laneIndex: 0, topPx: 0 },
    ]);
  });

  it("clusters default Branch markers when rendered hit targets overlap", () => {
    const result = packTimelineMarkers(
      [
        marker("a", "2026-06-10T10:00:00.000Z", 10),
        marker("b", "2026-06-10T10:01:00.000Z", 17.49),
      ],
      { railWidthPx: 320 }
    );

    expect(result.entries).toMatchObject([
      { id: "cluster-a-b", kind: "cluster", laneIndex: 0, topPx: 0 },
    ]);
    expect(result.railHeightPx).toBe(24);
  });

  it("keeps one visible row by clustering exact-collision Branch events", () => {
    const result = packTimelineMarkers(
      [
        marker("a", "2026-06-10T10:00:00.000Z", 50),
        marker("b", "2026-06-10T10:00:00.000Z", 50),
        marker("c", "2026-06-10T10:00:00.000Z", 50),
      ],
      { railWidthPx: 320 }
    );

    expect(result.entries).toMatchObject([
      { id: "cluster-a-b-c", kind: "cluster", laneIndex: 0 },
    ]);
    expect(result.railHeightPx).toBe(24);
  });

  it("clusters dense Branch events instead of growing rows", () => {
    const result = packTimelineMarkers(
      [
        marker("a", "2026-06-10T10:00:00.000Z", 50),
        marker("b", "2026-06-10T10:00:00.000Z", 50),
        marker("c", "2026-06-10T10:00:00.000Z", 50),
        marker("d", "2026-06-10T10:00:00.000Z", 50),
      ],
      { railWidthPx: 320 }
    );

    expect(result.entries).toMatchObject([
      { id: "cluster-a-b-c-d", kind: "cluster", laneIndex: 0 },
    ]);
    expect(result.entries[0]?.kind).toBe("cluster");
    if (result.entries[0]?.kind === "cluster") {
      expect(result.entries[0].items.map((item) => item.id)).toEqual([
        "a",
        "b",
        "c",
        "d",
      ]);
    }
    expect(result.railHeightPx).toBe(24);
  });

  it("uses bounded semantic rows for different-category collisions", () => {
    const result = packTimelineMarkers(
      [
        marker("a", "2026-06-10T10:00:00.000Z", 50),
        marker("b", "2026-06-10T10:00:00.000Z", 50, {
          semantic: TimelineMarkerSemantic.Delivery,
        }),
        marker("c", "2026-06-10T10:00:00.000Z", 50, {
          semantic: TimelineMarkerSemantic.FailureLimit,
        }),
      ],
      { railWidthPx: 320 }
    );

    expect(result.entries).toMatchObject([
      { id: "a", kind: "direct", laneIndex: 0 },
      { id: "b", kind: "direct", laneIndex: 1 },
      { id: "c", kind: "direct", laneIndex: 2 },
    ]);
    expect(result.railHeightPx).toBe(72);
  });

  it("orders equal-time markers by semantic, row, and stable identity", () => {
    const result = packTimelineMarkers(
      [
        marker("fail", "2026-06-10T10:00:00.000Z", 50, {
          row: 2,
          semantic: TimelineMarkerSemantic.FailureLimit,
        }),
        marker("delivery", "2026-06-10T10:00:00.000Z", 50, {
          row: null,
          semantic: TimelineMarkerSemantic.Delivery,
        }),
        marker("steer-row-5", "2026-06-10T10:00:00.000Z", 50, {
          row: 5,
          semantic: TimelineMarkerSemantic.HumanSteering,
        }),
        marker("steer-row-1", "2026-06-10T10:00:00.000Z", 50, {
          row: 1,
          semantic: TimelineMarkerSemantic.HumanSteering,
        }),
      ],
      { railWidthPx: 320 }
    );

    expect(result.entries.map((entry) => entry.id)).toEqual([
      "cluster-steer-row-1-steer-row-5",
      "delivery",
      "fail",
    ]);
    const cluster = result.entries[0];
    expect(cluster?.kind).toBe("cluster");
    if (cluster?.kind === "cluster") {
      expect(cluster.items.map((item) => item.id)).toEqual([
        "steer-row-1",
        "steer-row-5",
      ]);
    }
  });

  it("orders equal-time lifecycle markers by source order before stable identity", () => {
    const result = packTimelineMarkers(
      [
        marker("opened", "2026-06-10T10:00:00.000Z", 50, {
          row: null,
          semantic: TimelineMarkerSemantic.Delivery,
          sourceOrder: 2,
          stableOrderKey: "A-label-sorts-first",
        }),
        marker("closed", "2026-06-10T10:00:00.000Z", 50, {
          row: null,
          semantic: TimelineMarkerSemantic.Delivery,
          sourceOrder: 1,
          stableOrderKey: "Z-label-sorts-last",
        }),
      ],
      { railWidthPx: 320 }
    );

    expect(result.entries.map((entry) => entry.id)).toEqual([
      "cluster-closed-opened",
    ]);
    const cluster = result.entries[0];
    expect(cluster?.kind).toBe("cluster");
    if (cluster?.kind === "cluster") {
      expect(cluster.items.map((item) => item.id)).toEqual([
        "closed",
        "opened",
      ]);
    }
  });

  it("responds to rail width instead of same-hour buckets", () => {
    const items = [
      marker("a", "2026-06-10T10:00:00.000Z", 10),
      marker("b", "2026-06-10T10:01:00.000Z", 20),
    ];

    expect(
      packTimelineMarkers(items, { railWidthPx: 320 }).entries.map(
        (entry) => entry.laneIndex
      )
    ).toEqual([0, 0]);
    expect(
      packTimelineMarkers(items, { railWidthPx: 160 }).entries.map(
        (entry) => entry.id
      )
    ).toEqual(["cluster-a-b"]);
  });

  it("drops invalid timestamps and clamps positions to the rail", () => {
    const result = packTimelineMarkers(
      [
        marker("left", "2026-06-10T10:00:00.000Z", -12),
        marker("invalid", "not-a-date", 50),
        marker("right", "2026-06-10T10:02:00.000Z", 112),
      ],
      { railWidthPx: 320 }
    );

    expect(result.entries).toMatchObject([
      { id: "left", kind: "direct", leftPct: 0 },
      { id: "right", kind: "direct", leftPct: 100 },
    ]);
  });
});

function marker(
  id: string,
  t: string,
  leftPct: number,
  overrides: Partial<TimelineMarkerInput<Payload>> = {}
): TimelineMarkerInput<Payload> {
  return {
    id,
    label: id,
    leftPct,
    payload: { name: id },
    row: overrides.row ?? 0,
    semantic: overrides.semantic ?? TimelineMarkerSemantic.HumanSteering,
    sourceOrder: overrides.sourceOrder ?? 0,
    stableOrderKey: overrides.stableOrderKey ?? id,
    timeMs: Date.parse(t),
  };
}
