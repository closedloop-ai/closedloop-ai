import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "vitest";
import type { Range } from "../src/main/database/local-insights-range.js";
import {
  buildModelSeries,
  gapFilledSeries,
  prSplitSeries,
} from "../src/main/database/local-insights-series.js";
import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../src/shared/session-date-window-contract.js";

const range: Range = {
  startIso: localNoonIso(19),
  endIso: localNoonIso(21),
  elapsedEndIso: localNoonIso(21),
  trendStartIso: localNoonIso(19),
  priorStartIso: localNoonIso(17),
  priorEndIso: localNoonIso(19),
  // These cases shape an already-fetched series; the basis only decides which
  // rows a query returned, so it cannot reach them. Named as the surface field
  // because ISS-10541 left that the only value an insights range carries.
  dateWindowField: SESSIONS_SURFACE_DATE_WINDOW_FIELD,
  sessionsWindow: { startDate: localNoonIso(19), endDate: localNoonIso(21) },
};

describe('local Insights series shaping — a model named "other" (ISS-8564)', () => {
  // The desktop fold mirrors the cloud `modelUsageSeries`, so it carried the
  // identical sentinel collision. Fixing only the cloud would leave the two
  // surfaces charting the same org differently, which is precisely the local-vs-
  // cloud divergence the repo guidelines say to check for when touching one.
  const sevenModels = [
    ["m-a", 120],
    ["m-b", 90],
    ["other", 75],
    ["m-d", 60],
    ["m-e", 45],
    ["m-f", 30],
    ["m-tiny", 5],
  ] as const;

  function seriesForSeven() {
    return buildModelSeries(
      sevenModels.map(([model, value]) => ({
        day: "2026-08-20",
        model,
        value,
        tokens: BigInt(value * 10),
      })),
      range
    );
  }

  test("charts a real model named other separately from the residual", () => {
    const result = seriesForSeven();
    const keys = result.spend.series.map((series) => series.key);

    assert.equal(new Set(keys).size, keys.length, "no duplicate series key");
    assert.ok(keys.includes("other"), "the real model keeps its own key");

    const residual = result.spend.series.find(
      (series) => series.label === "Other models"
    );
    assert.ok(residual, "residual band is emitted under a distinct label");
    assert.notEqual(residual?.key, "other");
  });

  test("leaves the residual key as the bare sentinel when nothing collides", () => {
    const result = buildModelSeries(
      [
        { day: "2026-08-20", model: "m-a", value: 10, tokens: 100n },
        { day: "2026-08-20", model: "m-b", value: 9, tokens: 90n },
        { day: "2026-08-20", model: "m-c", value: 8, tokens: 80n },
        { day: "2026-08-20", model: "m-d", value: 7, tokens: 70n },
        { day: "2026-08-20", model: "m-e", value: 6, tokens: 60n },
        { day: "2026-08-20", model: "m-f", value: 5, tokens: 50n },
        { day: "2026-08-20", model: "m-g", value: 1, tokens: 10n },
      ],
      range
    );
    assert.ok(
      result.spend.series.some(
        (series) => series.key === "other" && series.label === "Other"
      ),
      "unchanged for every payload without a colliding model"
    );
  });
});

