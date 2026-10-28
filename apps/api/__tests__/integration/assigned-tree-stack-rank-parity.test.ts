/**
 * ISS-10471: `STACK_RANK_ORDER_BY_SQL` and `compareStackRankKeys` order the same
 * rows the same way.
 *
 * Runs against a real Postgres because the property under test is a property of
 * the DATABASE, not of either implementation's control flow. `NULLS LAST` is
 * spelled out rather than inherited — a bare `ASC` already sorts nulls last,
 * but the comparator's null rule is a deliberate one — and `id ASC` is `uuid`
 * byte order here against `localeCompare` on a string in the TypeScript. Both
 * are properties of the column, so a fixture-free assertion over the comparator
 * alone proves nothing about either.
 *
 * Why it matters past this slice: ISS-10472 slices the root set with the SQL and
 * the page renders it in whatever order it arrives. If the two expressions ever
 * disagree the server returns one ordering and the client draws another, which
 * is exactly how a row is skipped or shown twice across a page boundary — the
 * defect PRD-743 exists to remove, reintroduced one layer down.
 *
 * The fixture covers what the ticket's acceptance criterion names: null and
 * non-null `sort_order`, an exact `created_at` tie, and a mixed-vocabulary
 * status set. It adds the case the criterion does not — identical `sort_order`
 * AND `created_at`, so the id tiebreak is the only thing deciding — because
 * without it the tiebreak can be deleted from both sides and this suite stays
 * green.
 */

import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType, Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareStackRankKeys,
  STACK_RANK_ORDER_BY_SQL,
} from "@/app/artifacts/artifact-tree-shared";
import { generateSlug } from "@/app/documents/document-utils";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

const organizations = createCommittedTestOrganizationTracker();

/** One instant every tie-breaking row shares, so `created_at DESC` cannot decide. */
const TIE = new Date("2026-06-01T12:00:00.000Z");
const EARLIER = new Date("2026-05-01T12:00:00.000Z");
const LATER = new Date("2026-07-01T12:00:00.000Z");

/**
 * Ids chosen so the deciding character sweeps the two boundaries where ICU
 * collation and byte order could part: digit-against-letter (`9` vs `a`) and
 * the low and high ends of the hex alphabet (`0`, `f`). All are canonical
 * lowercase with hyphens at the four standard positions, which is the only
 * shape the `uuid` column can hold.
 */
const TIEBREAK_IDS = [
  "aaaa0000-0000-7000-8000-00000000000f",
  "aaaa0000-0000-7000-8000-0000000000a0",
  "aaaa0000-0000-7000-8000-000000000009",
  "aaaa0000-0000-7000-8000-000000000000",
] as const;

type Seeded = { organizationId: string; ids: string[] };

async function seedFixture(): Promise<Seeded> {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);

  const rows: Array<{
    id?: string;
    sortOrder: number | null;
    createdAt: Date;
    status: string;
    type: ArtifactType;
  }> = [
    // Ranked rows, including two sharing a rank so `created_at DESC` decides.
    {
      sortOrder: 1000,
      createdAt: EARLIER,
      status: DocumentStatus.Draft,
      type: ArtifactType.DOCUMENT,
    },
    {
      sortOrder: 1000,
      createdAt: LATER,
      status: IssueStatus.Todo,
      type: ArtifactType.DOCUMENT,
    },
    {
      sortOrder: 0,
      createdAt: TIE,
      status: DocumentStatus.Approved,
      type: ArtifactType.DOCUMENT,
    },
    // Unranked rows must sort after every ranked one, whatever their dates.
    {
      sortOrder: null,
      createdAt: LATER,
      status: IssueStatus.InProgress,
      type: ArtifactType.DOCUMENT,
    },
    {
      sortOrder: null,
      createdAt: EARLIER,
      status: IssueStatus.Canceled,
      type: ArtifactType.DOCUMENT,
    },
    // A status in NEITHER document vocabulary. `Artifact.status` is freeform and
    // off-vocabulary rows demonstrably exist, so the stack-rank order must not
    // depend on the value being nameable. Carried on a DOCUMENT rather than a
    // real BRANCH row, which would need its own detail and session rows to be a
    // legal artifact and would be proving someone else's invariant.
    {
      sortOrder: 500,
      createdAt: TIE,
      status: "merged",
      type: ArtifactType.DOCUMENT,
    },
  ];
  // Same rank AND same instant, so only the id tiebreak is left.
  for (const id of TIEBREAK_IDS) {
    rows.push({
      id,
      sortOrder: 2000,
      createdAt: TIE,
      status: DocumentStatus.Draft,
      type: ArtifactType.DOCUMENT,
    });
  }

  const ids: string[] = [];
  for (const row of rows) {
    const created = await withDb((db) =>
      db.artifact.create({
        data: {
          ...(row.id ? { id: row.id } : {}),
          name: `rank-${row.sortOrder ?? "null"}-${row.createdAt.toISOString()}`,
          slug: generateSlug(),
          type: row.type,
          subtype:
            row.type === ArtifactType.DOCUMENT ? ArtifactSubtype.PRD : null,
          status: row.status,
          organizationId,
          createdById: user.id,
          projectId,
          sortOrder: row.sortOrder,
          createdAt: row.createdAt,
        },
        select: { id: true },
      })
    );
    ids.push(created.id);
  }
  return { organizationId, ids };
}

