/**
 * ISS-6892, restated for ISS-7176 — ordering by cost and FILTERING on it are
 * different questions, and only the second one may narrow a population.
 *
 * The invariant is unchanged and still worth a guard: an aggregate has no order,
 * so a `sortBy` must never change which rows the cards count. What changed is
 * why it holds. It used to hold by a decision — the where-builder keyed off a
 * membership predicate rather than a sensitivity one, because treating a sort as
 * narrowing would have scoped the cards to a bounded matched-id set while the
 * table reported the whole population. Now it holds by construction:
 * `buildUsageSummaryWhere` never reads
 * `sortBy` at all, and a cost bucket is an ordinary `estimated_cost` conjunct
 * rather than an id set resolved by a capped candidate scan.
 *
 * "By construction" is exactly the claim that rots quietly, which is why these
 * cases outlived the machinery they were written against: a future change that
 * makes the summary consult the sort, or reintroduces a candidate scan for a
 * cost filter, fails here rather than on someone's dashboard.
 */
import { describe, expect, it, vi } from "vitest";
import { installDb } from "@/__tests__/support/agent-sessions/service.test-harness";
import { SESSION_COST_SORT_BY } from "./session-sort-rules";
import { buildUsageSummaryWhere } from "./usage-summary-where";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

/** Spy on the candidate scan that must no longer happen for a cost query. */
function installCandidateScanSpy() {
  const findMany = vi.fn().mockResolvedValue([]);
  installDb({ sessionDetail: { findMany } });
  return findMany;
}

describe("a cost SORT never narrows the summary population (ISS-6892)", () => {
  it("builds the SAME where with and without the cost sort", async () => {
    const findMany = installCandidateScanSpy();

    const [unsorted, costSorted] = await Promise.all([
      buildUsageSummaryWhere({ organizationId: "org-1", filters: {} } as never),
      buildUsageSummaryWhere({
        organizationId: "org-1",
        filters: { sortBy: SESSION_COST_SORT_BY },
      } as never),
    ]);

    // Byte-identical, which is the strongest form of "the sort did not narrow":
    // a `sortBy` that leaked into the predicate would show up as any difference
    // at all, not merely as a different row count.
    expect(JSON.stringify(costSorted)).toBe(JSON.stringify(unsorted));
    // And no candidate scan for either — the read that used to bound the cost
    // path to 10,000 sessions is gone, not merely unused.
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("a cost FILTER narrows in SQL, not through an id set (ISS-7176)", () => {
  it("predicates on estimated_cost with no candidate scan", async () => {
    const findMany = installCandidateScanSpy();

    const where = await buildUsageSummaryWhere({
      organizationId: "org-1",
      filters: { costBuckets: ["under_1"] },
    } as never);

    const serialized = JSON.stringify(where);
    // The bucket reaches the database as a predicate on the SAME column the row
    // displays. Previously this asserted the opposite shape — an `artifactId IN
    // (…)` set resolved in memory — which is what let the cards and the table
    // disagree once the cap bit.
    expect(serialized).toContain("estimatedCost");
    expect(serialized).not.toContain('"artifactId"');
    expect(findMany).not.toHaveBeenCalled();
  });

  it("leaves an unfiltered summary carrying no cost clause at all", async () => {
    const where = await buildUsageSummaryWhere({
      organizationId: "org-1",
      filters: {},
    } as never);

    expect(JSON.stringify(where)).not.toContain("estimatedCost");
  });
});
