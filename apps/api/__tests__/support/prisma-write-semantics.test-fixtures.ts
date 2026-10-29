/**
 * A Prisma delegate double that reproduces the SINGLE-ROW WRITE SEMANTICS the
 * ISS-6317..6322 narrowing batches must preserve, rather than the
 * always-resolves `vi.fn()` a plain mock gives you.
 *
 * The batches replace a discarded wide write with a narrowed one, and the whole
 * risk is that the replacement is `updateMany`: `update` THROWS `P2025` when its
 * `where` matches no row, `updateMany` returns `{ count: 0 }` and says nothing.
 * A `vi.fn().mockResolvedValue({})` cannot tell those apart, so a suite built on
 * one stays green through exactly the regression it exists to catch.
 *
 * This double therefore models the row set: `update` resolves its `where`
 * against it and throws a real-shaped `P2025` on a miss, `upsert` resolves its
 * `where` and CREATES when it matches nothing (as Prisma does — there is no
 * missing-row failure mode to cover there), `updateMany` reports a count, and
 * `create` throws `P2002` on a unique collision. Narrowing a write with
 * `select` must not change any of that — which is what the parity suite
 * asserts.
 *
 * THREE suites consume it: `__tests__/unit/artifact-crud-write-parity.test.ts`,
 * `__tests__/unit/api-remainder-write-parity.test.ts`, and
 * `app/catalog/__tests__/list-catalog-items-rows.test.ts`. That reaches the
 * 3-distinct-module bar `apps/api/AGENTS.md` sets for `__tests__/utils/`, and it
 * stays in `support/` anyway on the other half of that rule: `utils/` is for
 * app-wide INFRASTRUCTURE (`db-helpers`, `auth-helpers`, the globally-aliased
 * `server-only-mock`), and this is a single-subject double — Prisma's
 * single-row write semantics — that happens to be reachable from several
 * suites. Revisit if it ever grows a second subject.
 *
 * It sits flat rather than in a mirrored subdirectory because it is scoped to no
 * single `app/` module: the suites it serves span `app/documents`,
 * `app/comments`, `app/tags`, `app/projects`, `app/catalog`, `app/settings`,
 * `app/teams`, `app/users`, `app/compute-targets`, and `apps/api/lib`.
 */

import { vi } from "vitest";
import { makePrismaKnownRequestError } from "@/__tests__/fixtures/prisma-errors";

const PRISMA_NOT_FOUND = "P2025";
const PRISMA_UNIQUE_VIOLATION = "P2002";

type Row = Record<string, unknown>;

export const PrismaWriteErrorCode = {
  NotFound: PRISMA_NOT_FOUND,
  UniqueViolation: PRISMA_UNIQUE_VIOLATION,
} as const;
export type PrismaWriteErrorCode =
  (typeof PrismaWriteErrorCode)[keyof typeof PrismaWriteErrorCode];

/**
 * Build the error a Prisma write rejects with, through the fixture that already
 * owns that shape (`__tests__/fixtures/prisma-errors`) rather than a second
 * constructor beside it — `getPrismaErrorCode` and the service catch blocks
 * branch on `.code`, and only one module should decide what that value sits on.
 */
function prismaWriteError(
  code: PrismaWriteErrorCode,
  meta?: Record<string, unknown>
) {
  return makePrismaKnownRequestError(
    code,
    code === PRISMA_NOT_FOUND
      ? "An operation failed because it depends on one or more records that were required but not found."
      : "Unique constraint failed",
    meta
  );
}

