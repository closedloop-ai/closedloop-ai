import { type Mock, vi } from "vitest";

/**
 * A Prisma read double that actually applies `select`.
 *
 * A plain `vi.fn().mockResolvedValue(fullRow)` cannot characterize a read
 * narrowing at all: it hands the consumer every column no matter what the
 * production code asked Postgres for, so a test written against it passes
 * whether the `select` is right, wrong, or absent. This double projects the
 * stored row through the `select` clause the way the database does — a column
 * the query did not ask for is ABSENT from the object the consumer receives —
 * so a wrong `select` shows up as the consumer's observable output changing.
 *
 * It models only what it can model exactly, and throws on anything else, so a
 * clause it silently ignored can never be mistaken for a passing assertion.
 */

export type Row = Record<string, unknown>;
type SelectClause = Record<string, boolean>;
type WhereClause = Record<string, unknown>;

/**
 * Each delegate carries its real signature rather than a bare
 * `ReturnType<typeof vi.fn>`: the erased form is not callable through `tsc`, so
 * a case that drives the double directly — the only way to characterize the
 * double's own `where` handling — could not be written against it.
 */
export type ModelDouble = {
  rows: Row[];
  findUnique: Mock<(args: unknown) => Promise<Row | null>>;
  findFirst: Mock<(args: unknown) => Promise<Row | null>>;
  findMany: Mock<(args: unknown) => Promise<Row[]>>;
  update: Mock<(args: unknown) => Promise<Row>>;
  updateMany: Mock<(args: unknown) => Promise<{ count: number }>>;
  deleteMany: Mock<(args: unknown) => Promise<{ count: number }>>;
  delete: Mock<(args: unknown) => Promise<Row>>;
  /** Column names actually returned by each read, oldest call first. */
  returnedColumns: string[][];
};

/**
 * Build a model double over a fixed row set. Reads and `update` both project
 * through `select` and record what they returned; `updateMany`/`deleteMany`
 * return only the affected count, as Prisma does.
 */
export function createModelDouble(rows: Row[]): ModelDouble {
  const returnedColumns: string[][] = [];

  const read = (args: unknown): Row[] => {
    const { where, select, take, skip } = readArgs(args);
    const offset = skip ?? 0;
    const all = rows.filter((row) => matchesWhere(row, where)).slice(offset);
    const matches = take === undefined ? all : all.slice(0, take);
    return matches.map((row) => {
      const out = project(row, select);
      returnedColumns.push(Object.keys(out));
      return out;
    });
  };

  const write = (args: unknown) => {
    const { where, data } = writeArgs(args);
    const matches = rows.filter((row) => matchesWhere(row, where));
    for (const row of matches) {
      Object.assign(row, data);
    }
    return matches;
  };

  /**
   * `update`'s RETURNING obeys `select` exactly as a read's does. Modelling it
   * matters because a write's resolved row is a response body on several
   * routes, so a widened write select is the same disclosure as a widened read.
   */
  const writeAndProject = (args: unknown) => {
    const [updated] = write(args);
    if (!updated) {
      throw new Error("P2025: record not found");
    }
    const { select } = writeArgs(args);
    const out = project(updated, select);
    returnedColumns.push(Object.keys(out));
    return Promise.resolve(out);
  };

  const double: ModelDouble = {
    rows,
    returnedColumns,
    findUnique: vi.fn((args: unknown) =>
      Promise.resolve(read(args)[0] ?? null)
    ),
    findFirst: vi.fn((args: unknown) => Promise.resolve(read(args)[0] ?? null)),
    findMany: vi.fn((args: unknown) => Promise.resolve(read(args))),
    update: vi.fn((args: unknown) => writeAndProject(args)),
    updateMany: vi.fn((args: unknown) =>
      Promise.resolve({ count: write(args).length })
    ),
    deleteMany: vi.fn((args: unknown) => {
      const { where } = writeArgs({ ...(args as object), data: {} });
      const kept = rows.filter((row) => !matchesWhere(row, where));
      const removed = rows.length - kept.length;
      rows.splice(0, rows.length, ...kept);
      return Promise.resolve({ count: removed });
    }),
    delete: vi.fn((args: unknown) => {
      const { where } = writeArgs({ ...(args as object), data: {} });
      const index = rows.findIndex((row) => matchesWhere(row, where));
      if (index === -1) {
        throw new Error("P2025: record not found");
      }
      const [removed] = rows.splice(index, 1);
      return Promise.resolve(removed);
    }),
  };
  return double;
}

/**
 * `orderBy` is deliberately NOT modelled — sort order is Postgres's contract,
 * not this double's. Fixtures must therefore never depend on ordering: give a
 * `where` that matches exactly the rows the assertion is about.
 */
