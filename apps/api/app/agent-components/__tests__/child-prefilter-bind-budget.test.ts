/**
 * ISS-8932 (#6483, chatgpt-codex-connector): the plugin child-usage rollup builds
 * two predicates whose width follows the org's data and nothing upstream caps —
 * `readChildInventory`'s `packId: { in: … }` (one bind per requested pack) and
 * `loadChildInventoryJoin`'s prefilter (`componentKind` + `componentKeyNormalized`,
 * two bind slots per child identity since #6584 folded the arm to an indexed
 * equality). ISS-6891 removed the row cap that used to sit behind both. Against the
 * ~32,000-slot `INVENTORY_USAGE_ID_CHUNK_SIZE`, an org past roughly 32k candidate
 * packs or 16k child identities emitted a statement Postgres refuses.
 *
 * BOTH slicers are exercised here (whitlockk review on #6611). Supplying a single pack
 * leaves the `packId` chunker dead code that no assertion can reach, so a
 * regression putting every pack back into one statement would keep this suite
 * green; the inventory cases below therefore drive an over-budget PACK list and
 * pin each emitted statement's width AND its membership.
 *
 * WHY THE SLICES NEED A DEDUPE, which is the half a shape assertion cannot see.
 * The two LANES overlap by construction: a usage row carrying a live inventory FK
 * whose folded key also matches one of that pack's identity arms is returned by
 * the FK statement AND by the identity statement. A plain concatenation returns it
 * twice, doubling that plugin's invocations — a plausible wrong number rather than
 * an error. The read therefore selects the row's primary key and de-duplicates on
 * it, and the case below proves both statements really do return that row.
 *
 * (Within a lane there is nothing to dedupe: a usage row carries exactly one
 * `componentKeyNormalized` and the arms are distinct equalities, so the identity
 * slices partition. That is a property of #6584's arm shape, not of the slicing,
 * and it is why the overlap case targets the lane boundary instead.)
 *
 * The ticket's acceptance for this lane is the last case: identical per-pack
 * totals at a child-identity count past the budget as below it.
 */
import { describe, expect, it, vi } from "vitest";

// The module imports `@repo/database` only for a `typeof withDb` type and is
// called with a caller-supplied `db`; mock it so it loads without a real client.
vi.mock("@repo/database", () => ({
  Prisma: {},
  withDb: vi.fn(),
}));

import {
  countPredicateBindParameters,
  POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS,
} from "@/lib/postgres-bind-parameters";
import {
  loadChildUsageByPackId,
  loadDetailChildUsageRows,
  MAX_ORG_ORPHAN_USAGE_ROWS,
} from "../plugin-child-usage";
import { INVENTORY_USAGE_ID_CHUNK_SIZE } from "../usage-bind-budget";

const ORG = "org-iss-8932";
const PACK = "pack-under-test";

/**
 * Enough children that two binds each carries the unsplit prefilter past the
 * ceiling. An independent literal, not derived from the constant it guards; the
 * first case below measures that it really is past.
 */
const OVER_CEILING_CHILD_COUNT = 20_000;

/**
 * Enough packs that one bind each carries the unsplit `packId` list past the
 * ceiling. Independent of the constant for the same reason.
 */
const OVER_CEILING_PACK_COUNT = 40_000;

/**
 * The key both lanes admit: `child-0`'s inventory key, so the identity arm
 * `command::reviewer` exists, and the FK a usage row can also carry.
 */
const SHARED_KEY = "reviewer";
const CHILD_KIND = "command";
const FK_CHILD_ID = "child-0";

type ChildInvRow = {
  id: string;
  componentKind: string;
  componentKey: string;
  packId: string;
};

type UsageRow = {
  id: string;
  agentSessionId: string;
  agentComponentId: string | null;
  componentKind: string;
  componentKey: string;
  invocationCount: number;
  errorCount: number;
  lastInvokedAt: Date | null;
};

type FkArm = { agentComponentId: { in: string[] } };
type IdentityArm = { componentKind: string; componentKeyNormalized: string };
type PrefilterArm = FkArm | IdentityArm;

