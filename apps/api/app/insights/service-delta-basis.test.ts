/**
 * ISS-4995 regression guard — the CLOUD producer's per-KPI `deltaBasis`.
 *
 * ISS-4995 was the "No comparison" chip blaming the user's date range for a
 * comparison this producer never computes. The fix split the wire constructors
 * (`kpi` stamps {@link KpiDeltaBasis.NotComputed}, `comparableKpi` stamps
 * {@link KpiDeltaBasis.Computed}) so the renderer can say WHICH cause applies,
 * and threaded the resolved reason through the dashboard rows and KPI tiles.
 *
 * Those render sites are covered (`dashboard-rows-delta-basis.test.tsx`,
 * `kpi-stat-tile.test.tsx`), and so is the desktop producer — its per-key basis
 * is pinned byte-for-byte in `apps/desktop/test/fixtures/sqlite-golden.json`.
 * The CLOUD producer's choice was the one unpinned link: swapping any
 * `comparableKpi(` in `service.ts` back to `kpi(` would ship the honest-but-wrong
 * "we don't calculate this" on a metric cloud demonstrably DOES compare, and
 * every existing test would stay green.
 *
 * This pins the contract stated in `packages/loops-api/src/insights.ts`:
 *
 *   "cloud computes a comparison for `merged`/`cost`/`sessions`/`tool-runs`"
 *
 * The assertions compare the FULL SET of Computed keys per endpoint rather than
 * spot-checking one, so the guard fails in BOTH directions: demoting a compared
 * metric to `kpi(` drops a key, and promoting an uncompared one to
 * `comparableKpi(` adds a key that the producer computes no prior window for.
 *
 * Lives beside `service.test.ts` rather than inside it because that file is on
 * the `noExcessiveLinesPerFile` grandfather list (shrink-only).
 */

import { KpiDeltaBasis, type KpiStat } from "@closedloop-ai/loops-api/insights";
import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
  (await import("@/__tests__/support/insights/service.test-db")).databaseMock()
);

import { withDb } from "@repo/database";
import { makeFakeDb, ORG } from "@/__tests__/support/insights/service.test-db";
import { insightsService } from "./service";

const USER = "user-1";
const ORG_CTX = { organizationId: ORG, userId: USER, scope: InsightsScope.Org };
const NOW = new Date("2026-06-09T12:00:00.000Z");

// The documented cloud contract, per endpoint. `mergedCount` is the FEA-2946
// internal twin of `merged` and is compared for the same reason, so it belongs
// in the Computed set alongside it.
const DELIVERY_COMPARED_KEYS = ["cost", "merged", "mergedCount"];
const UTILIZATION_COMPARED_KEYS = ["sessions"];
const AGENTS_COMPARED_KEYS = ["tool-runs"];

// Named metrics the ISS-4995 report caught rendering the wrong cause. Asserted
// explicitly (not just by absence from the Computed set) so the ticket's own
// reproduction stays legible in the guard.
const DELIVERY_NOT_COMPUTED_KEYS = ["kloc", "pr-size"];

function comparedKeys(kpis: KpiStat[]): string[] {
  return kpis
    .filter((stat) => stat.deltaBasis === KpiDeltaBasis.Computed)
    .map((stat) => stat.key)
    .sort();
}

function installEmptyDb(): void {
  const { db } = makeFakeDb({ counts: () => 0 });
  vi.mocked(withDb).mockReset();
  vi.mocked(withDb).mockImplementation((cb) =>
    Promise.resolve(cb(db as never))
  );
}

describe("cloud insights producer: per-KPI deltaBasis", () => {
  it("marks exactly the delivery KPIs it computes a prior window for", async () => {
    installEmptyDb();

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expect(comparedKeys(result.kpis)).toEqual(DELIVERY_COMPARED_KEYS);
  });

  it("marks KLOC and median PR size as never compared, not as a thin date range", async () => {
    installEmptyDb();

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    // The exact pair from the ISS-4995 report: both rendered "No comparison"
    // with the range-blaming tooltip while `merged` and `cost` carried real
    // deltas in the SAME payload.
    for (const key of DELIVERY_NOT_COMPUTED_KEYS) {
      const stat = result.kpis.find((candidate) => candidate.key === key);
      expect(stat?.deltaBasis).toBe(KpiDeltaBasis.NotComputed);
    }
  });

  it("marks exactly the utilization KPIs it computes a prior window for", async () => {
    installEmptyDb();

    const result = await insightsService.getUtilization(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expect(comparedKeys(result.kpis)).toEqual(UTILIZATION_COMPARED_KEYS);
  });

  it("marks exactly the agents KPIs it computes a prior window for", async () => {
    installEmptyDb();

    const result = await insightsService.getAgents(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expect(comparedKeys(result.kpis)).toEqual(AGENTS_COMPARED_KEYS);
  });

  it("stamps a basis on every emitted KPI so none can inherit the range-blaming default", async () => {
    installEmptyDb();

    const results = [
      await insightsService.getDelivery(ORG_CTX, InsightsPeriod.Quarter, NOW),
      await insightsService.getUtilization(
        ORG_CTX,
        InsightsPeriod.Quarter,
        NOW
      ),
      await insightsService.getAgents(ORG_CTX, InsightsPeriod.Quarter, NOW),
    ];

    // A KPI built as a raw object literal rather than through `kpi()` /
    // `comparableKpi()` would carry no basis at all, and the renderer would fall
    // back to the range sentence — the ISS-4995 defect, reintroduced past both
    // constructors. Every emitted stat must resolve to one of the two states.
    const bases = results.flatMap((result) =>
      result.kpis.map((stat) => stat.deltaBasis)
    );
    expect(bases.length).toBeGreaterThan(0);
    for (const basis of bases) {
      expect([KpiDeltaBasis.Computed, KpiDeltaBasis.NotComputed]).toContain(
        basis
      );
    }
  });
});
