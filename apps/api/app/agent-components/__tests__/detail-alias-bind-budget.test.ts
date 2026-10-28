/**
 * ISS-7284 (whitlockk review): `inventoryUsageIdChunkSize` narrows the id `IN` by
 * what the rest of the predicate binds and FLOORS at one id — and a floor is not
 * a bound. Once the non-id half alone crosses the accepted ceiling, that floor
 * still emits a statement (one id alongside an over-limit alias `IN`) and
 * Postgres refuses it outright, which this lane does not fail open on.
 *
 * The `?search=` facet cannot reach that band — its arms are bounded by the
 * identity spine cap, which is what `inventory-usage-facet-bind-budget` (ISS-7271)
 * covers. The DETAIL lane's alias set can: `keys` are
 * `resolveContentHashIdentity`'s alias set, one per distinct `componentKey` among
 * the `AgentComponentVersion` rows sharing a fingerprint, and that lookup takes no
 * `take`. `loadUsageGroupsLinkedElsewhere` therefore splits the alias list itself
 * before the id chunking runs.
 *
 * WHAT IS PINNED HERE, and why each case is load-bearing: that the emitted
 * statements stay inside the reserved budget under an alias set that alone
 * exceeds the ceiling; that the alias chunks PARTITION the set (a dropped alias
 * understates the detail's total, a duplicated one double-counts it — both
 * plausible wrong numbers rather than errors); that every alias chunk still sees
 * the whole id set; and that the split is EVEN, so the alias half cannot take the
 * whole budget and leave the id half floored at one statement per inventory row.
 * Every case measures the width off the `where` the production call handed the
 * client, not arithmetic over the constants.
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
import { PRISMA_IMPLICIT_BIND_PARAMETERS } from "../../agent-sessions/service/write-chunking";
import { usageNameIdentityWhere } from "../detail-usage-reads";
import { loadUsageGroupsLinkedElsewhere } from "../org-population";
import {
  BIND_PARAMETERS_RESERVED_PER_STATEMENT,
  INVENTORY_USAGE_ID_CHUNK_SIZE,
} from "../usage-bind-budget";

const ORG = "org-iss-7284";
const KIND = "skill";

/**
 * The one parameter the emitted `where` carries that the production sizing does
 * NOT subtract: `runUsageGroupBy` applies the org isolation bound after the lane
 * predicate, and `BIND_PARAMETERS_RESERVED_PER_STATEMENT` is what holds a slot
 * for it. The widths measured below are read off that final `where`, so the org
 * bind is inside them already.
 */
const ORG_SCOPE_BIND_COUNT = 1;

/**
 * The width an emitted statement may actually reach —
 * `POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS` less the headroom the production
 * sizing holds back for what no caller can count, plus back the org bind that
 * reserve covers and the measurement already contains. Subtracting the whole
 * reserve from a width that already includes the org scope would charge that one
 * slot twice and reject a chunk the production path is entitled to emit.
 *
 * davetho (ISS-7284 review): asserting against the raw accepted ceiling checks
 * only the structural half of the budget. The production path reserves ON TOP of
 * what it counts, so a regression that filled structural width all the way to
 * 32,766 would pass a raw-ceiling assertion while the real statement — structural
 * width plus Prisma's own binds — overflowed. Pinning the reserved budget is what
 * makes these assertions describe the statement Postgres actually sees.
 */
const COUNTED_PREDICATE_BIND_BUDGET =
  POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS -
  BIND_PARAMETERS_RESERVED_PER_STATEMENT +
  ORG_SCOPE_BIND_COUNT;

/**
 * One alias per accepted bind slot: under a single un-split predicate the
 * aliases alone reach the ceiling, so the one id the floor still sends puts the
 * statement past it.
 */
const OVER_CEILING_ALIAS_COUNT = POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS;

type GroupByArgs = { where: Record<string, unknown> };

function makeFakeDb() {
  const groupBy = vi.fn((_args: GroupByArgs) => Promise.resolve([]));
  return {
    db: {
      agentComponentSessionUsage: { groupBy },
      definitionVersion: { findMany: vi.fn() },
    } as unknown as Parameters<typeof loadUsageGroupsLinkedElsewhere>[0],
    groupBy,
  };
}

function inventoryIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `component-${index}`
  );
}

function aliases(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `alias-${index}`);
}

/**
 * The width of every statement the lane emitted, ids and aliases and kind
 * together — the count Postgres compares against its own limit.
 */
function emittedStatementWidths(
  groupBy: ReturnType<typeof makeFakeDb>["groupBy"]
): number[] {
  return groupBy.mock.calls.map(([args]) =>
    countPredicateBindParameters(args.where)
  );
}

/** The alias slice one emitted statement asked under. */
function askedAliases(args: GroupByArgs): string[] {
  const [nameWhere] = args.where.AND as {
    componentKeyNormalized: { in: string[] };
  }[];
  return nameWhere.componentKeyNormalized.in;
}

function askedIds(args: GroupByArgs): string[] {
  return (args.where.agentComponentId as { in: string[] }).in;
}

