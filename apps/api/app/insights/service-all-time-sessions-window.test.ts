/**
 * ISS-12263 — the cloud service hands the list-ruled session reads the
 * Sessions-list window, and every other read keeps `start..end`.
 *
 * `period-sessions-window-parity.test.ts` pins what `resolvePeriodRange`
 * returns and `session-rollup-population.integration.test.ts` pins what the
 * reads count against a real database. Neither sees which bounds `service.ts`
 * actually passes, so passing `range.start, range.end` to the Sessions KPI or
 * the cost again would leave both green. This file is that link.
 */

import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { describe, expect, it, vi } from "vitest";
import type * as SessionQueries from "./service/session-queries";

vi.mock("@repo/database", async () =>
  (await import("@/__tests__/support/insights/service.test-db")).databaseMock()
);

vi.mock("./service/session-queries", async (importOriginal) => {
  const original = await importOriginal<typeof SessionQueries>();
  return {
    ...original,
    fetchSessionRollup: vi.fn(original.fetchSessionRollup),
    sumSessionCost: vi.fn(original.sumSessionCost),
    sumToolRuns: vi.fn(original.sumToolRuns),
  };
});

import { withDb } from "@repo/database";
import { makeFakeDb, ORG } from "@/__tests__/support/insights/service.test-db";
import { insightsService } from "./service";
import { resolvePeriodRange } from "./service/period";
import {
  fetchSessionRollup,
  sumSessionCost,
  sumToolRuns,
} from "./service/session-queries";

const ORG_CTX = {
  organizationId: ORG,
  userId: "user-1",
  scope: InsightsScope.Org,
};
const NOW = new Date("2026-06-09T12:00:00.000Z");

describe("insights service: the Sessions-list window (ISS-12263)", () => {
  it("reads the all-time Sessions KPI with no bounds, as the Sessions list does", async () => {
    installEmptyDb();

    await insightsService.getUtilization(ORG_CTX, InsightsPeriod.All, NOW);

    expect(vi.mocked(fetchSessionRollup)).toHaveBeenCalledWith(ORG_CTX, {});
  });

  it("prices the all-time cost with no bounds, as the Sessions list does", async () => {
    installEmptyDb();

    await insightsService.getDelivery(ORG_CTX, InsightsPeriod.All, NOW);

    expect(vi.mocked(sumSessionCost)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sumSessionCost)).toHaveBeenCalledWith(ORG_CTX, {});
  });

  it("keeps the all-time tool runs on session start, bounded at today's end", async () => {
    installEmptyDb();
    const range = resolvePeriodRange(InsightsPeriod.All, NOW);

    await insightsService.getAgents(ORG_CTX, InsightsPeriod.All, NOW);

    expect(vi.mocked(sumToolRuns)).toHaveBeenCalledWith(
      ORG_CTX,
      range.start,
      range.end
    );
  });

  it("reads a bounded period's Sessions KPI and cost over the shared window", async () => {
    installEmptyDb();
    const range = resolvePeriodRange(InsightsPeriod.Week, NOW);
    const window = { start: range.start, end: range.end };

    await insightsService.getUtilization(ORG_CTX, InsightsPeriod.Week, NOW);
    await insightsService.getDelivery(ORG_CTX, InsightsPeriod.Week, NOW);

    expect(vi.mocked(fetchSessionRollup)).toHaveBeenCalledWith(ORG_CTX, window);
    expect(vi.mocked(sumSessionCost)).toHaveBeenCalledWith(ORG_CTX, window);
  });
});

function installEmptyDb(): void {
  const { db } = makeFakeDb({ counts: () => 0 });
  vi.mocked(withDb).mockImplementation((cb) =>
    Promise.resolve(cb(db as never))
  );
}
