import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { InsightsSection } from "@closedloop-ai/loops-api/insights";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import { openInsightsDb } from "./local-insights-test-helpers.js";

/**
 * ISS-5412 — the Local-mode Delivery "KLOC captured" tile must report UNKNOWN,
 * not `0.0`, when no captured PR carries line counts.
 *
 * Its row neighbour "Median PR size" already did this (FEA-2923), and cloud's
 * twin returns `null` in exactly this case, so the same desktop app was showing
 * `0.0` in Local mode and `—` in Cloud mode for identical missing data. These
 * live in a focused sibling suite because `local-insights-contract.test.ts` is
 * in the shrink-only grandfather list.
 */

// Same timezone pin as the sibling contract suite: the insights SQL buckets by
// process-local day, so a fixed non-UTC zone keeps the conversion exercised and
// deterministic. Runs at module evaluation, before any DB opens.
process.env.TZ = "America/Chicago";

const NOW = new Date("2026-06-22T00:00:00.000Z"); // = June 21 19:00 CDT
const IN_WINDOW = "2026-06-20T10:00:00.000Z"; // = June 20 05:00 CDT
const PRIOR_WINDOW = "2026-01-15T10:00:00.000Z";
const SENTINEL_DATE = "2025-12-01T00:00:00.000Z";
const INSERT_PR = `INSERT INTO artifacts
     (id, identity_key, kind, repo_full_name, pr_number,
      lines_added, lines_removed, files_changed, created_at, last_seen_at)
   VALUES ($1, $2, 'pull_request', $3, $4, $5, $6, $7, $8, $8)`;

