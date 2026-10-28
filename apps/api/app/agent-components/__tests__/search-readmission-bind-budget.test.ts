/**
 * ISS-8932 (#6483, davetho): the `?search=` readmission arms were bounded only
 * by the 5,000-identity population cap ISS-6891 removed. `usageSearchWhere` emits
 * one `OR` arm per name-matched identity at two bind slots each, so against the
 * ~32,000-slot `INVENTORY_USAGE_ID_CHUNK_SIZE` an org with roughly 16k
 * name-matching components floored the id chunking at one id and STILL emitted a
 * statement Postgres refuses — a 500 on a broad `?search=` instead of the
 * complete inventory.
 *
 * WHY THE FIX IS A PARTITION AND NOT A CHUNKING, which is what most of this file
 * pins. A usage row can satisfy BOTH the `componentKey contains` arm and an
 * identity arm, so slicing the `OR` naively returns the same row under two
 * statements; both consumers concatenate `groupBy` results without
 * re-aggregating, so that would double a component's invocations and sessions —
 * a silently inflated total, strictly worse than the refusal it replaced. The
 * passes therefore carry an explicit `NOT` of the `contains` arm, and the
 * assertions below evaluate the EMITTED passes against rows that sit on each side
 * of that overlap rather than trusting the shape.
 *
 * The widths are measured off the `where` each production call handed the client,
 * never re-derived from the constants they are supposed to be holding.
 */
import { describe, expect, it, vi } from "vitest";

// The modules import `@repo/database` only for a `typeof withDb` type and are
// called with a caller-supplied `db`; mock it so they load without a real client.
vi.mock("@repo/database", () => ({
  Prisma: {},
  withDb: vi.fn(),
}));

import {
  countPredicateBindParameters,
  POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS,
} from "@/lib/postgres-bind-parameters";
import { loadUsageGroupsForInventory } from "../org-population";
import { loadOrphanUsageRows, usageSearchWhere } from "../org-population-reads";
import { BIND_PARAMETERS_RESERVED_PER_STATEMENT } from "../usage-bind-budget";

const ORG = "org-iss-8932";
const SEARCH = "review";
const KINDS = ["skill", "command", "subagent"] as const;

/**
 * The one parameter the emitted `where` carries that the production sizing does
 * NOT subtract for the FK lane: `runUsageGroupBy` applies the org isolation bound
 * after the lane predicate. The widths measured below are read off that final
 * `where`, so the org bind is inside them already — adding it back keeps the
 * budget from charging that slot twice and rejecting a statement the production
 * path is entitled to emit.
 */
const ORG_SCOPE_BIND_COUNT = 1;

const COUNTED_PREDICATE_BIND_BUDGET =
  POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS -
  BIND_PARAMETERS_RESERVED_PER_STATEMENT +
  ORG_SCOPE_BIND_COUNT;

/**
 * Wide enough that the arms ALONE fill the ceiling at two binds each, so the
 * unsplit predicate is over the line before a single inventory id joins it. An
 * independent literal, deliberately not derived from the constant it guards.
 */
const OVER_CEILING_IDENTITY_COUNT = 20_000;

/**
 * A key that CONTAINS the search term, carried by one of the name-matched
 * identities. This is the overlap the naive chunking gets wrong: its usage rows
 * satisfy the `contains` arm and its own identity arm at once.
 */
const OVERLAPPING_KEY = "team-review-bot";

/** Keys that do NOT contain the search term — the ordinary readmission case. */
function nonOverlappingKey(index: number): string {
  return `name-matched-key-${index}`;
}

const NAME_MATCHED_IDENTITIES = [
  { kind: "skill", key: OVERLAPPING_KEY },
  ...Array.from(
    { length: OVER_CEILING_IDENTITY_COUNT - 1 },
    (_unused, index) => ({ kind: "skill", key: nonOverlappingKey(index) })
  ),
];

const SEARCH_FACET = {
  search: SEARCH,
  nameMatchedIdentities: NAME_MATCHED_IDENTITIES,
};

type WhereArgs = { where: Record<string, unknown> };

function makeFakeDb() {
  const groupBy = vi.fn((_args: WhereArgs) => Promise.resolve([]));
  return {
    db: {
      agentComponentSessionUsage: { groupBy },
      definitionVersion: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as Parameters<typeof loadUsageGroupsForInventory>[0],
    groupBy,
  };
}

function inventoryIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `component-${index}`
  );
}

