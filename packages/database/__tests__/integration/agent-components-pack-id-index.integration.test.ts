import { randomUUID } from "node:crypto";
import {
  AgentComponentKind,
  PLUGIN_CHILD_KINDS,
} from "@repo/api/src/types/agent-component";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../../scripts/seed/__tests__/fixtures/ephemeral-db";
import {
  requireIndexPredicate,
  requireNonEmptyPlan,
  requireRowsRemovedByFilter,
  requireScanNode,
} from "../test-helpers/explain-plan";
import { settleAll } from "../test-helpers/settle-all";

/**
 * ISS-6104 — the partial index migration 20260812120000 builds on
 * `agent_components (organization_id, pack_id) WHERE pack_id IS NOT NULL`.
 *
 * This suite runs against a real Postgres that has had `prisma migrate deploy`
 * applied, so the index under test is the one the migration actually creates —
 * deleting the `CREATE INDEX` line from `migration.sql` fails every case here.
 * That is the point: the index is UNMANAGED by Prisma (its DSL cannot declare a
 * partial index), so nothing else in the repo would notice its absence.
 *
 * Three things are asserted, and none of them can be judged by a mock:
 *
 *  1. the migration really produced a PARTIAL two-column index (its `indexdef`);
 *  2. the planner really uses it for `loadChildInventoryJoin`'s predicate
 *     (apps/api/app/agent-components/plugin-child-usage.ts) instead of walking
 *     the organization's whole component partition — the ISS-6104 complaint;
 *  3. the index is PURELY a plan change: the same query returns byte-identical
 *     rows with the index present and with it dropped, for both the zero-match
 *     case (today's production state, where no child carries a `pack_id`) and
 *     the matching case (after ISS-6094's linkage lands).
 *
 * Rows are written under throwaway organizations and removed in `afterAll`.
 */

const COMPONENTS_TABLE = "agent_components";
const INDEX_NAME = "agent_components_org_pack_id_idx";
const ORG_ID = randomUUID();
const COMPUTE_TARGET_ID = randomUUID();

/**
 * Eleven decoy organizations alongside the one under test. The count is not
 * decorative: the planner's scan choice depends on the TABLE's absolute size
 * and on how selective the org predicate is, not only on the org's own row
 * count. At 12 organizations the org under test is ~8% of the table — the same
 * ratio the migration's EXPLAIN evidence was measured at (2,388 of 28,656). A
 * two-org fixture makes the org predicate merely halve a small table, which is
 * exactly the profile where a cost-based planner prefers a sequential scan
 * regardless of how good the index is, and the plan assertion below would then
 * be measuring the fixture rather than the index.
 */
const DECOY_ORG_IDS: readonly string[] = Array.from({ length: 11 }, () =>
  randomUUID()
);
const DECOY_COMPUTE_TARGET_IDS: readonly string[] = DECOY_ORG_IDS.map(() =>
  randomUUID()
);
const ALL_ORG_IDS: readonly string[] = [ORG_ID, ...DECOY_ORG_IDS];
const ALL_COMPUTE_TARGET_IDS: readonly string[] = [
  COMPUTE_TARGET_ID,
  ...DECOY_COMPUTE_TARGET_IDS,
];

/**
 * The reference organization's live component shape (2,388 rows across
 * 12 pages of the components API, grouped by kind). Seeded verbatim so the
 * planner sees a realistic partition rather than a toy table it would seq-scan
 * regardless of the index.
 */
const ORG_POPULATION: readonly (readonly [string, number])[] = [
  [AgentComponentKind.Skill, 947],
  [AgentComponentKind.Command, 122],
  [AgentComponentKind.Subagent, 307],
  [AgentComponentKind.Mcp, 12],
  [AgentComponentKind.Plugin, 32],
  [AgentComponentKind.Tool, 500],
  [AgentComponentKind.Hook, 300],
  [AgentComponentKind.Orchestration, 168],
];

/** Pack ids of the plugins on screen — the `packIds` argument to the join. */
const REQUESTED_PACK_IDS: readonly string[] = Array.from(
  { length: 32 },
  (_, i) => `pack-${i + 1}`
);