test("ISS-5412: KLOC captured is `—` (null), not 0.0, when no captured PR carries line counts", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-kloc-none-");
  try {
    // Two captured PRs, NEITHER carrying line counts. Both certainly changed
    // lines; the local store just has not sized them. Before ISS-5412 the sum
    // over the COALESCE'd projection was a vacuous 0 and the tile claimed
    // "0.0 thousands of lines changed in captured PRs".
    for (const [id, prNumber] of [
      ["pr-unsized-a", 1],
      ["pr-unsized-b", 2],
    ] as const) {
      await db.query(INSERT_PR, [
        id,
        `pr:none/repo:${prNumber}`,
        "none/repo",
        prNumber,
        null,
        null,
        null,
        IN_WINDOW,
      ]);
    }

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    const kloc = delivery.kpis.find((k) => k.key === "kloc");
    assert.equal(kloc?.value, null);
    // ...and no delta: there is no current value to compare.
    assert.equal(kloc?.deltaPct, null);
    // Both PRs are reported as the coverage exclusion, mirroring cloud's
    // `mergedPrsWithoutLoc`.
    const unsized = delivery.kpis.find(
      (k) => k.key === "capturedPrsWithoutLoc"
    );
    assert.equal(unsized?.value, 2);
    assert.equal(unsized?.internal, true);
    // The neighbouring median already reported unknown and still does — the two
    // tiles now agree instead of one claiming zero beside the other's dash.
    assert.equal(delivery.kpis.find((k) => k.key === "pr-size")?.value, null);
    // The trend is OMITTED rather than drawn as a flat line at zero under a `—`
    // KPI; every `chart:klocTrend` variant then renders `ChartEmpty` instead.
    assert.equal(delivery.charts.klocTrend, undefined);
    // ISS-5412: `mergedKloc` — documented as carrying semantics identical to
    // cloud's `kloc`, which is null here — must not keep the vacuous 0 either.
    assert.equal(
      delivery.kpis.find((k) => k.key === "mergedKloc")?.value,
      null
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5412: a PR carrying ONE line count still sizes the window — KLOC reports a lower bound and the coverage count says so", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-kloc-half-");
  try {
    // `sized` is OR where `enriched` is AND: a half-projected row contributes
    // its known side to the COALESCE'd sum, so the sum HAS evidence and must
    // still report — even though the row's total size is unknown and it stays
    // out of the median (FEA-2868 thread 3).
    //   pr-half: added=200 removed=NULL → sized, NOT enriched
    //   pr-none: added=NULL removed=NULL → neither
    for (const [id, prNumber, added, removed] of [
      ["pr-half", 1, 200, null],
      ["pr-none", 2, null, null],
    ] as const) {
      await db.query(INSERT_PR, [
        id,
        `pr:half/repo:${prNumber}`,
        "half/repo",
        prNumber,
        added,
        removed,
        added === null ? null : 5,
        IN_WINDOW,
      ]);
    }

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    // 200 lines → 0.2 KLOC, unchanged from the pre-ISS-5412 sum semantics.
    assert.equal(delivery.kpis.find((k) => k.key === "kloc")?.value, 0.2);
    // The coverage count uses cloud's BOTH-counts rule, so it counts the
    // half-projected PR too: 0.2 is a lower bound, not complete coverage, and
    // "2 without size" is what stops it reading as a complete figure.
    assert.equal(
      delivery.kpis.find((k) => k.key === "capturedPrsWithoutLoc")?.value,
      2
    );
    // Neither row is enriched, so the median is still unknown.
    assert.equal(delivery.kpis.find((k) => k.key === "pr-size")?.value, null);
    // The window HAS line counts to sum, so the trend still draws.
    assert.notEqual(delivery.charts.klocTrend, undefined);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5412: an unknown current KLOC suppresses the delta rather than reporting -100% against a real prior", async () => {
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-kloc-delta-null-"
  );
  try {
    // Sentinel older than the prior window start so hasFullPriorPeriod is TRUE
    // — without the null guard the delta gate would otherwise be closed and the
    // regression would not be reachable.
    await db.query(
      `INSERT INTO session_analytics (session_id, started_at, is_human, est_cost)
       VALUES ($1, $2, 0, 0)`,
      ["sentinel", SENTINEL_DATE]
    );
    // Prior window: a real 900-line PR — a genuine baseline.
    await db.query(INSERT_PR, [
      "prior-sized",
      "pr:delta/repo:2",
      "delta/repo",
      2,
      900,
      0,
      5,
      PRIOR_WINDOW,
    ]);
    // Current window: one captured PR with NO line counts → unknown KLOC.
    await db.query(INSERT_PR, [
      "cur-unsized",
      "pr:delta/repo:1",
      "delta/repo",
      1,
      null,
      null,
      null,
      IN_WINDOW,
    ]);

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    const kloc = delivery.kpis.find((k) => k.key === "kloc");
    assert.equal(kloc?.value, null);
    // pctDelta(0, 900) would be -100% — a collapse the window cannot see.
    assert.equal(kloc?.deltaPct, null);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5412: a MEASURED zero still reports 0 — unknown and zero stay distinct claims", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-kloc-zero-");
  try {
    // The counterweight to the first case, and the reason the fix keys on
    // `sized` rather than on the sum being 0. This PR carries BOTH line counts
    // and they are genuinely 0 (an empty PR, or one that changed only file
    // modes). The window HAS been measured and the measurement is zero, so the
    // tile must assert `0` — collapsing it into the same `—` as an unmeasured
    // window would lose exactly the distinction ISS-5412 exists to draw.
    await db.query(INSERT_PR, [
      "pr-measured-zero",
      "pr:zero/repo:1",
      "zero/repo",
      1,
      0,
      0,
      0,
      IN_WINDOW,
    ]);

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    assert.equal(delivery.kpis.find((k) => k.key === "kloc")?.value, 0);
    // Enriched, so it medians — also a real 0, not a dash.
    assert.equal(delivery.kpis.find((k) => k.key === "pr-size")?.value, 0);
    // Nothing is unsized: coverage over this window is complete.
    assert.equal(
      delivery.kpis.find((k) => k.key === "capturedPrsWithoutLoc")?.value,
      0
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
