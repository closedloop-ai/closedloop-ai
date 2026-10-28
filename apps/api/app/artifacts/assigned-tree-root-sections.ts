import {
  ArtifactGroupByMode,
  type ArtifactSectionOrdering,
} from "@repo/api/src/types/artifact-group-by-mode";
import {
  planSectionPages,
  type SectionSize,
} from "@repo/api/src/types/artifact-section-paging";
import type { AssignedTreeSort } from "@repo/api/src/types/assigned-tree-sort";
import { ArtifactType, Prisma, withDb } from "@repo/database";
import type { TreeAnchorFilters } from "./assigned-artifact-tree-anchors";
import { distinctRootsCteSql } from "./assigned-artifact-tree-root-page";
import {
  assignedTreeRootOrderBySql,
  assignedTreeRootSortJoinSql,
} from "./assigned-tree-root-sort";
import {
  sectionOrderBySql,
  sectionOrderColumnsSql,
  sectionValueSql,
} from "./assigned-tree-section-order";

/** `BRANCH` inlined from the enum constant, never from input. */
const BRANCH_TYPE_LITERAL = Prisma.raw(
  `'${ArtifactType.BRANCH}'::"ArtifactType"`
);

/** One section as it appears on the requested page. */
export type RootSection = {
  /** This section's root ids ON THIS PAGE, in render order. */
  ids: string[];
  /**
   * The section's size over the WHOLE set, which is the population a header's
   * count claims to be — never the slice this page took.
   */
  total: number;
  /** This section's rows began on an earlier page. */
  continued: boolean;
};

export type RootSectionPage = {
  /** Every root id on this page, in render order, sections concatenated. */
  ids: string[];
  /** Renderable roots behind the whole predicate. */
  total: number;
  /** Pages the packer laid the whole set into. Variable-height. */
  totalPages: number;
  /**
   * Rows on every earlier page — this page's first root's 0-based index among
   * all of them. Read off the PLAN rather than multiplied out, because a
   * variable-height page makes `pageIndex * pageSize` a window nothing
   * returned.
   */
  rowsBefore: number;
  sections: RootSection[];
};

export type RootSectionPageInput = {
  assigneeId: string;
  organizationId: string;
  viewerUserId: string;
  groupBy: Exclude<ArtifactGroupByMode, typeof ArtifactGroupByMode.None>;
  ordering: ArtifactSectionOrdering;
  /** Zero-based page index. Pages are variable-height, so this is not an offset. */
  pageIndex: number;
  pageSize: number;
  filters?: TreeAnchorFilters;
  /**
   * ISS-12636: the root column, or stack rank when absent.
   *
   * It orders ROOTS. Section order stays `sectionOrderBySql`'s answer, derived
   * from the grouping and the resolved `ordering` — the same split the browser
   * makes, where `buildSortedGroups` sorts the flat root list and the grouping
   * bands it afterwards.
   *
   * With ONE consequence worth stating, because it is not "never touches
   * sections": the legacy status arms tiebreak on `min(row_ord)`, and `row_ord`
   * is this sort's order, so two sections whose status rank ties can swap when
   * the column changes. That is the mirror, not a leak — the browser's
   * `compareStatusSections` ties those same two at 0 and falls to insertion
   * order, which is first appearance in the sorted root list.
   */
  sort?: AssignedTreeSort;
};

