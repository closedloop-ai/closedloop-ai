/**
 * ISS-7261: the fold that splits a session's token series back apart by
 * subagent.
 *
 * The corpus below is deliberately not a single row. A fold that ignored
 * `subagentId` entirely — the shape of the bug this replaces, where the parser
 * knew the attribution and the write path discarded it — would credit every
 * subagent the whole session's tokens and still satisfy any single-subagent
 * fixture. So the series carries TWO different subagents plus parent round-trips
 * that belong to neither.
 */
import { describe, expect, test } from "vitest";
import {
  foldComponentUsage,
  foldSubagentComponentUsage,
  foldSubagentTokenRecords,
  foldTokenRecords,
  groupSubagentTokenRecords,
} from "./component-usage";
import type { NormalizedTokenRecord } from "./types";

const REVIEWER = "019ec93a-b1f0-7140-b416-5e653d85dd67";
const EXPLORER = "019ec93a-b1f0-7140-b416-5e653d85dd68";

function record(
  overrides: Partial<NormalizedTokenRecord> &
    Pick<NormalizedTokenRecord, "model">
): NormalizedTokenRecord {
  return {
    timestamp: "2026-08-19T09:00:00.000Z",
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...overrides,
  };
}

/**
 * Ordering is scrambled on purpose: a folded root's series is parent-then-child
 * rather than time-ordered, so anything that read a position instead of summing
 * would answer differently here than on a live transcript.
 */
const SERIES: NormalizedTokenRecord[] = [
  record({ model: "claude-opus-4-8", input: 100, output: 10 }),
  record({
    model: "claude-opus-4-8",
    input: 7,
    output: 3,
    subagentId: REVIEWER,
  }),
  record({
    model: "claude-sonnet-4-8",
    input: 40,
    output: 4,
    subagentId: EXPLORER,
  }),
  record({ model: "claude-opus-4-8", input: 200, output: 20 }),
  record({
    model: "claude-sonnet-4-8",
    input: 5,
    output: 1,
    cacheRead: 9,
    cacheWrite: 2,
    subagentId: REVIEWER,
  }),
];

