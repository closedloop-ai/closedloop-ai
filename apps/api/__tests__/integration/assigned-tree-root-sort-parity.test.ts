/**
 * ISS-12636: the root sort's SQL and its TypeScript comparator order the same
 * rows the same way.
 *
 * Runs against a real Postgres for the reason the sibling stack-rank suite
 * states: the property under test is a property of the DATABASE. Three of the
 * five columns are text, and whether `COLLATE "und-x-icu"` ranks `Äpple` where
 * `Intl.Collator("en")` ranks it — or whether `COLLATE "en-u-kn"` puts `ISS-9`
 * before `ISS-10` the way `numeric: true` does — cannot be established from
 * either implementation's control flow. Neither can the Type column's `CASE`,
 * which has to agree with a mapping that lives in TypeScript.
 *
 * It drives the shared `ORDER BY` over a seeded `artifacts` table rather than
 * through the whole paged read, which is the same isolation
 * `assigned-tree-stack-rank-parity` uses: the root DERIVATION is covered by
 * `assigned-tree-root-page`, and mixing the two would mean a failure here could
 * be either.
 *
 * The fixture is adversarial on purpose, and every row deliberately shares one
 * `sort_order` and one `created_at` so the stack-rank tiebreak decides every
 * tie the column leaves — without that, a column comparison that silently
 * returned 0 could still come back in an order the plan happened to produce.
 */

