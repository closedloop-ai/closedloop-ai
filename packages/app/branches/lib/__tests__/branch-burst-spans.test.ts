import type { MergedTraceItem } from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import { computeBurstSpans } from "../branch-burst-spans";

function say(t: string): MergedTraceItem {
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

describe("computeBurstSpans", () => {
  it("inverts idle spans into active bursts and flags the post-idle resumption", () => {
    // 10:01→10:30 is a 29-min idle gap (≥ 2-min default threshold).
    const items = [
      say("2026-06-10T10:00:00.000Z"),
      say("2026-06-10T10:01:00.000Z"),
      say("2026-06-10T10:30:00.000Z"),
      say("2026-06-10T10:31:00.000Z"),
    ];
    const bursts = computeBurstSpans({
      startedAt: "2026-06-10T10:00:00.000Z",
      endedAt: "2026-06-10T11:00:00.000Z",
      items,
    });
    expect(bursts).toHaveLength(2);
    expect(bursts[0]?.isResumption).toBe(false);
    expect(bursts[1]?.isResumption).toBe(true);
    expect(bursts[1]?.endT).toBe("2026-06-10T11:00:00.000Z");
  });

  it("degrades to a single full-window burst when there are no idle markers", () => {
    const bursts = computeBurstSpans({
      startedAt: "2026-06-10T10:00:00.000Z",
      endedAt: "2026-06-10T10:45:00.000Z",
      items: [],
    });
    expect(bursts).toEqual([
      {
        startT: "2026-06-10T10:00:00.000Z",
        endT: "2026-06-10T10:45:00.000Z",
        isResumption: false,
      },
    ]);
  });

  it("uses the last item time as the window end when the session is unmerged", () => {
    // Items 1 min apart stay active (< 2-min idle threshold) → one burst whose
    // end is the last item time, since there is no `endedAt`.
    const bursts = computeBurstSpans({
      startedAt: "2026-06-10T10:00:00.000Z",
      endedAt: null,
      items: [say("2026-06-10T10:00:00.000Z"), say("2026-06-10T10:01:00.000Z")],
    });
    expect(bursts).toHaveLength(1);
    expect(bursts[0]?.endT).toBe("2026-06-10T10:01:00.000Z");
  });

  it("returns no bursts for an unparseable start", () => {
    expect(
      computeBurstSpans({ startedAt: "nope", endedAt: null, items: [] })
    ).toEqual([]);
  });
});
