import { type Mock, vi } from "vitest";

/**
 * ISS-6666: in-memory, *discriminating* stand-ins for the two Prisma delegates
 * the GitHub installation service writes through.
 *
 * The suite these serve previously asserted `upsert`/`update`/`findMany`
 * argument shapes — which prove the query the service BUILT, not the record it
 * PRODUCED. A stub returning one fixed row regardless of input makes those
 * assertions vacuous: it passes when the args are correct and then handed to
 * the wrong model, discarded, or overridden downstream.
 *
 * These delegates resolve `where` against a seeded corpus instead, so a wrong
 * filter yields a *different* record and the test fails on the end state. Seed
 * rows the code must exclude (another installation, an already-tombstoned repo)
 * and the exclusion becomes observable too.
 *
 * Prisma semantics deliberately reproduced, because the service depends on them:
 * `undefined` in an update payload means "leave this column alone" (not "write
 * null"), and `update` on a missing row rejects rather than creating one.
 *
 * Root `AND`/`OR`/`NOT` are resolved as `where`-level operators against the
 * whole row. They are not columns, and treating them as columns returned an
 * empty result rather than an error — the silent-empty false green this file
 * exists to prevent. `installation-store.test-fixtures.test.ts` pins each form
 * positively and negatively, because a negative expectation alone is satisfied
 * by that bug.
 *
 * SCOPE: scalar columns only. Rows carry no relation data, so a relation
 * predicate always excludes the row — including one whose nested clause is
 * itself logical (`installation: { OR: … }` in `repository-artifact-relink.ts`,
 * `branchDetails: { some: … }`). That is deliberate and conservative — a test
 * that needs relation semantics must seed the relation and extend
 * `matchesFilter` rather than read an empty result as proof the production
 * filter worked.
 */

export type StoreRow = Record<string, unknown>;

type WhereClause = Record<string, unknown>;

/**
 * Stand-in for `db.gitHubInstallation`. Seeded rows are matched by whatever
 * `where` the service actually passes, so upserting under the wrong unique key
 * appends a second row instead of updating the first.
 */
export function createInstallationDelegate(seed: StoreRow[] = []) {
  const rows: StoreRow[] = seed.map((row) => ({ ...row }));
  let generatedIds = 0;

  return {
    rows,
    rowById: (id: string) => rows.find((row) => row.id === id),
    upsert: vi.fn(
      ({
        where,
        create,
        update,
      }: {
        where: WhereClause;
        create: StoreRow;
        update: StoreRow;
      }) => {
        const existing = rows.find((row) => matchesWhere(row, where));
        if (existing) {
          Object.assign(existing, definedEntries(update));
          return Promise.resolve({ ...existing });
        }
        generatedIds += 1;
        const created = {
          id: `generated-installation-${generatedIds}`,
          ...definedEntries(create),
        };
        rows.push(created);
        return Promise.resolve({ ...created });
      }
    ),
    update: vi.fn(({ where, data }: { where: WhereClause; data: StoreRow }) => {
      const existing = rows.find((row) => matchesWhere(row, where));
      if (!existing) {
        return Promise.reject(
          new Error(
            `No GitHubInstallation matches ${JSON.stringify(where)} (Prisma P2025)`
          )
        );
      }
      Object.assign(existing, definedEntries(data));
      return Promise.resolve({ ...existing });
    }),
    findFirst: vi.fn(
      ({ where, select }: { where: WhereClause; select?: StoreRow }) => {
        const found = rows.find((row) => matchesWhere(row, where));
        return Promise.resolve(found ? projectRow(found, select) : null);
      }
    ),
  };
}

/**
 * Stand-in for `db.gitHubInstallationRepository`. `findMany`, `updateMany` and
 * the `$executeRaw` bulk upsert read and write the same corpus, so both the
 * tombstone the service issues and the rows the bulk upsert writes are
 * observable in the rows the very next read returns.
 */
export function createInstallationRepositoryDelegate(seed: StoreRow[] = []) {
  const rows: StoreRow[] = seed.map((row) => ({ ...row }));

  return {
    rows,
    rowByGithubRepoId: (installationId: string, githubRepoId: string) =>
      rows.find(
        (row) =>
          row.installationId === installationId &&
          row.githubRepoId === githubRepoId
      ),
    findMany: vi.fn(
      ({ where, select }: { where: WhereClause; select?: StoreRow }) =>
        Promise.resolve(
          rows
            .filter((row) => matchesWhere(row, where))
            .map((row) => projectRow(row, select))
        )
    ),
    updateMany: vi.fn(
      ({ where, data }: { where: WhereClause; data: StoreRow }) => {
        const matched = rows.filter((row) => matchesWhere(row, where));
        for (const row of matched) {
          Object.assign(row, definedEntries(data));
        }
        return Promise.resolve({ count: matched.length });
      }
    ),
    upsert: vi.fn(() =>
      Promise.reject(
        new Error(
          "ISS-4618: repositories are written by one set-based $executeRaw, never a per-row ORM upsert"
        )
      )
    ),
  };
}

