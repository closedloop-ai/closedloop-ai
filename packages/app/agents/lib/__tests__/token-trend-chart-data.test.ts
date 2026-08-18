import type { ComponentVersion } from "@repo/api/src/types/agent-component";
import type { TokenTrendResponse } from "@repo/api/src/types/agent-component-analytics";
import { describe, expect, it } from "vitest";
import { UsageMetric } from "../../../insights/components/overview/usage-graph-toggles";
import {
  bucketDay,
  buildTokenTrendSeries,
  buildVersionMarkers,
} from "../token-trend-chart-data";

const RE_CREATED = /created/i;
const RE_FIRST_USED = /first used/i;

const response: TokenTrendResponse = {
  slug: "skill::rtk",
  models: ["claude-opus-4-5", "gpt-5"],
  points: [
    {
      sessionId: "s1",
      sessionStartedAt: "2026-06-01T10:00:00.000Z",
      model: "claude-opus-4-5",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.1,
      runtimeMs: 1000,
      componentInvocations: 1,
      componentErrorCount: 0,
    },
    {
      sessionId: "s2",
      sessionStartedAt: "2026-06-01T14:00:00.000Z",
      model: "claude-opus-4-5",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.02,
      runtimeMs: 500,
      componentInvocations: 1,
      componentErrorCount: 0,
    },
    {
      sessionId: "s3",
      sessionStartedAt: "2026-06-02T09:00:00.000Z",
      model: "gpt-5",
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.05,
      runtimeMs: 2000,
      componentInvocations: 2,
      componentErrorCount: 0,
    },
  ],
};

const versions: ComponentVersion[] = [
  {
    hash: "hashB",
    source: "repo",
    format: "md",
    createdAt: "2026-06-02T00:00:00.000Z",
    isCurrent: true,
    content: "v2",
  },
  {
    hash: "hashA",
    source: "repo",
    format: "md",
    createdAt: "2026-06-01T00:00:00.000Z",
    isCurrent: false,
    content: "v1",
  },
];

describe("bucketDay", () => {
  it("date-prefixes an ISO string", () => {
    expect(bucketDay("2026-06-01T10:00:00.000Z")).toBe("2026-06-01");
  });

  it("normalizes Date / epoch without throwing", () => {
    expect(bucketDay(new Date("2026-06-01T10:00:00.000Z"))).toBe("2026-06-01");
    expect(bucketDay(Date.UTC(2026, 5, 1, 10, 0, 0))).toBe("2026-06-01");
  });

  it("falls back to a stable bucket for bad inputs", () => {
    for (const bad of [null, undefined, "", Number.NaN, new Date("nope"), {}]) {
      expect(bucketDay(bad)).toBe("unknown");
    }
  });
});

