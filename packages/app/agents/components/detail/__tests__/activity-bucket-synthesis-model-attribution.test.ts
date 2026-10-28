import type {
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { UNKNOWN_MODEL_LABEL } from "@repo/app/agents/lib/session-timeline-stacks";
import { describe, expect, it } from "vitest";
import {
  type ActivityBucketStrip,
  buildActivityBuckets,
} from "../activity-bucket-synthesis";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";

/**
 * ISS-5634: the per-model split on a SYNTHESIZED bucket must not name a model
 * the record does not support.
 *
 * The key it is built under is read verbatim by two surfaces — the hover card's
 * `model` column (`activity-bucket-tooltip`) and the "Group by: Model" cut
 * (`buildModelStack`) — so a placeholder there is presented to the reader as a
 * model name. Two shapes reached that column before this fix:
 *
 *   - the ISS-5572 errored-turn-one session (`model: null`, no primary), which
 *     printed the literal word `model`; and
 *   - a multi-model session, whose primary was handed 100% of every bucket
 *     while `tokenUsageByModel` on the same page said otherwise.
 *
 * Both now resolve to `UNKNOWN_MODEL_LABEL`. The single-model case is unchanged
 * — one model ran, so naming it is backed by the record.
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
  sessionId: "session-iss-5634",
};

const UNRESOLVED_MODEL = {
  model: null,
  models: [],
  primaryModel: null,
  tokenUsageByModel: [],
} satisfies Partial<AgentSessionDetail>;

function timedRow(row: number, at: string): TurnItem {
  return {
    _row: row,
    actor: ACTOR,
    cats: { tool: 1 },
    cum: 0,
    endMs: Date.parse(at) + 1000,
    failN: 0,
    hasFail: false,
    items: [{ detail: `call ${row}`, err: false, label: "rg" }],
    summary: `Ran a tool at turn ${row}`,
    t: at,
    tMs: Date.parse(at),
    type: "tools",
  };
}

/**
 * The two `TurnItem` variants that genuinely carry no `_row`/`t`, so
 * `hasTimedTraceRow` rejects both and `buildEvenActivityBuckets` runs.
 *
 * Review (whitlockk): this was a `tools` row cast past the compiler with its
 * `_row`/`t`/`tMs`/`endMs` removed — a shape the union forbids, so the case
 * proved nothing about a reachable path. `idle` and `end` reach the even-bucket
 * fallback without a cast.
 */
const UNTIMED_ROWS: TurnItem[] = [
  { gap: 90_000, type: "idle" },
  { text: "Session ended", type: "end" },
];

/** `buildEvenActivityBuckets`'s key prefix; the timed builder writes `time-`. */
const EVEN_BUCKET_KEY_RE = /^even-/;

function synthesizedSession(
  overrides: Partial<AgentSessionDetail>
): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    activityBuckets: [],
    endedAt: new Date(ENDED_AT),
    estimatedCost: 4.82,
    markers: [],
    startedAt: new Date(STARTED_AT),
    turnItems: [
      timedRow(0, "2026-06-10T12:01:00.000Z"),
      timedRow(1, "2026-06-10T12:06:00.000Z"),
    ],
    ...overrides,
  });
}

/** The keys the hover card and the Model cut would print, deduped. */
function pricedModelKeys(strip: ActivityBucketStrip): string[] {
  const keys = new Set<string>();
  for (const bucket of strip.buckets) {
    for (const model of Object.keys(bucket.byModel)) {
      keys.add(model);
    }
  }
  return [...keys];
}