function readArgs(args: unknown): {
  where: WhereClause;
  select: SelectClause | undefined;
  take: number | undefined;
  skip: number | undefined;
} {
  const record = asRecord(args, "read args");
  for (const key of Object.keys(record)) {
    if (!READ_ARG_KEYS.has(key)) {
      throw new Error(
        `read-narrowing-projection double cannot model the read argument "${key}"`
      );
    }
  }
  if ("include" in record) {
    throw new Error(
      "read-narrowing-projection double cannot model `include`; use a read that selects scalars"
    );
  }
  return {
    where: asRecord(record.where ?? {}, "where"),
    select: record.select as SelectClause | undefined,
    take: record.take as number | undefined,
    skip: record.skip as number | undefined,
  };
}

function writeArgs(args: unknown): {
  where: WhereClause;
  data: Row;
  select: SelectClause | undefined;
} {
  const record = asRecord(args, "write args");
  return {
    where: asRecord(record.where ?? {}, "where"),
    data: asRecord(record.data ?? {}, "data"),
    select: record.select as SelectClause | undefined,
  };
}

/**
 * Project a stored row exactly as `RETURNING` would. A selected column missing
 * from the fixture row is a broken fixture, not an absent value, so it throws
 * rather than quietly yielding `undefined` and making the test unfalsifiable.
 */
function project(row: Row, select: SelectClause | undefined): Row {
  if (!select) {
    return { ...row };
  }
  const out: Row = {};
  for (const [column, wanted] of Object.entries(select)) {
    if (typeof wanted !== "boolean") {
      throw new Error(
        `read-narrowing-projection double cannot model the nested select on "${column}"`
      );
    }
    if (!wanted) {
      continue;
    }
    if (!(column in row)) {
      throw new Error(
        `fixture row has no column "${column}" but the query selected it`
      );
    }
    out[column] = row[column];
  }
  return out;
}

function matchesWhere(row: Row, where: WhereClause): boolean {
  return Object.entries(where).every(([column, expected]) => {
    if (column === "AND") {
      return (expected as WhereClause[]).every((clause) =>
        matchesWhere(row, clause)
      );
    }
    // Gated on the KEY, exactly as `AND` above is. Sniffing the VALUE instead
    // is what broke this double twice: `Date` and `Json` columns are both
    // object-valued, so no test of the value's shape can tell a boolean
    // combinator from an ordinary column predicate.
    if (column === "OR") {
      return (expected as WhereClause[]).some((clause) =>
        matchesWhere(row, clause)
      );
    }
    if (expected !== null && typeof expected === "object") {
      const operators = expected as Record<string, unknown>;
      const keys = Object.keys(operators);
      if (keys.length === 1 && keys[0] === "in") {
        return (operators.in as unknown[]).includes(row[column]);
      }
      if (keys.length === 1 && keys[0] === "notIn") {
        return !(operators.notIn as unknown[]).includes(row[column]);
      }
      if (keys.length === 1 && keys[0] === "not") {
        return row[column] !== operators.not;
      }
      if (keys.length === 1 && COMPARISONS.has(keys[0] as string)) {
        return compare(
          keys[0] as string,
          row[column],
          operators[keys[0] as string]
        );
      }
      // A compound-unique `where` key (`{ bucket_subject: { bucket, subject } }`)
      // is not an operator: it names no column of its own, and Prisma spells it
      // as its field list joined with `_`. That SPELLING is load-bearing here,
      // not decoration. The branch used to accept any key whose sub-keys all
      // happened to be columns of this row, which cannot tell a compound-unique
      // key from a RELATION filter the fixture forgot to embed:
      // `{ artifact: { organizationId } }` against a row carrying its own
      // `organizationId` matched HERE, against this row's column, even though
      // Postgres would have scoped the RELATED row. A read whose only org scope
      // is that join would then pass its test with the scope never applied —
      // a fail-open that leaves an org-scope regression green. Requiring the
      // join spelling reserves this branch for an unambiguous modeled
      // compound-unique key and sends everything else to the relation branch,
      // which throws when the related row is absent.
      if (!(column in row) && isModeledCompoundUniqueKey(column, keys)) {
        const missing = keys.filter((key) => !(key in row));
        if (missing.length > 0) {
          throw new Error(
            `read-narrowing-projection double cannot model the compound-unique key "${column}": the fixture row has no ${JSON.stringify(missing)}`
          );
        }
        return matchesWhere(row, operators);
      }
      // A to-one relation filter (`{ artifact: { is: { organizationId } } }`,
      // or the same thing without the explicit `is`) constrains the RELATED
      // row, not a column of this one — it is how the org-scoped reads that own
      // no `organizationId` column reach their scope. It is modelled only
      // against a related row the fixture EMBEDS as a plain object, and an
      // unembedded one throws rather than falling back to this row's columns.
      //
      // The operator exclusion is what keeps that throw from swallowing an
      // unmodelled column predicate. A clause naming any Prisma operator is a
      // column predicate, so a multi-key range like
      // `{ eventCreatedAt: { gte, lte } }` — which the single-operator branches
      // above deliberately do not model — must reach the generic throw below
      // instead of being reported as a missing relation.
      const related = row[column];
      const explicitIs = keys.length === 1 && keys[0] === "is";
      const isRelationFilter =
        explicitIs || keys.every((key) => !OPERATOR_KEYS.has(key));
      if (isRelationFilter) {
        // A `Date` column value is an object but not a related row, so it can
        // never stand in for one.
        if (!isEmbeddedRelatedRow(related)) {
          throw new Error(
            `read-narrowing-projection double cannot model the relation filter on "${column}": the fixture row embeds no "${column}". Embed the related row so the predicate is actually applied — matching this row's own columns instead would let a relation-scoped read pass with its scope never applied.`
          );
        }
        const nested = explicitIs ? operators.is : operators;
        return matchesWhere(
          related as Row,
          asRecord(nested, `relation filter on "${column}"`)
        );
      }
      throw new Error(
        `read-narrowing-projection double cannot model the operator ${JSON.stringify(expected)} on "${column}"`
      );
    }
    return row[column] === expected;
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `read-narrowing-projection double expected an object for ${label}`
    );
  }
  return value as Record<string, unknown>;
}