/**
 * Whether a `where` clause selects `row`.
 *
 * Three shapes are modelled, and anything else THROWS rather than silently
 * failing to match. That distinction is the whole point: a predicate the double
 * cannot evaluate must fail loudly, because "matched nothing" is a legitimate
 * outcome that a broken matcher produces identically to a correct one — a test
 * asserting "the guarded update matched nothing" would pass even if the guard
 * were inverted. An earlier revision flattened EVERY nested object one level,
 * which turned a comparison object (`{ checkedAt: { lte: now } }`) into an
 * unmatchable top-level `lte` key and made exactly that assertion unfalsifiable.
 *
 *  - a compound unique named by its Prisma key
 *    (`{ clerkId_organizationId: { clerkId, organizationId } }`) — recursed into;
 *  - a comparison object (`{ checkedAt: { lte: now } }`) — evaluated;
 *  - `OR` — a disjunction over sub-`where`s.
 */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    // Prisma treats an `undefined` field as "no constraint", NOT as "equals
    // undefined". `listCatalogItemsForOrg` relies on exactly that to express
    // `includeArchived` (`archived: input.includeArchived ? undefined : false`),
    // so a double that compared strictly would drop every row on the
    // include-archived branch and make the row assertions vacuously empty.
    if (value === undefined) {
      return true;
    }
    if (key === WHERE_DISJUNCTION_KEY) {
      return (value as Row[]).some((branch) => matches(row, branch));
    }
    if (key === WHERE_CONJUNCTION_KEY) {
      return (value as Row[]).every((branch) => matches(row, branch));
    }
    if (key === WHERE_NEGATION_KEY) {
      // Deliberately unmodelled rather than guessed: Prisma's `NOT` takes either
      // a single `where` or an array, and its NULL semantics differ from a
      // plain JS negation. No site in these suites uses it — the day one does,
      // model it here instead of inheriting a silently wrong answer.
      throw new Error(
        "prisma-write-semantics double: `where.NOT` is not modelled; add it explicitly before relying on it."
      );
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value as Row);
      const operators = keys.filter((name) =>
        COMPARISON_OPERATORS.has(name)
      ).length;
      if (operators === keys.length && keys.length > 0) {
        return matchesComparison(row[key], value as Row);
      }
      if (operators > 0) {
        throw new Error(
          `prisma-write-semantics double: \`where.${key}\` mixes comparison operators with plain fields; model it explicitly rather than guessing.`
        );
      }
      return matches(row, value as Row);
    }
    return valuesEqual(row[key], value);
  });
}

function isPlainObject(value: unknown): boolean {
  return (
    value !== null && typeof value === "object" && !(value instanceof Date)
  );
}

/** Dates are compared by instant — two equal `Date`s are never `===`. */
function valuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  return left === right;
}

function compareValues(left: unknown, right: unknown): number {
  const a = left instanceof Date ? left.getTime() : left;
  const b = right instanceof Date ? right.getTime() : right;
  if ((a as number) < (b as number)) {
    return -1;
  }
  return (a as number) > (b as number) ? 1 : 0;
}

function matchesComparison(actual: unknown, comparison: Row): boolean {
  return Object.entries(comparison).every(([operator, operand]) => {
    if (operator === "equals") {
      return valuesEqual(actual, operand);
    }
    if (operator === "not") {
      return !valuesEqual(actual, operand);
    }
    if (operator === "in") {
      return (operand as unknown[]).some((entry) => valuesEqual(actual, entry));
    }
    if (operator === "notIn") {
      return !(operand as unknown[]).some((entry) =>
        valuesEqual(actual, entry)
      );
    }
    if (actual === null || actual === undefined) {
      // Postgres: any ordered comparison against NULL is NULL, i.e. not a match.
      return false;
    }
    const ordering = compareValues(actual, operand);
    if (operator === "lt") {
      return ordering < 0;
    }
    if (operator === "lte") {
      return ordering <= 0;
    }
    if (operator === "gt") {
      return ordering > 0;
    }
    return ordering >= 0;
  });
}

function project(row: Row, select?: Row): Row {
  if (!select) {
    return { ...row };
  }
  const picked: Row = {};
  for (const [key, wanted] of Object.entries(select)) {
    if (wanted === true) {
      picked[key] = row[key];
    }
  }
  return picked;
}

export type RecordedWrite = {
  method:
    | "create"
    | "update"
    | "upsert"
    | "updateMany"
    | "updateManyAndReturn"
    | "createMany";
  args: Row;
  /** The column names the write asked Postgres to RETURN, or `null` for all. */
  selected: string[] | null;
};

export type FakeDelegate = {
  create: ReturnType<typeof vi.fn>;
  createMany: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  updateManyAndReturn: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  rows: Row[];
  writes: RecordedWrite[];
};