/**
 * A pack whose children ARE linked, so the equivalence check covers a
 * non-empty result set and not only the zero-match path.
 */
const LINKED_PACK_ID = "pack-linked";
const LINKED_CHILD_COUNT = 20;

type ChildRow = {
  id: string;
  component_kind: string;
  component_key: string | null;
  pack_id: string | null;
};

type IndexComparison = { withIndex: ChildRow[]; withoutIndex: ChildRow[] };

describe.skipIf(!process.env.DATABASE_URL)(
  "agent_components (organization_id, pack_id) partial index (integration)",
  () => {
    let ctx: EphemeralDbContext;

    beforeAll(async () => {
      ctx = await setupEphemeralDb();
      await seedComponents(ctx);
    }, 120_000);

    afterAll(async () => {
      if (!ctx) {
        return;
      }
      // `setupEphemeralDb` opens a PrismaClient and a pg.Pool against the
      // SHARED database, so the row cleanup failing must not leak either for
      // the rest of the run. `finally` would close them but replace the DELETE
      // error with the teardown's whenever both reject, hiding the cause;
      // `settleAll` runs every step and surfaces all of them.
      await settleAll(
        [
          () =>
            ctx.prisma.$executeRawUnsafe(
              'DELETE FROM "agent_components" WHERE "organization_id" = ANY($1::uuid[])',
              [...ALL_ORG_IDS]
            ),
          () =>
            ctx.prisma.$executeRawUnsafe(
              'DELETE FROM "compute_targets" WHERE "id" = ANY($1::uuid[])',
              [...ALL_COMPUTE_TARGET_IDS]
            ),
          () =>
            ctx.prisma.$executeRawUnsafe(
              'DELETE FROM "organizations" WHERE "id" = ANY($1::uuid[])',
              [...ALL_ORG_IDS]
            ),
          () => teardownEphemeralDb(ctx),
        ],
        "agent_components index suite teardown failed"
      );
    }, 120_000);

    it("migration 20260812120000 built a PARTIAL two-column index on (organization_id, pack_id)", async () => {
      const rows = await ctx.prisma.$queryRawUnsafe<{ indexdef: string }[]>(
        "SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2",
        COMPONENTS_TABLE,
        INDEX_NAME
      );

      expect(rows).toHaveLength(1);
      const def = rows[0].indexdef;
      // Column order is load-bearing: organization_id must lead so the index
      // serves the org-scoped equality prefix.
      expect(def).toContain("(organization_id, pack_id)");
      // Partial, so the index stays near-empty while every child's pack_id is
      // NULL. Dropping the WHERE clause is a silent 6x size/write regression.
      expect(def).toContain("WHERE (pack_id IS NOT NULL)");
      expect(def).not.toContain("UNIQUE");
    });

    it("plans the zero-match child-inventory join through the index instead of the org partition", async () => {
      const plan = await explain(ctx, REQUESTED_PACK_IDS);

      expect(plan).toContain(INDEX_NAME);
      // `pack_id` must be an Index Cond, not a post-scan Filter — that is the
      // whole fix. Before the index the plan read
      //   Index Scan using agent_components_organization_id_idx
      //     Filter: (… pack_id = ANY …)  /  Rows Removed by Filter: 2388
      // Both reads are scoped to the agent_components scan itself. Reading them
      // off the whole plan would bind the bound to whichever node sorts first,
      // so a future join could satisfy it from an unrelated scan.
      //
      // The predicate read spans that scan's bitmap-index children because the
      // planner picks a Bitmap Heap Scan here: `Index Cond:` sits on the child
      // over this same relation's index, and the heap node carries
      // `Recheck Cond:`. The row metric stays on the heap node, which is where
      // the filter actually discards rows.
      const scan = requireScanNode(plan, COMPONENTS_TABLE);
      const indexCond = requireIndexPredicate(plan, COMPONENTS_TABLE);
      expect(indexCond).toContain("pack_id");
      expect(indexCond).toContain("organization_id");
      // The scan must not walk the organization's whole component partition.
      // Only the plugins' own rows (which carry the requested pack ids and are
      // rejected by the component_kind filter) may be discarded. The healthy
      // plan DOES report this metric — it discards exactly the plugin rows — so
      // its absence means a different plan ran, and `requireRowsRemovedByFilter`
      // throws rather than letting an unread metric satisfy the bound.
      expect(requireRowsRemovedByFilter(scan)).toBeLessThanOrEqual(
        REQUESTED_PACK_IDS.length
      );
    });

    it("returns an identical zero-match result set with and without the index", async () => {
      const { withIndex, withoutIndex } = await compareWithAndWithoutIndex(
        ctx,
        REQUESTED_PACK_IDS
      );

      // Today's production state: no child carries a pack_id, so the honest
      // answer is the empty set — and it must stay the empty set.
      expect(withIndex).toEqual([]);
      expect(withIndex).toEqual(withoutIndex);
    });

    it("returns an identical non-empty result set with and without the index", async () => {
      const { withIndex, withoutIndex } = await compareWithAndWithoutIndex(
        ctx,
        [LINKED_PACK_ID]
      );

      // Guards the partial predicate: `pack_id = ANY(...)` proves
      // `pack_id IS NOT NULL`, so the partial index must not hide linked rows
      // once ISS-6094 starts populating pack_id.
      expect(withIndex).toHaveLength(LINKED_CHILD_COUNT);
      expect(withIndex).toEqual(withoutIndex);
      expect(
        withIndex.every((r) =>
          PLUGIN_CHILD_KINDS.some((kind) => kind === r.component_kind)
        )
      ).toBe(true);
    });
  }
);

