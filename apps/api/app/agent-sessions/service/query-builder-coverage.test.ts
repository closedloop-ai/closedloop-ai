import { describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_QUERY_BATCH_SIZE,
  buildAgentSessionOrderBy,
  buildLastSyncTargetWhere,
  buildWhere,
  findPagedRecords,
} from "./query-builder";
import type { AgentSessionScope } from "./records";

// ISS-9713 branch coverage. `buildWhere` is pure given a scope + filters, so
// these call it directly and assert the exact emitted Prisma where shape —
// the same pattern query-builder.test.ts already uses at its bottom
// (`describe("ISS-4481 Unknown-cost DB clause (buildWhere)")`).

const scope: AgentSessionScope = { organizationId: "org-1" };

describe("appendAndClauses AND-array merge (buildWhere)", () => {
  it("appends a second AND clause onto an existing array rather than replacing it", async () => {
    // Two independent facets each call appendAndClauses: the cost-bucket facet
    // (applySessionFacetFilters) runs first and creates where.AND, then the
    // quality=substantive filter appends a second clause onto that same array.
    // This exercises the "where.AND already set" branch of appendAndClauses,
    // never reached when only one facet is active.
    const where = await buildWhere(scope, {
      costBuckets: ["under_1"],
      quality: "substantive",
    });

    expect(Array.isArray(where.AND)).toBe(true);
    const and = where.AND as Record<string, unknown>[];
    expect(and).toHaveLength(2);
    // First clause: the cost-bucket OR. Second: the substantive predicate.
    expect(and[0]).toHaveProperty("AND");
    expect(and[1]).toHaveProperty("OR");
  });
});

describe("buildAutonomyTierWhere (buildWhere autonomyTiers facet)", () => {
  it("matches the null-autonomy rows for the unknown tier", async () => {
    const where = await buildWhere(scope, { autonomyTiers: ["unknown"] });
    const and = where.AND as { OR: { autonomy: unknown }[] }[];
    expect(and[0].OR).toEqual([{ autonomy: null }]);
  });

  it("builds an unbounded gte range for the high tier (no upper bound)", async () => {
    const where = await buildWhere(scope, { autonomyTiers: ["high"] });
    const and = where.AND as { OR: { autonomy: unknown }[] }[];
    expect(and[0].OR).toEqual([{ autonomy: { gte: 70 } }]);
  });

  it("builds a bounded gte/lt range for the mixed tier", async () => {
    const where = await buildWhere(scope, { autonomyTiers: ["mixed"] });
    const and = where.AND as { OR: { autonomy: unknown }[] }[];
    expect(and[0].OR).toEqual([{ autonomy: { gte: 35, lt: 70 } }]);
  });

  it("skips an unrecognized tier id and adds no autonomy clause when it is the only one", async () => {
    const where = await buildWhere(scope, {
      // "bogus" resolves to null via autonomyTierRange's default case, so the
      // `continue` branch fires and no autonomy clause is added at all —
      // where.AND stays undefined rather than an empty OR.
      autonomyTiers: ["bogus"],
    });
    expect(where.AND).toBeUndefined();
  });

  it("drops an unrecognized tier while keeping a recognized sibling", async () => {
    const where = await buildWhere(scope, {
      autonomyTiers: ["bogus", "guided"],
    });
    const and = where.AND as { OR: { autonomy: unknown }[] }[];
    expect(and[0].OR).toEqual([{ autonomy: { gte: 0, lt: 35 } }]);
  });
});

describe("buildCostBucketWhere (buildWhere costBuckets facet)", () => {
  it("builds a known numeric-bucket clause for a single recognized bucket id", async () => {
    const where = await buildWhere(scope, { costBuckets: ["from_1_to_10"] });
    const and = where.AND as { AND: [{ OR: unknown[] }, unknown] }[];
    expect(and[0].AND[0]).toEqual({
      OR: [{ estimatedCost: { gte: 1.005, lt: 10.005 } }],
    });
  });

  it("omits the upper bound for the open-ended top bucket", async () => {
    const where = await buildWhere(scope, { costBuckets: ["from_50"] });
    const and = where.AND as { AND: [{ OR: unknown[] }, unknown] }[];
    expect(and[0].AND[0]).toEqual({
      OR: [{ estimatedCost: { gte: 50.005 } }],
    });
  });

  it("emits NO cost clause for an exhaustive selection", async () => {
    // ISS-4481 (shafty): selecting every numeric bucket AND Unknown covers every
    // row, so it is a no-op filter rather than a narrowing one. Moved here by
    // ISS-7176 from `cost-query-reconciliation.test.ts`, which asserted it
    // through the deleted candidate scan; the property belongs to the predicate.
    const exhaustive = await buildWhere(scope, {
      costBuckets: [
        "under_1",
        "from_1_to_10",
        "from_10_to_50",
        "from_50",
        "unknown",
      ],
    });
    expect(JSON.stringify(exhaustive)).not.toContain("estimatedCost");
  });

  it("drops unrecognized bucket ids, keeping the canonical ones", async () => {
    // Also from `cost-query-reconciliation.test.ts`. An id the vocabulary does
    // not know must not widen or empty the filter — the recognized member still
    // narrows on its own.
    const where = await buildWhere(scope, {
      costBuckets: ["not-a-bucket", "from_1_to_10"],
    });
    const and = where.AND as { AND: [{ OR: unknown[] }, unknown] }[];
    expect(and[0].AND[0]).toEqual({
      OR: [{ estimatedCost: { gte: 1.005, lt: 10.005 } }],
    });
  });

  it("ORs the numeric-bucket clause with the Unknown clause for a non-exhaustive mixed selection", async () => {
    const where = await buildWhere(scope, {
      costBuckets: ["under_1", "unknown"],
    });
    const and = where.AND as { OR: [unknown, unknown] }[];
    // Two option clauses (numeric-bucket AND, Unknown) means the builder wraps
    // them in an OR rather than returning the single clause directly.
    expect(and[0]).toHaveProperty("OR");
    expect((and[0] as { OR: unknown[] }).OR).toHaveLength(2);
  });
});