function isFkArm(arm: PrefilterArm): arm is FkArm {
  return "agentComponentId" in arm;
}

function childRow(key: string, index: number): ChildInvRow {
  return {
    id: `child-${index}`,
    componentKind: CHILD_KIND,
    componentKey: key,
    packId: PACK,
  };
}

/** `child-0` carries the shared key; the filler children widen the prefilter. */
function childInventory(fillerCount: number): ChildInvRow[] {
  return [
    childRow(SHARED_KEY, 0),
    ...Array.from({ length: fillerCount }, (_unused, index) =>
      childRow(`filler-child-${index}`, index + 1)
    ),
  ];
}

/**
 * `usage-1` carries BOTH a live FK and a case/whitespace variant of the shared
 * key, so the FK statement and the identity statement each return it — the
 * overlap the dedupe exists for, and the FEA-3239 fold in one row. `usage-2` is
 * the orphan-FK case, reachable only through the identity lane.
 */
const CHILD_USAGE: UsageRow[] = [
  {
    id: "usage-1",
    agentSessionId: "session-1",
    agentComponentId: FK_CHILD_ID,
    componentKind: CHILD_KIND,
    componentKey: "  ReViEwEr  ",
    invocationCount: 7,
    errorCount: 2,
    lastInvokedAt: new Date("2026-01-02T00:00:00.000Z"),
  },
  {
    id: "usage-2",
    agentSessionId: "session-2",
    agentComponentId: null,
    componentKind: CHILD_KIND,
    componentKey: SHARED_KEY,
    invocationCount: 5,
    errorCount: 1,
    lastInvokedAt: new Date("2026-01-01T00:00:00.000Z"),
  },
];

/** The persisted fold the ISS-6756 trigger writes, applied by the double. */
function foldKey(componentKey: string): string {
  return componentKey.trim().toLowerCase();
}

function armAdmits(arm: PrefilterArm, row: UsageRow): boolean {
  if (isFkArm(arm)) {
    return (
      row.agentComponentId !== null &&
      arm.agentComponentId.in.includes(row.agentComponentId)
    );
  }
  return (
    arm.componentKind === row.componentKind &&
    arm.componentKeyNormalized === foldKey(row.componentKey)
  );
}

/**
 * A fake client whose inventory read honors the `packId` slice and whose usage
 * read EVALUATES the prefilter arms it was handed. A double that returned the
 * same rows regardless of the `OR` would prove nothing about the slicing — it
 * would hand every row to every statement and pass identically with or without
 * the dedupe.
 */
function makeFakeDb(inventory: ChildInvRow[]) {
  const inventoryFindMany = vi.fn(
    (args: { where: { packId: { in: string[] } } }) => {
      const requested = new Set(args.where.packId.in);
      return Promise.resolve(
        inventory.filter((row) => requested.has(row.packId))
      );
    }
  );
  const usageFindMany = vi.fn((args: { where: { OR: PrefilterArm[] } }) =>
    Promise.resolve(
      CHILD_USAGE.filter((row) =>
        args.where.OR.some((arm) => armAdmits(arm, row))
      )
    )
  );
  return {
    db: {
      agentComponent: { findMany: inventoryFindMany },
      agentComponentSessionUsage: { findMany: usageFindMany },
    } as unknown as Parameters<typeof loadChildUsageByPackId>[0],
    inventoryFindMany,
    usageFindMany,
  };
}

function unsplitPrefilterWidth(childCount: number): number {
  return countPredicateBindParameters(
    Array.from({ length: childCount }, (_unused, index) => ({
      componentKind: CHILD_KIND,
      componentKeyNormalized: `key-${index}`,
    }))
  );
}

function packIds(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `pack-${index}`);
}