function selectedColumns(args: Row): string[] | null {
  const select = args.select as Row | undefined;
  if (!select) {
    return null;
  }
  return Object.keys(select).sort();
}

/**
 * Build one model's delegate over `rows`, honouring `uniqueKeys` when deciding
 * whether a `create` collides.
 *
 * `createDefaults` supplies the columns PostgreSQL fills that this double
 * otherwise cannot — a `@default(uuid(7))` primary key above all. Without it a
 * created row comes back with `id: undefined`, and every assertion about the id
 * of a row the test itself created passes vacuously. `data` still wins on any
 * key it sets, exactly as a Prisma default does.
 */
export function createFakeDelegate(
  rows: Row[] = [],
  uniqueKeys: readonly (readonly string[])[] = [["id"]],
  createDefaults: () => Row = () => ({})
): FakeDelegate {
  const writes: RecordedWrite[] = [];

  const collisionKey = (candidate: Row): readonly string[] | null => {
    for (const row of rows) {
      const key = uniqueKeys.find(
        (columns) =>
          columns.every((column) => candidate[column] !== undefined) &&
          columns.every((column) => row[column] === candidate[column])
      );
      if (key) {
        return key;
      }
    }
    return null;
  };

  const delegate: FakeDelegate = {
    rows,
    writes,
    findUnique: vi.fn(({ where, select }: Row) => {
      const row = rows.find((candidate) => matches(candidate, where as Row));
      return Promise.resolve(row ? project(row, select as Row) : null);
    }),
    findFirst: vi.fn(({ where, select }: Row) => {
      const row = rows.find((candidate) => matches(candidate, where as Row));
      return Promise.resolve(row ? project(row, select as Row) : null);
    }),
    findMany: vi.fn(({ where, select }: Row = {}) => {
      const found = where
        ? rows.filter((candidate) => matches(candidate, where as Row))
        : rows;
      return Promise.resolve(found.map((row) => project(row, select as Row)));
    }),
    create: vi.fn((args: Row) => {
      const data = { ...createDefaults(), ...(args.data as Row) };
      writes.push({ method: "create", args, selected: selectedColumns(args) });
      const conflict = collisionKey(data);
      if (conflict) {
        return Promise.reject(
          prismaWriteError(PrismaWriteErrorCode.UniqueViolation, {
            target: [...conflict],
          })
        );
      }
      rows.push(data);
      return Promise.resolve(project(data, args.select as Row));
    }),
    // Modelled because it is the batch form the gate offers as a remedy for a
    // discarded `create`, so a counterfactual that reaches for it must fail on
    // BEHAVIOUR — a missing mock would throw a TypeError instead and look like
    // the same red for the wrong reason. `skipDuplicates` swallows the P2002 a
    // create-then-catch site depends on; without it the collision still throws.
    createMany: vi.fn((args: Row) => {
      writes.push({
        method: "createMany",
        args,
        selected: selectedColumns(args),
      });
      const data = Array.isArray(args.data)
        ? (args.data as Row[])
        : [args.data as Row];
      let created = 0;
      for (const candidate of data) {
        const conflict = collisionKey(candidate);
        if (conflict) {
          if (args.skipDuplicates) {
            continue;
          }
          return Promise.reject(
            prismaWriteError(PrismaWriteErrorCode.UniqueViolation, {
              target: [...conflict],
            })
          );
        }
        rows.push({ ...candidate });
        created++;
      }
      return Promise.resolve({ count: created });
    }),
    update: vi.fn((args: Row) => {
      writes.push({ method: "update", args, selected: selectedColumns(args) });
      const row = rows.find((candidate) =>
        matches(candidate, args.where as Row)
      );
      if (!row) {
        return Promise.reject(prismaWriteError(PrismaWriteErrorCode.NotFound));
      }
      Object.assign(row, args.data as Row);
      return Promise.resolve(project(row, args.select as Row));
    }),
    // Modelled rather than stubbed so a cleanup-then-write path (the local
    // gateway JTI registry sweeps expired rows inside the same transaction as
    // the insert) is exercised against the real row set: a `deleteMany` that
    // resolves `{}` without removing anything would let a replay test pass for
    // the wrong reason.
    deleteMany: vi.fn((args: Row = {}) => {
      const where = args.where as Row | undefined;
      const doomed = where
        ? rows.filter((candidate) => matches(candidate, where))
        : [...rows];
      for (const row of doomed) {
        rows.splice(rows.indexOf(row), 1);
      }
      return Promise.resolve({ count: doomed.length });
    }),
    updateMany: vi.fn((args: Row) => {
      writes.push({
        method: "updateMany",
        args,
        selected: selectedColumns(args),
      });
      const found = rows.filter((candidate) =>
        matches(candidate, args.where as Row)
      );
      for (const row of found) {
        Object.assign(row, args.data as Row);
      }
      return Promise.resolve({ count: found.length });
    }),
    // The batch form that reports the rows it wrote, so a count read from it
    // reconciles by construction.
    updateManyAndReturn: vi.fn((args: Row) => {
      writes.push({
        method: "updateManyAndReturn",
        args,
        selected: selectedColumns(args),
      });
      const found = rows.filter((candidate) =>
        matches(candidate, args.where as Row)
      );
      for (const row of found) {
        Object.assign(row, args.data as Row);
      }
      return Promise.resolve(
        found.map((row) => project(row, args.select as Row))
      );
    }),
    upsert: vi.fn((args: Row) => {
      writes.push({ method: "upsert", args, selected: selectedColumns(args) });
      const row = rows.find((candidate) =>
        matches(candidate, args.where as Row)
      );
      if (row) {
        Object.assign(row, args.update as Row);
        return Promise.resolve(project(row, args.select as Row));
      }
      const created = { ...(args.create as Row) };
      rows.push(created);
      return Promise.resolve(project(created, args.select as Row));
    }),
  };

  return delegate;
}