function emittedWidths(groupBy: ReturnType<typeof makeFakeDb>["groupBy"]) {
  return groupBy.mock.calls.map(([args]) =>
    countPredicateBindParameters(args.where)
  );
}

type IdentityArm = { componentKind: string; componentKeyNormalized: string };
type ContainsFilter = { contains: string; mode: string };

/**
 * Evaluate ONE emitted `where` against a synthetic usage row, modelling only the
 * three shapes `usageSearchWherePasses` can produce: the bare `contains` arm, an
 * identity pass under a `NOT` of it, and the un-split `OR` of both. Anything else
 * throws rather than being waved through — a double that silently answered
 * `false` for an unrecognised shape would report a clean partition for a
 * predicate it never understood.
 */
function passMatches(
  where: Record<string, unknown>,
  row: { componentKind: string; componentKey: string }
): boolean {
  const normalized = row.componentKey.trim().toLowerCase();
  const containsFilter = where.componentKey as ContainsFilter | undefined;
  const negated = where.NOT as { componentKey: ContainsFilter } | undefined;
  const or = where.OR as
    | ({ componentKey?: ContainsFilter } & Partial<IdentityArm>)[]
    | undefined;
  if (containsFilter && !(negated || or)) {
    return normalized.includes(containsFilter.contains.toLowerCase());
  }
  if (!or) {
    throw new Error(`double does not model pass ${JSON.stringify(where)}`);
  }
  if (
    negated &&
    normalized.includes(negated.componentKey.contains.toLowerCase())
  ) {
    return false;
  }
  return or.some((arm) => {
    if (arm.componentKey) {
      return normalized.includes(arm.componentKey.contains.toLowerCase());
    }
    return (
      arm.componentKind === row.componentKind &&
      arm.componentKeyNormalized === normalized
    );
  });
}

/** Every identity arm asked for across every emitted statement. */
function askedIdentityArms(
  groupBy: ReturnType<typeof makeFakeDb>["groupBy"]
): IdentityArm[] {
  return groupBy.mock.calls.flatMap(([args]) => {
    const or = (args.where.OR ?? []) as Partial<IdentityArm>[];
    return or.filter(
      (arm): arm is IdentityArm => arm.componentKeyNormalized !== undefined
    );
  });
}

/**
 * Rows that sit on each side of the overlap the naive chunking gets wrong. Each
 * one is a `(componentKind, componentKey)` pair, which is all any pass predicate
 * reads — and both columns are in each lane's `groupBy` key, which is why a row's
 * pass count is also its GROUP's pass count.
 */
const PARTITION_PROBE_ROWS = [
  // Matches BOTH the `contains` arm and its own identity arm.
  { componentKind: "skill", componentKey: OVERLAPPING_KEY },
  // Matches the `contains` arm only — no identity readmits it.
  { componentKind: "skill", componentKey: "unrelated-review-helper" },
  // Matches an identity arm only, from the first slice.
  { componentKind: "skill", componentKey: nonOverlappingKey(0) },
  // Matches an identity arm only, from deep in the tail.
  {
    componentKind: "skill",
    componentKey: nonOverlappingKey(OVER_CEILING_IDENTITY_COUNT - 2),
  },
  // Matches nothing: right key, wrong kind.
  { componentKind: "command", componentKey: nonOverlappingKey(0) },
  // Matches nothing at all.
  { componentKind: "skill", componentKey: "no-match-anywhere" },
];