describe("plugin child-usage prefilter bind budget (ISS-8932)", () => {
  it("asks for predicates an unsplit statement could not have emitted", () => {
    // The counterfactual, measured: each list on its own is already past the
    // ceiling before the rest of the statement joins it.
    expect(unsplitPrefilterWidth(OVER_CEILING_CHILD_COUNT)).toBeGreaterThan(
      POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS
    );
    expect(
      countPredicateBindParameters(packIds(OVER_CEILING_PACK_COUNT))
    ).toBeGreaterThan(POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS);
  });

  it("keeps every emitted usage statement inside the reserved bind budget", async () => {
    const { db, usageFindMany } = makeFakeDb(
      childInventory(OVER_CEILING_CHILD_COUNT)
    );

    await loadChildUsageByPackId(db, [PACK], ORG);

    const widths = usageFindMany.mock.calls.map(([args]) =>
      countPredicateBindParameters(args.where)
    );
    expect(widths.length).toBeGreaterThan(1);
    expect(Math.max(...widths)).toBeLessThanOrEqual(
      INVENTORY_USAGE_ID_CHUNK_SIZE
    );
  });

  it("keeps every emitted INVENTORY statement inside the reserved bind budget", async () => {
    const { db, inventoryFindMany } = makeFakeDb(childInventory(0));

    await loadChildUsageByPackId(db, packIds(OVER_CEILING_PACK_COUNT), ORG);

    // whitlockk: with one pack this slicer never runs and a regression that put every
    // pack back into one statement would not be visible here.
    const widths = inventoryFindMany.mock.calls.map(([args]) =>
      countPredicateBindParameters(args.where)
    );
    expect(widths.length).toBeGreaterThan(1);
    expect(Math.max(...widths)).toBeLessThanOrEqual(
      INVENTORY_USAGE_ID_CHUNK_SIZE
    );
  });

  it("asks for every requested pack exactly once across the inventory slices", async () => {
    const requested = packIds(OVER_CEILING_PACK_COUNT);
    const { db, inventoryFindMany } = makeFakeDb(childInventory(0));

    await loadChildUsageByPackId(db, requested, ORG);

    // A dropped pack silently removes its children from every plugin whose
    // candidate set contained it; a duplicated one re-reads the same inventory.
    const asked = inventoryFindMany.mock.calls.flatMap(
      ([args]) => args.where.packId.in
    );
    expect(asked).toHaveLength(requested.length);
    expect(new Set(asked)).toEqual(new Set(requested));
  });

  it("asks for every child identity exactly once across the slices", async () => {
    const { db, usageFindMany } = makeFakeDb(
      childInventory(OVER_CEILING_CHILD_COUNT)
    );

    await loadChildUsageByPackId(db, [PACK], ORG);

    // A dropped arm silently removes a child from its plugin's total; a
    // duplicated one is a second route to a double-count.
    const asked = usageFindMany.mock.calls
      .flatMap(([args]) => args.where.OR)
      .filter((arm): arm is IdentityArm => !isFkArm(arm));
    expect(asked).toHaveLength(OVER_CEILING_CHILD_COUNT + 1);
    expect(new Set(asked.map((arm) => arm.componentKeyNormalized)).size).toBe(
      OVER_CEILING_CHILD_COUNT + 1
    );
  });

  it("asks for every inventory FK exactly once across the slices", async () => {
    const { db, usageFindMany } = makeFakeDb(
      childInventory(OVER_CEILING_CHILD_COUNT)
    );

    await loadChildUsageByPackId(db, [PACK], ORG);

    // The FK lane is #6584's half of the prefilter — it is what keeps usage
    // written before an inventory key rename attributed — and it is bound by the
    // same budget, so it is sliced and must be complete for the same reason.
    const asked = usageFindMany.mock.calls
      .flatMap(([args]) => args.where.OR)
      .filter(isFkArm)
      .flatMap((arm) => arm.agentComponentId.in);
    expect(asked).toHaveLength(OVER_CEILING_CHILD_COUNT + 1);
    expect(new Set(asked)).toEqual(
      new Set(childInventory(OVER_CEILING_CHILD_COUNT).map((row) => row.id))
    );
  });

  it("returns a lane-overlapping row from both statements, and counts it once", async () => {
    const { db, usageFindMany } = makeFakeDb(
      childInventory(OVER_CEILING_CHILD_COUNT)
    );

    const byPack = await loadChildUsageByPackId(db, [PACK], ORG);

    // The premise of the dedupe: `usage-1` really IS returned twice, so the
    // concatenation carries it twice and the dedupe is load-bearing, not
    // defensive. Asserted on what the double returned, not on the arms.
    const returned = await Promise.all(
      usageFindMany.mock.results.map(
        (result) => result.value as Promise<UsageRow[]>
      )
    );
    const usageOneCount = returned
      .flat()
      .filter((row) => row.id === "usage-1").length;
    expect(usageOneCount).toBe(2);
    // And the total counts its 7 invocations once, not 14.
    expect(byPack.get(PACK)?.invocations).toBe(12);
  });

  it("returns identical per-pack totals past the budget as below it", async () => {
    const under = makeFakeDb(childInventory(0));
    const over = makeFakeDb(childInventory(OVER_CEILING_CHILD_COUNT));

    const underBudget = await loadChildUsageByPackId(under.db, [PACK], ORG);
    const overBudget = await loadChildUsageByPackId(over.db, [PACK], ORG);

    // The ticket's acceptance for this lane, stated as it states it: no
    // double-count, no drop. The under-budget run is ONE statement per lane, the
    // over-budget run splits the identity lane; the filler children match no
    // usage row, so the only thing that can move the numbers is the slicing.
    expect(under.usageFindMany).toHaveBeenCalledTimes(2);
    expect(over.usageFindMany.mock.calls.length).toBeGreaterThan(2);

    const underBucket = underBudget.get(PACK);
    const overBucket = overBudget.get(PACK);
    // Pinned against independent literals, not against each other: two runs that
    // agreed on a doubled number would satisfy an equality between them.
    expect(underBucket?.invocations).toBe(12);
    expect(underBucket?.errors).toBe(3);
    expect(underBucket?.sessionIds.size).toBe(2);
    expect(overBucket?.invocations).toBe(12);
    expect(overBucket?.errors).toBe(3);
    expect(overBucket?.sessionIds.size).toBe(2);
    expect(overBucket?.lastInvokedAt).toEqual(underBucket?.lastInvokedAt);
  });
});