/**
 * Every column a narrowed write is allowed to RETURN: the model's primary key.
 * Asserted per site so a `select` naming a non-key column — the shape that
 * broke seven sites in ISS-6319 when `{ id: true }` was applied to a
 * `*Detail`-style model keyed on something else — fails here and not in
 * production.
 */
export const PrimaryKeyColumn = {
  Artifact: "id",
  ArtifactLink: "id",
  BranchDetail: "artifactId",
  CatalogItem: "id",
  CatalogItemVersion: "id",
  Comment: "id",
  ComputeTarget: "id",
  DesktopCommand: "id",
  DocumentDetail: "artifactId",
  DocumentVersion: "id",
  FavoriteProject: "id",
  GitHubAccessCapability: "id",
  GitHubCommentProjection: "commentId",
  GitHubCommentThreadProjection: "threadId",
  GoogleIntegration: "id",
  JudgeHumanScore: "id",
  LinearIntegration: "id",
  LocalGatewayChallengeJti: "jti",
  OAuthRateLimit: "id",
  Organization: "id",
  Project: "id",
  PullRequestDetail: "id",
  SlackIntegration: "id",
  TagArtifact: "id",
  TagProject: "id",
  TeamMember: "id",
  User: "id",
} as const;
export type PrimaryKeyColumn =
  (typeof PrimaryKeyColumn)[keyof typeof PrimaryKeyColumn];

/**
 * The `where` key Prisma reserves for a disjunction. It holds an ARRAY of
 * sub-`where`s rather than a field constraint, so `matches` branches on it
 * before any field handling.
 */
const WHERE_DISJUNCTION_KEY = "OR";
const WHERE_CONJUNCTION_KEY = "AND";
const WHERE_NEGATION_KEY = "NOT";

/**
 * The canonical `where` predicate, exported so a sibling double that models a
 * delegate method this file does not (`count`) evaluates the SAME semantics
 * rather than writing a second, quietly divergent model of them.
 */
export function matchesPrismaWhere(row: Row, where: Row): boolean {
  return matches(row, where);
}

/**
 * The comparison operators the double evaluates. An operator OUTSIDE this set
 * (`contains`, `startsWith`, a nested relation filter, …) makes `matches` throw
 * — see its docstring for why silence would be worse than a crash. Widen this
 * set, with a test, when a write site starts using one.
 */
const COMPARISON_OPERATORS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
]);