/**
 * Materializing stand-in for the ISS-4618 set-based bulk upsert. It applies the
 * statement's own row binds to `rows`, so the incoming grant is created,
 * updated, and revived from a tombstone exactly as `ON CONFLICT DO UPDATE`
 * would — and a bulk upsert that writes nothing leaves the corpus unchanged,
 * which the caller can then assert against.
 *
 * Rows are read from the bind values rather than by re-parsing SQL, and the
 * layout is validated per row: a statement whose binds stop matching this shape
 * throws instead of silently materializing the wrong record.
 *
 * SCOPE: the authority-free reduction only. When every incoming row carries a
 * NULL `default_branch_observed_at`, the statement's CASE ladder collapses to
 * "write the scalars and clear `removed_at`", which is what this reproduces. A
 * row carrying authority is rejected rather than guessed at — that precedence
 * is Postgres-evaluated and its stored-value assertions belong to the
 * real-Postgres integration test.
 */
export function createBulkUpsertExecuteRaw(
  installationId: string,
  rows: StoreRow[]
): Mock<(statement: unknown) => Promise<number>> {
  let generatedIds = 0;

  return vi.fn((statement: unknown) => {
    let written = 0;
    for (const incoming of readBulkUpsertRows(installationId, statement)) {
      const existing = rows.find(
        (row) =>
          row.installationId === installationId &&
          row.githubRepoId === incoming.githubRepoId
      );
      if (existing) {
        // `removed_at = NULL` is the PLN-634 revival of a repo a prior
        // disconnect tombstoned.
        Object.assign(existing, incoming, { removedAt: null });
        written += 1;
        continue;
      }
      generatedIds += 1;
      rows.push({
        id: `generated-repo-${generatedIds}`,
        installationId,
        removedAt: null,
        ...incoming,
      });
      written += 1;
    }
    return Promise.resolve(written);
  });
}

/**
 * Bind positions inside one VALUES tuple. `Prisma.join` keeps each tuple as its
 * own nested fragment rather than flattening, so rows are read structurally
 * (statement → joined fragment → per-row fragment) instead of by slicing one
 * flat array, and a tuple that stops matching this arity throws.
 */
const BULK_UPSERT_ROW_BINDS = 19;
const BULK_UPSERT_INSTALLATION_ID_BIND = 1;
const BULK_UPSERT_GITHUB_REPO_ID_BIND = 2;
const BULK_UPSERT_FULL_NAME_BIND = 3;
const BULK_UPSERT_NAME_BIND = 4;
const BULK_UPSERT_OWNER_BIND = 5;
const BULK_UPSERT_PRIVATE_BIND = 6;
const BULK_UPSERT_OBSERVED_AT_BIND = 17;

function readBulkUpsertRows(
  installationId: string,
  statement: unknown
): StoreRow[] {
  const joined = readSqlValues(statement)[0];
  const rowFragments = readSqlValues(joined);
  if (rowFragments.length === 0) {
    throw new Error("Fixture delegate: bulk upsert carried no VALUES tuples");
  }
  return rowFragments.map((fragment) =>
    readBulkUpsertRow(installationId, readSqlValues(fragment))
  );
}

function readBulkUpsertRow(installationId: string, binds: unknown[]): StoreRow {
  if (binds.length !== BULK_UPSERT_ROW_BINDS) {
    throw new Error(
      `Fixture delegate: bulk-upsert tuple has ${binds.length} binds, expected ${BULK_UPSERT_ROW_BINDS}; update createBulkUpsertExecuteRaw alongside the statement`
    );
  }
  if (binds[BULK_UPSERT_INSTALLATION_ID_BIND] !== installationId) {
    throw new Error(
      `Fixture delegate: bulk-upsert tuple targets installation ${String(binds[BULK_UPSERT_INSTALLATION_ID_BIND])}, expected ${installationId}`
    );
  }
  if (binds[BULK_UPSERT_OBSERVED_AT_BIND] != null) {
    throw new Error(
      "Fixture delegate: the bulk-upsert stand-in models only authority-free rows; assert authority precedence in the real-Postgres integration test"
    );
  }
  return {
    githubRepoId: binds[BULK_UPSERT_GITHUB_REPO_ID_BIND],
    fullName: binds[BULK_UPSERT_FULL_NAME_BIND],
    name: binds[BULK_UPSERT_NAME_BIND],
    owner: binds[BULK_UPSERT_OWNER_BIND],
    private: binds[BULK_UPSERT_PRIVATE_BIND],
  };
}

function readSqlValues(node: unknown): unknown[] {
  if (!(node && typeof node === "object")) {
    throw new Error("Fixture delegate: bulk upsert expects a Prisma.Sql");
  }
  const values = Reflect.get(node, "values");
  if (!Array.isArray(values)) {
    throw new Error("Fixture delegate: bulk upsert expects a Prisma.Sql");
  }
  return values;
}

/** A tombstone stamped by an earlier disconnect, before the sync under test. */
export const PREVIOUSLY_REMOVED_AT = new Date("2026-01-01T00:00:00.000Z");