/**
 * The DETAIL lane's twin of the above (whitlockk review on #6611). Bounding only the
 * list rollup left `loadDetailChildIdentityLookup`'s complete prefilter going to
 * `service/detail-read.ts` as ONE `OR`, so a plugin whose candidate packs carry
 * enough children still 500ed its own detail page — the same statement, reached
 * from a different screen.
 *
 * The detail statement carries a `take` the list's does not, which is what these
 * cases are really about: a per-slice `take` alone keeps up to `slices × cap`, so
 * the cap has to be re-applied over the merged rows, and re-applying it must
 * reproduce the rows ONE statement would have returned rather than an arbitrary
 * subset. The last case pins that ordering, not just the count.
 */
const DETAIL_KIND = "skill";

/** Enough arms that two binds each splits the detail statement. */
const DETAIL_OVER_CEILING_ARM_COUNT = 20_000;

/** Rows per slice, sized so the MERGED set is past the cap but no slice is. */
const DETAIL_ROWS_PER_SLICE = 15_000;

type DetailUsageRow = {
  id: string;
  lastInvokedAt: Date | null;
  agentSessionId: string;
  componentKind: string;
  componentKey: string;
  invocationCount: number;
};

function detailPrefilter(count: number): IdentityArm[] {
  return Array.from({ length: count }, (_unused, index) => ({
    componentKind: DETAIL_KIND,
    componentKeyNormalized: `detail-key-${index}`,
  }));
}

/**
 * A double that returns `DETAIL_ROWS_PER_SLICE` rows per statement, each row
 * stamped with the statement that produced it so recency is globally ordered and
 * interleaved across slices — a merge that simply concatenated the slices would
 * keep the wrong rows and be visible here.
 */
