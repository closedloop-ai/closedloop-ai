/**
 * ISS-6756 — `usageSearchWhere` and `usageContentScopeWhere` each own a
 * top-level `OR` key, and `loadUsageGroupsForInventory` SPREAD them as siblings.
 * Object spread keeps the last, so the content scope replaced the search
 * predicate outright: a usage row whose own `(componentKind, componentKey)`
 * never matched `?search=` was grouped straight back into a search-filtered
 * response, and the read lost the only predicate that narrowed it.
 *
 * This is the third instance of one collision. `detailOrphanUsageWhere` and
 * `loadUsageGroupsLinkedElsewhere` were fixed under ISS-5363 (whitlockk); the
 * token-trend read and this lane are fixed here.
 *
 * No production caller passes a search facet AND a content scope today, which is
 * precisely why it survived — nothing exercised it. The assertions read the
 * emitted `where` rather than filtering fixture rows, because the defect IS the
 * clause shape: a predicate that is not in the `where` at all is not a row the
 * database declined to return.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

import {
  loadUsageGroupsForInventory,
  loadUsageGroupsLinkedElsewhere,
} from "../org-population";

const ORGANIZATION_ID = "org-iss-6756";
const CONTENT_SCOPE = { contentHashes: ["hash-a"], fingerprint: "hash-a" };

type Where = Record<string, unknown>;

function installGroupBy(): { groupBy: ReturnType<typeof vi.fn> } {
  const groupBy = vi.fn(() => Promise.resolve([]));
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback({ agentComponentSessionUsage: { groupBy } })
  );
  return { groupBy };
}

async function whereFor(
  contentScope: typeof CONTENT_SCOPE | null,
  searchFacet: { nameMatchedIdentities: []; search: string } | null
): Promise<Where> {
  const { groupBy } = installGroupBy();
  await loadUsageGroupsForInventory(
    { agentComponentSessionUsage: { groupBy } } as never,
    ORGANIZATION_ID,
    ["inv-1"],
    {},
    contentScope,
    undefined,
    searchFacet
  );
  return groupBy.mock.calls[0][0].where as Where;
}

describe("loadUsageGroupsForInventory — OR-owning predicates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps BOTH the search and the content predicate when both are supplied", async () => {
    const where = await whereFor(CONTENT_SCOPE, {
      nameMatchedIdentities: [],
      search: "create-feat",
    });

    // Both survive, under `AND` — pre-fix `where.OR` held only the content arms
    // and the search predicate was nowhere in the clause.
    expect(where.AND).toEqual([
      {
        OR: [
          { componentKey: { contains: "create-feat", mode: "insensitive" } },
        ],
      },
      {
        OR: [
          { componentVersionHash: { in: ["hash-a"] } },
          { definitionVersion: { definitionHash: "hash-a" } },
        ],
      },
    ]);
    expect(where).not.toHaveProperty("OR");
  });

  it("emits the search predicate flat when it is the only OR-owning arm", async () => {
    // The reachable shape, held byte-identical to what the call site emitted
    // before: an `AND` wrapper around a lone predicate would be a gratuitous
    // change to every list read that carries a `?search=`.
    const where = await whereFor(null, {
      nameMatchedIdentities: [],
      search: "create-feat",
    });

    expect(where.OR).toEqual([
      { componentKey: { contains: "create-feat", mode: "insensitive" } },
    ]);
    expect(where).not.toHaveProperty("AND");
  });

  it("emits neither key when no OR-owning predicate applies", async () => {
    const where = await whereFor(null, null);

    expect(where).not.toHaveProperty("AND");
    expect(where).not.toHaveProperty("OR");
  });
});

/**
 * ISS-6756: `loadUsageGroupsLinkedElsewhere` was converted onto the persisted
 * fold alongside `detailOrphanUsageWhere`, because `detailUsageNameKeys` exists
 * so both lanes ask under ONE name set and the fold trims where `ILIKE` does not.
 *
 * The reconciliation suite that drives this lane runs it against a
 * `where`-evaluating double that lowercases both sides under
 * `mode: "insensitive"` and derives the fixture's fold with the same
 * `normalizeComponentKey` — so the two spellings are indistinguishable to it and
 * reverting this lane to the ILIKE twin leaves that suite green. The sibling lane
 * got an explicit spelling assertion (`detail-usage-reads.test.ts`); this is the
 * one it was missing.
 */
describe("loadUsageGroupsLinkedElsewhere — identity spelling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches the persisted fold, with no raw-key ILIKE left in the predicate", async () => {
    const { groupBy } = installGroupBy();

    await loadUsageGroupsLinkedElsewhere(
      { agentComponentSessionUsage: { groupBy } } as never,
      ORGANIZATION_ID,
      "skill",
      ["Create-Feat"],
      ["inv-other"],
      CONTENT_SCOPE
    );

    const where = groupBy.mock.calls[0][0].where as Where;
    expect((where.AND as Where[]).at(0)).toEqual({
      componentKeyNormalized: { in: ["create-feat"] },
    });
    expect(JSON.stringify(where)).not.toContain("insensitive");
  });
});
