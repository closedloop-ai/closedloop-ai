import { withDb } from "@repo/database";
import { requireNonEmptyPlan } from "@repo/database/__tests__/test-helpers/explain-plan";
import type { ObservedStatement } from "@/__tests__/support/db-statement-observer";
import { withRolledBackFixtureTransaction } from "@/__tests__/utils/fixture-db";

/**
 * EXPLAIN a statement a production read actually issued, and re-plan it with a
 * capability removed, for the planner guards that assert plan SHAPE.
 *
 * Extracted when a third guard needed it (ISS-9478): the Sessions keyset suite
 * (ISS-9627) and the Delivery merged-PR suite (ISS-6825) each carried a private
 * copy, and the two copies disagreed on the one decision that is genuinely
 * per-table — what to do with an index something else depends on — which is why
 * that decision is a required argument here rather than a default.
 */

/** The narrow client slice these helpers need, inside or outside a transaction. */
type RawClient = {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

/**
 * What to do with a matched index that another object depends on.
 *
 * `DropForeignKeys` removes the foreign-key constraints whose target is a matched
 * index, then the index — for a table where the capability under test is EVERY
 * index leading with the column (ISS-10170 gave `pull_request_detail` a composite
 * FK onto `artifacts_org_id_key`, and Postgres refuses to drop an index a FK
 * depends on).
 *
 * `KeepDependentIndexes` leaves such an index in place and drops the rest — for a
 * table where removing it would need a CASCADE that takes unrelated schema with
 * it (`pull_request_detail_org_id_key`, 2BP01), and the narrower counterfactual
 * is still decisive.
 */
export const IndexDependentPolicy = {
  DropForeignKeys: "drop-foreign-keys",
  KeepDependentIndexes: "keep-dependent-indexes",
} as const;
export type IndexDependentPolicy =
  (typeof IndexDependentPolicy)[keyof typeof IndexDependentPolicy];

export type LeadingIndexRemoval = {
  /** Suite-owned table literal; interpolated into DDL. */
  table: string;
  /** Suite-owned column literal; an index whose key list starts with it is dropped. */
  leadingColumn: string;
  dependents: IndexDependentPolicy;
};

/** `EXPLAIN (ANALYZE, BUFFERS)` of a captured statement, as its own plan text. */
export function explainCapturedStatement(
  statement: ObservedStatement,
  description: string
): Promise<string> {
  return withDb((db) => explainOn(db, statement, description));
}

/**
 * The same plans with every index leading on `removal.leadingColumn` gone, inside
 * a transaction that is always rolled back.
 *
 * The indexes are DROPPED rather than the planner talked out of them with
 * `enable_indexscan = off`: that setting disables every index on both sides of a
 * join, so the resulting plan would be evidence about sequential scans in
 * general rather than about the predicate having nothing to seek on.
 *
 * `DROP INDEX` is owner DDL, which ISS-5978 took off the runtime role, and the
 * EXPLAINs must run inside the transaction that dropped the indexes, so this
 * whole arm plans on the FIXTURE connection. {@link explainCapturedStatement},
 * the positive control, still plans on the production one.
 */
export function explainWithoutLeadingIndexes(
  statements: readonly ObservedStatement[],
  removal: LeadingIndexRemoval,
  description: string
): Promise<string[]> {
  return withRolledBackFixtureTransaction(
    `the ${removal.table} leading-${removal.leadingColumn} index counterfactual`,
    async (client) => {
      const indexes = await findLeadingIndexes(client, removal);
      if (indexes.length === 0) {
        throw new Error(
          `No index on ${removal.table} leading with ${removal.leadingColumn} was found to drop, so this counterfactual would prove nothing.`
        );
      }
      if (removal.dependents === IndexDependentPolicy.DropForeignKeys) {
        await dropDependentForeignKeys(client, indexes);
      }
      for (const index of indexes) {
        await client.$executeRawUnsafe(`DROP INDEX "${index}"`);
      }
      const plans: string[] = [];
      for (const statement of statements) {
        plans.push(await explainOn(client, statement, description));
      }
      return plans;
    }
  );
}

async function explainOn(
  client: RawClient,
  statement: ObservedStatement,
  description: string
): Promise<string> {
  const rows = await client.$queryRawUnsafe<Record<string, string>[]>(
    `EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`,
    ...statement.values
  );
  return requireNonEmptyPlan(
    rows.map((row) => Object.values(row)[0]).join("\n"),
    description
  );
}

async function findLeadingIndexes(
  client: RawClient,
  removal: LeadingIndexRemoval
): Promise<string[]> {
  const keepDependents =
    removal.dependents === IndexDependentPolicy.KeepDependentIndexes;
  const rows = await client.$queryRawUnsafe<{ indexname: string }[]>(
    `SELECT i.indexname
       FROM pg_indexes i
      WHERE i.tablename = $1
        AND i.indexdef LIKE '%(' || $2 || '%'
        AND (NOT $3::boolean OR NOT EXISTS (
          SELECT 1
            FROM pg_depend d
            JOIN pg_class ic ON ic.oid = d.refobjid
           WHERE ic.relname = i.indexname AND d.deptype = 'n'
        ))`,
    removal.table,
    removal.leadingColumn,
    keepDependents
  );
  return rows.map((row) => row.indexname);
}

async function dropDependentForeignKeys(
  client: RawClient,
  indexes: readonly string[]
): Promise<void> {
  const dependents = await client.$queryRawUnsafe<
    { conname: string; tablename: string }[]
  >(
    `SELECT con.conname, child.relname AS tablename
       FROM pg_constraint con
       JOIN pg_class child ON child.oid = con.conrelid
       JOIN pg_class idx ON idx.oid = con.conindid
      WHERE con.contype = 'f' AND idx.relname = ANY($1::text[])`,
    [...indexes]
  );
  for (const dependent of dependents) {
    await client.$executeRawUnsafe(
      `ALTER TABLE "${dependent.tablename}" DROP CONSTRAINT "${dependent.conname}"`
    );
  }
}

/**
 * The same plans with ONE named index gone, inside a transaction that is always
 * rolled back — for a guard whose capability is a specific index rather than
 * every index leading with a column. Dropping an index that does not exist
 * throws, so the arm cannot pass vacuously against a renamed index.
 */
export function explainWithoutIndex(
  statements: readonly ObservedStatement[],
  indexName: string,
  description: string
): Promise<string[]> {
  return withRolledBackFixtureTransaction(
    `the ${indexName} counterfactual`,
    async (client) => {
      await client.$executeRawUnsafe(`DROP INDEX "${indexName}"`);
      const plans: string[] = [];
      for (const statement of statements) {
        plans.push(await explainOn(client, statement, description));
      }
      return plans;
    }
  );
}