describe("loadUsageGroupsLinkedElsewhere alias bind budget (ISS-7284)", () => {
  it("asks for an alias set an unsplit predicate could not have emitted", () => {
    // The counterfactual, measured rather than restated: the whole alias set as
    // ONE `usageNameIdentityWhere` — the shape this lane built before the split
    // — already fills the ceiling, so the single id the floor still sends put
    // the statement past it.
    expect(
      countPredicateBindParameters(
        usageNameIdentityWhere(aliases(OVER_CEILING_ALIAS_COUNT))
      )
    ).toBeGreaterThanOrEqual(POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS);
  });

  it("keeps every emitted statement inside the reserved bind budget", async () => {
    const { db, groupBy } = makeFakeDb();

    await loadUsageGroupsLinkedElsewhere(
      db,
      ORG,
      KIND,
      aliases(OVER_CEILING_ALIAS_COUNT),
      inventoryIds(3)
    );

    const statementWidths = emittedStatementWidths(groupBy);
    expect(statementWidths.length).toBeGreaterThan(0);
    expect(Math.max(...statementWidths)).toBeLessThanOrEqual(
      COUNTED_PREDICATE_BIND_BUDGET
    );
  });

  it("partitions the alias set — every name asked for exactly once", async () => {
    const { db, groupBy } = makeFakeDb();
    const keys = aliases(OVER_CEILING_ALIAS_COUNT);

    await loadUsageGroupsLinkedElsewhere(db, ORG, KIND, keys, [
      "other-component",
    ]);

    // A dropped alias understates the detail's total and a duplicated one
    // double-counts it — both plausible wrong numbers rather than errors, so
    // this is pinned by multiset AND set identity. Aliases are already folded
    // and de-duplicated, so a usage row's single `componentKeyNormalized`
    // matches at most one chunk and the concatenation owes no dedupe.
    const asked = groupBy.mock.calls.flatMap(([args]) => askedAliases(args));
    expect(asked).toHaveLength(keys.length);
    expect(new Set(asked)).toEqual(new Set(keys));
  });

  it("still covers every inventory id under each alias chunk", async () => {
    const { db, groupBy } = makeFakeDb();
    const otherInventoryIds = inventoryIds(3);

    await loadUsageGroupsLinkedElsewhere(
      db,
      ORG,
      KIND,
      aliases(OVER_CEILING_ALIAS_COUNT),
      otherInventoryIds
    );

    // The two loops partition independently, so their product is a partition:
    // each alias chunk must see the WHOLE id set, or the rows FK-linked to the
    // ids it missed are lost for the names it owned.
    const byAliasChunk = new Map<string, string[]>();
    for (const [args] of groupBy.mock.calls) {
      const chunkKey = askedAliases(args)[0];
      const seen = byAliasChunk.get(chunkKey) ?? [];
      seen.push(...askedIds(args));
      byAliasChunk.set(chunkKey, seen);
    }
    expect(byAliasChunk.size).toBeGreaterThan(1);
    for (const seen of byAliasChunk.values()) {
      expect(seen).toEqual(otherInventoryIds);
    }
    // The two loops MULTIPLY, so the alias slice may not take the whole budget
    // and leave the id width floored at one: that trades a bind-limit refusal
    // for one statement per inventory row inside a bounded interactive
    // transaction. An even split leaves each alias chunk room to carry its ids
    // in a single statement, which is what this count pins.
    expect(groupBy.mock.calls).toHaveLength(byAliasChunk.size);
  });

  it("leaves an alias set that fits the budget in a single un-split chunk", async () => {
    const { db, groupBy } = makeFakeDb();
    const keys = aliases(900);

    await loadUsageGroupsLinkedElsewhere(
      db,
      ORG,
      KIND,
      keys,
      inventoryIds(INVENTORY_USAGE_ID_CHUNK_SIZE)
    );

    // The realistic case must be unchanged: an alias set well under half the
    // shared budget is asked in ONE slice, so the split costs no extra round
    // trip for any detail this product actually serves.
    const aliasSlices = new Set(
      groupBy.mock.calls.map(([args]) => askedAliases(args).length)
    );
    expect(aliasSlices).toEqual(new Set([keys.length]));
    expect(Math.max(...emittedStatementWidths(groupBy))).toBeLessThanOrEqual(
      COUNTED_PREDICATE_BIND_BUDGET
    );
  });

  it("keeps enough headroom for the binds Prisma adds that no caller can count", () => {
    // The alias split spends `INVENTORY_USAGE_ID_CHUNK_SIZE` as its shared
    // budget, and that constant is the accepted ceiling less this reserve — so
    // the split's own margin is only as honest as the reserve is. ISS-7271 moved
    // the FACET cost out of this constant into a per-request count, which leaves
    // it standing for one thing: the org scope plus the parameters Prisma spends
    // building the statement, measured and owned by
    // `PRISMA_IMPLICIT_BIND_PARAMETERS` (ISS-8185). Without this pin the constant
    // could be trimmed toward zero on the reasoning that the facets are counted
    // now — and a full chunk would then reach the last width the driver accepts
    // BEFORE Prisma adds its own, which is the ISS-8185/ISS-8239 refusal again.
    expect(BIND_PARAMETERS_RESERVED_PER_STATEMENT).toBeGreaterThanOrEqual(
      PRISMA_IMPLICIT_BIND_PARAMETERS
    );
  });
});
