/**
 * Unit tests for the ordering read inside `documentMoveService.moveArtifact`
 * (PR #7201 review, chatgpt-codex-connector P1 + P2).
 *
 * `@repo/database` is replaced by a small in-memory store that FILTERS on
 * `organizationId`/`projectId`/`type` and SORTS by the `orderBy` it is actually
 * given, exactly as Postgres would. Both properties are load-bearing rather
 * than convenience: a fake returning a fixed row set would pass whether or not
 * the service scoped its read to the caller's organization, and a fake that
 * ignored `orderBy` could not tell a total order from a sequence the database
 * is free to hand back either way.
 *
 * What is NOT checkable here is the race itself — two concurrent transactions
 * need a real Postgres. What is checkable is the property that closes it: the
 * lock is the transaction's FIRST statement, so a waiter resumes after the
 * winner committed and re-reads its order. The DB-backed half lives in
 * `document-service.integration.test.ts`.
 */

import { MovePosition } from "@repo/api/src/types/project-artifact-move";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/database")>("@repo/database");
  // The real `Prisma` namespace comes through the spread: `lockProjectRank`
  // builds its statement with `Prisma.sql`, so a stub would fake away the very
  // SQL these cases read.
  return { ...actual, withDb: createFakeWithDb() };
});

import { ArtifactType } from "@repo/database";
import { documentMoveService } from "../document-move-service";

const ORG = "org-move-service";
const OTHER_ORG = "org-intruder";
const PROJECT = "project-move-service";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

/** One instant for every seeded row, so `createdAt` can never break a tie. */
const TIED_AT = new Date("2026-01-01T00:00:00.000Z");

type StoredArtifact = {
  id: string;
  organizationId: string;
  projectId: string;
  type: string;
  sortOrder: number | null;
  createdAt: Date;
};

type OrderByClause = Record<string, "asc" | "desc">;

const store: { artifacts: StoredArtifact[] } = { artifacts: [] };

/**
 * Every statement the service issued, in order. The lock is only worth anything
 * if it precedes the read it protects, and ordering is not observable from the
 * store's contents.
 */
const statementLog: string[] = [];

/** The SQL text and bound values of each `$executeRaw`, in order. */
const rawQueries: { sql: string; values: unknown[] }[] = [];

function compareRows(
  orderBy: OrderByClause[],
  a: StoredArtifact,
  b: StoredArtifact
): number {
  for (const clause of orderBy) {
    const [field, direction] = Object.entries(clause)[0] as [
      keyof StoredArtifact,
      "asc" | "desc",
    ];
    const left = a[field];
    const right = b[field];
    // NULLS LAST regardless of direction: the only nullable key in this read is
    // `sortOrder`, which it reads ASC, and Postgres puts nulls last there.
    if (left === null || right === null) {
      if (left === right) {
        continue;
      }
      return left === null ? 1 : -1;
    }
    let comparison = 0;
    if (left instanceof Date && right instanceof Date) {
      comparison = left.getTime() - right.getTime();
    } else if (typeof left === "number" && typeof right === "number") {
      comparison = left - right;
    } else {
      comparison = String(left).localeCompare(String(right));
    }
    if (comparison !== 0) {
      return direction === "desc" ? -comparison : comparison;
    }
  }
  return 0;
}

function makeClient() {
  return {
    artifact: {
      findMany: ({
        where,
        orderBy,
      }: {
        where: {
          organizationId: string;
          projectId: string;
          type: string;
        };
        orderBy: OrderByClause[];
      }) => {
        statementLog.push("artifact.findMany");
        const matched = store.artifacts.filter(
          (row) =>
            row.organizationId === where.organizationId &&
            row.projectId === where.projectId &&
            row.type === where.type
        );
        return Promise.resolve(
          [...matched]
            .sort((left, right) => compareRows(orderBy, left, right))
            .map((row) => ({ id: row.id }))
        );
      },
    },
    $executeRaw: (query: { sql: string; values: unknown[] }) => {
      statementLog.push("$executeRaw");
      rawQueries.push({ sql: query.sql, values: query.values });
      return Promise.resolve(1);
    },
  };
}

