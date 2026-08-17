import { INSIGHTS_SECTION_OPTIONS } from "@repo/api/src/types/insights";
import { describe, expect, it } from "vitest";
import { getMetricInfo } from "../metric-info";
import {
  type ChartTileDescriptor,
  DEFAULT_DASHBOARD_TILE_IDS,
  getSectionTiles,
  getTile,
  INSIGHTS_TILES,
  REMOVED_DASHBOARD_TILE_IDS,
  TileKind,
} from "../tile-catalog";

describe("tile catalog", () => {
  it("has unique tile ids", () => {
    const ids = INSIGHTS_TILES.map((tile) => tile.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("assigns every tile to a known section", () => {
    for (const tile of INSIGHTS_TILES) {
      expect(INSIGHTS_SECTION_OPTIONS).toContain(tile.section);
    }
  });

  it("partitions tiles across sections with getSectionTiles", () => {
    const total = INSIGHTS_SECTION_OPTIONS.reduce(
      (sum, section) => sum + getSectionTiles(section).length,
      0
    );
    expect(total).toBe(INSIGHTS_TILES.length);
  });

  it("resolves tiles by id and returns undefined for unknown ids", () => {
    expect(getTile("kpi:merged")?.title).toBe("Merged PRs");
    expect(getTile("nope")).toBeUndefined();
  });

  it("has metric-info copy for every tile", () => {
    for (const tile of INSIGHTS_TILES) {
      expect(getMetricInfo(tile.id)).toBeDefined();
    }
  });

  // ISS-4634 (review): the two branch-population donuts window a BROADER
  // population than the Branches list (they count every non-deleted active
  // branch; the list also requires a linked session). The tooltip copy must say
  // so — "every branch we observed active" + the "broader than the list" caveat
  // — rather than promising the list's narrower "active in the selected period"
  // filter, which would invite a reconciliation the two surfaces can't satisfy.
  it("branch-population donut copy states the broader-than-list population (ISS-4634)", () => {
    for (const tileId of ["chart:checkStatus", "chart:branchesWithoutPr"]) {
      const info = getMetricInfo(tileId);
      expect(info?.what).toContain("every branch we observed active");
      expect(info?.how).toContain(
        "broader than the Branches list's session-linked filter"
      );
      // The old copy promised the list's exact filter wording; it must be gone.
      expect(info?.what).not.toBe(
        "Whether branches active in the selected period have a pull request."
      );
    }
  });

  // ISS-5502: neither producer medians "per merged branch" from branch file
  // diffs. Cloud medians deduped merged PRs off each PR's own projected counts
  // (PLN-1535 M4 deleted the branch-file-cache derivation because it
  // double-counted multi-PR branches); desktop medians enriched captured PRs.
  // The copy must name both populations and must not re-assert the branch
  // provenance either one dropped. The ban is on the WORD, not on one phrase:
  // "merged branch" and "the merged branch's file diffs" were two spellings of
  // the same wrong claim, and no correct copy for this tile needs the word at
  // all, so banning a single phrase leaves the rest of them passing.
  it("median-PR-size copy names both surfaces' populations (ISS-5502)", () => {
    const info = getMetricInfo("kpi:pr-size");
    expect(info?.what).toContain("merged PRs");
    expect(info?.what).toContain("captured PRs");
    for (const field of [info?.what, info?.how, info?.sessions]) {
      expect(field).not.toMatch(BRANCH_PROVENANCE);
    }
  });

  // ISS-5502 (review): the populations above are also each SHRUNK before the
  // median is taken, and the dash claim is only honest once both edges are
  // stated. Cloud scans at most MERGED_PR_SCAN_CAP = 25,000 newest merged rows
  // (apps/api/app/insights/merged-pr-queries.ts), so a wide range can dash over
  // a population that does hold a sized merged PR. Desktop's delivery gate
  // (apps/desktop/src/main/database/non-delivery-artifacts.ts) drops any
  // artifact whose only session links are non-delivery evidence — `reviewed`
  // per FEA-3585 AND the prose-mention methods per ISS-5764, not reviews alone.
  it("median-PR-size copy states both retained-population edges (ISS-5502)", () => {
    const info = getMetricInfo("kpi:pr-size");
    expect(info?.how).toMatch(CLOUD_SCAN_CAP);
    expect(info?.how).toMatch(DESKTOP_REVIEWED_ONLY);
    expect(info?.how).toMatch(DESKTOP_PROSE_ONLY);
    // The dash must be attributed to what the producer READ, never to the range.
    expect(info?.how).toMatch(DASH_SCOPED_TO_WHAT_WAS_READ);
  });

  // ISS-5502 (review): this field renders under the FIXED heading "From session
  // logs" (packages/app/insights/components/info-tip.tsx — a literal, not a
  // per-tile prop), and neither line count comes from a session log: cloud reads
  // the merged PR's own projection row, desktop reads the cloud PR record synced
  // down onto its local artifact (cloud-github-overlay-store.ts). The field has
  // to say so, or the heading asserts a provenance the producers contradict.
  it("median-PR-size source copy names the real origins, not session logs (ISS-5502)", () => {
    const info = getMetricInfo("kpi:pr-size");
    expect(info?.sessions).toMatch(NOT_FROM_SESSION_LOG);
    expect(info?.sessions).toMatch(CLOUD_READS_PR_RECORD);
    expect(info?.sessions).toMatch(DESKTOP_READS_SYNCED_CLOUD);
  });

  // ISS-5501: both producers compute merge rate as merged ÷ decided (merged +
  // closed) through the shared `ssotMergeRateFromCounts` SSOT, and the tile's
  // own caption says "of decided PRs". The popover claimed the opened-PR
  // denominator, so one tile made two contradictory claims. Pin the decided
  // denominator so the copy cannot drift back off the SSOT.
  it("states the decided denominator for merge rate (ISS-5501)", () => {
    const info = getMetricInfo("kpi:merge-rate");
    expect(info?.what).toContain("decided PRs");
    expect(info?.how).toContain("decided PRs (merged + closed)");
    // The denominator neither producer uses must be gone from both claims.
    expect(info?.what).not.toContain("opened");
    expect(info?.how).not.toContain("opened");
  });

  it("only defaults to tiles that exist", () => {
    for (const id of DEFAULT_DASHBOARD_TILE_IDS) {
      expect(getTile(id)).toBeDefined();
    }
  });

  it("does not expose retired sessions-by-status dashboard tiles", () => {
    for (const id of Object.values(REMOVED_DASHBOARD_TILE_IDS)) {
      expect(DEFAULT_DASHBOARD_TILE_IDS).not.toContain(id);
      expect(getTile(id)).toBeUndefined();
    }
  });

  it("exposes unit labels for line-based KPI tiles", () => {
    expect(getTile("kpi:pr-size")?.unitLabel).toBe("lines");
    expect(getTile("kpi:kloc")?.unitLabel).toBe("KLOC");
  });

  it("keeps runtime availability out of the static catalog", () => {
    for (const tile of INSIGHTS_TILES) {
      expect(tile).not.toHaveProperty("availability");
      expect(tile).not.toHaveProperty("state");
    }
  });

  // ISS-5507: a tile that declares `titleSuffix` has its heading rebuilt at
  // render time as `<response metric noun> <suffix>`, while `title` stays the
  // default every catalog reader without a response in hand still uses (the
  // metric picker, the loading card). The two must agree, or the heading would
  // silently reword itself the moment the response lands on the cloud surface —
  // where the noun is unchanged and nothing should move.
  it("derives a suffixed tile's default title from its own metric label", () => {
    const suffixed = INSIGHTS_TILES.filter(
      (tile): tile is ChartTileDescriptor =>
        tile.kind !== TileKind.Kpi && tile.titleSuffix !== undefined
    );
    expect(suffixed.length).toBeGreaterThan(0);
    for (const tile of suffixed) {
      expect(tile.title).toBe(`${tile.metricLabel} ${tile.titleSuffix}`);
    }
  });

  it("exposes multiple visualizations for data-backed metric choices", () => {
    expect(kindsForMetric("kloc", "date")).toEqual([
      TileKind.TimeSeries,
      TileKind.TimeSeriesBar,
      TileKind.Heatmap,
    ]);
    expect(kindsForMetric("models", "model")).toEqual([
      TileKind.CategoryBar,
      TileKind.Donut,
    ]);
    expect(kindsForMetric("tool-runs", "date")).toEqual([
      TileKind.TimeSeries,
      TileKind.TimeSeriesBar,
      TileKind.Heatmap,
    ]);
  });
});

/**
 * The retired ISS-5502 provenance, in every spelling. Neither producer reads
 * this metric off a branch, so the word itself is the tell.
 */
const BRANCH_PROVENANCE = /branch/i;
const CLOUD_SCAN_CAP = /newest 25,000 merged PRs/;
const DESKTOP_REVIEWED_ONLY = /only ever saw reviewed/;
const DESKTOP_PROSE_ONLY = /only ever saw mentioned in prose/;
const DASH_SCOPED_TO_WHAT_WAS_READ = /no PR it read has a known size/;
const NOT_FROM_SESSION_LOG = /Neither figure is read from a session log/;
const CLOUD_READS_PR_RECORD = /each merged PR's own record/;
const DESKTOP_READS_SYNCED_CLOUD = /synced down from the cloud/;

function kindsForMetric(metricKey: string, groupBy: string): string[] {
  return INSIGHTS_TILES.filter(
    (tile) => tile.metricKey === metricKey && tile.groupBy?.key === groupBy
  ).map((tile) => tile.kind);
}