describe("local Insights series shaping", () => {
  test("keeps the top six spend models and aggregates the remainder into Other", () => {
    const rows = [7, 6, 5, 4, 3, 2, 1].map((value, index) => ({
      day: "2026-08-20",
      model: `model-${index + 1}`,
      value: value + 0.004,
      tokens: BigInt(value * 100),
    }));

    const result = buildModelSeries(rows, range);

    assert.deepEqual(
      result.spend.series.map((series) => series.key),
      [
        "model-1",
        "model-2",
        "model-3",
        "model-4",
        "model-5",
        "model-6",
        "other",
      ]
    );
    assert.deepEqual(result.spend.points[0]?.values, {});
    assert.deepEqual(result.spend.points[1]?.values, {
      "model-1": 7.01,
      "model-2": 6,
      "model-3": 5,
      "model-4": 4,
      "model-5": 3,
      "model-6": 2.01,
      other: 1.01,
    });
    assert.deepEqual(result.tokens.points[1]?.values, {
      "model-1": 700,
      "model-2": 600,
      "model-3": 500,
      "model-4": 400,
      "model-5": 300,
      "model-6": 200,
      other: 100,
    });
    assert.deepEqual(result.spend.points[2]?.values, {});
  });

  test("aggregates repeated rows without adding an Other series when all models fit", () => {
    const result = buildModelSeries(
      [
        { day: "2026-08-20", model: "model-a", value: 0.005, tokens: 2 },
        { day: "2026-08-20", model: "model-a", value: 0.005, tokens: 3 },
        { day: "2026-08-20", model: "model-b", value: 0.004, tokens: 4 },
      ],
      range
    );

    assert.deepEqual(result.spend.series, [
      { key: "model-a", label: "model-a" },
      { key: "model-b", label: "model-b" },
    ]);
    assert.deepEqual(result.spend.points[1]?.values, {
      "model-a": 0.01,
      "model-b": 0,
    });
    assert.deepEqual(result.tokens.points[1]?.values, {
      "model-a": 5,
      "model-b": 4,
    });
  });

  // ISS-8234 — `r.model` is the model string as the local SQLite stored it,
  // transcript-controlled and never allow-listed, so it reaches the per-day
  // accumulator as a key. On the plain `{}` this used to build, `"__proto__"`
  // and `"constructor"` read back as INHERITED members, so the `?? 0` first-write
  // check never fired. Each name then fails differently, which is why they get a
  // case each rather than a loop: `"__proto__"` assigns through the prototype
  // setter and the day's spend and tokens vanish from the chart entirely, while
  // `"constructor"` reads back the `Object` FUNCTION and `Object + 1.5`
  // string-concatenates, putting "function Object() { [native code] }1.5" into a
  // field the renderer charts as a number.
  const PROTO_KEY = "__proto__";

  test("keeps a __proto__ model's spend and tokens in the series", () => {
    const result = buildModelSeries(
      [{ day: "2026-08-20", model: PROTO_KEY, value: 1.5, tokens: 100 }],
      range
    );

    assert.deepEqual(result.spend.series, [
      { key: PROTO_KEY, label: PROTO_KEY },
    ]);
    const spendValues = result.spend.points[1]?.values ?? {};
    const tokenValues = result.tokens.points[1]?.values ?? {};
    assert.equal(Object.hasOwn(spendValues, PROTO_KEY), true);
    assert.equal(Object.hasOwn(tokenValues, PROTO_KEY), true);
    assert.equal(spendValues[PROTO_KEY], 1.5);
    assert.equal(tokenValues[PROTO_KEY], 100);
  });

  test("keeps a constructor model's spend and tokens numeric", () => {
    const result = buildModelSeries(
      [{ day: "2026-08-20", model: "constructor", value: 1.5, tokens: 100 }],
      range
    );

    const spendValues = result.spend.points[1]?.values ?? {};
    const tokenValues = result.tokens.points[1]?.values ?? {};
    // Type, not just value: the pre-fix defect emitted a STRING here, which
    // charts as a number-shaped nothing rather than failing loudly.
    assert.equal(typeof spendValues.constructor, "number");
    assert.equal(typeof tokenValues.constructor, "number");
    assert.equal(spendValues.constructor, 1.5);
    assert.equal(tokenValues.constructor, 100);
  });

  test("a poisoned model name does not steal another model's day totals", () => {
    const result = buildModelSeries(
      [
        { day: "2026-08-20", model: PROTO_KEY, value: 2, tokens: 10 },
        { day: "2026-08-20", model: "model-a", value: 3, tokens: 20 },
        { day: "2026-08-20", model: PROTO_KEY, value: 1, tokens: 5 },
      ],
      range
    );

    // Reconciliation: every row's dollars and tokens present exactly once, and
    // the repeat row proves the accumulator's UPDATE path as well as its create.
    const spendValues = result.spend.points[1]?.values ?? {};
    const tokenValues = result.tokens.points[1]?.values ?? {};
    assert.deepEqual(Object.keys(spendValues).sort(), [PROTO_KEY, "model-a"]);
    assert.equal(spendValues[PROTO_KEY], 3);
    assert.equal(spendValues["model-a"], 3);
    assert.equal(tokenValues[PROTO_KEY], 15);
    assert.equal(tokenValues["model-a"], 20);
  });

  test("emits normally-prototyped value objects on the wire", () => {
    // The accumulator is null-prototype; the emit boundary must not be. The
    // spend half gets that from `allocateRoundedUsdValues`; assert the token
    // half's spread does the same, so no consumer receives a prototype-less
    // object where it always had a plain one.
    const result = buildModelSeries(
      [{ day: "2026-08-20", model: "model-a", value: 1, tokens: 2 }],
      range
    );

    for (const point of result.tokens.points) {
      assert.equal(Object.getPrototypeOf(point.values), Object.prototype);
    }
    for (const point of result.spend.points) {
      assert.equal(Object.getPrototypeOf(point.values), Object.prototype);
    }
  });

  test("gap fills missing days with the requested value", () => {
    const result = gapFilledSeries(
      new Map([["2026-08-20", 4]]),
      range,
      { key: "sessions", label: "Sessions" },
      null
    );

    assert.deepEqual(result, {
      series: [{ key: "sessions", label: "Sessions" }],
      points: [
        { date: "2026-08-19", values: { sessions: null } },
        { date: "2026-08-20", values: { sessions: 4 } },
        { date: "2026-08-21", values: { sessions: null } },
      ],
    });
  });

  test("keeps the merged PR total undeclared while splitting manual throughput", () => {
    const result = prSplitSeries(
      new Map([["2026-08-20", { total: 7, agent: 3 }]]),
      range
    );

    assert.deepEqual(result.series, [
      { key: "agent", label: "Agent-raised" },
      { key: "manual", label: "Manual/untracked" },
    ]);
    assert.deepEqual(result.points[1]?.values, {
      agent: 3,
      manual: 4,
      merged: 7,
    });
    assert.deepEqual(result.points[0]?.values, {
      agent: 0,
      manual: 0,
      merged: 0,
    });
  });
});

