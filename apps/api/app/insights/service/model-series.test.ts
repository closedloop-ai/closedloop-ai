import type { CategoryBucket } from "@repo/api/src/types/insights";
import { describe, expect, it } from "vitest";
import { type ModelUsageDayRow, modelUsageSeries } from "./model-series";

/**
 * A model name reaches this fold verbatim from `agent_session_token_usage.model`
 * — `syncedAgentSessionTokenUsageSchema` bounds it only to a non-empty string,
 * and every hop in between keys on a `Map`. These cases pin the two shapes a
 * prototype-colliding name produced before ISS-8233 (a silently erased series,
 * and a `NaN` that serializes to `null` in a `Record<string, number>`), plus the
 * ordinary-name output that proves the null-prototype swap left valid input
 * alone. That last one is what protects the byte-compared Layer 5.3 fixture.
 */

const START = new Date("2026-08-01T00:00:00.000Z");
const END = new Date("2026-08-02T00:00:00.000Z");
const UTC = "UTC";
const FIRST_DAY = "2026-08-01";
// Held in a constant so the assertion below is an ordinary computed lookup:
// spelling `__proto__` inline as a property access trips `lint/suspicious/noProto`,
// which is the very hazard this suite exists to prove is contained.
const PROTO_KEY = "__proto__";
const SECOND_DAY = "2026-08-02";

function bucketFor(key: string, value: number): CategoryBucket {
  return { key, label: key, value };
}

function rowFor(
  model: string,
  overrides: Partial<ModelUsageDayRow> = {}
): ModelUsageDayRow {
  return { day: FIRST_DAY, model, cost: 10, tokens: 100, ...overrides };
}

// The wire shape a client actually receives. Asserting through it is
// load-bearing for the `constructor` case: the in-memory value is `NaN`, and
// only serialization turns it into the `null` the client sees.
function overWire(series: { points: { date: string; values: unknown }[] }) {
  return JSON.parse(JSON.stringify(series)) as {
    series: { key: string; label: string }[];
    points: { date: string; values: Record<string, number | null> }[];
  };
}

describe("modelUsageSeries — prototype-colliding model names (ISS-8233)", () => {
  it("keeps a model named __proto__ carrying its own spend instead of erasing it", () => {
    const { spend } = modelUsageSeries(
      [rowFor("__proto__", { cost: 999 })],
      [bucketFor("__proto__", 999)],
      START,
      END,
      UTC
    );

    // Before the fix `day["__proto__"]` read back Object.prototype, the `?? 0`
    // never fired, and the write hit the __proto__ setter, which drops a
    // non-object — so `values` came back `{}` while the model still sat in the
    // legend as a flat zero line and its $999 stayed in the spend KPI.
    expect(spend.series).toContainEqual({
      key: "__proto__",
      label: "__proto__",
    });
    const firstDay = spend.points.find((point) => point.date === FIRST_DAY);
    expect(firstDay?.values[PROTO_KEY]).toBe(999);
  });

  it("emits a number, not null, for a model named constructor", () => {
    const { spend } = modelUsageSeries(
      [rowFor("constructor", { cost: 12.5 })],
      [bucketFor("constructor", 12.5)],
      START,
      END,
      UTC
    );

    const wire = overWire(spend);
    const firstDay = wire.points.find((point) => point.date === FIRST_DAY);
    expect(firstDay?.values.constructor).toBe(12.5);
    expect(typeof firstDay?.values.constructor).toBe("number");
  });

  it("leaves a day with no rows empty rather than inventing a NaN for an inherited key", () => {
    // The read-side `?? {}` fallback was its own hole: on a day the fold never
    // touched, `raw["constructor"]` resolved to Object itself — not undefined —
    // so the `!== undefined` guard passed and rounded it to NaN.
    const { spend, tokens } = modelUsageSeries(
      [rowFor("constructor", { cost: 12.5, tokens: 40 })],
      [bucketFor("constructor", 12.5)],
      START,
      END,
      UTC
    );

    for (const series of [spend, tokens]) {
      const emptyDay = overWire(series).points.find(
        (point) => point.date === SECOND_DAY
      );
      expect(emptyDay?.values).toEqual({});
    }
  });

  it("collapses a prototype-colliding name outside the top-N into other", () => {
    const { spend } = modelUsageSeries(
      [rowFor("sonnet", { cost: 5 }), rowFor("__proto__", { cost: 7 })],
      [bucketFor("sonnet", 5)],
      START,
      END,
      UTC
    );

    expect(spend.series).toContainEqual({ key: "other", label: "Other" });
    const firstDay = spend.points.find((point) => point.date === FIRST_DAY);
    expect(firstDay?.values.other).toBe(7);
    expect(firstDay?.values.sonnet).toBe(5);
  });
});

