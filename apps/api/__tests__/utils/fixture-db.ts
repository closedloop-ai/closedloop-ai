import {
  analyzeTables,
  findUnownedTables,
} from "@repo/database/__tests__/test-helpers/planner-fixture";
import {
  formatSearchPath,
  resolveSchemaName,
} from "@repo/database/schema-utils";
import { Client } from "pg";

/**
 * The connection a FIXTURE owns, as distinct from the one the app under test
 * uses.
 *
 * ISS-5978 split the two database roles in production: `vercel_migrator` owns
 * every table and runs the migrations, `vercel_iam` is DML-only and owns
 * nothing. A fixture that creates a trigger, truncates a ledger, drops an
 * index, or ANALYZEs a table is doing the MIGRATOR's work, so under that split
 * it cannot run on the connection the app under test uses. Two of those fail
 * loudly (42501); `ANALYZE` and `VACUUM` do not — Postgres skips a table the
 * caller does not own with a WARNING and reports success, so a planner guard
 * would go on measuring itself against whatever statistics happened to be
 * there.
 *
 * `MIGRATE_DATABASE_URL` carries the migrator connection here the way
 * `MIGRATE_PGUSER` carries the migrator user in production. It is OPTIONAL and
 * additive: unset, every helper below falls back to `DATABASE_URL`, so a
 * single-role database — which is what CI and a developer box run today —
 * behaves exactly as it did before this module existed.
 */
export function fixtureDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  // `||`, not `??`: an env schema that normalizes `""` to unset is not in play
  // here (this reads `process.env` directly), and a blank `MIGRATE_DATABASE_URL`
  // means "no split", not "connect to the empty string".
  return env.MIGRATE_DATABASE_URL || env.DATABASE_URL;
}

/**
 * {@link fixtureDatabaseUrl}, for a caller that cannot proceed without one —
 * and the single place the split is checked.
 *
 * ISS-5978 moves the CREDENTIAL, never the database: the fixture connection
 * exists to run owner DDL against the same rows the app under test reads. So a
 * `MIGRATE_DATABASE_URL` naming a different cluster or database is refused
 * here rather than at connect time, because what arrives over this connection
 * is `TRUNCATE`, `DROP INDEX`, `VACUUM FULL` and `ALTER TABLE … DISABLE
 * TRIGGER` — a typo that silently pointed them somewhere else would be found
 * by its damage.
 */
export function requireFixtureDatabaseUrl(
  purpose: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const databaseUrl = fixtureDatabaseUrl(env);
  if (!databaseUrl) {
    throw new Error(
      `DATABASE_URL (or MIGRATE_DATABASE_URL) is required for ${purpose}`
    );
  }
  assertFixtureTargetsRuntimeDatabase(databaseUrl, purpose, env);
  return databaseUrl;
}

/**
 * A connected `pg.Client` on the fixture's own connection, resolving unqualified
 * names in the SAME schema the app under test uses.
 *
 * `withDb`'s pool sets `-c search_path=<schema>` whenever `resolveSchemaName`
 * returns one (`packages/database/index.ts`), from `PGSCHEMA` or a Vercel
 * preview ref. A fixture client left on the server default would then resolve
 * an unqualified table in a DIFFERENT schema — and the cluster guard below
 * cannot catch that, because it compares host and database, which is two of the
 * three things that decide which rows you touch. Latent while the integration
 * tier sets no `PGSCHEMA`, but `withRolledBackFixtureTransaction`'s
 * counterfactual reads `pg_indexes` unqualified and would happily drop another
 * schema's index.
 */
export async function connectFixtureClient(purpose: string): Promise<Client> {
  const schema = resolveSchemaName({
    pgSchema: process.env.PGSCHEMA,
    vercelEnv: process.env.VERCEL_ENV,
    vercelGitCommitRef: process.env.VERCEL_GIT_COMMIT_REF,
  });
  const client = new Client({
    connectionString: requireFixtureDatabaseUrl(purpose),
    ...(schema
      ? { options: `-c search_path=${formatSearchPath(schema)}` }
      : {}),
  });
  await client.connect();
  return client;
}

/**
 * Run `fn` on a fixture connection and close it, even when `fn` throws — the
 * integration tier shares one database, so a leaked backend is charged against
 * every file that runs after this one.
 */