/**
 * ISS-10583: every day axis must stop at the instant the window has ELAPSED,
 * never at its declared end.
 *
 * The declared end is the in-progress UTC day's last instant, so it is ahead of
 * the clock. A reader east of UTC is already on the NEXT local day at that
 * instant, so an axis walked to `endIso` paints one trailing column for a day
 * that has not begun anywhere on earth — permanently empty, under a caption
 * that says "Last 7 days".
 *
 * This case exists because nothing else in the repo can see it. The fixture
 * above sets `elapsedEndIso` equal to `endIso`, which makes the two bounds
 * indistinguishable, and the Layer-3 golden runs only in UTC and
 * America/Chicago — both at or west of UTC, where the two bounds floor to the
 * same local day. The bug this pins survived exactly there.
 */
describe("local Insights series day axis stops at the elapsed clock (ISS-10583)", () => {
  const ORIGINAL_TZ = process.env.TZ;
  // A positive UTC offset, which is the whole point: at 12:00Z on the 20th,
  // Tokyo (UTC+9) is already 21:00 on the 20th, and the window's declared end
  // (23:59:59.999Z on the 20th) is 08:59 on the 21st there.
  const TOKYO = "Asia/Tokyo";
  const eastOfUtcRange: Range = {
    startIso: "2026-08-14T00:00:00.000Z",
    endIso: "2026-08-20T23:59:59.999Z",
    elapsedEndIso: "2026-08-20T12:00:00.000Z",
    trendStartIso: "2026-08-14T00:00:00.000Z",
    priorStartIso: "2026-08-07T00:00:00.000Z",
    priorEndIso: "2026-08-13T12:00:00.000Z",
    // Irrelevant here for the same reason as the fixture above: this case walks
    // an axis over rows already handed to it, so the column the query bounded on
    // cannot reach it.
    dateWindowField: SESSIONS_SURFACE_DATE_WINDOW_FIELD,
    sessionsWindow: {
      startDate: "2026-08-14T00:00:00.000Z",
      endDate: "2026-08-20T23:59:59.999Z",
    },
  };

  beforeAll(() => {
    process.env.TZ = TOKYO;
  });

  afterAll(() => {
    if (ORIGINAL_TZ === undefined) {
      Reflect.deleteProperty(process.env, "TZ");
      return;
    }
    process.env.TZ = ORIGINAL_TZ;
  });

  test("gapFilledSeries stops on the local day the clock is in", () => {
    const points = gapFilledSeries(new Map(), eastOfUtcRange, {
      key: "events",
      label: "Events",
    }).points;
    // 2026-08-21 is the local day the DECLARED end falls in, and it has not
    // started at the elapsed instant — it must not be a column.
    assert.equal(
      points.some((p) => p.date === "2026-08-21"),
      false
    );
    // The positive twin: the local day the clock IS in must be the last column,
    // so this is pinning the right edge rather than an axis that stops early.
    assert.equal(points.at(-1)?.date, "2026-08-20");
  });

  test("prSplitSeries and buildModelSeries share that right edge", () => {
    const pr = prSplitSeries(new Map(), eastOfUtcRange);
    const model = buildModelSeries([], eastOfUtcRange);
    assert.equal(pr.points.at(-1)?.date, "2026-08-20");
    assert.equal(model.spend.points.at(-1)?.date, "2026-08-20");
    assert.equal(model.tokens.points.at(-1)?.date, "2026-08-20");
    // All three axes are one length, so no two charts in one response can
    // describe the same window over a different number of days.
    assert.equal(pr.points.length, model.spend.points.length);
  });
});

function localNoonIso(day: number): string {
  return new Date(2026, 7, day, 12).toISOString();
}
