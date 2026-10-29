import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readCohortCostFacts: vi.fn(),
  readCohortPullRequestFacts: vi.fn(),
  reportBranchListEnrichmentFailedOpen: vi.fn(),
}));

vi.mock("@repo/observability/tracing/spans", () => ({
  withAppSpan: (_name: string, callback: () => unknown) => callback(),
}));

vi.mock("./branch-list-enrichment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./branch-list-enrichment")>()),
  reportBranchListEnrichmentFailedOpen:
    mocks.reportBranchListEnrichmentFailedOpen,
}));

vi.mock("./branch-cohort-cost-facts", () => ({
  readCohortCostFacts: mocks.readCohortCostFacts,
}));

vi.mock("./branch-cohort-pull-request-facts", () => ({
  readCohortPullRequestFacts: mocks.readCohortPullRequestFacts,
}));

import { BranchListEnrichmentRead } from "./branch-list-enrichment";
import { startMetricFactsOnCohort } from "./branch-metric-facts-start";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-03T00:00:00.000Z");
const IDS = ["branch-a", "branch-b"];

describe("startMetricFactsOnCohort", () => {
  beforeEach(() => {
    mocks.readCohortCostFacts.mockResolvedValue("cost");
    mocks.readCohortPullRequestFacts.mockResolvedValue("pull-requests");
  });

  it("starts both reads when the cohort is provided, not when it is settled", async () => {
    const facts = startMetricFactsOnCohort(ORGANIZATION_ID, {});

    facts.provide(IDS, NOW);
    await Promise.resolve();

    expect(mocks.readCohortPullRequestFacts).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      IDS,
      {},
      NOW
    );
    expect(mocks.readCohortCostFacts).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      IDS,
      {},
      NOW
    );
    await expect(facts.settle(IDS, NOW)).resolves.toEqual([
      "pull-requests",
      "cost",
    ]);
    expect(mocks.readCohortCostFacts).toHaveBeenCalledOnce();
  });

  it("runs the reads outside the async context the cohort was provided from", async () => {
    const snapshot = new AsyncLocalStorage<string>();
    const seen: (string | undefined)[] = [];
    mocks.readCohortCostFacts.mockImplementation(() => {
      seen.push(snapshot.getStore());
      return Promise.resolve("cost");
    });
    const facts = startMetricFactsOnCohort(ORGANIZATION_ID, {});

    snapshot.run("snapshot-transaction", () => facts.provide(IDS, NOW));
    await facts.settle(IDS, NOW);

    expect(seen).toEqual([undefined]);
  });

  it("reads again for a cohort or instant other than the one it started on", async () => {
    const facts = startMetricFactsOnCohort(ORGANIZATION_ID, {});
    facts.provide(IDS, NOW);

    await facts.settle(["branch-a"], NOW);
    await facts.settle(IDS, new Date(NOW.getTime() + 1));

    expect(mocks.readCohortCostFacts).toHaveBeenCalledTimes(3);
  });

  it("reads once at settle when no cohort was ever provided", async () => {
    const facts = startMetricFactsOnCohort(ORGANIZATION_ID, {});

    await facts.settle(IDS, NOW);

    expect(mocks.readCohortCostFacts).toHaveBeenCalledOnce();
  });

  /**
   * ISS-12346 (H2, marisolashgrove review on #8791) changed this expectation. The
   * rejection used to propagate out of `readBranchAnalytics` and 500 the whole
   * response, including the cards the snapshot had already computed; it now
   * degrades the fact-backed cards alone and records the failure.
   */
  it("degrades a failed read instead of rejecting the analytics read", async () => {
    mocks.readCohortCostFacts.mockRejectedValue(new Error("cost read failed"));
    const facts = startMetricFactsOnCohort(ORGANIZATION_ID, {});
    facts.provide(IDS, NOW);

    await expect(facts.settle(IDS, NOW)).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(mocks.reportBranchListEnrichmentFailedOpen).toHaveBeenCalledWith(
      BranchListEnrichmentRead.MetricFacts,
      expect.objectContaining({ message: "cost read failed" }),
      { organizationId: ORGANIZATION_ID, rowCount: IDS.length }
    );
  });

  it("degrades a read taken at settle, with no cohort ever provided", async () => {
    mocks.readCohortPullRequestFacts.mockRejectedValue(new Error("pr failed"));
    const facts = startMetricFactsOnCohort(ORGANIZATION_ID, {});

    await expect(facts.settle(IDS, NOW)).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(mocks.reportBranchListEnrichmentFailedOpen).toHaveBeenCalledOnce();
  });
});
