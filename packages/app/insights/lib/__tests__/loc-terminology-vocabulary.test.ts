import { INSIGHTS_LOC_TERMINOLOGY_FLAG_KEY } from "@repo/api/src/types/insights-loc-terminology-flag";
import { describe, expect, it } from "vitest";
import { getMetricInfo, LOC_TERMINOLOGY_METRIC_INFO } from "../metric-info";
import { getTile, resolveTileVocabulary } from "../tile-catalog";

/**
 * ISS-8184. Every expected string here is a LITERAL rather than the constant it
 * guards: a fixture that imports `LOC_TERMINOLOGY_VOCABULARY` agrees with any
 * future edit to it, so it could not fail on the rename it exists to pin.
 */
const ON = (key: string) => key === INSIGHTS_LOC_TERMINOLOGY_FLAG_KEY;
const OFF = () => false;

function tile(id: string) {
  const found = getTile(id);
  if (found === undefined) {
    throw new Error(`no catalog tile ${id}`);
  }
  return found;
}

describe("resolveTileVocabulary", () => {
  it("leaves every tile alone when the flag is off", () => {
    const kpi = resolveTileVocabulary(tile("kpi:kloc"), OFF);

    expect(kpi.title).toBe("KLOC merged");
    expect(kpi.metricLabel).toBe("KLOC merged");
    expect(kpi.dataKey).toBe("kloc");
    expect(kpi.unitLabel).toBe("KLOC");
  });

  it("swaps the volume KPI onto the raw-line label AND the raw-line operand", () => {
    const kpi = resolveTileVocabulary(tile("kpi:kloc"), ON);

    expect(kpi.title).toBe("Merged LOC");
    expect(kpi.metricLabel).toBe("Merged LOC");
    // The operand moves with the word. A relabel alone would put a thousands
    // figure under a label that says lines.
    expect(kpi.dataKey).toBe("loc");
    expect(kpi.metricKey).toBe("loc");
    // DOC-27 R4a: the label already carries the unit, so the value does not
    // repeat it.
    expect(kpi.unitLabel).toBeUndefined();
  });

  it("keeps the tile id, so a pinned dashboard survives the flag flip", () => {
    expect(resolveTileVocabulary(tile("kpi:kloc"), ON).id).toBe("kpi:kloc");
  });

  it.each([
    ["chart:klocTrend", "KLOC merged over time", "Merged LOC over time"],
    ["chart:klocTrend:bar", "KLOC merged by day", "Merged LOC by day"],
    ["chart:klocTrend:heatmap", "KLOC merged heatmap", "Merged LOC heatmap"],
  ])("swaps %s from %s to %s", (id, off, on) => {
    expect(resolveTileVocabulary(tile(id), OFF).title).toBe(off);

    const flagged = resolveTileVocabulary(tile(id), ON);
    expect(flagged.title).toBe(on);
    expect(flagged.metricLabel).toBe("Merged LOC");
    expect(flagged.dataKey).toBe("locTrend");
  });

  it("does not touch a tile outside the volume vocabulary", () => {
    const cost = tile("kpi:cost");

    expect(resolveTileVocabulary(cost, ON)).toBe(cost);
  });
});

describe("LOC terminology metric info", () => {
  it("drops the divide-by-1,000 sentence and quotes the new labels", () => {
    const flagged = getMetricInfo("kpi:kloc", LOC_TERMINOLOGY_METRIC_INFO);

    expect(flagged?.what).toContain("Merged LOC");
    expect(flagged?.what).not.toContain("Captured LOC");
    expect(flagged?.what).not.toContain("KLOC");
    expect(flagged?.how).not.toContain("divided by 1,000");
  });

  it("leaves the shipped registry on the KLOC wording", () => {
    expect(getMetricInfo("kpi:kloc")?.what).toContain("KLOC merged");
  });

  it("carries every non-volume entry through unchanged", () => {
    expect(getMetricInfo("kpi:ttm", LOC_TERMINOLOGY_METRIC_INFO)).toEqual(
      getMetricInfo("kpi:ttm")
    );
  });
});
