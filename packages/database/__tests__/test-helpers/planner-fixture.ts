/**
 * Fixture machinery shared by the planner/access-path guards.
 *
 * Every one of those suites needs the same three things, and until this module
 * existed each re-derived all three (davetho on #6972, counting three copies):
 * enough decoy tenants that the org predicate is genuinely selective, a
 * prefix-keyed purge that reclaims residue a killed run left behind, and fresh
 * statistics on both sides of the fixture's life.
 *
 * WHY NOT `explain-plan.ts`, which is where the rest of the plan-guard helpers
 * live: that module's own header records that it is deliberately free of a
 * database so its fail-closed readers can be unit-tested without one. These
 * helpers execute SQL. Co-locating them here keeps that claim true while still
 * giving the suites one owner for the fixture half.
 *
 * NOTHING HERE PARSES A PLAN. The assertions stay in the suites, where the
 * property being guarded is stated alongside the statement it guards.
 */
import { randomUUID } from "node:crypto";
import { settleAll } from "./settle-all";

/**
 * The narrow slice of the client these helpers need.
 *
 * Structural rather than imported so this module does not depend on the
 * ephemeral-db fixture (which lives under `scripts/seed/`) and cannot drag a
 * seeding cycle into a suite that only wants to clean up after itself.
 */
