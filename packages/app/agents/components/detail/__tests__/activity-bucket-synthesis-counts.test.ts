import type { TurnItem } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { getBucketCost } from "../activity-bucket-rendering";
import { buildActivityBuckets } from "../activity-bucket-synthesis";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";

/**
 * ISS-5566 review: a SYNTHESIZED bucket must count the same population the
 * MEASURED producer counts — tool CALLS, not folded tool RUNS.
 *
 * `buildToolsTurn` (packages/lib/sessions/agent-session-detail-projection.ts)
 * collapses a consecutive run of tool-like timeline events into ONE
 * `type: "tools"` TurnItem carrying `items: ToolItem[]`. The measured producer
 * (apps/desktop/src/main/database/session-trace.ts) walks the RAW timeline rows
 * and increments `total`/`toolStart` once per row. So counting turn ROWS during
 * synthesis put the two strips on different populations, with two consequences
 * this file pins:
 *
 *   - the READOUT — with the disclosure on, `{total} events | {toolStart} tool
 *     calls` is the only quantitative content left on a synthesized bucket, and
 *     it reported a run count under a label that means calls; and
 *   - the SHAPE — the bar weight is `total + toolStart * 3`, so one folded run
 *     of five calls scored `1 + 3 = 4` against three separate single-call runs'
 *     `3 + 9 = 12`, ranking the busier slice BELOW the quieter one.
 *
 * The fixture is built so both claims have a discriminator: bucket 0 holds ONE
 * folded run of five calls, bucket 1 holds THREE separate single-call runs.
 * Under the old counting bucket 0 lost on both counts; under the corrected one
 * it wins on both.
 */

const STARTED_AT = "2026-06-10T12:00:00.000Z";
const ENDED_AT = "2026-06-10T12:20:00.000Z";
const WINDOW = {
  endMs: Date.parse(ENDED_AT),
  startMs: Date.parse(STARTED_AT),
};

const ACTOR = {
  color: "var(--primary)",
  harness: "codex",
  human: null,
  name: "gpt-5.5",
  sessionId: "session-iss-5566-counts",
};

/**
 * One `type: "tools"` turn standing for `callCount` raw timeline events — the
 * shape `buildToolsTurn` emits when that many tool-like events landed back to
 * back.
 */
function foldedToolsRow(row: number, at: string, callCount: number): TurnItem {
  return {
    _row: row,
    actor: ACTOR,
    cats: { tool: callCount },
    cum: 0,
    endMs: Date.parse(at) + 1000,
    failN: 0,
    hasFail: false,
    items: Array.from({ length: callCount }, (_, callIndex) => ({
      detail: `call ${row}-${callIndex}`,
      err: false,
      label: "rg",
    })),
    summary: `Ran ${callCount} tools at turn ${row}`,
    t: at,
    tMs: Date.parse(at),
    type: "tools",
  };
}

/**
 * A 20-minute window with four rows: one five-call run in the first five-minute
 * slice, three single-call runs in the second. `getFallbackBucketCount` returns
 * `min(16, max(4, 4)) = 4` buckets over this span, so the two groups land in
 * bucket 0 and bucket 1 and nothing else competes with them.
 */
function synthesizedSession() {
  return createAgentSessionDetailFixture({
    activityBuckets: [],
    endedAt: new Date(ENDED_AT),
    estimatedCost: 4.82,
    markers: [],
    startedAt: new Date(STARTED_AT),
    turnItems: [
      foldedToolsRow(0, "2026-06-10T12:01:00.000Z", 5),
      foldedToolsRow(1, "2026-06-10T12:06:00.000Z", 1),
      foldedToolsRow(2, "2026-06-10T12:07:00.000Z", 1),
      foldedToolsRow(3, "2026-06-10T12:08:00.000Z", 1),
    ],
  });
}

describe("synthesized activity buckets count tool CALLS, not folded runs", () => {
  it("reports the folded run's five calls, not one", () => {
    const strip = buildActivityBuckets(synthesizedSession(), [], WINDOW);

    expect(strip.synthesized).toBe(true);
    const [foldedRun, separateRuns] = strip.buckets;

    // The tooltip's whole quantitative content on a synthesized bucket.
    expect(foldedRun.toolStart).toBe(5);
    expect(foldedRun.total).toBe(5);

    // The neighbouring slice is unfolded already, so it is unchanged — which is
    // what makes the pair a discriminator rather than a uniform rescale.
    expect(separateRuns.toolStart).toBe(3);
    expect(separateRuns.total).toBe(3);
  });

  it("ranks the busier slice taller, which the run count inverted", () => {
    const strip = buildActivityBuckets(synthesizedSession(), [], WINDOW);
    const [foldedRun, separateRuns] = strip.buckets;

    // Weight is `total + toolStart * 3`: 5+15=20 against 3+9=12. Counting runs
    // gave 1+3=4 against 3+9=12 and drew the five-call slice SHORTER.
    expect(getBucketCost(foldedRun)).toBeGreaterThan(
      getBucketCost(separateRuns)
    );
  });

  it("counts calls on the untimed even-bucket fallback too", () => {
    // No `t`/`tMs` anywhere, so `hasTimedTraceRow` rejects every row and
    // `buildEvenActivityBuckets` runs instead. It folded runs the same way.
    const untimedRun = {
      actor: ACTOR,
      cats: { tool: 4 },
      cum: 0,
      failN: 0,
      hasFail: false,
      items: Array.from({ length: 4 }, (_, callIndex) => ({
        detail: `call ${callIndex}`,
        err: false,
        label: "rg",
      })),
      summary: "Ran 4 tools",
      type: "tools",
    } as unknown as TurnItem;

    const strip = buildActivityBuckets(
      createAgentSessionDetailFixture({
        activityBuckets: [],
        endedAt: new Date(ENDED_AT),
        estimatedCost: 4.82,
        markers: [],
        startedAt: new Date(STARTED_AT),
        turnItems: [untimedRun],
      }),
      [],
      null
    );

    expect(strip.synthesized).toBe(true);
    const busy = strip.buckets.filter((entry) => entry.total > 0);
    expect(busy).toHaveLength(1);
    expect(busy[0].toolStart).toBe(4);
    expect(busy[0].total).toBe(4);
  });
});
