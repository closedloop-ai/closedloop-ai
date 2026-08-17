import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import { describe, expect, it } from "vitest";
import { reviveWithDates } from "../../../shared/api/revive-with-dates";
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

  it("extends the window to trace items that run past `endedAt`", () => {
    // The Branch-details shape: the session's own timestamps cover minutes, but
    // its trace items run for days. The timeline must span the trace, not the
    // session — which is only possible if the items are consumed at all.
    const bursts = computeBurstSpans({
      startedAt: SESSION_STARTED_AT,
      endedAt: SESSION_ENDED_AT,
      items: [say(LAST_TRACE_ITEM_AT)],
    });

    expect(bursts.at(-1)?.endT).toBe(LAST_TRACE_ITEM_AT);
  });
});

/**
 * ISS-5771 regression: the reviver must leave `MergedTraceItem.t` a `string`,
 * because the timeline's item guards are `typeof t === "string"`.
 *
 * This is the defect ISS-5771 un-masked on the Branch PR timeline. `t` is
 * declared `string`, but the old value-shape reviver turned every ISO-8601
 * string into a `Date` whatever its key — so `maxItemMs` (`branch-burst-spans`)
 * and `activeIdleSpans` (`branch-derivations`) rejected EVERY trace item, and
 * the timeline silently fell back to the session's own window while looking
 * perfectly plausible. Nothing crashed, which is why it survived where
 * `invokedAt` did not.
 *
 * Driving the real reviver here, rather than asserting a key list, is the point:
 * putting `t` back on the revival allowlist turns `t` into a `Date`, the guard
 * drops the item, and the window collapses to `endedAt` — failing this test
 * instead of quietly re-breaking the timeline.
 */
describe("trace-item timing survives the API client's date revival (ISS-5771)", () => {
  it("keeps `t` a string, so the item still moves the window", () => {
    const parsed = JSON.parse(
      JSON.stringify({ t: LAST_TRACE_ITEM_AT }),
      reviveWithDates
    ) as { t: string };

    expect(typeof parsed.t).toBe("string");

    const bursts = computeBurstSpans({
      startedAt: SESSION_STARTED_AT,
      endedAt: SESSION_ENDED_AT,
      items: [say(parsed.t)],
    });

    expect(bursts.at(-1)?.endT).toBe(LAST_TRACE_ITEM_AT);
  });

  it("collapses to the session window when `t` arrives as a Date", () => {
    // The pre-ISS-5771 runtime shape, pinned so the cost of reviving `t` is
    // visible rather than inferred: the item is discarded and the timeline
    // reports only the session's own minutes.
    const revived = new Date(LAST_TRACE_ITEM_AT) as unknown as string;

    const bursts = computeBurstSpans({
      startedAt: SESSION_STARTED_AT,
      endedAt: SESSION_ENDED_AT,
      items: [say(revived)],
    });

    expect(bursts.at(-1)?.endT).toBe(SESSION_ENDED_AT);
  });
});

/** The Branch-details fixture's shape: minutes of session, days of trace. */
const SESSION_STARTED_AT = "2026-07-30T09:00:00.000Z";
const SESSION_ENDED_AT = "2026-07-30T09:05:00.000Z";
const LAST_TRACE_ITEM_AT = "2026-08-01T12:00:00.000Z";
