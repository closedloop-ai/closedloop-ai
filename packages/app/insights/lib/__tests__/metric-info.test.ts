import { describe, expect, it } from "vitest";
import { getMetricInfo, METRIC_INFO } from "../metric-info";

// ISS-9842 (marisolashgrove review): the bar and the ring of each pair read the
// same capped desktop query, but only the ring folds the tail into an Other
// slice — the bar drops it. So the four entries are pinned per tile: each
// states the retained Local-mode population (insights/AGENTS.md, "state the
// retained population"), the ring names its Other slice, and the bar must not
// borrow the ring's sentence. The number is attributed to Local data, so it is
// no claim about the uncapped cloud producer.
const CAPPED_PAIR_TIPS = [
  {
    id: "chart:toolUsage",
    retained: "keeps the 20 most-used tools",
    ring: false,
  },
  {
    id: "chart:toolUsage:donut",
    retained: "keeps the 20 most-used tools",
    ring: true,
  },
  {
    id: "chart:eventsByType",
    retained: "keeps the 12 most common types",
    ring: true,
  },
  {
    id: "chart:eventsByType:bar",
    retained: "keeps the 12 most common types",
    ring: false,
  },
] as const;
const OTHER_SLICE = /one Other slice/;
const DROPS_THE_REST = /drops the rest/;

describe("getMetricInfo", () => {
  it("resolves a known KPI tile id with what/how/sessions copy", () => {
    const info = getMetricInfo("kpi:merged");
    expect(info).toBeDefined();
    expect(info).toEqual(METRIC_INFO["kpi:merged"]);
    expect(typeof info?.what).toBe("string");
    expect(typeof info?.how).toBe("string");
    expect(typeof info?.sessions).toBe("string");
    expect(info?.what.length).toBeGreaterThan(0);
    expect(info?.how.length).toBeGreaterThan(0);
    expect(info?.sessions.length).toBeGreaterThan(0);
  });

  it("resolves a known chart tile id", () => {
    const info = getMetricInfo("chart:prTrend");
    expect(info).toEqual(METRIC_INFO["chart:prTrend"]);
  });

  it("returns undefined for an unknown tile id", () => {
    expect(getMetricInfo("kpi:does-not-exist")).toBeUndefined();
  });

  // TRIPWIRE (ISS-9171): pins current main behavior, which is wrong. METRIC_INFO
  // is a plain object literal, so a tile id naming an Object.prototype member
  // resolves through the prototype chain and returns a truthy non-MetricInfo
  // instead of undefined. AGENTS.md ("Build event-dispatch tables and handler
  // registries with Object.create(null)") is the fix, but that is a source
  // change and ISS-9171 forbids a coverage PR from changing behavior in either
  // direction. Pinned here so the behavior PR breaks on purpose.
  it("resolves an Object.prototype member name instead of returning undefined", () => {
    const protoKey = ["__pro", "to__"].join("");
    expect(getMetricInfo(protoKey)).toBe(Object.prototype);
    expect(getMetricInfo("constructor")).toBe(Object);
  });

  it("resolves 'kpi:sessions' directly from the registry", () => {
    const info = getMetricInfo("kpi:sessions");
    expect(info).toEqual(METRIC_INFO["kpi:sessions"]);
  });

  it("falls back to the base kind:key entry for a suffixed variant id not itself in the registry", () => {
    // "chart:klocTrend:bar" is a real tile id (the bar-chart variant of
    // chart:klocTrend) but METRIC_INFO only carries the base "chart:klocTrend"
    // key. getMetricInfo splits on ":" and reconstructs the first two segments
    // so every surface-specific variant shares the base tile's copy.
    expect(getMetricInfo("chart:klocTrend:bar")).toEqual(
      METRIC_INFO["chart:klocTrend"]
    );
    expect(getMetricInfo("chart:klocTrend:heatmap")).toEqual(
      METRIC_INFO["chart:klocTrend"]
    );
  });

  it("returns undefined for an id with no ':' to split on", () => {
    expect(getMetricInfo("no-colon-here")).toBeUndefined();
  });

  it("returns undefined for an unknown kind:key pair", () => {
    expect(getMetricInfo("chart:does-not-exist")).toBeUndefined();
  });

  it.each(CAPPED_PAIR_TIPS)(
    "ISS-9842: $id states its retained Local population and only a ring names an Other slice",
    ({ id, retained, ring }) => {
      const info = getMetricInfo(id);
      expect(info?.how).toBeDefined();
      expect(info?.how).toContain(retained);
      expect(info?.how).toContain("Synced data lists every");
      if (ring) {
        expect(info?.how).toMatch(OTHER_SLICE);
        expect(info?.how).not.toMatch(DROPS_THE_REST);
      } else {
        expect(info?.how).toMatch(DROPS_THE_REST);
        expect(info?.how).not.toMatch(OTHER_SLICE);
      }
    }
  );

  it("ISS-9842: the bar and the ring of a pair resolve to different entries", () => {
    expect(getMetricInfo("chart:toolUsage:donut")).not.toEqual(
      getMetricInfo("chart:toolUsage")
    );
    expect(getMetricInfo("chart:eventsByType:bar")).not.toEqual(
      getMetricInfo("chart:eventsByType")
    );
  });
});