describe("buildTokenTrendSeries", () => {
  it("returns empty for undefined/empty responses", () => {
    expect(buildTokenTrendSeries(undefined, UsageMetric.Tokens)).toEqual({
      series: [],
      points: [],
    });
  });

  it("sums input+output tokens per model per day for the tokens metric", () => {
    const { series, points } = buildTokenTrendSeries(
      response,
      UsageMetric.Tokens
    );
    expect(series).toEqual([
      { key: "claude-opus-4-5", label: "claude-opus-4-5" },
      { key: "gpt-5", label: "gpt-5" },
    ]);
    expect(points.map((p) => p.date)).toEqual(["2026-06-01", "2026-06-02"]);
    // Day 1 opus (zero cache in this fixture): (100+50) + (10+5) = 165 tokens.
    expect(points[0].values["claude-opus-4-5"]).toBe(165);
    // Day 2 gpt-5: 200+100 = 300 tokens.
    expect(points[1].values["gpt-5"]).toBe(300);
  });

  it("includes cache read+write in the tokens metric, matching the dashboard", () => {
    // Same "Tokens" toggle must read the same total as the dashboard, which sums
    // input + output + cache_read + cache_write server-side (FEA-3497). A
    // cache-heavy session would otherwise show a smaller total here under the
    // identical label. Regression for the parity gap wongk flagged on #3756.
    const cacheHeavy: TokenTrendResponse = {
      slug: "skill::rtk",
      models: ["claude-opus-4-5"],
      points: [
        {
          sessionId: "s1",
          sessionStartedAt: "2026-06-01T10:00:00.000Z",
          model: "claude-opus-4-5",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 900,
          cacheWriteTokens: 300,
          estimatedCostUsd: 0.1,
          runtimeMs: 1000,
          componentInvocations: 1,
          componentErrorCount: 0,
        },
      ],
    };
    const { points } = buildTokenTrendSeries(cacheHeavy, UsageMetric.Tokens);
    // 100 + 50 + 900 + 300 = 1350 total token volume.
    expect(points[0].values["claude-opus-4-5"]).toBe(1350);
  });

  it("sums estimated USD per model per day for the cost metric", () => {
    const { points } = buildTokenTrendSeries(response, UsageMetric.Cost);
    // Day 1 opus: 0.1 + 0.02 = 0.12 dollars.
    expect(points[0].values["claude-opus-4-5"]).toBeCloseTo(0.12);
    // Day 2 gpt-5: 0.05 dollars.
    expect(points[1].values["gpt-5"]).toBeCloseTo(0.05);
  });

  it("does not throw when points carry non-string sessionStartedAt (crash-spiral regression)", () => {
    // The API types sessionStartedAt as an ISO string, but a Date/epoch can reach
    // the renderer (Liveblocks/non-JSON hydration). bucketDay must coerce, never
    // throw, so the detail page's LiveblocksErrorBoundary never crash-spirals.
    const dirty = {
      slug: "skill::rtk",
      models: ["claude-opus-4-5"],
      points: [
        {
          sessionId: "s1",
          sessionStartedAt: new Date("2026-06-01T10:00:00.000Z"),
          model: "claude-opus-4-5",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCostUsd: 0.1,
          runtimeMs: 1000,
          componentInvocations: 1,
          componentErrorCount: 0,
        },
        {
          sessionId: "s2",
          sessionStartedAt: Date.UTC(2026, 5, 2, 9, 0, 0),
          model: "claude-opus-4-5",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCostUsd: 0.02,
          runtimeMs: 500,
          componentInvocations: 1,
          componentErrorCount: 0,
        },
      ],
    } as unknown as TokenTrendResponse;
    expect(() =>
      buildTokenTrendSeries(dirty, UsageMetric.Tokens)
    ).not.toThrow();
    const { points } = buildTokenTrendSeries(dirty, UsageMetric.Tokens);
    expect(points.map((p) => p.date)).toEqual(["2026-06-01", "2026-06-02"]);
  });
});

describe("buildVersionMarkers", () => {
  it("emits a created marker per version on its created day", () => {
    const markers = buildVersionMarkers(versions, [], response);
    const created = markers.filter((m) => RE_CREATED.test(m.description));
    expect(created.map((m) => m.date).sort()).toEqual([
      "2026-06-01",
      "2026-06-02",
    ]);
  });

  it("emits a first-used marker at the earliest session day per version hash", () => {
    // hashA ran in s1 (2026-06-01) and s2 (also 2026-06-01); hashB in s3
    // (2026-06-02). First-used = earliest joined session start.
    const markers = buildVersionMarkers(
      versions,
      [
        { sessionId: "s1", versionHash: "hashA" },
        { sessionId: "s2", versionHash: "hashA" },
        { sessionId: "s3", versionHash: "hashB" },
      ],
      response
    );
    const used = markers.filter((m) => RE_FIRST_USED.test(m.description));
    const byLabelDate = Object.fromEntries(used.map((m) => [m.label, m.date]));
    // Rev 1 == hashA (older), Current == hashB.
    expect(byLabelDate["Rev 1 used"]).toBe("2026-06-01");
    expect(byLabelDate["Current used"]).toBe("2026-06-02");
  });

  it("collapses same-hash revisions from different sources to one marker set", () => {
    // Version identity is (component, source, hash); the detail producer can
    // return two revision rows with the same content hash under different
    // sources. The usage join only carries versionHash, so it cannot say which
    // source ran — the first-used day is hash-level. Emitting a marker per raw
    // row would paint the same day twice under identical labels. Regression for
    // the hash-collision wongk flagged on #3756.
    const sameHashTwoSources: ComponentVersion[] = [
      {
        hash: "dupeHash",
        source: "repo",
        format: "md",
        createdAt: "2026-06-01T00:00:00.000Z",
        isCurrent: true,
        content: "v1",
      },
      {
        hash: "dupeHash",
        source: "pack",
        format: "md",
        createdAt: "2026-06-01T00:00:00.000Z",
        isCurrent: false,
        content: "v1",
      },
    ];
    const markers = buildVersionMarkers(
      sameHashTwoSources,
      [{ sessionId: "s1", versionHash: "dupeHash" }],
      response
    );
    // Exactly one created + one first-used marker for the single hash.
    expect(markers.filter((m) => RE_CREATED.test(m.description))).toHaveLength(
      1
    );
    expect(
      markers.filter((m) => RE_FIRST_USED.test(m.description))
    ).toHaveLength(1);
  });

  it("returns no markers when there are no versions", () => {
    expect(buildVersionMarkers([], [], response)).toEqual([]);
  });
});