import { normalizeArtifactSubtype } from "@repo/api/src/types/artifact";
import {
  ASSIGNED_TREE_SORT_KEYS,
  type AssignedTreeSort,
  AssignedTreeSortDirection,
  AssignedTreeSortKey,
  type AssignedTreeSortValues,
  compareAssignedTreeSortValues,
} from "@repo/api/src/types/assigned-tree-sort";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  LIST_QUERY_TEXT_COLLATION,
  ListQueryTextOrdering,
} from "@repo/api/src/types/list-query-ordering-semantics";
import { mentionMatchDisplayName } from "@repo/collaboration/shared/mention-matching";
import { ArtifactSubtype, ArtifactType, Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { compareStackRankKeys } from "@/app/artifacts/artifact-tree-shared";
import {
  assignedTreeRootOrderBySql,
  assignedTreeRootSortJoinSql,
} from "@/app/artifacts/assigned-tree-root-sort";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

const organizations = createCommittedTestOrganizationTracker();

/**
 * One rank and one instant for every row, so the column under test is the only
 * thing that can order them and the stack-rank tiebreak settles what it leaves.
 */
const SHARED_RANK = 1000;
const SHARED_CREATED_AT = new Date("2026-06-01T12:00:00.000Z");

const EARLIER_UPDATE = new Date("2026-05-01T12:00:00.000Z");
const LATER_UPDATE = new Date("2026-07-01T12:00:00.000Z");

/**
 * One title in two encodings: `é` as U+00E9, and as `e` plus U+0301. Written as
 * escapes because the distinction is the whole point and an editor that
 * normalizes the file would silently delete the case.
 */
const NFC_TITLE = "café";
const NFD_TITLE = "café";

/**
 * Names sweeping the boundaries where ICU collation and byte order part: case
 * folding (`apple`/`Apple`), an accent (`Äpple`), a leading punctuation mark,
 * a digit run against a letter, and one canonically equivalent pair.
 */
type SeedRow = {
  name: string;
  subtype: ArtifactSubtype;
  slug: string | null;
  updatedAt: Date;
  assignee: "named" | "emailOnly" | "none";
};

const SEED_ROWS: readonly SeedRow[] = [
  {
    assignee: "named",
    name: "apple",
    slug: "ISS-9",
    subtype: ArtifactSubtype.PRD,
    updatedAt: LATER_UPDATE,
  },
  {
    assignee: "none",
    name: "Apple",
    slug: "ISS-10",
    subtype: ArtifactSubtype.FEATURE,
    updatedAt: EARLIER_UPDATE,
  },
  {
    assignee: "emailOnly",
    name: "Äpple",
    slug: "ISS-100",
    subtype: ArtifactSubtype.IMPLEMENTATION_PLAN,
    updatedAt: SHARED_CREATED_AT,
  },
  {
    assignee: "named",
    name: "_leading",
    slug: "PRD-2",
    subtype: ArtifactSubtype.TEMPLATE,
    updatedAt: LATER_UPDATE,
  },
  {
    assignee: "none",
    name: "10th",
    slug: null,
    subtype: ArtifactSubtype.DOC,
    updatedAt: EARLIER_UPDATE,
  },
  {
    assignee: "emailOnly",
    name: "2nd",
    // The empty string, which the row adapter writes for a missing slug and
    // both mirrors must read as absent rather than as the smallest string.
    slug: "",
    subtype: ArtifactSubtype.PRD,
    updatedAt: SHARED_CREATED_AT,
  },
  {
    // The skewed alias the column accepts and our own writes never produce.
    // Both mirrors must rank it as the Issue it normalizes to.
    assignee: "named",
    name: "zebra",
    slug: "ISS-3",
    subtype: ArtifactSubtype.ISSUE,
    updatedAt: LATER_UPDATE,
  },
  {
    // This row and the next carry ONE title in two encodings. ICU and
    // `localeCompare` call them equal; a deterministic collation parts them by
    // bytes unless the key folds both to one form. Their subtypes and slugs
    // stay clear of the rows the Type and slug cases below name, so the pair
    // adds a title tie and disturbs nothing else.
    assignee: "named",
    name: NFC_TITLE,
    slug: "PRD-3",
    subtype: ArtifactSubtype.PRD,
    updatedAt: LATER_UPDATE,
  },
  {
    assignee: "named",
    name: NFD_TITLE,
    slug: "PRD-4",
    subtype: ArtifactSubtype.TEMPLATE,
    updatedAt: EARLIER_UPDATE,
  },
];

type SeededRow = {
  id: string;
  name: string;
  subtype: ArtifactSubtype;
  slug: string | null;
  updatedAt: Date;
  assigneeDisplayName: string | null;
};

type Seeded = { organizationId: string; rows: SeededRow[] };

async function seedFixture(): Promise<Seeded> {
  const organizationId = await organizations.create();
  const author = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, author.id);
  // "Zoe Adams" ranks after an email-only assignee's address under either
  // collation, so the two assignees plus the unassigned row exercise all three
  // arms of the display-name fold.
  const named = await createTestUser(organizationId, {
    firstName: "Zoe",
    lastName: "Adams",
  });
  const emailOnly = await createTestUser(organizationId, {
    firstName: null,
    lastName: null,
  });

  const assigneeOf = (kind: SeedRow["assignee"]) => {
    if (kind === "named") {
      return named;
    }
    if (kind === "emailOnly") {
      return emailOnly;
    }
    return null;
  };

  const rows: SeededRow[] = [];
  for (const row of SEED_ROWS) {
    const assignee = assigneeOf(row.assignee);
    const created = await withDb((db) =>
      db.artifact.create({
        data: {
          assigneeId: assignee?.id ?? null,
          createdAt: SHARED_CREATED_AT,
          createdById: author.id,
          name: row.name,
          organizationId,
          projectId,
          slug: row.slug,
          sortOrder: SHARED_RANK,
          status: IssueStatus.Todo,
          subtype: row.subtype,
          type: ArtifactType.DOCUMENT,
          updatedAt: row.updatedAt,
        },
        select: { id: true },
      })
    );
    rows.push({
      assigneeDisplayName:
        assignee === null
          ? null
          : displayName(assignee.firstName, assignee.lastName, assignee.email),
      id: created.id,
      name: row.name,
      slug: row.slug,
      subtype: row.subtype,
      updatedAt: row.updatedAt,
    });
  }
  return { organizationId, rows };
}

/**
 * The display-name fold, read from its OWNER rather than reimplemented.
 *
 * A local copy is a third mirror, and a third mirror agrees with whichever of
 * the other two it was written from — here that would have been the SQL, so the
 * suite could not have seen a divergence. `getUserDisplayName` wraps this with
 * a final `|| "Unknown user"` arm the SQL deliberately does not reproduce
 * (`assigneeDisplayNameSql` records why), so this names the part that IS
 * mirrored.
 */