/**
 * ISS-10472 — one page of a GROUPED board's root groups.
 *
 * The paged unit is the SECTION, not a fixed row window: whole sections are
 * packed onto a page and only a section larger than a page spans pages, which
 * is what the browser already does and what a repeated header has to mean. The
 * packing itself is {@link planSectionPages} in `@repo/api`, shared with the
 * browser so the two cannot cut in different places.
 *
 * TWO statements, because the plan depends on every section's size and the page
 * depends on the plan. They run in ONE `RepeatableRead` transaction so both
 * observe the same snapshot — otherwise a write landing between them could make
 * the page disagree with the totals the headers state, which is the
 * `50 items, total 49` class `apps/api/AGENTS.md` forbids.
 *
 * The transaction budget is EXPLICIT because the two statements each run the
 * recursive root climb, on one pinned connection, for the readers who have most
 * to climb — a tenant past `MAX_TREE_ANCHORS` is exactly who this read exists
 * for, and Prisma's 5s default would abort them with P2028 and 500 the board
 * (marisolashgrove, PR #9026). {@link SECTION_PAGE_TX_TIMEOUT_MS} is the budget
 * `withStatusCountsSnapshot` already pins for the sibling multi-statement
 * snapshot read in this app, not a number chosen here.
 *
 * Only the page's ids come back. The sizes query returns one row per SECTION,
 * so nothing here grows with the root count the way reading every root id into
 * Node would — the thing root-group paging exists to stop.
 */
