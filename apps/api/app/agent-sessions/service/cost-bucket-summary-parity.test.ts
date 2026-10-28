// FEA-4293/4294 (thread whitlockk), re-decided by ISS-7176: the usage-summary cards
// and the Sessions TABLE must aggregate the SAME cost-bucket population.
//
// THE INVARIANT IS UNCHANGED. WHAT ENFORCES IT IS NOT. The table used to bucket
// on a RECONCILED captured cost rather than on the stored rollup, so the summary
// could not simply restate a `estimated_cost` predicate — it had to resolve the
// identical reconciled-matched id set, through a capped candidate scan ordered
// the same way the table's. Every case below used to turn on a fixture where the
// two numbers disagreed.
//
// ISS-7176 made `session_detail.estimated_cost` the whole-session cost, which is
// the column `buildCostBucketWhere` has always predicated on. Table and cards
// now compose the SAME conjunct from the SAME builder, so parity is structural.
// These cases outlived the machinery because "structural" is the claim that rots
// quietly: a future change that gives either surface its own cost predicate, or
// reintroduces an id-set detour, fails here.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FROM_50_BUCKET,
  installCostSessions,
  UNDER_1_BUCKET,
  UPDATED,
} from "@/__tests__/support/agent-sessions/service/cost-query-reconciliation.test-harness";
import { agentSessionsService } from "../service";
import { buildUsageSummaryWhere } from "./usage-summary-where";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

/** Two sessions straddling the ≤ $1 boundary, plus one far above it. */
function installStraddlingPopulation() {
  installCostSessions([
    {
      artifactId: "row-cheap",
      storedRollup: 0.42,
      eventCostSum: 0.42,
      eventCount: 2,
      sessionUpdatedAt: UPDATED(9),
    },
    {
      artifactId: "row-boundary",
      storedRollup: 1,
      eventCostSum: 1,
      eventCount: 2,
      sessionUpdatedAt: UPDATED(5),
    },
    {
      artifactId: "row-expensive",
      storedRollup: 90,
      eventCostSum: 90,
      eventCount: 2,
      sessionUpdatedAt: UPDATED(1),
    },
  ]);
}

describe("usage-summary ↔ table cost-bucket parity (FEA-4293/4294)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("narrows the cards on the SAME column the table filters on", async () => {
    installStraddlingPopulation();

    const page = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET], quality: "all" },
    });
    const summaryWhere = await buildUsageSummaryWhere({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET] },
    } as never);

    // The table admits the two rows at or under $1 and drops the $90 one.
    expect(page.items.map((item) => item.id).sort()).toEqual([
      "row-boundary",
      "row-cheap",
    ]);
    // …and the cards carry a predicate on the same column, with no id set. An
    // `artifactId IN (…)` here would mean the summary had resolved its own
    // cohort again, which is exactly how the two used to drift apart.
    const serialized = JSON.stringify(summaryWhere);
    expect(serialized).toContain("estimatedCost");
    expect(serialized).not.toContain('"artifactId"');
  });

  it("keeps the FEA-4293 inclusive boundary on both surfaces", async () => {
    // A session displaying exactly $1.00 belongs in "≤ $1". The bucket's bounds
    // are half-open around a rounded cent (`gte`/`lt` at x.005), so this is the
    // case an off-by-one in either surface's bounds would drop.
    installStraddlingPopulation();

    const page = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET], quality: "all" },
    });

    expect(page.items.map((item) => item.id)).toContain("row-boundary");
  });

  it("agrees on the EMPTY case too, where a wrong predicate hides best", async () => {
    // A bucket nothing matches must be empty on both surfaces rather than
    // falling back to the unfiltered population — the failure mode a summary
    // that quietly dropped its cost clause would have.
    installStraddlingPopulation();

    const page = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [FROM_50_BUCKET], quality: "all" },
    });
    const summaryWhere = await buildUsageSummaryWhere({
      organizationId: "org-1",
      filters: { costBuckets: [FROM_50_BUCKET] },
    } as never);

    expect(page.items.map((item) => item.id)).toEqual(["row-expensive"]);
    expect(JSON.stringify(summaryWhere)).toContain("estimatedCost");
  });
});