function displayName(
  firstName: string | null,
  lastName: string | null,
  email: string
): string {
  return mentionMatchDisplayName({ email, firstName, lastName });
}

/** The order Postgres produces, through the shared `ORDER BY` itself. */
function readSqlOrder(
  organizationId: string,
  sort: AssignedTreeSort,
  assigneeGrouped = false
): Promise<string[]> {
  return withDb(async (db) => {
    const rows = await db.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT a.id
        FROM artifacts a
        ${assignedTreeRootSortJoinSql(sort, assigneeGrouped)}
        WHERE a.organization_id = ${organizationId}::uuid
        ORDER BY ${assignedTreeRootOrderBySql(sort)}
      `
    );
    return rows.map((row) => row.id);
  });
}

/** The comparator's order over the same persisted rows. */
function comparatorOrder(rows: SeededRow[], sort: AssignedTreeSort): string[] {
  // Seeded in DESCENDING id, the opposite of what the stack-rank tiebreak must
  // produce, and `Array.prototype.sort` is stable — so anything the comparators
  // do NOT decide survives into the result and is visible, rather than being
  // masked by an input that already happened to be right. The sibling
  // stack-rank suite measured that exact masking.
  const seeded = [...rows].sort((left, right) =>
    right.id.localeCompare(left.id)
  );
  // `seeded` is already a fresh array, so sorting it in place mutates nothing
  // the caller holds.
  return seeded
    .sort((left, right) => {
      const byColumn = compareAssignedTreeSortValues(
        sortValuesOf(left),
        sortValuesOf(right),
        sort
      );
      if (byColumn !== 0) {
        return byColumn;
      }
      return compareStackRankKeys(
        { createdAt: SHARED_CREATED_AT, id: left.id, sortOrder: SHARED_RANK },
        { createdAt: SHARED_CREATED_AT, id: right.id, sortOrder: SHARED_RANK }
      );
    })
    .map((row) => row.id);
}

/** A seeded row as the values the board compares. */
function sortValuesOf(row: SeededRow): AssignedTreeSortValues {
  return {
    assigneeDisplayName: row.assigneeDisplayName,
    slug: row.slug,
    title: row.name,
    type: normalizeArtifactSubtype(row.subtype),
    updatedAt: row.updatedAt,
  };
}

const EVERY_DIRECTION = Object.values(AssignedTreeSortDirection);

describe.skipIf(!hasDatabase)(
  "assigned-tree root sort: SQL and comparator parity (Postgres)",
  () => {
    // `createCommittedTestOrganizationTracker` commits its fixtures and does
    // NOT tear them down for you.
    afterEach(async () => {
      await organizations.cleanup();
    });

    it("has the natural collation the slug key names", async () => {
      // The one object in this change that lives only in migration SQL. Prisma
      // models no collation, so its differ cannot miss it and cannot catch it
      // either; without this the slug sort's 42704 would surface as a 500 on a
      // user-facing board rather than as a red test.
      const rows = await withDb((db) =>
        db.$queryRaw<Array<{ provider: string; deterministic: boolean }>>(
          Prisma.sql`
            SELECT collprovider::text AS provider,
                   collisdeterministic AS deterministic
            FROM pg_collation
            WHERE collname = ${
              LIST_QUERY_TEXT_COLLATION[ListQueryTextOrdering.Natural]
            }
          `
        )
      );

      expect(rows).toHaveLength(1);
      // `i` is the ICU provider; the numeric tailoring needs it.
      expect(rows[0]?.provider).toBe("i");
      expect(rows[0]?.deterministic).toBe(true);
    });

    it("orders every column, in both directions, identically on both mirrors", async () => {
      const { organizationId, rows } = await seedFixture();

      for (const key of ASSIGNED_TREE_SORT_KEYS) {
        for (const direction of EVERY_DIRECTION) {
          const sort: AssignedTreeSort = { direction, key };
          const sqlOrder = await readSqlOrder(organizationId, sort);

          expect(sqlOrder).toHaveLength(rows.length);
          expect({ direction, key, order: sqlOrder }).toEqual({
            direction,
            key,
            order: comparatorOrder(rows, sort),
          });
        }
      }
    });

    it("ranks a slug's digit run as a magnitude on BOTH mirrors", async () => {
      // Asserted on each side rather than inferred from the equality above: two
      // mirrors that agree with each other can still both be wrong, and
      // code-unit order — which the shared ruling names for a slug — would put
      // ISS-10 and ISS-100 ahead of ISS-3 and ISS-9 while agreeing.
      const { organizationId, rows } = await seedFixture();
      const sort: AssignedTreeSort = {
        direction: AssignedTreeSortDirection.Asc,
        key: AssignedTreeSortKey.Slug,
      };
      const byId = new Map(rows.map((row) => [row.id, row]));
      const slugsOf = (order: string[]) =>
        order
          .map((id) => byId.get(id)?.slug)
          .filter((slug): slug is string => Boolean(slug));

      const sqlOrder = await readSqlOrder(organizationId, sort);

      for (const order of [sqlOrder, comparatorOrder(rows, sort)]) {
        expect(slugsOf(order)).toEqual([
          "ISS-3",
          "ISS-9",
          "ISS-10",
          "ISS-100",
          "PRD-2",
          "PRD-3",
          "PRD-4",
        ]);
      }
    });

    it("sends an absent slug last ASCENDING and first DESCENDING, on both mirrors", async () => {
      // The direction-flipping null placement is the behaviour the board has:
      // `buildSortedGroups` negates a `comparator`'s result wholesale, nulls
      // included. A `NULLS LAST` on both directions would be a quieter column
      // and a different product.
      const { organizationId, rows } = await seedFixture();
      const absent = new Set(
        rows.filter((row) => !row.slug).map((row) => row.id)
      );
      expect(absent.size).toBe(2);

      for (const direction of EVERY_DIRECTION) {
        const sort: AssignedTreeSort = {
          direction,
          key: AssignedTreeSortKey.Slug,
        };
        const sqlOrder = await readSqlOrder(organizationId, sort);

        for (const order of [sqlOrder, comparatorOrder(rows, sort)]) {
          const positions = order
            .map((id, index) => ({ absent: absent.has(id), index }))
            .filter((entry) => entry.absent)
            .map((entry) => entry.index);

          expect(positions).toEqual(
            direction === AssignedTreeSortDirection.Asc
              ? [order.length - 2, order.length - 1]
              : [0, 1]
          );
        }
      }
    });

    it("sends an unassigned root the same way the slug column sends an absent one", async () => {
      const { organizationId, rows } = await seedFixture();
      const unassigned = new Set(
        rows
          .filter((row) => row.assigneeDisplayName === null)
          .map((row) => row.id)
      );
      expect(unassigned.size).toBe(2);

      const sqlOrder = await readSqlOrder(organizationId, {
        direction: AssignedTreeSortDirection.Asc,
        key: AssignedTreeSortKey.Assignee,
      });

      expect(sqlOrder.slice(-2).every((id) => unassigned.has(id))).toBe(true);
    });

    it("ranks a cross-org assignee as unassigned, on the grouped and ungrouped joins alike", async () => {
      // marisolashgrove and tamsinb, PR #9108: the assignee-grouped section read
      // used to write its own join without the `organization_id` predicate, so
      // the SAME row ranked by a foreign tenant's name there and as unassigned
      // on an ungrouped page. Both arms now resolve through one builder, and
      // `assigneeGrouped` is the one the grouped read passes.
      //
      // The foreign name leads under either collation and the same-org name
      // trails, so a join that matched across orgs puts the cross-org row FIRST
      // ascending instead of last. Asserted through the production SQL rather
      // than a fake: which rows a fake returns says nothing about how the
      // predicate is written.
      const organizationId = await organizations.create();
      const author = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, author.id);
      const sameOrg = await createTestUser(organizationId, {
        firstName: "Zoe",
        lastName: "Zebra",
      });
      const foreign = await createTestUser(await organizations.create(), {
        firstName: "Aaa",
        lastName: "Aaa",
      });

      const seed = async (assigneeId: string, name: string) => {
        const created = await withDb((db) =>
          db.artifact.create({
            data: {
              assigneeId,
              createdAt: SHARED_CREATED_AT,
              createdById: author.id,
              name,
              organizationId,
              projectId,
              sortOrder: SHARED_RANK,
              status: IssueStatus.Todo,
              subtype: ArtifactSubtype.FEATURE,
              type: ArtifactType.DOCUMENT,
              updatedAt: SHARED_CREATED_AT,
            },
            select: { id: true },
          })
        );
        return created.id;
      };
      const crossOrgRoot = await seed(foreign.id, "cross-org-assignee");
      const sameOrgRoot = await seed(sameOrg.id, "same-org-assignee");

      const sort: AssignedTreeSort = {
        direction: AssignedTreeSortDirection.Asc,
        key: AssignedTreeSortKey.Assignee,
      };

      for (const assigneeGrouped of [false, true]) {
        expect({
          assigneeGrouped,
          order: await readSqlOrder(organizationId, sort, assigneeGrouped),
        }).toEqual({ assigneeGrouped, order: [sameOrgRoot, crossOrgRoot] });
      }
    });

    it("leaves two canonically equivalent titles in stack-rank order, both directions, on both mirrors", async () => {
      // The pair the all-columns case above also covers, asserted on its own
      // because that case reports only THAT some column disagreed. Equal keys
      // mean the stack-rank terms decide, and they rank by id ascending
      // whichever way the column points — so a byte comparison leaking into the
      // key shows up as the DESCENDING read reversing this pair.
      const { organizationId, rows } = await seedFixture();
      const pair = rows.filter(
        (row) => row.name === NFC_TITLE || row.name === NFD_TITLE
      );
      expect(pair).toHaveLength(2);
      const stackRankKeyOf = (id: string) => ({
        createdAt: SHARED_CREATED_AT,
        id,
        sortOrder: SHARED_RANK,
      });
      const expected = [...pair]
        .sort((left, right) =>
          compareStackRankKeys(
            stackRankKeyOf(left.id),
            stackRankKeyOf(right.id)
          )
        )
        .map((row) => row.id);

      for (const direction of EVERY_DIRECTION) {
        const sort: AssignedTreeSort = {
          direction,
          key: AssignedTreeSortKey.Title,
        };
        const sqlOrder = await readSqlOrder(organizationId, sort);
        const ids = new Set(expected);

        for (const order of [sqlOrder, comparatorOrder(rows, sort)]) {
          expect(order.filter((id) => ids.has(id))).toEqual(expected);
        }
      }
    });

    it("ranks the ISSUE alias as the document type it normalizes to", async () => {
      // The row seeded with the skewed subtype must land among the FEATURE
      // rows, not alone at the end as a row with no Type. A `CASE` with no arm
      // for the alias ranks it NULL and fails here.
      const { organizationId, rows } = await seedFixture();
      const aliasRow = rows.find(
        (row) => row.subtype === ArtifactSubtype.ISSUE
      );
      const featureRow = rows.find(
        (row) => row.subtype === ArtifactSubtype.FEATURE
      );
      expect(aliasRow && featureRow).toBeTruthy();

      const sqlOrder = await readSqlOrder(organizationId, {
        direction: AssignedTreeSortDirection.Asc,
        key: AssignedTreeSortKey.Type,
      });
      const aliasIndex = sqlOrder.indexOf(aliasRow?.id ?? "");
      const featureIndex = sqlOrder.indexOf(featureRow?.id ?? "");

      // Adjacent, because they carry the same Type and nothing but the
      // stack-rank tiebreak separates two rows that do.
      expect(Math.abs(aliasIndex - featureIndex)).toBe(1);
    });
  }
);
