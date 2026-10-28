import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { InsightsSection } from "@closedloop-ai/loops-api/insights";
import { test } from "vitest";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import { openInsightsDb } from "./local-insights-test-helpers.js";

/**
 * ISS-5412 — the Local-mode Delivery "KLOC captured" tile must report UNKNOWN,
 * not `0.0`, when no captured PR carries line counts (the desktop store keeps
 * none since ISS-12709).
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
const INSERT_PR = `INSERT INTO artifacts
     (id, identity_key, kind, repo_full_name, pr_number, created_at, last_seen_at)
   VALUES ($1, $2, 'pull_request', $3, $4, $5, $5)`;

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