/**
 * ISS-4802 — a component with usage must never render a blank chart frame.
 *
 * The production symptom was an area with no bars, no axes, AND no empty state,
 * on a component with 61 invocations. That specific combination is diagnostic:
 * the chart's empty check asks whether every plotted value is `0`, so a
 * non-finite value slips past it (`NaN === 0` is false), the "No usage recorded"
 * fallback is skipped, and the renderer is handed a `NaN` that collapses the
 * y-domain — painting nothing at all.
 */
describe("buildTokenTrendSeries dirty-input hardening (ISS-4802)", () => {
  const basePoint = {
    sessionId: "s1",
    sessionStartedAt: "2026-06-01T10:00:00.000Z",
    model: "claude-opus-4-5",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0.1,
    runtimeMs: 1000,
    componentInvocations: 1,
    componentErrorCount: 0,
  };

  const seriesFor = (
    points: TokenTrendResponse["points"],
    models: string[] = ["claude-opus-4-5"]
  ) =>
    buildTokenTrendSeries(
      { slug: "tool::_create_pull_request", models, points },
      UsageMetric.Tokens
    );

  it("plots a finite total when a token field did not arrive on the wire", () => {
    // The producer is version-skewed, so `number` is a compile-time claim only.
    const point = {
      ...basePoint,
      cacheReadTokens: undefined,
    } as unknown as TokenTrendResponse["points"][number];

    const { points } = seriesFor([point]);

    const total = points[0]?.values["claude-opus-4-5"];
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBe(150);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a non-numeric string", "n/a"],
  ])("keeps every plotted value finite when a field is %s", (_label, bad) => {
    const point = {
      ...basePoint,
      outputTokens: bad,
    } as unknown as TokenTrendResponse["points"][number];

    const { points } = seriesFor([point]);

    for (const bucket of points) {
      for (const value of Object.values(bucket.values)) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  /**
   * ISS-4798/ISS-4802: an absent cost estimate is UNKNOWN, never a measured
   * zero. Coercing it to 0 drew a $0.00 point beside days with real spend, which
   * reads as a day nobody spent anything — the fabricated-measurement shape root
   * AGENTS.md names explicitly. The point is dropped from the bucket instead.
   */
  it("drops an unattributed cost point rather than plotting it as $0", () => {
    const unattributed = {
      ...basePoint,
      sessionStartedAt: "2026-02-01T00:00:00.000Z",
      estimatedCostUsd: null,
    } as unknown as TokenTrendResponse["points"][number];
    const measured = {
      ...basePoint,
      sessionStartedAt: "2026-02-02T00:00:00.000Z",
      estimatedCostUsd: 4.5,
    } as unknown as TokenTrendResponse["points"][number];

    const { points } = buildTokenTrendSeries(
      {
        slug: "tool::_create_pull_request",
        models: ["claude-opus-4-5"],
        points: [unattributed, measured],
      },
      UsageMetric.Cost
    );

    // Only the day we could actually price is plotted; the unpriced day is
    // absent, not a zero sitting next to real spend.
    expect(points.map((bucket) => bucket.date)).toEqual(["2026-02-02"]);
    expect(points[0]?.values["claude-opus-4-5"]).toBe(4.5);
  });

  it("resolves to the empty series when NO point carries a cost estimate", () => {
    // With every cost unknown there is nothing to plot, so the chart falls
    // through to its own empty state (whose $-toggle copy names spend) rather
    // than drawing a flat $0.00 line across the range.
    const point = {
      ...basePoint,
      estimatedCostUsd: null,
    } as unknown as TokenTrendResponse["points"][number];

    const { points } = buildTokenTrendSeries(
      {
        slug: "tool::_create_pull_request",
        models: ["claude-opus-4-5"],
        points: [point],
      },
      UsageMetric.Cost
    );

    expect(points).toEqual([]);
  });

  it("still plots a genuine zero-dollar day", () => {
    // The distinction the null-preserving path must not lose: a real measured 0
    // is data, and it still renders.
    const point = {
      ...basePoint,
      estimatedCostUsd: 0,
    } as unknown as TokenTrendResponse["points"][number];

    const { points } = buildTokenTrendSeries(
      {
        slug: "tool::_create_pull_request",
        models: ["claude-opus-4-5"],
        points: [point],
      },
      UsageMetric.Cost
    );

    expect(points[0]?.values["claude-opus-4-5"]).toBe(0);
  });

  /**
   * wongk (PR #4322): `point.model` reaches the DOM as a series label and was
   * the one field the numeric hardening skipped. An absent value minted
   * `{ key: undefined, label: undefined }` — the literal word "undefined" in the
   * legend, and a TypeError from `providerOf` on the By-provider toggle.
   */
  it("folds a point with no model under an explicit label instead of undefined", () => {
    const point = {
      ...basePoint,
      model: null,
    } as unknown as TokenTrendResponse["points"][number];

    const { series, points } = buildTokenTrendSeries(
      { slug: "tool::t", models: [], points: [point] },
      UsageMetric.Tokens
    );

    expect(series).toEqual([{ key: "Unattributed", label: "Unattributed" }]);
    // The usage is preserved under that label, not dropped.
    expect(points[0]?.values.Unattributed).toBeGreaterThan(0);
    for (const entry of series) {
      expect(typeof entry.key).toBe("string");
    }
  });

  it("folds a blank model string under the same label", () => {
    const point = {
      ...basePoint,
      model: "   ",
    } as unknown as TokenTrendResponse["points"][number];

    const { series } = buildTokenTrendSeries(
      { slug: "tool::t", models: [], points: [point] },
      UsageMetric.Tokens
    );

    expect(series).toEqual([{ key: "Unattributed", label: "Unattributed" }]);
  });

  /**
   * closedloop-ai-stage (PR #4322): the same untrusted model name arrives in
   * TWO places, and hardening only `point.model` left the other one open. A
   * `null` or blank ELEMENT inside the `models[]` convenience list reached the
   * legend verbatim as `{ key: null, label: null }` — the literal word in the
   * swatch, and `providerOf(null)` (`model.toLowerCase()`) throwing on the
   * By-provider toggle. Unlike a point, a declared name carries no usage to
   * account for, so it is dropped rather than folded onto "Unattributed".
   */
  it("drops an unusable name declared in models[] instead of legending it", () => {
    const skewed = {
      slug: "tool::t",
      models: [null, "   ", "claude-opus-4-5"],
      points: [{ ...basePoint, model: "claude-opus-4-5" }],
    } as unknown as TokenTrendResponse;

    const { series } = buildTokenTrendSeries(skewed, UsageMetric.Tokens);

    expect(series).toEqual([
      { key: "claude-opus-4-5", label: "claude-opus-4-5" },
    ]);
    for (const entry of series) {
      expect(typeof entry.key).toBe("string");
    }
  });

  /**
   * wongk (PR #4322): a skewed response that omits `models` but still carries
   * valid points must not throw from `new Set(undefined)` — the legend is
   * rebuildable from the points themselves.
   */
  it("rebuilds the legend when the response omits models entirely", () => {
    const skewed = {
      slug: "tool::t",
      points: [{ ...basePoint, model: "claude-opus-4-5" }],
    } as unknown as TokenTrendResponse;

    const { series, points } = buildTokenTrendSeries(
      skewed,
      UsageMetric.Tokens
    );

    expect(series).toEqual([
      { key: "claude-opus-4-5", label: "claude-opus-4-5" },
    ]);
    expect(points).toHaveLength(1);
  });

  it("returns the empty series when the response omits points entirely", () => {
    const skewed = {
      slug: "tool::t",
      models: ["claude-opus-4-5"],
    } as unknown as TokenTrendResponse;

    expect(buildTokenTrendSeries(skewed, UsageMetric.Tokens)).toEqual({
      series: [],
      points: [],
    });
  });

  /**
   * The second way a populated response drew nothing: bucketed values are keyed
   * off `point.model`, but the legend used to come from `data.models` alone. A
   * model the server omitted from that list wrote its value under a key with no
   * matching series — real usage present in the data, absent from the plot.
   */
  it("gives a point's model a series even when the server omitted it from models", () => {
    const { series, points } = seriesFor(
      [{ ...basePoint, model: "gpt-5-codex" }],
      []
    );

    expect(series.map((entry) => entry.key)).toContain("gpt-5-codex");
    expect(points[0]?.values["gpt-5-codex"]).toBe(150);
  });

  it("preserves the server's declared model ordering ahead of discovered ones", () => {
    const { series } = seriesFor(
      [
        { ...basePoint, model: "gpt-5-codex" },
        { ...basePoint, model: "claude-opus-4-5" },
      ],
      ["claude-opus-4-5"]
    );

    expect(series.map((entry) => entry.key)).toEqual([
      "claude-opus-4-5",
      "gpt-5-codex",
    ]);
  });

  it("does not invent a series for a response with no points", () => {
    expect(seriesFor([], ["claude-opus-4-5"])).toEqual({
      series: [],
      points: [],
    });
  });
});