/**
 * The `syncRepositories` corpus: one repo the grant keeps, one it drops, one
 * already tombstoned, and one owned by a different installation. Each is a row
 * whose fate distinguishes a correct filter from a wrong one, so the sync's end
 * state — not its query arguments — carries the assertion.
 */
export function createSyncRepositoryFixture(installationId: string): {
  repositories: ReturnType<typeof createInstallationRepositoryDelegate>;
  executeRaw: Mock<(statement: unknown) => Promise<number>>;
} {
  const repositories = createInstallationRepositoryDelegate([
    {
      id: "repo-rec-1",
      installationId,
      githubRepoId: "r-1",
      fullName: "org/repo1",
      removedAt: null,
    },
    {
      id: "repo-rec-stale",
      installationId,
      githubRepoId: "stale-1",
      fullName: "org/stale",
      removedAt: null,
    },
    {
      id: "repo-rec-gone",
      installationId,
      githubRepoId: "gone-1",
      fullName: "org/gone",
      removedAt: PREVIOUSLY_REMOVED_AT,
    },
    {
      id: "repo-rec-other",
      installationId: "other-install",
      githubRepoId: "o-1",
      fullName: "other/repo",
      removedAt: null,
    },
  ]);

  return {
    repositories,
    executeRaw: createBulkUpsertExecuteRaw(installationId, repositories.rows),
  };
}

function matchesWhere(row: StoreRow, where: WhereClause): boolean {
  return Object.entries(where).every(([key, expected]) =>
    matchesWhereEntry(row, key, expected)
  );
}

/**
 * Prisma's logical combinators are `where`-level operators over the WHOLE row,
 * not columns. Resolving them as fields looked up `row.OR`, found it absent on
 * every row, and excluded everything — a query returning no rows rather than
 * failing, which is the silent-empty false green this file exists to prevent.
 */
function matchesWhereEntry(
  row: StoreRow,
  key: string,
  expected: unknown
): boolean {
  if (key === LOGICAL_OR) {
    return requireClauseList(key, expected).some((clause) =>
      matchesWhere(row, clause)
    );
  }
  if (key === LOGICAL_AND) {
    return requireClauseList(key, expected).every((clause) =>
      matchesWhere(row, clause)
    );
  }
  if (key === LOGICAL_NOT) {
    return !matchesWhere(row, requireClauseObject(expected));
  }
  return matchesFilter(row[key], expected);
}

function requireClauseList(key: string, expected: unknown): WhereClause[] {
  if (!Array.isArray(expected)) {
    throw new Error(
      `Fixture delegate: ${key} must be an array of where clauses, received ${JSON.stringify(expected)}`
    );
  }
  return expected as WhereClause[];
}

/**
 * Prisma also accepts `NOT: [...]`, whose distribution over the list is subtle
 * enough that guessing it would bake an unverified semantic into every suite
 * reading this oracle. Nothing in the service issues that form, so reject it
 * loudly and let whoever needs it model it deliberately.
 */
function requireClauseObject(expected: unknown): WhereClause {
  if (Array.isArray(expected) || !(expected && typeof expected === "object")) {
    throw new Error(
      `Fixture delegate: list-form NOT is not modelled; pass a single where clause, received ${JSON.stringify(expected)}`
    );
  }
  return expected as WhereClause;
}

function matchesFilter(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !(expected instanceof Date)) {
    const filter = expected as Record<string, unknown>;
    if ("in" in filter) {
      return (filter.in as unknown[]).includes(actual);
    }
    if ("notIn" in filter) {
      return !(filter.notIn as unknown[]).includes(actual);
    }
    if ("not" in filter) {
      return !sameScalar(actual, filter.not);
    }
    // A nested clause against a value the corpus does not carry is a relation
    // predicate this delegate does not model (`branchDetails: { some: … }`,
    // `installation: { OR: … }`). It must EXCLUDE the row: resolving it by
    // walking into `undefined` compares absent-against-absent and admits
    // everything, which is worse than the never-matches bug — an exclusion
    // guard that always admits is a false green in the permissive direction.
    if (actual === null || actual === undefined) {
      return false;
    }
    return Object.entries(filter).every(([nestedKey, nestedExpected]) =>
      matchesFilter(
        (actual as Record<string, unknown>)[nestedKey],
        nestedExpected
      )
    );
  }
  return sameScalar(actual, expected);
}

/**
 * An unset key on a seeded row stands for a NULL column, so it must compare
 * equal to `null` — otherwise `{ not: null }` would match a row whose column is
 * simply absent from the fixture, the opposite of the real query's behaviour.
 */
function sameScalar(actual: unknown, expected: unknown): boolean {
  return (actual ?? null) === (expected ?? null);
}

function projectRow(row: StoreRow, select?: StoreRow): StoreRow {
  if (!select) {
    return { ...row };
  }
  const projected: StoreRow = {};
  for (const key of Object.keys(select)) {
    projected[key] = row[key] ?? null;
  }
  return projected;
}

const LOGICAL_OR = "OR";
const LOGICAL_AND = "AND";
const LOGICAL_NOT = "NOT";

/** Prisma treats an `undefined` field as "do not write this column". */
function definedEntries(data: StoreRow): StoreRow {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined)
  );
}