function makeDetailDb() {
  let callIndex = 0;
  const findMany = vi.fn(
    (args: { where: { OR: IdentityArm[] }; take: number }) => {
      const slice = callIndex;
      callIndex += 1;
      const rows: DetailUsageRow[] = Array.from(
        { length: Math.min(DETAIL_ROWS_PER_SLICE, args.take) },
        (_unused, index) => ({
          id: `row-${slice}-${String(index).padStart(6, "0")}`,
          // Interleaved: slice 0's row N and slice 1's row N differ by one ms, so
          // the true top-N is drawn from BOTH slices.
          lastInvokedAt: new Date(2_000_000_000_000 - index * 10 - slice),
          agentSessionId: `session-${index}`,
          componentKind: DETAIL_KIND,
          componentKey: `detail-key-${index}`,
          invocationCount: 1,
        })
      );
      return Promise.resolve(rows);
    }
  );
  return {
    db: {
      agentComponentSessionUsage: { findMany },
    } as unknown as Parameters<typeof loadDetailChildUsageRows>[0],
    findMany,
  };
}

describe("plugin detail child-usage prefilter bind budget (ISS-8932)", () => {
  it("keeps every emitted detail statement inside the reserved bind budget", async () => {
    const { db, findMany } = makeDetailDb();

    await loadDetailChildUsageRows(
      db,
      detailPrefilter(DETAIL_OVER_CEILING_ARM_COUNT),
      ORG
    );

    const widths = findMany.mock.calls.map(([args]) =>
      countPredicateBindParameters(args.where)
    );
    expect(widths.length).toBeGreaterThan(1);
    expect(Math.max(...widths)).toBeLessThanOrEqual(
      INVENTORY_USAGE_ID_CHUNK_SIZE
    );
  });

  it("asks for every detail identity exactly once across the slices", async () => {
    const { db, findMany } = makeDetailDb();

    await loadDetailChildUsageRows(
      db,
      detailPrefilter(DETAIL_OVER_CEILING_ARM_COUNT),
      ORG
    );

    const asked = findMany.mock.calls.flatMap(([args]) => args.where.OR);
    expect(asked).toEqual(detailPrefilter(DETAIL_OVER_CEILING_ARM_COUNT));
  });

  it("re-applies the row cap over the merged slices, keeping the true most-recent rows", async () => {
    const { db, findMany } = makeDetailDb();

    const { rows, truncated } = await loadDetailChildUsageRows(
      db,
      detailPrefilter(DETAIL_OVER_CEILING_ARM_COUNT),
      ORG
    );

    // The premise: more rows came back than the cap allows, from more than one
    // statement, so a missing re-slice would over-return and a missing re-sort
    // would return the wrong ones.
    const returned = findMany.mock.calls.length * DETAIL_ROWS_PER_SLICE;
    expect(findMany.mock.calls.length).toBeGreaterThan(1);
    expect(returned).toBeGreaterThan(MAX_ORG_ORPHAN_USAGE_ROWS);

    expect(rows).toHaveLength(MAX_ORG_ORPHAN_USAGE_ROWS);
    // ISS-9852: the read reports that its rows are a prefix, so the caller
    // re-reads the cards' totals rowless instead of folding this floor.
    expect(truncated).toBe(true);
    // Most-recent-first, nulls last, `id` ascending — the statement's own
    // `orderBy`, which the merged result must still satisfy.
    const times = rows.map((row) => row.lastInvokedAt?.getTime() ?? -1);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // And the retained set really is the TOP of the merged population: the
    // newest row of every slice survives, the oldest row of every slice does not.
    const retained = new Set(rows.map((row) => row.id));
    for (let slice = 0; slice < findMany.mock.calls.length; slice += 1) {
      expect(retained.has(`row-${slice}-000000`)).toBe(true);
      expect(
        retained.has(
          `row-${slice}-${String(DETAIL_ROWS_PER_SLICE - 1).padStart(6, "0")}`
        )
      ).toBe(false);
    }
  });
});