export async function withFixtureClient<T>(
  purpose: string,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = await connectFixtureClient(purpose);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * The narrow slice of Prisma's raw surface the planner and counterfactual
 * fixtures drive, so a helper written against `withDb`'s client — `analyzeTables`
 * and the suites' own `RawClient` aliases — runs unchanged on a fixture
 * connection.
 */
export type FixtureRawClient = {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

/** Present a `pg.Client` as the raw surface in {@link FixtureRawClient}. */
export function asFixtureRawClient(client: Client): FixtureRawClient {
  return {
    async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
      const result = await client.query(query, values);
      return result.rows as T;
    },
    async $executeRawUnsafe(
      query: string,
      ...values: unknown[]
    ): Promise<number> {
      const result = await client.query(query, values);
      return result.rowCount ?? 0;
    },
  };
}

/** {@link withFixtureClient}, handing `fn` the raw surface instead of `pg`. */
export function withFixtureRawClient<T>(
  purpose: string,
  fn: (client: FixtureRawClient) => Promise<T>
): Promise<T> {
  return withFixtureClient(purpose, (client) => fn(asFixtureRawClient(client)));
}

/**
 * A fixture transaction that is ALWAYS rolled back, for a counterfactual that
 * has to drop a real index and then plan against its absence.
 *
 * The `ROLLBACK` is in a `finally`, not on the success path: until it runs the
 * dropped index is really gone, and the integration tier shares one database
 * with every other suite.
 */
export function withRolledBackFixtureTransaction<T>(
  purpose: string,
  fn: (client: FixtureRawClient) => Promise<T>
): Promise<T> {
  return withFixtureClient(purpose, async (client) => {
    await client.query("BEGIN");
    // `allSettled` rather than try/finally so the ROLLBACK still runs on both
    // paths without sitting in a `finally`, where a throw would overwrite the
    // body's error (`noUnsafeFinally`) — and that error is the 42501 this
    // module exists to surface.
    // The async IIFE is load-bearing: `fn` may throw SYNCHRONOUSLY, and a bare
    // `fn(...)` inside the array would do so before `allSettled` was reached,
    // taking the ROLLBACK with it. Inside an async body that throw becomes a
    // rejection `allSettled` can hold.
    const [settled] = await Promise.allSettled([
      (async () => fn(asFixtureRawClient(client)))(),
    ]);
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // A failing ROLLBACK is real news on the SUCCESS path: the dropped index
      // is still gone and the tier shares one database with every later suite.
      // After a failed body it is usually just the aborted transaction
      // complaining, so the body's error wins.
      if (settled.status === "fulfilled") {
        throw rollbackError;
      }
    }
    if (settled.status === "rejected") {
      throw settled.reason;
    }
    return settled.value;
  });
}

/**
 * `ANALYZE` the given tables on the SEEDING connection, refusing the silent
 * skip instead of letting it through.
 *
 * The other planner guards in this tier commit their corpus in a `beforeAll`
 * and purge it in an `afterAll`, so their `ANALYZE` moves to a fixture
 * connection like every other piece of owner work. A guard that seeds inside
 * `autoRollbackTransaction` cannot: nothing is committed, so a second backend
 * would gather statistics from a table that is, to it, still unseeded. The
 * statement has to run where the rows are — which under the ISS-5978 split is
 * the DEMOTED role, exactly where Postgres skips it with a WARNING and reports
 * success.
 *
 * So the ownership check is the point. Without it such a suite goes on costing
 * its plan against whatever statistics happened to be there and stays green
 * while doing it; with it, the run fails and names the table.
 *
 * Table names are interpolated by {@link analyzeTables}, so they must be
 * suite-owned literals — never anything derived from a query result.
 */
export async function analyzeOnSeedingConnection(
  client: FixtureRawClient,
  tables: readonly string[],
  purpose: string
): Promise<void> {
  const unowned = await findUnownedTables(client, tables);
  if (unowned.length > 0) {
    throw new Error(
      `ANALYZE for ${purpose} would be skipped: the runtime role does not own ${unowned.join(", ")}. This fixture seeds inside a transaction, so its ANALYZE cannot move to the MIGRATE_DATABASE_URL connection — the corpus is not committed. Commit the corpus in a beforeAll and purge it in an afterAll, or run this suite on a role that owns the tables.`
    );
  }
  await analyzeTables(client, tables);
}

/**
 * Refuse a fixture connection that does not name the same database as the one
 * the app under test uses. Only the user and password may differ — that is the
 * whole of the ISS-5978 split.
 *
 * A no-op when no split is configured (the two strings are then the same one),
 * and when `DATABASE_URL` is unset there is nothing to compare against.
 */
function assertFixtureTargetsRuntimeDatabase(
  fixtureUrl: string,
  purpose: string,
  env: NodeJS.ProcessEnv
): void {
  const runtimeUrl = env.DATABASE_URL;
  if (!runtimeUrl || runtimeUrl === fixtureUrl) {
    return;
  }
  const fixture = describeTarget(
    parseDatabaseUrl(fixtureUrl, "MIGRATE_DATABASE_URL")
  );
  const runtime = describeTarget(parseDatabaseUrl(runtimeUrl, "DATABASE_URL"));
  if (fixture === runtime) {
    return;
  }
  throw new Error(
    `MIGRATE_DATABASE_URL must name the same host and database as DATABASE_URL for ${purpose}; received "${fixture}" and "${runtime}"`
  );
}

/** `new URL`, with the variable's name in the message when it will not parse. */
function parseDatabaseUrl(value: string, variableName: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${variableName} is not a parseable connection URL`);
  }
}

/** The port `pg` dials when a connection string does not spell one. */
const DEFAULT_POSTGRES_PORT = "5432";

/**
 * `host:port/database`, as the connection will actually be made.
 *
 * `URL.host` carries the port only when the string spelled one, so comparing it
 * raw makes `localhost/app` and `localhost:5432/app` two different targets even
 * though `pg` sends both to the same backend — and a pair of env files that
 * merely spell the port differently would be refused before the suite starts.
 * `URL` already lower-cases the hostname, so defaulting the port is the rest of
 * the normalization.
 */
function describeTarget(url: URL): string {
  return `${url.hostname}:${url.port || DEFAULT_POSTGRES_PORT}${url.pathname}`;
}