function createFakeWithDb() {
  const withDbFn = (fn: (db: unknown) => unknown) => fn(makeClient());
  const tx = (fn: (client: unknown) => unknown) => fn(makeClient());
  return Object.assign(withDbFn, { tx });
}

/**
 * Seed one project-less-of-nothing DOCUMENT row. Every case ties `sortOrder`
 * and `createdAt` on purpose, because the tiebreaker is what is under test.
 */
function seed(
  id: string,
  overrides: Partial<StoredArtifact> = {}
): StoredArtifact {
  const row: StoredArtifact = {
    createdAt: TIED_AT,
    id,
    organizationId: ORG,
    projectId: PROJECT,
    sortOrder: 1000,
    type: ArtifactType.DOCUMENT,
    ...overrides,
  };
  store.artifacts.push(row);
  return row;
}

beforeEach(() => {
  store.artifacts.length = 0;
  statementLog.length = 0;
  rawQueries.length = 0;
  vi.restoreAllMocks();
  // The rewrite itself is `reorder`'s contract, covered by its own suites. What
  // matters here is what the move computed BEFORE calling it.
  vi.spyOn(documentMoveService, "reorder").mockResolvedValue([]);
});

describe("moveArtifact — the project rank lock", () => {
  it("takes the lock as the transaction's first statement, before the ordering read", async () => {
    // Ordering is the whole contract. A lock taken AFTER the read would let two
    // movers observe the same ordering, both pass `checkExpectedOrder`, and the
    // later unconditional rewrite discard the earlier one with no conflict
    // reported — the lost update the precondition exists to refuse.
    seed(A, { sortOrder: 0 });
    seed(B, { sortOrder: 1000 });

    const result = await documentMoveService.moveArtifact(PROJECT, ORG, {
      artifactId: B,
      position: MovePosition.Top,
    });

    expect(result.ok).toBe(true);
    expect(statementLog.slice(0, 2)).toEqual([
      "$executeRaw",
      "artifact.findMany",
    ]);
    expect(rawQueries).toHaveLength(1);
    expect(rawQueries[0]?.sql).toContain("pg_advisory_xact_lock");
    // Keyed on THIS project, so two projects do not serialize against each
    // other and two movers of one project do.
    expect(rawQueries[0]?.values).toContain(PROJECT);
  });
});

describe("moveArtifact — the observed ordering", () => {
  it("breaks a sortOrder-and-createdAt tie on the id, ascending", async () => {
    // Seeded in DESCENDING id order and tied on both real sort keys, so the
    // store's own order is the WRONG answer: without the id key the read hands
    // back the insertion sequence and the precondition below refuses a project
    // nothing had touched.
    seed(C);
    seed(B);
    seed(A);

    const result = await documentMoveService.moveArtifact(PROJECT, ORG, {
      artifactId: C,
      expectedOrder: [A, B, C],
      position: MovePosition.Top,
    });

    expect(result.ok).toBe(true);
  });

  it("refuses a precondition that disagrees with that total order", async () => {
    // The falsifier for the case above: the same fixture, the same read, and an
    // ordering that is genuinely not what the transaction observed. Without it,
    // a `checkExpectedOrder` that had been reduced to "always pass" would leave
    // the previous case green.
    seed(C);
    seed(B);
    seed(A);

    const result = await documentMoveService.moveArtifact(PROJECT, ORG, {
      artifactId: C,
      expectedOrder: [C, B, A],
      position: MovePosition.Top,
    });

    expect(result.ok).toBe(false);
  });

  it("never admits another organization's row into the ordering", async () => {
    // Same project id, different organization — the shape a missing org
    // predicate would silently admit. It would lengthen the observed sequence,
    // so the precondition would refuse a move the caller was entitled to make,
    // and the rewrite would carry a row from another tenant.
    seed(A);
    seed(B);
    seed("44444444-4444-4444-8444-444444444444", {
      organizationId: OTHER_ORG,
    });

    const result = await documentMoveService.moveArtifact(PROJECT, ORG, {
      artifactId: B,
      expectedOrder: [A, B],
      position: MovePosition.Top,
    });

    expect(result.ok).toBe(true);
    expect(documentMoveService.reorder).toHaveBeenCalledWith(
      PROJECT,
      [B, A],
      ORG
    );
  });
});