describe("synthesized activity buckets name a model only when the record does", () => {
  it("builds the fallback strip these cases are about", () => {
    // Guards the rest of the file: with persisted `activityBuckets` the keys
    // would come from the measured producer and prove nothing about synthesis.
    expect(
      buildActivityBuckets(synthesizedSession(UNRESOLVED_MODEL), [], WINDOW)
        .synthesized
    ).toBe(true);
  });

  it("carries an unresolved model as the unknown label, not the word 'model'", () => {
    const keys = pricedModelKeys(
      buildActivityBuckets(synthesizedSession(UNRESOLVED_MODEL), [], WINDOW)
    );

    expect(keys).toEqual([UNKNOWN_MODEL_LABEL]);
    // The exact placeholder that used to sit under the `model` header.
    expect(keys).not.toContain("model");
  });

  it("withholds the model on a multi-model session rather than hand it all to the primary", () => {
    const keys = pricedModelKeys(
      buildActivityBuckets(
        synthesizedSession({
          model: "claude-opus-5",
          models: ["claude-opus-5", "claude-haiku-4-5"],
          primaryModel: "claude-opus-5",
          tokenUsageByModel: [
            {
              cacheReadTokens: 900,
              cacheWriteTokens: 400,
              estimatedCostUsd: 4,
              inputTokens: 12_000,
              model: "claude-opus-5",
              outputTokens: 3200,
            },
            {
              cacheReadTokens: 10,
              cacheWriteTokens: 5,
              estimatedCostUsd: 0.82,
              inputTokens: 800,
              model: "claude-haiku-4-5",
              outputTokens: 120,
            },
          ],
        }),
        [],
        WINDOW
      )
    );

    expect(keys).toEqual([UNKNOWN_MODEL_LABEL]);
    expect(keys).not.toContain("claude-opus-5");
  });

  it("never keys the split on a blank model name", () => {
    // A blank key renders an unlabelled segment and an empty `model` cell —
    // the same failure as the placeholder, minus the word. `??` does not catch
    // it, so the guard is explicit. Reachable where a producer writes an empty
    // model on a session whose own model never resolved.
    const keys = pricedModelKeys(
      buildActivityBuckets(
        synthesizedSession({
          model: "",
          models: [],
          primaryModel: "  ",
          tokenUsageByModel: [
            {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCostUsd: 1.2,
              inputTokens: 500,
              model: "",
              outputTokens: 90,
            },
          ],
        }),
        [],
        WINDOW
      )
    );

    expect(keys).toEqual([UNKNOWN_MODEL_LABEL]);
  });

  it("keeps a billed-but-unnamed row as ambiguity beside a named billed model", () => {
    // ISS-5634 review (whitlockk): the blank row is BILLED, so its spend is real and
    // unattributed. Dropping it before the cardinality check left one named
    // model standing, and every bucket then handed that model 100% of a total
    // it did not earn — a manufactured attribution, not a narrower answer.
    const keys = pricedModelKeys(
      buildActivityBuckets(
        synthesizedSession({
          model: "claude-opus-5",
          models: ["claude-opus-5"],
          primaryModel: "claude-opus-5",
          tokenUsageByModel: [
            {
              cacheReadTokens: 900,
              cacheWriteTokens: 400,
              estimatedCostUsd: 4,
              inputTokens: 12_000,
              model: "claude-opus-5",
              outputTokens: 3200,
            },
            {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCostUsd: 0.82,
              inputTokens: 800,
              model: "  ",
              outputTokens: 120,
            },
          ],
        }),
        [],
        WINDOW
      )
    );

    expect(keys).toEqual([UNKNOWN_MODEL_LABEL]);
    expect(keys).not.toContain("claude-opus-5");
  });

  it("does not hand a billed-but-unnamed row to a known primary model", () => {
    // The sibling shape: with no NAMED billed row the set is empty, so the blank
    // row used to fall past the cardinality check into `primaryModel`. Nothing
    // ties that column to the spend — the strip would name a model the usage
    // table never billed.
    const keys = pricedModelKeys(
      buildActivityBuckets(
        synthesizedSession({
          model: "claude-opus-5",
          models: ["claude-opus-5"],
          primaryModel: "claude-opus-5",
          tokenUsageByModel: [
            {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCostUsd: 1.2,
              inputTokens: 500,
              model: "",
              outputTokens: 90,
            },
          ],
        }),
        [],
        WINDOW
      )
    );

    expect(keys).toEqual([UNKNOWN_MODEL_LABEL]);
    expect(keys).not.toContain("claude-opus-5");
  });

  it("ignores a model that billed nothing when counting how many ran", () => {
    // Counting by presence let an empty usage row — one a producer can upsert
    // before any tokens land — withhold the name from the model that did all
    // the spending.
    const keys = pricedModelKeys(
      buildActivityBuckets(
        synthesizedSession({
          model: null,
          models: [],
          primaryModel: null,
          tokenUsageByModel: [
            {
              cacheReadTokens: 900,
              cacheWriteTokens: 400,
              estimatedCostUsd: 4.82,
              inputTokens: 12_000,
              model: "claude-opus-5",
              outputTokens: 3200,
            },
            {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCostUsd: 0,
              inputTokens: 0,
              model: "claude-haiku-4-5",
              outputTokens: 0,
            },
          ],
        }),
        [],
        WINDOW
      )
    );

    expect(keys).toEqual(["claude-opus-5"]);
  });

  it("still names the one model a single-model session ran", () => {
    expect(
      pricedModelKeys(
        buildActivityBuckets(
          synthesizedSession({
            model: "gpt-5.5",
            models: ["gpt-5.5"],
            primaryModel: "gpt-5.5",
          }),
          [],
          WINDOW
        )
      )
    ).toEqual(["gpt-5.5"]);
  });

  it("names the only billed model when the session carries no primary", () => {
    // The fixture's `tokenUsageByModel` bills exactly one model, so the record
    // still supports naming it even with `primaryModel`/`model` unset.
    expect(
      pricedModelKeys(
        buildActivityBuckets(
          synthesizedSession({ model: null, models: [], primaryModel: null }),
          [],
          WINDOW
        )
      )
    ).toEqual(["gpt-5.5"]);
  });

  it("applies the same resolution on the untimed even-bucket fallback", () => {
    const strip = buildActivityBuckets(
      synthesizedSession({ ...UNRESOLVED_MODEL, turnItems: UNTIMED_ROWS }),
      [],
      null
    );

    expect(strip.synthesized).toBe(true);
    // `synthesized` alone is true on the timed path too, so it cannot show WHICH
    // branch ran. The key prefix can: `buildEvenActivityBuckets` writes
    // `even-…`, `buildTimedActivityBuckets` writes `time-…`.
    expect(strip.buckets[0].key).toMatch(EVEN_BUCKET_KEY_RE);
    expect(pricedModelKeys(strip)).toEqual([UNKNOWN_MODEL_LABEL]);
  });

  it("keeps the one entry priced, so the Model cut still paints the bar", () => {
    const strip = buildActivityBuckets(
      synthesizedSession(UNRESOLVED_MODEL),
      [],
      WINDOW
    );
    const busy = strip.buckets.filter((bucket) => bucket.total > 0);

    expect(busy.length).toBeGreaterThan(0);
    for (const bucket of busy) {
      const entry = bucket.byModel[UNKNOWN_MODEL_LABEL];
      // The Model cut divides each segment by the bucket's own total, so the
      // single segment has to carry all of it or the bar renders short under
      // that grouping while Token Type draws it full height.
      expect(entry.cIn + entry.cOut + entry.cCache).toBeCloseTo(
        bucket.cIn + bucket.cOut + bucket.cCache
      );
    }
  });
});
