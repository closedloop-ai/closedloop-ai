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
 * Lives under `__tests__/support/` rather than `__tests__/utils/` because it
 * has ONE consumer (`__tests__/unit/artifact-crud-write-parity.test.ts`), well
 * short of the 3-distinct-module bar `apps/api/AGENTS.md` sets for app-wide
 * infrastructure. It sits flat rather than in a mirrored subdirectory because
 * it is scoped to no single `app/` module: the parity suite it serves spans
 * `app/documents`, `app/comments`, `app/tags`, and `app/projects`.
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
function prismaWriteError(code: PrismaWriteErrorCode) {
  return makePrismaKnownRequestError(
    code,
    code === PRISMA_NOT_FOUND
      ? "An operation failed because it depends on one or more records that were required but not found."
      : "Unique constraint failed"
  );
}

/**
 * A `where` may name a compound unique by its Prisma key
 * (`{ userId_projectId: { userId, projectId } }`), so flatten one level before
 * comparing. Nested relation filters are out of scope: the parity suite drives
 * writes keyed on a primary key or a unique tuple, which is every site the
 * batches touch.
 */
function flattenWhere(where: Row): Row {
  const flat: Row = {};
  for (const [key, value] of Object.entries(where)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Date)
    ) {
      Object.assign(flat, value as Row);
      continue;
    }
    flat[key] = value;
  }
  return flat;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(flattenWhere(where)).every(
    ([key, value]) => row[key] === value
  );
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
  method: "create" | "update" | "upsert" | "updateMany" | "createMany";
  args: Row;
  /** The column names the write asked Postgres to RETURN, or `null` for all. */
  selected: string[] | null;
};

export type FakeDelegate = {
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
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
 */
export function createFakeDelegate(
  rows: Row[] = [],
  uniqueKeys: readonly (readonly string[])[] = [["id"]]
): FakeDelegate {
  const writes: RecordedWrite[] = [];

  const collides = (candidate: Row): boolean =>
    rows.some((row) =>
      uniqueKeys.some(
        (key) =>
          key.every((column) => candidate[column] !== undefined) &&
          key.every((column) => row[column] === candidate[column])
      )
    );

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
      const data = { ...(args.data as Row) };
      writes.push({ method: "create", args, selected: selectedColumns(args) });
      if (collides(data)) {
        return Promise.reject(
          prismaWriteError(PrismaWriteErrorCode.UniqueViolation)
        );
      }
      rows.push(data);
      return Promise.resolve(project(data, args.select as Row));
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
  Comment: "id",
  DocumentDetail: "artifactId",
  DocumentGenerationStatusDismissal: "id",
  DocumentVersion: "id",
  FavoriteProject: "id",
  GitHubCommentProjection: "commentId",
  GitHubCommentThreadProjection: "threadId",
  JudgeHumanScore: "id",
  OAuthRateLimit: "id",
  Project: "id",
  TagArtifact: "id",
  TagLoop: "id",
  TagProject: "id",
} as const;
export type PrimaryKeyColumn =
  (typeof PrimaryKeyColumn)[keyof typeof PrimaryKeyColumn];