type RawExecutor = {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

/**
 * Eleven decoys, so the tenant under test holds ~1/12 of the table.
 *
 * Scan choice is costed against the TABLE's absolute size AND the org
 * predicate's selectivity, so a single-tenant fixture measures itself rather
 * than the plan: the predicate that "narrows" to the only org in the table
 * narrows nothing, and the planner's answer says nothing about production. Eleven
 * is the number `agent-components-pack-id-index.integration.test.ts` established
 * and `iss7804-artifact-reference-search-indexes` and
 * `iss9760-documents-search-access-path` inherited.
 */
export const PLANNER_DECOY_ORG_COUNT = 11;

/** Fresh decoy organisation ids, one per {@link PLANNER_DECOY_ORG_COUNT}. */
export function makePlannerDecoyOrgIds(
  count: number = PLANNER_DECOY_ORG_COUNT
): readonly string[] {
  return Array.from({ length: count }, () => randomUUID());
}

/**
 * `ANALYZE` each table, so the planner is choosing from statistics that describe
 * the rows actually present.
 *
 * Needed after seeding: without it the planner costs every shape against an
 * empty table and picks a sequential scan, which makes each assertion a
 * statement about the fixture rather than about the access path. The other end
 * of a fixture's life is not this helper's job: the fixture's statistics
 * OUTLIVE its rows, and {@link purgeFixtureOrganizations} compacts every table
 * it deletes from, so a teardown needs no ANALYZE of its own.
 *
 * Table names are interpolated, so they must be suite-owned literals — never
 * anything derived from a query result.
 */
export async function analyzeTables(
  db: RawExecutor,
  tables: readonly string[]
): Promise<void> {
  for (const table of tables) {
    await db.$executeRawUnsafe(`ANALYZE ${table}`);
  }
}

/**
 * Delete a fixture's organisations and everything hanging off them, leaves
 * first, running every statement even when an earlier one fails.
 *
 * WHY A SWEEP AND NOT A TEARDOWN. `setupEphemeralDb` is not schema-isolated
 * despite the name — these suites write into the SHARED integration database —
 * and `teardownEphemeralDb` scopes its cleanup to the fixture's own single
 * `ctx.organizationId`, which knows nothing about the twelve orgs a planner
 * guard creates. `afterAll` also does not run when a worker is killed or the run
 * times out, so a crashed run strands tens of thousands of rows addressed only
 * by ids that died with that process. Keying `selector` on a STABLE marker (a
 * `clerk_id` prefix) and calling this BEFORE seeding as well as after is what
 * makes a fixture self-healing rather than dependent on every run reaching its
 * own teardown.
 *
 * WHY EVERY STATEMENT RUNS. A bare sequence of awaits stops at the first failed
 * DELETE, which is precisely how a partial fixture survives into the next suite.
 * {@link settleAll} still rethrows, so a real breakage is not swallowed.
 *
 * WHY IT COMPACTS (ISS-11155). The deleted rows stay behind as dead pages, and
 * statistics taken over them record ~0 live rows, so whichever suite runs next
 * plans against one-row estimates; see {@link compactTables}. Every table a
 * statement deletes from is compacted here, so no call site has to remember it.
 * That needs `db` to OWN those tables: VACUUM on a table the caller does not
 * own is skipped with a WARNING and reports success (ISS-5978), so ownership is
 * checked first and a non-owner connection fails the purge instead.
 *
 * @param db An owner connection. Under the ISS-5978 role split that is the
 *   fixture connection, not the one the app under test uses. Not inside a
 *   transaction block, because VACUUM cannot run there.
 * @param selector SQL selecting the organisation ids to purge. Interpolated into
 *   every statement, so it must be suite-owned; bind anything variable through
 *   `values` instead.
 * @param leafDeletes DELETEs for tables referencing those organisations, LEAVES
 *   FIRST — deleting the organisations alone fails on a foreign key and leaves
 *   the fixture behind. The `organizations` delete itself is appended here.
 *   Each must start `DELETE FROM <table>`, which is how the tables to compact
 *   are found.
 * @param values Bound to every statement, so each must accept the same
 *   parameters (typically the one prefix `selector` reads).
 */
export async function purgeFixtureOrganizations(
  db: OwnerExecutor,
  options: {
    selector: string;
    leafDeletes: readonly string[];
    label: string;
    values?: readonly unknown[];
  }
): Promise<void> {
  const values = options.values ?? [];
  const statements = [
    ...options.leafDeletes,
    `DELETE FROM organizations WHERE id IN (${options.selector})`,
  ];
  const emptiedTables = [...new Set(statements.map(deletedTable))];
  await settleAll(
    [
      ...statements.map(
        (statement) => () => db.$executeRawUnsafe(statement, ...values)
      ),
      () => compactOwnedTables(db, emptiedTables, options.label),
    ],
    options.label
  );
}

/**
 * `VACUUM (FULL, ANALYZE)` the tables, so their size matches their live rows.
 * {@link purgeFixtureOrganizations} runs it on every table it deletes from,
 * because after a purge a bare {@link analyzeTables} is not enough: the purged
 * rows are still dead pages in the heap, so ANALYZE records ~0 live rows over
 * thousands of pages and the next suite's planner costs every scan of those
 * tables at one row. A suite can also call it directly, for example to rewrite
 * a table after seeding.
 * ISS-11155 measured it after the ISS-9455 teardown: the blocked-dependent
 * unblock guard's 32-row UPDATE ran 11.4 s as a Nested Loop Anti Join that
 * rescanned `artifacts` 6,432 times, and 5 ms once the statistics were honest.
 *
 * Owner-only like ANALYZE, and not allowed inside a transaction block. Table
 * names are interpolated, so they must be suite-owned literals.
 */
export async function compactTables(
  db: RawExecutor,
  tables: readonly string[]
): Promise<void> {
  await db.$executeRawUnsafe(`VACUUM (FULL, ANALYZE) ${tables.join(", ")}`);
}

/** A {@link RawExecutor} that can also read, for the ownership check. */
type OwnerExecutor = RawExecutor & {
  $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
};

const DELETED_TABLE_PATTERN =
  /^\s*DELETE\s+FROM\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/i;

function deletedTable(statement: string): string {
  const table = DELETED_TABLE_PATTERN.exec(statement)?.[1];
  if (!table) {
    throw new Error(
      `purgeFixtureOrganizations cannot tell which table this statement deletes from, so it cannot compact it: ${statement}`
    );
  }
  return table;
}

/**
 * The tables in `tables` that `db`'s role does not own, and so would silently
 * skip in a VACUUM or ANALYZE.
 *
 * `pg_has_role`, not `relowner = current_user`: membership in the owning role
 * is ownership as far as VACUUM and ANALYZE are concerned, and that is how a
 * split whose runtime role inherits from the migrator would legitimately pass.
 */
export async function findUnownedTables(
  db: OwnerExecutor,
  tables: readonly string[]
): Promise<string[]> {
  const unowned = await db.$queryRawUnsafe<{ tableName: string }[]>(
    `SELECT t AS "tableName"
       FROM unnest($1::text[]) AS t
       JOIN pg_catalog.pg_class c ON c.oid = to_regclass(t)
      WHERE NOT pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')`,
    [...tables]
  );
  return unowned.map((row) => row.tableName);
}

async function compactOwnedTables(
  db: OwnerExecutor,
  tables: readonly string[],
  label: string
): Promise<void> {
  const unowned = await findUnownedTables(db, tables);
  if (unowned.length > 0) {
    throw new Error(
      `${label}: the purge cannot compact ${unowned.join(", ")}, because this connection does not own them and VACUUM would skip them without an error. Purge on the fixture (owner) connection.`
    );
  }
  await compactTables(db, tables);
}
