/**
 * ISS-7271: the FK usage rollup held back a FIXED 767 bind slots for the
 * request's facets, but one of those facets — `?search=` — expands into an OR
 * arm per name-matched identity, each binding TWO parameters
 * (`componentKind` + `componentKeyNormalized`). The arm count follows the org's
 * name-matching inventory, so a large org running a broad search asked for
 * thousands of slots against a 767-slot reserve and built a statement past the
 * driver's bind-parameter limit.
 *
 * That statement is REFUSED, not merely slow, and this lane is deliberately not
 * fail-open — the rejection propagates and 500s the Agents catalog request. It
 * is the exact failure the ISS-5516 chunking was added to prevent, arriving
 * through the one term the reserve could not hold constant.
 *
 * ISS-6891: when this was written the arm count was bounded by the 5,000-identity
 * population cap, and the fixture below took its width from that constant. The
 * cap is gone — the population reads carry no terminal cap now — so the fixture
 * carries its own width. The contract under test is unchanged and strictly more
 * load-bearing: nothing upstream bounds this facet any more, so the measured
 * narrowing in `inventoryUsageIdChunkSize` is the only thing keeping the
 * statement under the ceiling.
 *
 * WHY THE EXISTING CHUNKING SUITES DID NOT CATCH IT. Both drive the read with
 * NO facets — `org-population-usage-chunking` (ISS-5516) pins the partition and
 * `inventory-usage-id-chunking` (ISS-8239) pins the fencepost — so the widest
 * statement they can emit is a full chunk plus a handful of binds, which fits
 * whatever the reserve is. The facet width is the variable neither varies.
 *
 * The assertions read the widths the production call actually EMITTED off the
 * `groupBy` double and hold them against the width the SAME request's facets
 * measure, rather than against arithmetic restated from the constants.
 */
import { describe, expect, it, vi } from "vitest";

// The module imports `@repo/database` only for a `typeof withDb` type and is
// called with a caller-supplied `db`; mock it so the module loads without a
// real client.
vi.mock("@repo/database", () => ({
  Prisma: {},
  withDb: vi.fn(),
}));

import {
  countPredicateBindParameters,
  POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS,
} from "@/lib/postgres-bind-parameters";
import { loadUsageGroupsForInventory } from "../org-population";
import { usageSearchWhere } from "../org-population-reads";
import { INVENTORY_USAGE_ID_CHUNK_SIZE } from "../usage-bind-budget";

const ORG = "org-1";
const SEARCH = "review";
const KINDS = ["skill", "command", "subagent"] as const;

/**
 * How many identities the `?search=` facet readmits in these fixtures. Held at
 * the 5,000 ISS-6891 removed as the population cap, so every width and every
 * assertion below is the one ISS-7271 established — but declared here now,
 * because no constant upstream bounds this count any more.
 *
 * What the number has to be is "wide enough that `2N + 2` dwarfs the 767-slot
 * reserve", which is the premise the first case asserts directly.
 */
const NAME_MATCHED_IDENTITY_COUNT = 5000;

type GroupByArgs = {
  where: { agentComponentId: { in: string[] } };
};

function makeFakeDb() {
  const groupBy = vi.fn((_args: GroupByArgs) => Promise.resolve([]));
  return {
    db: {
      agentComponentSessionUsage: { groupBy },
      definitionVersion: { findMany: vi.fn() },
    } as unknown as Parameters<typeof loadUsageGroupsForInventory>[0],
    groupBy,
  };
}

function emittedChunkWidths(
  groupBy: ReturnType<typeof makeFakeDb>["groupBy"]
): number[] {
  return groupBy.mock.calls.map(
    ([args]) => args.where.agentComponentId.in.length
  );
}

function inventoryIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `component-${index}`
  );
}

/**
 * A broad `?search=` facet: every identity is one an inventory row
 * matched on its display `name` and NOT on its key, which is exactly what
 * `collectNameMatchedIdentities` returns and what the readmission arms are built
 * from. Keys are distinct and fold to something, so none is dropped — a facet
 * whose keys folded away would emit no arms and prove nothing.
 */
const NAME_MATCHED_IDENTITIES = Array.from(
  { length: NAME_MATCHED_IDENTITY_COUNT },
  (_unused, index) => ({ kind: "skill", key: `name-matched-key-${index}` })
);

const SEARCH_FACET = {
  search: SEARCH,
  nameMatchedIdentities: NAME_MATCHED_IDENTITIES,
};

/** Two chunks' worth at the UNFACETED size, so the first chunk is always full. */
const ADVERSARIAL_ID_COUNT = INVENTORY_USAGE_ID_CHUNK_SIZE * 2;

/**
 * The bind width the request's own facets spend, measured the way the read
 * measures it: the search predicate, the `?kinds=` arm, and the org scope the
 * rollup applies to every chunk.
 */
function facetBindWidth(): number {
  return countPredicateBindParameters({
    ...usageSearchWhere(SEARCH_FACET),
    componentKind: { in: [...KINDS] },
    session: { artifact: { organizationId: ORG } },
  });
}

describe("loadUsageGroupsForInventory facet bind budget (ISS-7271)", () => {
  it("emits arms the fixed reserve could never have held — the premise of the defect", () => {
    // 2N + 1: one `contains` arm on the raw key plus two binds per readmitted
    // identity. Measured at one more than that, because the counter charges a
    // slot for the arm's `mode` modifier rather than guessing it apart from a
    // column named `mode` — slack, in the safe direction. If this ever stops
    // being true the budget assertions below are measuring something other than
    // the failure.
    expect(countPredicateBindParameters(usageSearchWhere(SEARCH_FACET))).toBe(
      2 * NAME_MATCHED_IDENTITY_COUNT + 2
    );
    expect(facetBindWidth()).toBeGreaterThan(INVENTORY_USAGE_ID_CHUNK_SIZE / 4);
  });

  it("keeps a full chunk plus the request's own facet width inside the bind ceiling", async () => {
    const { db, groupBy } = makeFakeDb();

    await loadUsageGroupsForInventory(
      db,
      ORG,
      inventoryIds(ADVERSARIAL_ID_COUNT),
      {},
      null,
      KINDS,
      SEARCH_FACET
    );

    const widths = emittedChunkWidths(groupBy);
    expect(widths.length).toBeGreaterThan(0);
    const widest = Math.max(...widths);
    // The chunk MUST have narrowed: at the unfaceted size the statement is over
    // the ceiling, so a passing budget check with an unnarrowed chunk would mean
    // the fixture, not the fix, did the work.
    expect(widest).toBeLessThan(INVENTORY_USAGE_ID_CHUNK_SIZE);
    expect(widest + facetBindWidth()).toBeLessThanOrEqual(
      POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS
    );
  });

  it("still covers the whole id set once the facet narrows the chunk", async () => {
    const { db, groupBy } = makeFakeDb();
    const ids = inventoryIds(ADVERSARIAL_ID_COUNT + 1);

    await loadUsageGroupsForInventory(
      db,
      ORG,
      ids,
      {},
      null,
      KINDS,
      SEARCH_FACET
    );

    // A narrower chunk means MORE statements, so a partition that dropped or
    // duplicated a boundary id would understate or double-count a component's
    // usage — a plausible wrong number rather than an error.
    const seen = groupBy.mock.calls.flatMap(
      ([args]) => args.where.agentComponentId.in
    );
    expect(seen).toEqual(ids);
  });
});
