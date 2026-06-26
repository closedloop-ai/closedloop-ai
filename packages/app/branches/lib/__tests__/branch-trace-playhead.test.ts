import { readFileSync } from "node:fs";
import type { MergedTraceItem } from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import {
  buildTraceTimeIndex,
  nearestRowForTimestamp,
  nearestTimestampForRow,
  truncateToHourIso,
} from "../branch-trace-playhead";

function sayItem(t: string): MergedTraceItem {
  return {
    type: "say",
    sessionId: "s1",
    t,
    tMs: 0,
    cumCostUsd: null,
    actorName: "alice",
    text: "x",
  };
}

const items: MergedTraceItem[] = [
  sayItem("2026-06-10T10:00:00.000Z"),
  sayItem("2026-06-10T10:30:00.000Z"),
  sayItem("2026-06-10T11:00:00.000Z"),
  { type: "end", sessionId: "s1", text: "done" }, // no `t` → excluded
];

describe("buildTraceTimeIndex", () => {
  it("indexes only items with a parseable timestamp, sorted by time", () => {
    const index = buildTraceTimeIndex(items);
    expect(index.map((entry) => entry.row)).toEqual([0, 1, 2]);
    expect(index.find((entry) => entry.row === 3)).toBeUndefined();
  });
});

describe("nearestRowForTimestamp", () => {
  const index = buildTraceTimeIndex(items);

  it("returns the row with the minimum absolute time delta", () => {
    // 10:20 is closer to 10:30 (row 1) than 10:00 (row 0).
    expect(nearestRowForTimestamp(index, "2026-06-10T10:20:00.000Z")).toBe(1);
  });

  it("clamps before the first and after the last entry", () => {
    expect(nearestRowForTimestamp(index, "2026-06-10T08:00:00.000Z")).toBe(0);
    expect(nearestRowForTimestamp(index, "2026-06-10T23:00:00.000Z")).toBe(2);
  });

  it("returns null for an empty index or an unparseable timestamp", () => {
    expect(nearestRowForTimestamp([], "2026-06-10T10:00:00.000Z")).toBeNull();
    expect(nearestRowForTimestamp(index, "not-a-date")).toBeNull();
  });
});

describe("nearestTimestampForRow", () => {
  const index = buildTraceTimeIndex(items);

  it("returns the indexed row's timestamp, null when the row is absent", () => {
    expect(nearestTimestampForRow(index, 1)).toBe("2026-06-10T10:30:00.000Z");
    expect(nearestTimestampForRow(index, 3)).toBeNull();
  });
});

describe("truncateToHourIso", () => {
  it("truncates to the hour and passes through null/invalid", () => {
    expect(truncateToHourIso("2026-06-10T10:37:12.000Z")).toBe(
      "2026-06-10T10:00:00.000Z"
    );
    expect(truncateToHourIso(null)).toBeNull();
    expect(truncateToHourIso("nope")).toBeNull();
  });
});

describe("timeline↔trace decoupling (architecture)", () => {
  const read = (relative: string) =>
    readFileSync(new URL(relative, import.meta.url), "utf8");

  it("E1 timeline does not import the trace/playhead modules", () => {
    const timeline = read("../../components/branch-pr-activity-timeline.tsx");
    expect(timeline).not.toContain("branch-trace-playhead");
    expect(timeline).not.toContain("session-trace");
  });

  it("the playhead scrubber does not import the timeline", () => {
    const playhead = read("../../components/branch-trace-playhead.tsx");
    expect(playhead).not.toContain("branch-pr-activity-timeline");
  });
});
