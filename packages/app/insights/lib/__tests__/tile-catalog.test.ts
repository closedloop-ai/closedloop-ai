import {
  INSIGHTS_SECTION_OPTIONS,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { describe, expect, it } from "vitest";
import type { MetricInfo } from "../metric-info";
import {
  getMetricInfo,
  LOC_TERMINOLOGY_METRIC_INFO,
  METRIC_INFO,
} from "../metric-info";
import {
  DEFAULT_DASHBOARD_TILE_IDS,
  getSectionTiles,
  getTile,
  INSIGHTS_TILES,
  isKpiTile,
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

  // ISS-11915 (Marisol Ashgrove, 2026-10-08): the two branch-population donuts
  // count the Branches list population for the period, so the ISS-4634
  // "broader than the list" clause was dropped from their `how` copy. The
  // exact strings pin that only the clause went.
  it("branch-population donut copy no longer claims a broader-than-list population (ISS-11915)", () => {
    expect(getMetricInfo("chart:checkStatus")?.how).toBe(
      "The range picks which branches are counted by their last activity; each is grouped by its checks status right now."
    );
    expect(getMetricInfo("chart:branchesWithoutPr")?.how).toBe(
      "The range picks which branches are counted by their last activity; each is split by whether it has a PR right now."
    );
    for (const tileId of ["chart:checkStatus", "chart:branchesWithoutPr"]) {
      const info = getMetricInfo(tileId);
      expect(info?.what).toContain("every branch we observed active");
      // The old copy promised the list's exact filter wording; it must be gone.
      expect(info?.what).not.toBe(
        "Whether branches active in the selected period have a pull request."
      );
    }
  });

  // ISS-6845: five Delivery-chart entries still claimed the session provenance
  // ISS-5505 deleted from `kpi:merged`, and no producer reads a session for the
  // attribute each line named — the repo comes off the PR row
  // (`buildPrByRepoBuckets`), the state split is `mergedStateBuckets(<merged
  // count>)`, the check donut groups `BranchDetail.checksStatus`, and the
  // coverage donut splits on the branch artifact's own pull-request rows.
  it("credits the PR/branch record, not a session, for chart provenance (ISS-6845)", () => {
    for (const [tileId, removedClaim] of Object.entries(
      RECORD_SOURCED_CHARTS
    )) {
      const { sessions } = metricInfoOf(tileId);
      expect(sessions).not.toContain(removedClaim);
      expect(sessions).toContain("own record");
    }
  });

  // The lifespan bands are the time-to-merge intervals in different buckets, so
  // the two entries must name the same timestamps — anything else means one of
  // them drifted off the shared `ttms`/`latencies` array they both read.
  it("gives branch lifespan the time-to-merge chart's provenance (ISS-6845)", () => {
    expect(metricInfoOf("chart:branchLifespan").sessions).toBe(
      metricInfoOf("chart:meanTimeToMerge").sessions
    );
  });

  // ISS-6845 (review): identical PROVENANCE must not become identical COPY.
  // The one thing that does differ is the band edges — `lifespanHistogram`'s
  // three day-scale bands against `ttmHistogram`'s five hour-scale ones
  // (packages/loops-api/src/insights.ts) — so a reader looking at two charts of
  // the same intervals is owed the reason they disagree on shape.
  it("still distinguishes the lifespan bands from the time-to-merge bands (ISS-6845)", () => {
    const lifespan = metricInfoOf("chart:branchLifespan");
    expect(lifespan.how).not.toBe(metricInfoOf("chart:meanTimeToMerge").how);
    expect(`${lifespan.what} ${lifespan.how}`).toContain("day-scale");
  });

  it("keeps every population-claim entry on a real tile (ISS-5506)", () => {
    for (const { tileId } of CLOUD_POPULATION_METRIC_INFO) {
      expect(getTile(tileId)).toBeDefined();
      expect(getMetricInfo(tileId)).toBeDefined();
    }
  });

  // A one-sided rewrite is the drift that shipped: an author editing a producer
  // restates its population and the popover claims one it never computes.
  // Pinning the claim is what makes that go red.
  it("states the cloud population in each entry that makes one (ISS-5506)", () => {
    for (const { tileId, cloud } of CLOUD_POPULATION_METRIC_INFO) {
      expect(infoCopy(tileId).join(" ")).toContain(cloud);
    }
  });

  // ISS-12638 (operator ruling, "Delete the Desktop clauses"): the widgets do
  // not know which surface they render on and carry one title in every mode, so
  // no popover describes the Desktop producer. This replaces the ISS-5506
  // assertions that every distinguishing field named BOTH surfaces, which
  // encoded the contract the ruling retired.
  it("names no Desktop producer in either metric-info registry (ISS-12638)", () => {
    expect(entriesMatching(DESKTOP_SURFACE)).toEqual([]);
  });

  // The Desktop wording also survives as an antecedent-less plural ("both
  // surfaces").
  it("leaves no two-surface wording in either metric-info registry (ISS-12638)", () => {
    expect(entriesMatching(TWO_SURFACE_WORDING)).toEqual([]);
  });

  // ISS-5503: PLN-1535 M4 replaced the branch-file-cache derivation with a
  // per-PR one precisely because the branch sum double-counted a branch carrying
  // two merged PRs. A reader uses this popover to tell a data problem from a
  // definition problem, so it must credit the derivation that actually runs.
  it("attributes cloud KLOC to the per-PR projection, not the branch (ISS-5503)", () => {
    const info = getMetricInfo("kpi:kloc");
    expect(info?.how).toContain("Cloud sums merged PRs only");
    expect(info?.sessions).toContain("each merged PR's own additions");
    // The deleted branch derivation must not be credited by either field.
    expect(info?.how).not.toContain("merged branches");
    expect(info?.sessions).not.toContain("merged branch");
    // ISS-5503 (review): this field renders under InfoTip's FIXED "From session
    // logs" heading (info-tip.tsx), but the counts are GitHub's, read from the
    // projected pull request. It must not credit the session log, and since
    // ISS-12594 it carries no Desktop clause.
    expect(info?.sessions).toContain("as GitHub reported them");
    expect(info?.sessions).not.toContain("Desktop");
    expect(info?.sessions).not.toContain("cloud hydration");
  });

  // The KPI and the trend chart are the SAME metric over the same deduped
  // per-PR population, so a reader must not get two derivations for it
  // depending on which popover they open.
  it("gives the KLOC trend the same per-PR provenance as the KPI (ISS-5503)", () => {
    const info = getMetricInfo("chart:klocTrend");
    expect(info?.sessions).toContain("each merged PR's own additions");
    expect(info?.sessions).not.toContain("branch file changes");
    // The per-PR/deduped clause is cloud's; it must not be extended to Desktop.
    expect(info?.sessions).toContain("Cloud reads");
    expect(info?.sessions).toContain("collapsed to one contribution");
    expect(info?.sessions).not.toContain("Desktop");
    expect(info?.sessions).toContain("as GitHub reported them");
  });

  // ISS-5506 (review): cloud KLOC is derived from the SAME capped row scan the
  // median-PR-size tile already discloses. `fetchMergedPrs` takes at most
  // MERGED_PR_SCAN_CAP = 25,000 rows ordered `mergedAt desc`
  // (apps/api/app/insights/merged-pr-queries.ts), and both the KPI
  // (`mergedPrLocTotals`) and the trend (`bucketKlocByDay`) sum that scan — so a
  // wide range drops older merged PRs from both, and copy that says "merged PRs"
  // without the edge claims a population neither figure actually read.
  //
  // ISS-6849: that argument is not specific to KLOC — it holds for EVERY figure
  // built from the same scan, and four of them shipped without the sentence. The
  // guard is therefore an inventory over all of them, asserted from the catalog
  // side because `apps/api` is gated from importing this package: add a Delivery
  // figure derived from that scan and it has to join this list.
  it("states the cloud retained-population edge on every capped-scan entry (ISS-5506, ISS-6849)", () => {
    for (const tileId of CAPPED_MERGED_PR_SCAN_TILE_IDS) {
      expect(getMetricInfo(tileId)?.how).toMatch(CLOUD_SCAN_CAP);
    }
  });

  // ISS-6849: the headline "Merged PRs" count is the shared fold's UNCAPPED count
  // (ISS-12408), so it must NOT carry the sentence — a cap stated
  // on the one exact figure on the page is the mirror-image false claim.
  it("does not claim the scan cap on the uncapped merged-PR count (ISS-6849)", () => {
    for (const field of METRIC_INFO_FIELDS) {
      expect(metricInfoOf("kpi:merged")[field]).not.toMatch(CLOUD_SCAN_CAP);
    }
  });

  // ISS-5505: the cloud `merged` KPI is the genuinely-merged count. The copy
  // names that population; ISS-12638 (operator ruling) dropped the Desktop
  // captured-PR half, so "Captured PRs" must not reach the popover.
  it("merged-PR KPI copy states the merged population only (ISS-5505)", () => {
    const info = getMetricInfo("kpi:merged");

    expect(info?.what).toContain("Merged PRs");
    expect(info?.what).not.toContain("Captured PRs");
  });

  // ISS-5505 (review): pin the cloud merge-date derivation verbatim — a
  // paraphrase-tolerant substring is what let a derivation be swapped for other
  // semantics with every assertion green.
  it("merged-PR KPI copy pins the cloud derivation verbatim (ISS-5505)", () => {
    const info = getMetricInfo("kpi:merged");

    expect(info?.how).toContain(MERGED_KPI_CLOUD_HOW);
  });

  // ISS-5505 (review): the cloud count filters `prState` MERGED + `mergedAt` in
  // range over the org/user/team-scoped PR projection and never joins an
  // authoring session (`mergedPrWhere`, apps/api/app/insights/merged-pr-queries
  // .ts). The popover must describe provider PR state, not a provenance the
  // count does not have.
  it("merged-PR KPI copy does not claim cloud session provenance (ISS-5505)", () => {
    const info = getMetricInfo("kpi:merged");

    expect(info?.sessions).toContain(MERGED_KPI_CLOUD_NO_SESSION_LINK);
    expect(info?.sessions).not.toContain(MERGED_KPI_RETIRED_SESSION_CLAIM);
  });

  // ISS-5502: neither producer medians "per merged branch" from branch file
  // diffs. Cloud medians deduped merged PRs off each PR's own projected counts
  // (PLN-1535 M4 deleted the branch-file-cache derivation because it
  // double-counted multi-PR branches); desktop medians enriched captured PRs.
  // The copy must name the cloud population and must not re-assert the branch
  // provenance either one dropped. The ban is on the WORD, not on one phrase:
  // "merged branch" and "the merged branch's file diffs" were two spellings of
  // the same wrong claim, and no correct copy for this tile needs the word at
  // all, so banning a single phrase leaves the rest of them passing.
  it("median-PR-size copy names the cloud population (ISS-5502)", () => {
    const info = getMetricInfo("kpi:pr-size");
    expect(info?.what).toContain("merged PRs");
    expect(info?.what).not.toContain("captured PRs");
    for (const field of [info?.what, info?.how, info?.sessions]) {
      expect(field).not.toMatch(BRANCH_PROVENANCE);
    }
  });

  // ISS-5502 (review): the dash claim is only honest when attributed to what the
  // producer READ, never to the range. Cloud's median no longer passes
  // MERGED_PR_SCAN_CAP (ISS-11589), so its cap assertion was removed with the
  // copy; ISS-12638 (operator ruling) removed the Desktop retained-population
  // edge that used to sit beside it.
  it("median-PR-size dash is attributed to what was read (ISS-5502)", () => {
    const info = getMetricInfo("kpi:pr-size");
    expect(info?.how).toMatch(DASH_SCOPED_TO_WHAT_WAS_READ);
    expect(info?.how).not.toMatch(DESKTOP_REVIEWED_ONLY);
    expect(info?.how).not.toMatch(DESKTOP_PROSE_ONLY);
  });

  // ISS-5502 (review): this field renders under the FIXED heading "From session
  // logs" (packages/app/insights/components/info-tip.tsx — a literal, not a
  // per-tile prop), and the line count does not come from a session log: cloud
  // reads the merged PR's own projection row. The field has to say so, or the
  // heading asserts a provenance the producer contradicts. Since ISS-12594 it
  // carries no Desktop clause.
  it("median-PR-size source copy names the cloud origin, not session logs (ISS-5502)", () => {
    const info = getMetricInfo("kpi:pr-size");
    expect(info?.sessions).toMatch(NOT_FROM_SESSION_LOG);
    expect(info?.sessions).toMatch(CLOUD_READS_PR_RECORD);
    expect(info?.sessions).not.toMatch(DESKTOP_READS_SYNCED_CLOUD);
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

// ISS-5505 (review): the exact `kpi:merged` sentences the popover must carry.
// Verbatim on purpose — a paraphrase-tolerant substring is what let the desktop
// derivation be swapped for merge-date semantics with every assertion green.
const MERGED_KPI_CLOUD_HOW =
  "On the cloud dashboard, counts PRs whose merge date falls in the range.";
const MERGED_KPI_CLOUD_NO_SESSION_LINK =
  "no authoring-session link is required";
const MERGED_KPI_RETIRED_SESSION_CLAIM =
  "linked to the authoring agent session";

/**
 * The retired ISS-5502 provenance, in every spelling. Neither producer reads
 * this metric off a branch, so the word itself is the tell.
 */
const BRANCH_PROVENANCE = /branch/i;
/**
 * ISS-6849 (review): the cap is a `LIMIT` on `pull_request_detail` ROWS
 * (`fetchMergedPrs`, apps/api/app/insights/merged-pr-queries.ts) and
 * `dedupeMergedPrsWithEarliestCreation` collapses twin projections AFTER it, so
 * the scan can retain fewer than 25,000 distinct PRs. The regex pins the ROW
 * wording precisely so a revert to the per-PR claim goes red here.
 */
const CLOUD_SCAN_CAP = /newest 25,000 merged-PR rows/;
/**
 * ISS-6849: every Delivery figure the cloud producer computes app-side over the
 * MERGED_PR_SCAN_CAP-bounded merged-PR row scan — the cap's own docstring names
 * them (apps/api/app/insights/merged-pr-queries.ts): the median-TTM, KLOC and
 * median-PR-size KPIs, and the repo, TTM and lifespan histograms. They read one
 * population through one capped scan, so the cap has to be disclosed on every
 * one of their popovers or the reader learns it from whichever they happen to
 * open — beside a headline "Merged PRs" count that is exact and uncapped.
 *
 * `chart:prTrend` is on the list too even though the docstring predates it: its
 * cloud half buckets the same `dedupedMerged` rows (`bucketCountByDay`,
 * apps/api/app/insights/service.ts), so its bars sum to at most the cap.
 */
const CAPPED_MERGED_PR_SCAN_TILE_IDS = [
  "kpi:ttm",
  "chart:prTrend",
  "kpi:kloc",
  "chart:prByRepo",
  "chart:klocTrend",
  "chart:meanTimeToMerge",
  "chart:branchLifespan",
] as const;
const DESKTOP_REVIEWED_ONLY = /only ever saw reviewed/;
const DESKTOP_PROSE_ONLY = /only ever saw mentioned in prose/;
const DASH_SCOPED_TO_WHAT_WAS_READ = /no PR it read has a known size/;
const NOT_FROM_SESSION_LOG = /Neither figure is read from a session log/;
// ISS-6845: tile id -> the session-provenance claim its `sessions` line used to
// make. `chart:branchLifespan` is absent because its corrected copy is the
// dual-surface time-to-merge sentence, pinned by its own assertion instead.
const RECORD_SOURCED_CHARTS: Record<string, string> = {
  "chart:prByRepo": "comes from the session that opened",
  "chart:prByState": "PR state on each session's proposal",
  "chart:checkStatus": "captured from CI events",
  "chart:branchesWithoutPr": "taken from session metadata",
};

const CLOUD_READS_PR_RECORD = /each merged PR's own record/;
const DESKTOP_READS_SYNCED_CLOUD = /synced down from the cloud/;

function kindsForMetric(metricKey: string, groupBy: string): string[] {
  return INSIGHTS_TILES.filter(
    (tile) => tile.metricKey === metricKey && tile.groupBy?.key === groupBy
  ).map((tile) => tile.kind);
}

// ISS-5506: the cloud population claim each popover must keep. The info popover
// is the only place a reader learns what a figure counts, and nothing pinned
// that copy to what the producer computes, so entries drifted one-sided through
// PLN-1535 M4 and FEA-2942/FEA-3151. ISS-12638 (operator ruling) removed the
// Desktop half of each claim; what remains is pinned here.
const CLOUD_POPULATION_METRIC_INFO: { tileId: string; cloud: string }[] = [
  {
    tileId: "kpi:merged",
    // Pin the population claim from `what`, not the derivation sentence — that
    // has its own verbatim pin (MERGED_KPI_CLOUD_HOW).
    cloud: "The cloud dashboard counts PRs merged in the period",
  },
  { tileId: "kpi:ttm", cloud: "across merged PRs only" },
  {
    tileId: "kpi:kloc",
    // Cloud KLOC sums each DEDUPED MERGED PR's own additions + deletions
    // (`mergedPrLocTotals`, apps/api/app/insights/merged-pr-loc.ts). The
    // branch-summed derivation this replaced double-counted a branch carrying
    // two merged PRs, so pinning a per-branch unit here would pin the very
    // arithmetic PLN-1535 M4 removed.
    cloud: "The cloud dashboard sums merged PRs",
  },
  { tileId: "kpi:pr-size", cloud: "The cloud dashboard medians merged PRs" },
  { tileId: "chart:prTrend", cloud: "merged PRs are bucketed by merge day" },
  {
    tileId: "chart:klocTrend",
    // The trend is the KLOC KPI's own population bucketed by day: cloud buckets
    // DEDUPED MERGED PRs (`bucketKlocByDay` over `mergedPullRequestLoc`,
    // apps/api/app/insights/service.ts).
    cloud: "The cloud dashboard buckets merged PRs",
  },
  {
    // ISS-6849 (review): pin the producer's actual UNIT. Cloud buckets one
    // duration per DEDUPED MERGED PR, so a per-branch pin would accept the
    // branch-keyed prose PLN-1535 M4's arithmetic retired.
    tileId: "chart:meanTimeToMerge",
    cloud: "one branch-creation → merge duration per merged PR is bucketed",
  },
  {
    tileId: "chart:prByRepo",
    cloud: "merged PRs are counted per source repository",
  },
  {
    // Same array as the time-to-merge histogram, so the same pin, character for
    // character; only the band edges differ and those are `what`'s to state
    // (ISS-6845).
    tileId: "chart:branchLifespan",
    cloud: "one branch-creation → merge duration per merged PR is bucketed",
  },
];

// The Record annotation is what makes a field added to MetricInfo fail typecheck
// here, rather than silently escaping the guards above; Object.keys then widens
// back to string, so the cast restores the key type it just erased.
const METRIC_INFO_FIELD_SET: Record<keyof MetricInfo, true> = {
  what: true,
  how: true,
  sessions: true,
};
const METRIC_INFO_FIELDS = Object.keys(
  METRIC_INFO_FIELD_SET
) as (keyof MetricInfo)[];

const DESKTOP_SURFACE = /\bdesktop\b/i;
const TWO_SURFACE_WORDING = /\b(both|two|either) surfaces?\b/i;

function metricInfoOf(tileId: string): MetricInfo {
  const info = getMetricInfo(tileId);
  if (!info) {
    throw new Error(`No metric info for tile ${tileId}`);
  }
  return info;
}

function infoCopy(tileId: string): string[] {
  const info = metricInfoOf(tileId);
  return METRIC_INFO_FIELDS.map((field) => info[field]);
}

/**
 * Both registries, because `LOC_TERMINOLOGY_METRIC_INFO` spreads
 * `METRIC_INFO` and then REPLACES `what`/`how` on `kpi:kloc` and
 * `chart:klocTrend` — strings a walk over `METRIC_INFO` alone never reads, so a
 * clause reintroduced in an override entry escapes it (tamsinb, #9101).
 */
function entriesMatching(pattern: RegExp): string[] {
  const matches = [METRIC_INFO, LOC_TERMINOLOGY_METRIC_INFO].flatMap(
    (registry) =>
      Object.entries(registry)
        .filter(([, info]) =>
          pattern.test(METRIC_INFO_FIELDS.map((field) => info[field]).join(" "))
        )
        .map(([tileId]) => tileId)
  );
  return [...new Set(matches)].sort();
}

/**
 * ISS-8424: the cloud producer reports every merged-PR-derived Delivery tile
 * Unavailable when nothing in the org-merged population has been verified
 * (`apps/api/app/insights/service/tiles.ts` → `MERGED_PR_DERIVED_TILE_IDS`).
 *
 * That list is hand-kept because `apps/api` is gated from importing this
 * catalog, and a hand-kept list cannot notice a variant added here. A tile it
 * misses does NOT fall back to Unavailable — it renders "No data yet", the
 * measured-zero statement this whole change exists to stop, sitting on the same
 * screen as its own Unavailable KPI. So the catalog asserts the inventory from
 * its own side: add a variant of one of these charts and this fails, naming the
 * file to update.
 */
describe("merged-PR Delivery charts the cloud availability map must cover (ISS-8424)", () => {
  const MERGED_PR_CHART_DATA_KEYS = new Set([
    "prTrend",
    "klocTrend",
    "prByRepo",
    "prByState",
    "meanTimeToMerge",
    "branchLifespan",
  ]);

  it("matches MERGED_PR_DERIVED_TILE_IDS in apps/api/app/insights/service/tiles.ts", () => {
    const derived = INSIGHTS_TILES.filter(
      (tile) =>
        tile.section === InsightsSection.Delivery &&
        !isKpiTile(tile) &&
        MERGED_PR_CHART_DATA_KEYS.has(tile.dataKey)
    )
      .map((tile) => tile.id)
      .sort();

    // Spelled out, not imported: importing the producer's constant would make
    // this assert that a list equals itself. This is the independent statement.
    expect(derived).toEqual(
      [
        "chart:branchLifespan",
        "chart:branchLifespan:donut",
        "chart:klocTrend",
        "chart:klocTrend:bar",
        "chart:klocTrend:heatmap",
        "chart:meanTimeToMerge",
        "chart:meanTimeToMerge:donut",
        "chart:prByRepo",
        "chart:prByRepo:donut",
        "chart:prByState",
        "chart:prByState:donut",
        "chart:prTrend",
        "chart:prTrend:bar",
        "chart:prTrend:heatmap",
      ].sort()
    );
  });
});