describe("buildChangePresenceWhere (buildWhere changePresence facet)", () => {
  it("ignores an unrecognized change-presence option and adds no clause", async () => {
    const where = await buildWhere(scope, {
      changePresence: ["bogus"],
    });
    expect(where.AND).toBeUndefined();
  });
});

describe("buildPrAssociationWhere (buildWhere prAssociation facet)", () => {
  it("negates SESSION_HAS_PR_WHERE for the no_pr option", async () => {
    const where = await buildWhere(scope, { prAssociation: ["no_pr"] });
    const and = where.AND as { OR: { NOT: unknown }[] }[];
    expect(and[0].OR).toHaveLength(1);
    expect(and[0].OR[0]).toHaveProperty("NOT");
  });

  it("ignores an unrecognized PR-association option and adds no clause", async () => {
    const where = await buildWhere(scope, {
      prAssociation: ["bogus"],
    });
    expect(where.AND).toBeUndefined();
  });
});

describe("applyDateFilter (buildWhere date window)", () => {
  it("omits the lte bound when only startDate is given", async () => {
    const where = await buildWhere(
      scope,
      { startDate: "2026-06-18T00:00:00.000Z" },
      "lastActivityAt"
    );
    expect(where.lastActivityAt).toEqual({
      gte: new Date("2026-06-18T00:00:00.000Z"),
    });
  });

  it("omits the gte bound when only endDate is given", async () => {
    const where = await buildWhere(
      scope,
      { endDate: "2026-06-25T00:00:00.000Z" },
      "lastActivityAt"
    );
    expect(where.lastActivityAt).toEqual({
      lte: new Date("2026-06-25T00:00:00.000Z"),
    });
  });

  it("windows on sessionStartedAt (not lastActivityAt) for the sessionStartedAt dateField", async () => {
    const where = await buildWhere(
      scope,
      { startDate: "2026-06-18T00:00:00.000Z" },
      "sessionStartedAt"
    );
    expect(where.sessionStartedAt).toEqual({
      gte: new Date("2026-06-18T00:00:00.000Z"),
    });
    expect(where.lastActivityAt).toBeUndefined();
  });
});

describe("buildLastSyncTargetWhere", () => {
  it("adds a team-membership predicate when teamId is filtered", () => {
    const where = buildLastSyncTargetWhere(scope, { teamId: "team-1" });
    expect(where.user).toEqual({
      is: { teamMemberships: { some: { teamId: "team-1" } } },
    });
  });
});

describe("findPagedRecords", () => {
  it("coalesces a null/undefined page to an empty array without throwing", async () => {
    const fetchPage = async () =>
      undefined as unknown as { artifactId: string }[];

    await expect(findPagedRecords(fetchPage)).resolves.toEqual([]);
  });

  it("stops paging after one fetch when a full page's last record carries no cursorable id", async () => {
    // Sized off the constant so the page stays full whatever the batch size
    // is: a hardcoded length would take the short-page return instead and
    // leave the missing-cursor branch below it untested.
    const fullPage = Array.from(
      { length: ANALYTICS_QUERY_BATCH_SIZE },
      (_, index) => ({
        artifactId:
          index === ANALYTICS_QUERY_BATCH_SIZE - 1 ? "" : `session-${index}`,
      })
    );
    // Later pages come back empty so a missed early return surfaces as an
    // extra fetch rather than an infinite loop.
    let calls = 0;
    const fetchPage = vi.fn(() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? fullPage : []);
    });

    const result = await findPagedRecords(fetchPage);

    // The page was full, so only the falsy cursor id can have stopped the walk.
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(ANALYTICS_QUERY_BATCH_SIZE);
  });
});

describe("buildAgentSessionOrderBy", () => {
  it("delegates to the shared DB sort-order builder and returns a non-empty order", () => {
    const orderBy = buildAgentSessionOrderBy({});
    expect(orderBy.length).toBeGreaterThan(0);
  });
});