const COMPARISONS = new Set(["lt", "lte", "gt", "gte"]);

/**
 * Order comparison over the two orderable column kinds Prisma exposes here,
 * numbers and timestamps. A non-orderable operand throws rather than comparing
 * as `NaN`, which would silently make every predicate false.
 */
function compare(
  operator: string,
  actual: unknown,
  expected: unknown
): boolean {
  const left = toOrdinal(actual);
  const right = toOrdinal(expected);
  if (operator === "lt") {
    return left < right;
  }
  if (operator === "lte") {
    return left <= right;
  }
  if (operator === "gt") {
    return left > right;
  }
  return left >= right;
}

function toOrdinal(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value;
  }
  throw new Error(
    `read-narrowing-projection double cannot order ${JSON.stringify(value)}`
  );
}

const READ_ARG_KEYS = new Set([
  "where",
  "select",
  "orderBy",
  "take",
  "skip",
  "include",
]);

/**
 * Prisma filter keys that name an operation on a COLUMN. A clause using any of
 * them is a column predicate, never a relation filter — the distinction the
 * relation branch needs so an unmodelled operator combination still throws.
 *
 * The `Json` operators are the reason this list must be COMPLETE rather than
 * merely representative. A `Json` column stores a plain object exactly as an
 * embedded related row is one, and a Json predicate is a plain object of keys
 * exactly as a relation predicate is, so a Json filter naming no key listed
 * here would be taken for a relation filter and ANSWERED — recursed into the
 * stored object and compared key-by-key, which is not what `path` and
 * `array_contains` mean. That returns a fabricated match instead of refusing a
 * clause this double does not model. Every Prisma Json filter names at least
 * one key below, so listing them all is what sends the whole family to the
 * generic throw.
 */
const OPERATOR_KEYS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "endsWith",
  "search",
  "mode",
  "some",
  "every",
  "none",
  "isNot",
  "path",
  "string_contains",
  "string_starts_with",
  "string_ends_with",
  "array_contains",
  "array_starts_with",
  "array_ends_with",
]);

/** A fixture-embedded related row: a plain object, so never a `Date` or array. */
function isEmbeddedRelatedRow(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * Whether `column` is Prisma's default name for a compound unique over exactly
 * `keys` — the field list joined with `_`, which is the only spelling this repo
 * has (no `@@unique(…, name:)` anywhere in the schema). Membership rather than
 * position, so a fixture whose sub-keys are written in a different order than
 * the model declares them still matches.
 *
 * A hypothetical model field containing an underscore would fail this test and
 * throw at the relation branch instead of matching. That is the safe direction:
 * a loud unmodelled-clause error is recoverable, a silent fail-open is not.
 */
function isModeledCompoundUniqueKey(column: string, keys: string[]): boolean {
  const parts = column.split("_");
  return (
    parts.length > 1 &&
    parts.length === keys.length &&
    parts.every((part) => keys.includes(part))
  );
}