describe("foldSubagentComponentUsage", () => {
  test("attributes each subagent only its own round-trips", () => {
    const usage = foldSubagentComponentUsage(SERIES);

    // The parent's 300 input tokens belong to no subagent and must not appear
    // in either row — crediting them is the over-attribution this fold exists
    // to prevent.
    expect([...usage.keys()].sort()).toEqual([REVIEWER, EXPLORER].sort());
    expect(usage.get(REVIEWER)).toEqual({
      // Two models served this subagent, so no single model describes the row.
      model: null,
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 9,
      cacheWriteTokens: 2,
    });
    expect(usage.get(EXPLORER)).toEqual({
      model: "claude-sonnet-4-8",
      inputTokens: 40,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("returns nothing for a series with no subagent-attributed record", () => {
    expect(
      foldSubagentComponentUsage([
        record({ model: "claude-opus-4-8", input: 100, output: 10 }),
      ]).size
    ).toBe(0);
    expect(foldSubagentComponentUsage(undefined).size).toBe(0);
    expect(
      foldSubagentComponentUsage([
        record({
          model: "claude-opus-4-8",
          input: 100,
          output: 10,
          subagentId: "",
        }),
      ]).size
    ).toBe(0);
  });
});

describe("foldComponentUsage", () => {
  test("reports no telemetry for an empty count map", () => {
    expect(foldComponentUsage({})).toBeUndefined();
  });
});

/**
 * FEA-3419's TTL split is a PRICE, not a decoration: a one-hour ephemeral cache
 * write bills at 2x the base input rate against a five-minute write's 1.25x, and
 * `estimateTokenCost` charges an omitted one-hour count at the five-minute rate.
 * A fold that summed `cacheWrite` and dropped the split therefore under-reports
 * the money. The cost half of this is asserted in
 * `apps/desktop/test/component-invocation-subagent-usage-cost.test.ts`.
 */
describe("cache-write TTL survives both folds (ISS-7261)", () => {
  test("the per-subagent fold sums the split across a subagent's records", () => {
    const usage = foldSubagentComponentUsage([
      record({
        model: "claude-sonnet-4-5",
        cacheWrite: 300,
        cacheWriteTtl: { fiveM: 100, oneH: 200 },
        subagentId: REVIEWER,
      }),
      record({
        model: "claude-sonnet-4-5",
        cacheWrite: 50,
        cacheWriteTtl: { fiveM: 20, oneH: 30 },
        subagentId: REVIEWER,
      }),
      // The OTHER subagent reported no split at all, so its row must stay
      // absent rather than inherit the reviewer's — a shared accumulator would
      // charge Explore for one-hour writes it never made.
      record({
        model: "claude-sonnet-4-5",
        cacheWrite: 10,
        subagentId: EXPLORER,
      }),
    ]);

    expect(usage.get(REVIEWER)?.cacheWriteTtl).toEqual({
      fiveM: 120,
      oneH: 230,
    });
    expect(usage.get(REVIEWER)?.cacheWriteTokens).toBe(350);
    expect(usage.get(EXPLORER)?.cacheWriteTtl).toBeUndefined();
  });

  test("the per-model fold sums the split across models", () => {
    expect(
      foldComponentUsage({
        "claude-opus-4-8": {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 400,
          cacheWriteTtl: { fiveM: 150, oneH: 250 },
        },
        "claude-sonnet-4-8": {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 60,
          cacheWriteTtl: { fiveM: 10, oneH: 50 },
        },
      })?.cacheWriteTtl
    ).toEqual({ fiveM: 160, oneH: 300 });
  });

  test("absence stays absent when no record reported a split", () => {
    // Presence is the provenance marker: `{0,0}` would claim the provider
    // reported an all-five-minute split it never sent.
    expect(
      foldSubagentComponentUsage([
        record({
          model: "claude-opus-4-8",
          cacheWrite: 90,
          subagentId: REVIEWER,
        }),
      ]).get(REVIEWER)
    ).not.toHaveProperty("cacheWriteTtl");
  });
});

describe("foldSubagentComponentUsage truncation refusal", () => {
  test("attributes nothing when the series was cut short", () => {
    // ISS-7534's marker means the tail is missing, so every per-subagent sum
    // over what survived is an undercount. An undercount stamped `measured` is
    // the confident-but-wrong number that marker exists to prevent, so the fold
    // must yield NO attribution rather than a partial one.
    const usage = foldSubagentComponentUsage(SERIES, {
      droppedRecords: 3,
      droppedTokens: { input: 900, output: 90, cacheRead: 0, cacheWrite: 0 },
    });

    expect(usage.size).toBe(0);
    // The positive sibling on the same corpus: without the marker the same
    // series still attributes, so the guard cannot be passing vacuously.
    expect(foldSubagentComponentUsage(SERIES).size).toBe(2);
  });
});

describe("foldSubagentComponentUsage untrusted model ids", () => {
  test("a `__proto__` model id does not reach Object.prototype", () => {
    // `record.model` is whatever the provider wrote into the transcript, so this
    // is a reachable parse-boundary input, not a type-forbidden one.
    const usage = foldSubagentComponentUsage([
      record({ model: "__proto__", input: 5, output: 2, subagentId: REVIEWER }),
      record({
        model: "constructor",
        input: 3,
        output: 1,
        subagentId: REVIEWER,
      }),
    ]);

    // The counters must land on the row, not on every object in the process.
    expect(usage.get(REVIEWER)).toEqual({
      model: null,
      inputTokens: 8,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(Object.hasOwn({}, "input")).toBe(false);
    expect(({} as Record<string, unknown>).input).toBeUndefined();
  });
});

describe("groupSubagentTokenRecords (ISS-7361)", () => {
  test("keeps each subagent's own records whole and in series order", () => {
    const grouped = groupSubagentTokenRecords(SERIES);

    // The parent's two records belong to no group; the reviewer's two arrive
    // in the order the series held them, which the pricing layer relies on
    // for nothing but which a caller reading a position would notice.
    expect([...grouped.keys()].sort()).toEqual([REVIEWER, EXPLORER].sort());
    expect(grouped.get(REVIEWER)).toEqual([SERIES[1], SERIES[4]]);
    expect(grouped.get(EXPLORER)).toEqual([SERIES[2]]);
  });

  test("attributes nothing when the series was cut short", () => {
    const grouped = groupSubagentTokenRecords(SERIES, {
      droppedRecords: 3,
      droppedTokens: { input: 900, output: 90, cacheRead: 0, cacheWrite: 0 },
    });

    expect(grouped.size).toBe(0);
    expect(groupSubagentTokenRecords(undefined).size).toBe(0);
  });

  test("folding the groups is the per-subagent fold", () => {
    // The two halves compose to the one-call fold, so a caller that needs the
    // records as well cannot arrive at a different usage row than one that
    // does not.
    expect(foldSubagentTokenRecords(groupSubagentTokenRecords(SERIES))).toEqual(
      foldSubagentComponentUsage(SERIES)
    );
    expect(foldTokenRecords([SERIES[1], SERIES[4]])).toEqual(
      foldSubagentComponentUsage(SERIES).get(REVIEWER)
    );
    expect(foldTokenRecords([])).toBeUndefined();
  });
});