/** The order Postgres produces, through the shared `ORDER BY` itself. */
function readSqlOrder(organizationId: string): Promise<string[]> {
  return withDb(async (db) => {
    const rows = await db.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT a.id
        FROM artifacts a
        WHERE a.organization_id = ${organizationId}::uuid
        ORDER BY ${STACK_RANK_ORDER_BY_SQL}
      `
    );
    return rows.map((row) => row.id);
  });
}

/** The order the TypeScript comparator produces over the same persisted rows. */
function readComparatorOrder(organizationId: string): Promise<string[]> {
  return withDb(async (db) => {
    const rows = await db.artifact.findMany({
      where: { organizationId },
      select: { id: true, sortOrder: true, createdAt: true },
    });
    // Seeded in DESCENDING id, the exact opposite of the order the comparator
    // must produce for a tie, and `Array.prototype.sort` is stable — so what
    // the comparator does NOT decide survives into the result and is visible.
    //
    // Measured 2026-10-16: seeding in ASCENDING id instead let a comparator that
    // had lost its id tiebreak still emit ties in id order, and every assertion
    // in this file stayed green. `findMany` carries no `orderBy`, so without a
    // deliberate seed the starting order is the storage layer's and the same
    // coincidence can reappear per read.
    const seeded = [...rows].sort((left, right) =>
      right.id.localeCompare(left.id)
    );
    return [...seeded]
      .sort((left, right) => compareStackRankKeys(left, right))
      .map((row) => row.id);
  });
}

describe.skipIf(!hasDatabase)(
  "assigned-tree stack rank: SQL and comparator parity (Postgres)",
  () => {
    // `createCommittedTestOrganizationTracker` commits its fixtures and does NOT
    // tear them down for you — each case seeds a fresh organization, so without
    // this every run leaves one behind in a real database.
    afterEach(async () => {
      await organizations.cleanup();
    });

    it("orders a fixture of ranked, unranked, tied and mixed-status rows identically", async () => {
      const { organizationId, ids } = await seedFixture();

      const [sqlOrder, comparatorOrder] = await Promise.all([
        readSqlOrder(organizationId),
        readComparatorOrder(organizationId),
      ]);

      expect(sqlOrder).toHaveLength(ids.length);
      expect(sqlOrder).toEqual(comparatorOrder);
    });

    it("places every unranked row after every ranked one, on both sides", async () => {
      const { organizationId } = await seedFixture();

      const [sqlOrder, comparatorOrder] = await Promise.all([
        readSqlOrder(organizationId),
        readComparatorOrder(organizationId),
      ]);
      const unranked = await withDb((db) =>
        db.artifact.findMany({
          where: { organizationId, sortOrder: null },
          select: { id: true },
        })
      );
      const unrankedIds = new Set(unranked.map((row) => row.id));

      // Asserted on each side separately rather than inferred from the equality
      // above: two implementations that agree with each other can still both be
      // wrong about where a null belongs.
      for (const order of [sqlOrder, comparatorOrder]) {
        const firstUnranked = order.findIndex((id) => unrankedIds.has(id));
        const lastRanked = order.reduce(
          (last, id, index) => (unrankedIds.has(id) ? last : index),
          -1
        );
        expect(firstUnranked).toBeGreaterThan(lastRanked);
      }
    });

    it("STATES all three sort keys, because a passing row order cannot prove it", () => {
      // Measured 2026-10-16: deleting `, a.id ASC` from the expression left every
      // row-order assertion in this file green. Without a stated tiebreak
      // Postgres may return rows of equal rank and instant in ANY order, and the
      // plan it chose here happened to produce id order anyway — so the output
      // agreed with the comparator by coincidence, not by contract. Nothing a
      // single query's result can be compared against distinguishes the two,
      // which is why the expression itself is asserted here.
      //
      // That is the defect class the repo's own review lessons name: two paths
      // ordering the same rows must SHARE one tiebreak or they disagree on every
      // tie, and a comparator returning 0 for two distinct rows leaves them in
      // whatever order the input happened to have.
      const text = STACK_RANK_ORDER_BY_SQL.sql;

      expect(text).toContain("a.sort_order ASC NULLS LAST");
      expect(text).toContain("a.created_at DESC");
      expect(text).toContain("a.id ASC");
    });

    it("breaks a rank-and-instant tie on the id, byte order agreeing with localeCompare", async () => {
      const { organizationId } = await seedFixture();

      const [sqlOrder, comparatorOrder] = await Promise.all([
        readSqlOrder(organizationId),
        readComparatorOrder(organizationId),
      ]);

      const tiebreakSet = new Set<string>(TIEBREAK_IDS);
      const sqlTiebreak = sqlOrder.filter((id) => tiebreakSet.has(id));
      const comparatorTiebreak = comparatorOrder.filter((id) =>
        tiebreakSet.has(id)
      );

      // Ascending hex across the deciding character, which is what BOTH
      // orderings must produce. Written out rather than derived from either
      // implementation, so a shared regression cannot satisfy it.
      //
      // This pins the SEQUENCE, not the fact that the SQL asked for it — see the
      // preceding case for why those are different assertions.
      expect(sqlTiebreak).toEqual([
        "aaaa0000-0000-7000-8000-000000000000",
        "aaaa0000-0000-7000-8000-000000000009",
        "aaaa0000-0000-7000-8000-00000000000f",
        "aaaa0000-0000-7000-8000-0000000000a0",
      ]);
      expect(comparatorTiebreak).toEqual(sqlTiebreak);
    });
  }
);