describe("?search= readmission bind budget (ISS-8932)", () => {
  it("asks for a facet an unsplit predicate could not have emitted", () => {
    // The counterfactual, measured rather than restated: the whole facet as ONE
    // `usageSearchWhere` already fills the ceiling, so the single id the chunk
    // floor still sends put the statement past it.
    expect(
      countPredicateBindParameters(usageSearchWhere(SEARCH_FACET))
    ).toBeGreaterThan(POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS);
  });

  it("keeps every FK-lane statement inside the reserved bind budget", async () => {
    const { db, groupBy } = makeFakeDb();

    await loadUsageGroupsForInventory(
      db,
      ORG,
      inventoryIds(3),
      {},
      null,
      KINDS,
      SEARCH_FACET
    );

    const widths = emittedWidths(groupBy);
    expect(widths.length).toBeGreaterThan(1);
    expect(Math.max(...widths)).toBeLessThanOrEqual(
      COUNTED_PREDICATE_BIND_BUDGET
    );
  });

  it("partitions the FK lane's rows — each probe row matches exactly one pass", async () => {
    const { db, groupBy } = makeFakeDb();

    await loadUsageGroupsForInventory(
      db,
      ORG,
      inventoryIds(1),
      {},
      null,
      KINDS,
      SEARCH_FACET
    );

    // The load-bearing assertion of the whole change. A row matching two passes
    // is a DOUBLED invocation count, a row matching none is a dropped component
    // — both plausible wrong numbers rather than errors, and both invisible to a
    // shape assertion. Held against the unsplit predicate's own answer so the
    // expectation is the production semantics, not a restatement of them.
    for (const row of PARTITION_PROBE_ROWS) {
      const matched = groupBy.mock.calls.filter(([args]) =>
        passMatches(args.where, row)
      ).length;
      const expected = passMatches(
        usageSearchWhere(SEARCH_FACET) as Record<string, unknown>,
        row
      )
        ? 1
        : 0;
      expect({ key: row.componentKey, matched }).toEqual({
        key: row.componentKey,
        matched: expected,
      });
    }
  });

  it("asks for every readmitted identity exactly once", async () => {
    const { db, groupBy } = makeFakeDb();

    await loadUsageGroupsForInventory(
      db,
      ORG,
      inventoryIds(1),
      {},
      null,
      KINDS,
      SEARCH_FACET
    );

    // A dropped identity understates the component it readmitted; a duplicated
    // one is the double-count above arriving by a different route. Pinned by
    // multiset AND set identity.
    const asked = askedIdentityArms(groupBy);
    expect(asked).toHaveLength(NAME_MATCHED_IDENTITIES.length);
    expect(new Set(asked.map((arm) => arm.componentKeyNormalized))).toEqual(
      new Set(NAME_MATCHED_IDENTITIES.map((identity) => identity.key))
    );
  });

  it("still covers every inventory id under each pass", async () => {
    const { db, groupBy } = makeFakeDb();
    const ids = inventoryIds(3);

    await loadUsageGroupsForInventory(
      db,
      ORG,
      ids,
      {},
      null,
      KINDS,
      SEARCH_FACET
    );

    // The two loops MULTIPLY, so a pass that took the whole budget would leave
    // the id chunking floored at one id — one statement per inventory row inside
    // a bounded interactive transaction. Every pass must see the whole id set in
    // a single statement, or rows FK-linked to the ids it missed are lost for the
    // identities it owned.
    for (const [args] of groupBy.mock.calls) {
      expect((args.where.agentComponentId as { in: string[] }).in).toEqual(ids);
    }
  });

  it("leaves a facet that fits in a single un-split statement", async () => {
    const { db, groupBy } = makeFakeDb();
    const facet = {
      search: SEARCH,
      nameMatchedIdentities: NAME_MATCHED_IDENTITIES.slice(0, 900),
    };

    await loadUsageGroupsForInventory(
      db,
      ORG,
      inventoryIds(3),
      {},
      null,
      KINDS,
      facet
    );

    // The realistic case must be byte-identical to what shipped before: one
    // statement carrying the whole `usageSearchWhere` predicate, so the split
    // costs no extra round trip for any request this product actually serves.
    expect(groupBy.mock.calls).toHaveLength(1);
    const [[args]] = groupBy.mock.calls;
    expect(args.where.OR).toEqual(
      (usageSearchWhere(facet) as { OR: unknown }).OR
    );
    expect(args.where.NOT).toBeUndefined();
  });

  it("bounds and partitions the ORPHAN lane, which has no id chunking to hide behind", async () => {
    const { db, groupBy } = makeFakeDb();

    await loadOrphanUsageRows(
      db,
      ORG,
      {
        kinds: KINDS,
        search: SEARCH,
        nameMatchedIdentities: [...NAME_MATCHED_IDENTITIES],
      },
      {}
    );

    // This lane issues ONE statement per pass with no second loop, so before the
    // fix the whole facet rode in a single un-split `OR` — the same refusal with
    // nothing between it and the driver.
    const widths = emittedWidths(groupBy);
    expect(widths.length).toBeGreaterThan(1);
    expect(Math.max(...widths)).toBeLessThanOrEqual(
      COUNTED_PREDICATE_BIND_BUDGET
    );
    for (const row of PARTITION_PROBE_ROWS) {
      const matched = groupBy.mock.calls.filter(([args]) =>
        passMatches(args.where, row)
      ).length;
      expect({ key: row.componentKey, matched }).toEqual({
        key: row.componentKey,
        matched: passMatches(
          usageSearchWhere(SEARCH_FACET) as Record<string, unknown>,
          row
        )
          ? 1
          : 0,
      });
    }
  });
});