describe("modelUsageSeries — ordinary model names are unchanged (ISS-8233)", () => {
  it("produces the same wire bytes the plain-object fold produced", () => {
    // The happy-path guard for the null-prototype swap. `Object.create(null)`
    // differs from `{}` only where a key collides with an Object.prototype
    // member, so an ordinary name must serialize identically — including key
    // insertion order, which is what the byte comparison in Layer 5.3 reads.
    const { spend, tokens } = modelUsageSeries(
      [
        rowFor("claude-opus-5", { cost: 1.25, tokens: 120 }),
        rowFor("claude-sonnet-5", { cost: 2.5, tokens: 80 }),
        rowFor("claude-opus-5", { day: SECOND_DAY, cost: 3, tokens: 60 }),
      ],
      [bucketFor("claude-opus-5", 4.25), bucketFor("claude-sonnet-5", 2.5)],
      START,
      END,
      UTC
    );

    expect(JSON.stringify(spend)).toBe(
      JSON.stringify({
        series: [
          { key: "claude-opus-5", label: "claude-opus-5" },
          { key: "claude-sonnet-5", label: "claude-sonnet-5" },
        ],
        points: [
          {
            date: FIRST_DAY,
            values: { "claude-opus-5": 1.25, "claude-sonnet-5": 2.5 },
          },
          { date: SECOND_DAY, values: { "claude-opus-5": 3 } },
        ],
      })
    );
    expect(JSON.stringify(tokens)).toBe(
      JSON.stringify({
        series: [
          { key: "claude-opus-5", label: "claude-opus-5" },
          { key: "claude-sonnet-5", label: "claude-sonnet-5" },
        ],
        points: [
          {
            date: FIRST_DAY,
            values: { "claude-opus-5": 120, "claude-sonnet-5": 80 },
          },
          { date: SECOND_DAY, values: { "claude-opus-5": 60 } },
        ],
      })
    );
  });
});

describe("modelUsageSeries — the top-N cap itself (ISS-8564 lock)", () => {
  // LOCK, not a new contract: `.slice(0, MAX_MODEL_SERIES)` survived Stryker at
  // model-series.ts:32 (97.44%, the file's one surviving mutant) — deleting the
  // slice left every suite green, so nothing pinned that the cap caps. ISS-8564
  // rewrites the residual-key derivation right beside it, so this pins the cap
  // FIRST and the diff in expectations is then exactly the intended change.
  it("emits at most six named series plus one residual, however many models rank", () => {
    const models = ["m-a", "m-b", "m-c", "m-d", "m-e", "m-f", "m-g", "m-h"];
    const { spend } = modelUsageSeries(
      models.map((model, index) => rowFor(model, { cost: 100 - index })),
      models.map((model, index) => bucketFor(model, 100 - index)),
      START,
      END,
      UTC
    );

    const named = spend.series.filter((entry) => entry.key !== "other");
    expect(named).toHaveLength(6);
    expect(named.map((entry) => entry.key)).toEqual([
      "m-a",
      "m-b",
      "m-c",
      "m-d",
      "m-e",
      "m-f",
    ]);
    // The two lowest-ranked models are the residual, and they are SUMMED there.
    expect(spend.series).toContainEqual({ key: "other", label: "Other" });
    const firstDay = spend.points.find((point) => point.date === FIRST_DAY);
    expect(firstDay?.values.other).toBe(94 + 93);
    expect(firstDay?.values["m-g"]).toBeUndefined();
  });
});

describe('modelUsageSeries — a model literally named "other" (ISS-8564)', () => {
  // The residual sentinel is drawn from the same unconstrained string space as
  // the model names it collects, and ISS-8233 reserved `__proto__`/`constructor`
  // out of that space but not the product's own sentinel.
  const SEVEN: [string, number][] = [
    ["claude-opus-4-5", 120],
    ["gpt-5.4", 90],
    ["other", 75],
    ["claude-sonnet-4-6", 60],
    ["gpt-5.1-codex", 45],
    ["claude-haiku-4-5", 30],
    ["legacy-tiny-model", 5],
  ];

  function seriesForSeven() {
    return modelUsageSeries(
      SEVEN.map(([model, cost]) => rowFor(model, { cost, tokens: cost * 10 })),
      SEVEN.map(([model, cost]) => bucketFor(model, cost)),
      START,
      END,
      UTC
    );
  }

  it("gives the real model its own series instead of merging it into the residual", () => {
    const { spend } = seriesForSeven();
    const firstDay = spend.points.find((point) => point.date === FIRST_DAY);

    // Before: `values.other` was 80 — the real model's 75 silently summed with
    // the residual model's 5, reported as one band.
    expect(firstDay?.values.other).toBe(75);
    expect(spend.series).toContainEqual({ key: "other", label: "other" });
  });

  it("emits the residual under a key no model can carry, holding only the residual", () => {
    const { spend } = seriesForSeven();
    const firstDay = spend.points.find((point) => point.date === FIRST_DAY);
    const residual = spend.series.find(
      (entry) => entry.label === "Other models"
    );

    expect(residual).toBeDefined();
    expect(residual?.key).not.toBe("other");
    expect(firstDay?.values[residual?.key ?? ""]).toBe(5);
  });

  it("never ships two series entries with the same key", () => {
    const { spend, tokens } = seriesForSeven();

    for (const series of [spend, tokens]) {
      const keys = series.series.map((entry) => entry.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("keeps the spend and token series on the SAME residual key", () => {
    // The $/# toggle only swaps y-values, so a residual key derived twice must
    // land identically or the legend would change under the toggle.
    const { spend, tokens } = seriesForSeven();
    expect(tokens.series.map((entry) => entry.key)).toEqual(
      spend.series.map((entry) => entry.key)
    );
  });

  it("leaves the residual key as the bare sentinel when no model collides", () => {
    // The byte-identity guarantee: every payload in production today takes this
    // branch, so the suffixing can never change an existing chart.
    const { spend } = modelUsageSeries(
      [rowFor("claude-opus-4-5", { cost: 10 }), rowFor("tiny", { cost: 1 })],
      [bucketFor("claude-opus-4-5", 10)],
      START,
      END,
      UTC
    );
    expect(spend.series).toContainEqual({ key: "other", label: "Other" });
  });
});