/**
 * `loadChildInventoryJoin`'s predicate, verbatim
 * (apps/api/app/agent-components/plugin-child-usage.ts:160-175). No ORDER BY:
 * the production `findMany` has none, and adding one puts a Sort node on top of
 * the plan the EXPLAIN case is reading.
 */
const JOIN_SQL = `SELECT id::text AS id, component_kind, component_key, pack_id
  FROM agent_components
  WHERE organization_id = $1::uuid
    AND pack_id = ANY($2::text[])
    AND component_kind = ANY($3::text[])
    AND component_key IS NOT NULL`;

/**
 * The same predicate ordered by id, so the with/without-index comparison is a
 * plain deep equality rather than a set comparison — an index change must not
 * be able to hide behind row order.
 */
const JOIN_SQL_ORDERED = `${JOIN_SQL} ORDER BY id`;

async function seedComponents(ctx: EphemeralDbContext): Promise<void> {
  for (const orgId of ALL_ORG_IDS) {
    await ctx.prisma.organization.create({
      data: {
        id: orgId,
        clerkId: `iss6104-${orgId}`,
        name: `iss6104-${orgId}`,
        slug: `iss6104-${orgId}`,
      },
    });
  }

  for (const [index, targetId] of ALL_COMPUTE_TARGET_IDS.entries()) {
    await ctx.prisma.computeTarget.create({
      data: {
        id: targetId,
        organizationId: ALL_ORG_IDS[index],
        userId: ctx.userId,
        machineName: `iss6104-${targetId}`,
        platform: "darwin",
      },
    });
  }

  // Every organization gets the reference org's live shape, the same pack ids,
  // and the same linked pack. The decoys serve two purposes at once: they put
  // the org under test at a production-like ~8% of the table (see
  // DECOY_ORG_IDS), and because they carry identical pack ids a plan that ever
  // dropped the org predicate would return 12x the rows and fail the
  // equivalence cases outright.
  for (const [index, orgId] of ALL_ORG_IDS.entries()) {
    const computeTargetId = ALL_COMPUTE_TARGET_IDS[index];

    // Only plugin rows carry a pack_id; every child's is NULL. That is today's
    // production state and the case the ticket is about — and the density the
    // planner costs the partial index against. Giving children a pack_id here
    // would make the requested ids look unselective and the planner would
    // correctly prefer a bitmap scan on (organization_id, component_kind);
    // that is a fixture artifact production never produces, not a fact about
    // the index.
    for (const [kind, count] of ORG_POPULATION) {
      await insertComponents(ctx, {
        orgId,
        computeTargetId,
        kind,
        count,
        packIdExpr:
          kind === AgentComponentKind.Plugin ? "'pack-' || g::text" : "NULL",
      });
    }

    // The linked pack: children that DO carry a pack_id, so the equivalence
    // check has a non-empty result set to compare.
    await insertComponents(ctx, {
      orgId,
      computeTargetId,
      kind: AgentComponentKind.Skill,
      count: LINKED_CHILD_COUNT,
      packIdExpr: `'${LINKED_PACK_ID}'`,
      externalPrefix: "linked",
    });
  }

  await ctx.prisma.$executeRawUnsafe(`ANALYZE ${COMPONENTS_TABLE}`);
}