export async function resolveRootSectionPage(
  input: RootSectionPageInput
): Promise<RootSectionPage> {
  return await withDb((db) =>
    db.$transaction(
      async (tx) => {
        const sizes = await tx.$queryRaw<
          Array<{ section_value: string | null; size: number }>
        >(sectionSizesSql(input));

        const plan = planSectionPages(
          sizes.map(
            (row): SectionSize => ({
              key: sectionKeyOf(row.section_value),
              size: row.size,
            })
          ),
          input.pageSize
        );
        const total = sizes.reduce((sum, row) => sum + row.size, 0);
        const page = plan.pages[input.pageIndex];
        if (page === undefined) {
          // A page past the end of the plan. The caller clamps; reporting an
          // empty page with the real total lets it do that without a second
          // read, and an empty set legitimately has no page zero.
          return {
            ids: [],
            rowsBefore: 0,
            sections: [],
            total,
            totalPages: plan.pages.length,
          };
        }

        const rowsBefore = plan.pages
          .slice(0, input.pageIndex)
          .reduce(
            (sum, earlier) =>
              sum +
              earlier.slices.reduce((rows, slice) => rows + slice.take, 0),
            0
          );

        const slices = page.slices.map((slice, ordinal) => ({
          sectionValue: sectionValueOf(slice.key),
          lo: slice.skip + 1,
          hi: slice.skip + slice.take,
          ordinal,
        }));
        const rows = await tx.$queryRaw<Array<{ id: string; ordinal: number }>>(
          sectionSliceSql(input, slices)
        );

        const idsByOrdinal = new Map<number, string[]>();
        for (const row of rows) {
          const bucket = idsByOrdinal.get(row.ordinal);
          if (bucket === undefined) {
            idsByOrdinal.set(row.ordinal, [row.id]);
          } else {
            bucket.push(row.id);
          }
        }

        const sections = page.slices.map((slice, ordinal) => ({
          continued: page.continuedSectionKeys.has(slice.key),
          ids: idsByOrdinal.get(ordinal) ?? [],
          total: plan.sectionTotals.get(slice.key) ?? 0,
        }));
        return {
          ids: sections.flatMap((section) => section.ids),
          rowsBefore,
          sections,
          total,
          totalPages: plan.pages.length,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: SECTION_PAGE_TX_TIMEOUT_MS,
      }
    )
  );
}

/**
 * Budget for the two-statement section snapshot, matching
 * `STATUS_COUNTS_SNAPSHOT_TX_TIMEOUT_MS` — the same shape of read (several
 * statements under one `RepeatableRead` snapshot) in the same app.
 */
const SECTION_PAGE_TX_TIMEOUT_MS = 30_000;

/**
 * A NULL section value as a packer key, and back.
 *
 * `priority` and `assignee_id` are both nullable, and "no priority" / unassigned
 * are sections a user sees rather than rows to drop. The packer keys on a
 * string, so null needs a representation that no real value can collide with —
 * a status, a priority and a uuid are all non-empty, so the empty string is
 * free. These keys never reach the client: the renderer derives its own section
 * keys from the rows, and this one only has to survive the round trip to
 * {@link sectionSliceSql}.
 */
const NULL_SECTION_KEY = "";

function sectionKeyOf(value: string | null): string {
  return value ?? NULL_SECTION_KEY;
}

function sectionValueOf(key: string): string | null {
  return key === NULL_SECTION_KEY ? null : key;
}

/** Every renderable root, with its section value and the order terms. */
function renderableRootsCteSql(input: RootSectionPageInput): Prisma.Sql {
  // ONE `assignee` join however many consumers want it: grouping by assignee
  // and sorting by assignee both read it, and emitting it twice is a duplicate
  // alias Postgres rejects outright. Both cases go through
  // `assignedTreeRootSortJoinSql`, which owns the join text and its org
  // predicate, so the grouped read cannot scope the join differently from the
  // ungrouped one. Correct only while `assignee` is the only sort key needing a
  // join: a second join-needing key would be silently dropped on an
  // assignee-grouped board. It fails loud (missing FROM-clause entry) rather
  // than quietly if that ever stops holding.
  const assigneeJoin = assignedTreeRootSortJoinSql(
    input.sort,
    input.groupBy === ArtifactGroupByMode.Assignee
  );
  return Prisma.sql`
    ${distinctRootsCteSql(input)},
    renderable AS (
      SELECT
        a.id,
        ${sectionValueSql(input.groupBy, input.ordering)} AS section_value,
        row_number() OVER (
          ORDER BY ${assignedTreeRootOrderBySql(input.sort)}
        ) AS row_ord,
        row_number() OVER (
          PARTITION BY ${sectionValueSql(input.groupBy, input.ordering)}
          ORDER BY ${assignedTreeRootOrderBySql(input.sort)}
        ) AS in_section
        ${sectionOrderColumnsSql(input.groupBy)}
      FROM distinct_roots
      JOIN artifacts a ON a.id = distinct_roots.root_id
      ${assigneeJoin}
      -- Branches are not tasks (ISS-12463) and pruneBranchSubtrees drops a
      -- BRANCH-typed root on the client, so counting one here would make a
      -- section header promise a row the board is required to drop.
      WHERE a.type <> ${BRANCH_TYPE_LITERAL}
    )`;
}

/**
 * One row per section, in the order the surface renders sections.
 *
 * `::int` on the count is deliberate: `count(*)` is `bigint`, which arrives as
 * a JS `BigInt` and is not a counting integer, so `planSectionPages` rejects it
 * (its `assertPlannableSection`). Casting in SQL keeps that conversion in one
 * place rather than at every read of the row.
 */
function sectionSizesSql(input: RootSectionPageInput): Prisma.Sql {
  return Prisma.sql`
    ${renderableRootsCteSql(input)}
    SELECT section_value, count(*)::int AS size
    FROM renderable
    GROUP BY section_value
    ORDER BY ${sectionOrderBySql(input.groupBy, input.ordering)}`;
}

/**
 * The roots this page takes, as the planner's slices.
 *
 * `IS NOT DISTINCT FROM` rather than `=`, because a section value is nullable
 * and `NULL = NULL` is unknown — the unset-priority and unassigned sections
 * would silently return no rows while their headers still claimed a size.
 */
function sectionSliceSql(
  input: RootSectionPageInput,
  slices: ReadonlyArray<{
    sectionValue: string | null;
    lo: number;
    hi: number;
    ordinal: number;
  }>
): Prisma.Sql {
  return Prisma.sql`
    ${renderableRootsCteSql(input)},
    wanted AS (
      SELECT *
      FROM unnest(
        ${slices.map((slice) => slice.sectionValue)}::text[],
        ${slices.map((slice) => slice.lo)}::int[],
        ${slices.map((slice) => slice.hi)}::int[],
        ${slices.map((slice) => slice.ordinal)}::int[]
      ) AS t(section_value, lo, hi, ordinal)
    )
    SELECT renderable.id, wanted.ordinal
    FROM renderable
    JOIN wanted
      ON renderable.section_value IS NOT DISTINCT FROM wanted.section_value
     AND renderable.in_section BETWEEN wanted.lo AND wanted.hi
    ORDER BY wanted.ordinal ASC, renderable.in_section ASC`;
}
