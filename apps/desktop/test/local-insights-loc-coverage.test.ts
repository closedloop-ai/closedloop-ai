/**
 * ISS-5414 — the size-coverage caveat reaches a reader on the desktop Delivery
 * dashboard, and quotes THIS surface's population.
 *
 * PLN-1535 M4 shipped `mergedPrsScanned` / `mergedPrsWithoutLoc` on the cloud
 * response, both `internal`, so nothing rendered them and the KLOC and
 * Median-PR-size tiles presented a partial-coverage lower bound as if it were
 * the whole figure. Desktop emitted no such pair at all. These cases pin the
 * fixed behaviour on the local producer: it emits the pair under the
 * `capturedPrs*` keys (this surface's tiles measure CAPTURED PRs, not merged
 * ones), and both tiles' captions state how much of that population it could
 * actually size.
 *
 * Lives beside `local-insights-contract.test.ts` rather than inside it: that
 * file is a grandfathered over-size module the repo's shrink-only rule forbids
 * growing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  InsightsPeriod,
  InsightsSection,
} from "@closedloop-ai/loops-api/insights";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import { openTestPrisma, type RawDb } from "./prisma-test-utils.js";

// Mirrors `local-insights-contract.test.ts`: the insights SQL buckets by the
// process-local timezone, so pin a real negative-offset zone at module eval
// before any DB is opened or Date is read.
process.env.TZ = "America/Chicago";

const NOW = new Date("2026-06-22T00:00:00.000Z");
const IN_WINDOW = "2026-06-20T10:00:00.000Z";

type CapturedPr = {
  id: string;
  number: number;
  added: number | null;
  removed: number | null;
};

async function seedCapturedPrs(db: RawDb, prs: readonly CapturedPr[]) {
  for (const pr of prs) {
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number,
          lines_added, lines_removed, files_changed, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $5, $6, $7, $7)`,
      [
        pr.id,
        `pr:org/repo:${pr.number}`,
        pr.number,
        pr.added,
        pr.removed,
        pr.added === null ? null : 5,
        IN_WINDOW,
      ]
    );
  }
}

/**
 * The emitted KPI for `key`, or a placeholder that fails the caller's own
 * assertion. Returning a sentinel rather than asserting here keeps every
 * assertion inside a `test()` body (Biome `noMisplacedAssertion`), and the
 * sentinel's key can never match a real one, so a missing KPI still fails loudly
 * on the caller's `assert.equal`.
 */
function deliveryKpi(
  kpis: readonly { key: string; value: number | null; sub: string }[],
  key: string
): { key: string; value: number | null; sub: string } {
  return (
    kpis.find((k) => k.key === key) ?? {
      key,
      value: null,
      sub: `MISSING: delivery response emitted no ${key} KPI`,
    }
  );
}

test("ISS-5414: the coverage pair is emitted and both size captions quote it", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    // Two enriched PRs (300 and 100 lines) and two whose size was never
    // fetched. KLOC sums 400 lines → 0.4, folding the unsized pair in as 0;
    // the median is over [100, 300] → 200. Both therefore describe 2 of the 4
    // captured PRs, which is exactly what the captions must say.
    await seedCapturedPrs(db, [
      { id: "pr-sized-a", number: 1, added: 300, removed: 0 },
      { id: "pr-sized-b", number: 2, added: 100, removed: 0 },
      { id: "pr-unsized-a", number: 3, added: null, removed: null },
      { id: "pr-unsized-b", number: 4, added: null, removed: null },
    ]);

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      InsightsPeriod.Quarter,
      NOW
    );

    assert.equal(deliveryKpi(delivery.kpis, "capturedPrsScanned").value, 4);
    assert.equal(deliveryKpi(delivery.kpis, "capturedPrsWithoutLoc").value, 2);

    // The tiles still report their lower-bound figures — the caption is what
    // stops a reader taking them for the whole picture.
    assert.equal(deliveryKpi(delivery.kpis, "kloc").value, 0.4);
    assert.equal(deliveryKpi(delivery.kpis, "pr-size").value, 200);
    assert.equal(
      deliveryKpi(delivery.kpis, "kloc").sub,
      "thousands of lines changed in captured PRs · sized 2 of 4 captured PRs scanned"
    );
    assert.equal(
      deliveryKpi(delivery.kpis, "pr-size").sub,
      "median lines changed per captured PR · sized 2 of 4 captured PRs scanned"
    );
  } finally {
    await close();
  }
});

test("ISS-5414: full coverage is stated, not left to be inferred from a missing clause", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedCapturedPrs(db, [
      { id: "pr-sized-a", number: 1, added: 120, removed: 30 },
      { id: "pr-sized-b", number: 2, added: 40, removed: 10 },
    ]);

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      InsightsPeriod.Quarter,
      NOW
    );

    assert.equal(deliveryKpi(delivery.kpis, "capturedPrsWithoutLoc").value, 0);
    assert.equal(
      deliveryKpi(delivery.kpis, "kloc").sub,
      "thousands of lines changed in captured PRs · sized 2 of 2 captured PRs scanned"
    );
    assert.equal(
      deliveryKpi(delivery.kpis, "pr-size").sub,
      "median lines changed per captured PR · sized 2 of 2 captured PRs scanned"
    );
  } finally {
    await close();
  }
});

test("ISS-5414 × ISS-5412: an unknown KLOC still carries the clause that says why", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    // Neither PR carries line counts, so ISS-5412 makes the KLOC value UNKNOWN
    // (`—`) rather than a measured-looking 0.0. Neither branch produced this
    // pairing alone: the dash needs the caption to say what is missing, and the
    // caption must not be dropped just because the value went null.
    await seedCapturedPrs(db, [
      { id: "pr-unsized-a", number: 1, added: null, removed: null },
      { id: "pr-unsized-b", number: 2, added: null, removed: null },
    ]);

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      InsightsPeriod.Quarter,
      NOW
    );

    assert.equal(deliveryKpi(delivery.kpis, "kloc").value, null);
    assert.equal(deliveryKpi(delivery.kpis, "capturedPrsScanned").value, 2);
    assert.equal(
      deliveryKpi(delivery.kpis, "kloc").sub,
      "thousands of lines changed in captured PRs · sized 0 of 2 captured PRs scanned"
    );
    assert.equal(
      deliveryKpi(delivery.kpis, "pr-size").sub,
      "median lines changed per captured PR · sized 0 of 2 captured PRs scanned"
    );
  } finally {
    await close();
  }
});

test("ISS-5414: an empty window leaves both captions unqualified", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      InsightsPeriod.Quarter,
      NOW
    );

    // No captured PRs means no population for the figure to be a share of, so
    // "sized 0 of 0 captured PRs" would be noise rather than a caveat.
    assert.equal(deliveryKpi(delivery.kpis, "capturedPrsScanned").value, 0);
    assert.equal(
      deliveryKpi(delivery.kpis, "kloc").sub,
      "thousands of lines changed in captured PRs"
    );
    assert.equal(
      deliveryKpi(delivery.kpis, "pr-size").sub,
      "median lines changed per captured PR"
    );
  } finally {
    await close();
  }
});