async function insertComponents(
  ctx: EphemeralDbContext,
  opts: {
    orgId: string;
    computeTargetId: string;
    kind: string;
    count: number;
    packIdExpr: string;
    externalPrefix?: string;
  }
): Promise<void> {
  const prefix = opts.externalPrefix ?? "seed";
  await ctx.prisma.$executeRawUnsafe(
    `INSERT INTO agent_components
       (id, organization_id, compute_target_id, component_kind,
        external_component_id, component_key, pack_id, created_at, updated_at)
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3,
            $4 || '-' || $3 || '-' || g::text,
            $3 || '-key-' || g::text,
            ${opts.packIdExpr},
            now(), now()
     FROM generate_series(1, $5::int) AS g`,
    opts.orgId,
    opts.computeTargetId,
    opts.kind,
    `${prefix}-${opts.orgId}`,
    opts.count
  );
}

async function explain(
  ctx: EphemeralDbContext,
  packIds: readonly string[]
): Promise<string> {
  const rows = await ctx.prisma.$queryRawUnsafe<Record<string, string>[]>(
    `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${JOIN_SQL}`,
    ORG_ID,
    [...packIds],
    [...PLUGIN_CHILD_KINDS]
  );
  return requireNonEmptyPlan(
    rows.map((r) => Object.values(r)[0]).join("\n"),
    `EXPLAIN of the child-inventory join for packIds=[${packIds.join(", ")}]`
  );
}

/**
 * Run the join predicate twice inside one transaction — once as the migrated
 * database plans it, then again with the index dropped — and roll back so the
 * index survives. `DROP INDEX` is transactional in PostgreSQL, which is what
 * makes a true before/after comparison possible inside a test.
 */
async function compareWithAndWithoutIndex(
  ctx: EphemeralDbContext,
  packIds: readonly string[]
): Promise<{ withIndex: ChildRow[]; withoutIndex: ChildRow[] }> {
  const args = [ORG_ID, [...packIds], [...PLUGIN_CHILD_KINDS]];
  let result: IndexComparison | null = null;

  try {
    await ctx.prisma.$transaction(
      async (tx) => {
        const withIndex = await tx.$queryRawUnsafe<ChildRow[]>(
          JOIN_SQL_ORDERED,
          ...args
        );
        await tx.$executeRawUnsafe(`DROP INDEX "${INDEX_NAME}"`);
        const withoutIndex = await tx.$queryRawUnsafe<ChildRow[]>(
          JOIN_SQL_ORDERED,
          ...args
        );
        result = { withIndex, withoutIndex };
        // Roll back so the migration's index is restored for the next case.
        throw new RollbackSignal();
      },
      { timeout: 30_000 }
    );
  } catch (error) {
    // Anything other than our own rollback sentinel is a real failure — most
    // usefully the `DROP INDEX` erroring because the migration never built it.
    if (!(error instanceof RollbackSignal)) {
      throw error;
    }
  }

  if (result === null) {
    throw new Error(
      `compareWithAndWithoutIndex: the comparison transaction never captured a result for packIds=[${packIds.join(", ")}]`
    );
  }
  return result;
}

/** Sentinel used to roll back the drop-the-index comparison transaction. */
class RollbackSignal extends Error {
  constructor() {
    super("iss6104: intentional rollback");
    this.name = "RollbackSignal";
  }
}
