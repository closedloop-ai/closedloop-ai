import { ArtifactSubtypeInput } from "@repo/api/src/types/artifact";
import {
  ASSIGNED_TREE_SORT_TEXT_ORDERING,
  type AssignedTreeSort,
  AssignedTreeSortDirection,
  AssignedTreeSortKey,
} from "@repo/api/src/types/assigned-tree-sort";
import { normalizeDocumentType } from "@repo/api/src/types/document";
import {
  LIST_QUERY_TEXT_COLLATION,
  type ListQueryTextOrdering,
} from "@repo/api/src/types/list-query-ordering-semantics";
import { ArtifactType, Prisma } from "@repo/database";
import { STACK_RANK_ORDER_BY_SQL } from "./artifact-tree-shared";

/**
 * `DOCUMENT` inlined from the enum constant, never from input — the same reason
 * `BRANCH_TYPE_LITERAL` is inlined in `assigned-artifact-tree-root-page.ts`: a
 * bound `$n::"ArtifactType"` is an I/O cast Postgres does not fold.
 */
const DOCUMENT_TYPE_LITERAL = Prisma.raw(
  `'${ArtifactType.DOCUMENT}'::"ArtifactType"`
);

/**
 * ISS-12636: the root `ORDER BY` for one requested column, or stack rank when
 * no column was requested.
 *
 * Every arm ends in {@link STACK_RANK_ORDER_BY_SQL}, and that is the mirror of
 * a specific client behaviour rather than a flourish. The path this mirrors is
 * `buildSortedGroups`' own inline sort over the root list, which consults
 * `comparator`/`directedComparator` and IGNORES `tieBreak` outright — so a tie
 * keeps the order the rows ARRIVED in, which is the order this query returned,
 * which is stack rank. (The `tieBreak` field exists, and `sortItems` honours it,
 * but only on the flat-view path; adding one to `ITEM_SORT_CONFIGS` would not
 * reach the root ordering, so the premise here is the sort's structure and not
 * the absence of an entry.) A query that stopped after the column would leave
 * tied roots in whatever order the plan produced, and because the result is
 * then SLICED into pages, two reads that disagree about a tied pair drop one
 * root from the page bound and admit the other: a row served twice or skipped
 * entirely. The same reasoning `compareStackRankKeys` records for its own `id`
 * tiebreak.
 *
 * NULL placement is Postgres' own `ASC`/`DESC` default rather than an explicit
 * `NULLS` clause; {@link sortKeyExpressionSql} records why that is the faithful
 * mirror here.
 */
export function assignedTreeRootOrderBySql(
  sort: AssignedTreeSort | undefined
): Prisma.Sql {
  if (sort === undefined) {
    return STACK_RANK_ORDER_BY_SQL;
  }
  const key = sortKeyExpressionSql(sort.key);
  const direction =
    sort.direction === AssignedTreeSortDirection.Asc
      ? Prisma.raw("ASC")
      : Prisma.raw("DESC");
  return Prisma.sql`${key} ${direction}, ${STACK_RANK_ORDER_BY_SQL}`;
}

/**
 * One column's sort key, collated by the class
 * {@link ASSIGNED_TREE_SORT_TEXT_ORDERING} declares for it.
 *
 * NULL placement is left to Postgres' own `ASC`/`DESC` defaults — last on
 * ascending, first on descending — because that is exactly what the client's
 * comparators do. `compareSlugValues` and `compareAssigneeNames` return `1` for
 * a missing left value, and `buildSortedGroups` NEGATES a `comparator`'s result
 * wholesale on a descending sort, so the missing row moves to the top. A
 * `NULLS LAST` written on both directions would pin it at the bottom instead
 * and disagree with the board on every descending page.
 */
function sortKeyExpressionSql(key: AssignedTreeSortKey): Prisma.Sql {
  switch (key) {
    case AssignedTreeSortKey.Title:
      return collatedSql(Prisma.sql`a.name`, key);
    case AssignedTreeSortKey.Type:
      return collatedSql(rowTypeSql(), key);
    case AssignedTreeSortKey.Updated:
      return Prisma.sql`a.updated_at`;
    case AssignedTreeSortKey.Assignee:
      // The join is the caller's: both root reads already LEFT JOIN `users` as
      // `assignee` when they group by it, and `assignedTreeRootSortJoinSql`
      // below is what a caller adds when the SORT needs it.
      return collatedSql(assigneeDisplayNameSql(), key);
    case AssignedTreeSortKey.Slug:
      // `''` folds to NULL rather than sorting as the smallest string: the
      // adapter writes `artifact.slug ?? ""`, and `compareSlugValues` treats
      // the empty string as absent, so an unslugged root is "no slug" on both
      // mirrors instead of leading every ascending page.
      return collatedSql(Prisma.sql`NULLIF(a.slug, '')`, key);
    default:
      return unsupportedSortKey(key);
  }
}

/** A sort key added to the contract without an expression here fails `tsc`. */
function unsupportedSortKey(key: never): Prisma.Sql {
  throw new TypeError(`Unsupported assigned-tree sort key: ${String(key)}`);
}

/**
 * The Type column's value, not the raw `subtype` column.
 *
 * A document row's Type is `DOCUMENT_TYPE_BY_ARTIFACT_SUBTYPE[subtype]` — what
 * `documentRowFromArtifact` writes — and every other row kind shows its
 * `ArtifactType`. `getItemSortType` reads that same field, so the comparison
 * has to be over the MAPPED value: ordering on `a.subtype` would agree only
 * while `ArtifactSubtype` and `DocumentType` share spellings.
 *
 * A DOCUMENT with no subtype cannot become a document row at all
 * (`documentRowFromArtifact` returns null), so it has no Type to rank and
 * resolves to NULL here rather than to the artifact type the board never shows.
 */
function rowTypeSql(): Prisma.Sql {
  // Arms built by calling the normalizer, never from a second copy of its
  // table: `normalizeArtifactSubtype`'s docstring states the `ISSUE → FEATURE`
  // fold is "owned in exactly one place instead of a second exhaustive record
  // that could drift", and this `CASE` is that record if it is written out.
  // Keyed over the INPUT superset so the alias gets an arm — it never persists
  // through our own writes, but the Prisma enum carries it, so a row a skewed
  // client wrote still ranks as the Issue the board shows it as.
  const arms = Object.values(ArtifactSubtypeInput).map(
    (subtype) =>
      Prisma.sql`WHEN ${subtype} THEN ${normalizeDocumentType(subtype)}`
  );
  return Prisma.sql`CASE
      WHEN a.type = ${DOCUMENT_TYPE_LITERAL}
        THEN CASE a.subtype::text ${Prisma.join(arms, " ")} END
      ELSE a.type::text
    END`;
}

/**
 * `getUserDisplayName`, mirrored: the joined name parts, falling back to the
 * email, and NULL when the root has no assignee at all.
 *
 * Deliberately not `displayUserNameSql` from the Branch read service, whose
 * `COALESCE` over a LEFT JOIN cannot tell "no assignee" from "an assignee with
 * no readable name" — the first must rank as absent here, and the second must
 * rank as its email.
 *
 * `getUserDisplayName`'s last arm is NOT mirrored: it falls back to the literal
 * "Unknown user" when the email is empty too, and this expression ranks that row
 * by `''` instead. `users.email` is NOT NULL, so the case needs a stored empty
 * string to occur at all; mirroring a user-facing literal into a sort key is the
 * larger cost, and the row still sorts adjacent to the other nameless ones.
 */
function assigneeDisplayNameSql(): Prisma.Sql {
  return Prisma.sql`CASE
      WHEN a.assignee_id IS NULL THEN NULL
      ELSE COALESCE(
        NULLIF(btrim(concat_ws(' ', assignee.first_name, assignee.last_name)), ''),
        assignee.email
      )
    END`;
}

/**
 * The `users assignee` join, for the assignee SORT key and for the
 * assignee-GROUPED section read, which passes `assigneeGrouped` because it
 * needs the same join under any sort. The two cannot both emit one — a single
 * alias, and Postgres rejects the duplicate — so this is their one owner.
 *
 * Carries its own `organization_id` predicate. The row is already unreachable
 * across orgs — every artifact the surrounding read admits is org-scoped, and
 * `users.id` belongs to one org — so this is defence in depth rather than a fix:
 * it means an `assignee_id` pointing outside the caller's org ranks as unassigned
 * instead of ordering by a name from another tenant. The grouped read used to
 * write its own join without it, and ranked a cross-org assignee by name where
 * the ungrouped page ranked the same row unassigned (marisolashgrove and tamsinb,
 * PR #9108).
 */
export function assignedTreeRootSortJoinSql(
  sort: AssignedTreeSort | undefined,
  assigneeGrouped = false
): Prisma.Sql {
  if (assigneeGrouped || sort?.key === AssignedTreeSortKey.Assignee) {
    return Prisma.sql`LEFT JOIN users assignee
      ON assignee.id = a.assignee_id
     AND assignee.organization_id = a.organization_id`;
  }
  return Prisma.empty;
}

/**
 * `COLLATE` for one key's declared class, read from the shared ruling so this
 * module carries no collation literal of its own (`LIST_QUERY_TEXT_COLLATION`
 * states why the name is constrained to a closed union rather than a string).
 *
 * `normalize(…, NFC)` is what keeps a tie a tie (whitlockk, PR #9108). Both
 * collations this module names are DETERMINISTIC — `assigned-tree-root-sort-parity`
 * asserts that of the one it creates — and a deterministic collation breaks an
 * ICU tie by comparing bytes, BEFORE the stack-rank terms this `ORDER BY` ends
 * in ever run. So `café` composed and the same title decomposed, which
 * `localeCompare` and `compareAssignedTreeSortValues` both call equal and leave
 * in arrival order, would otherwise be ordered here by their encoding. Folding
 * both to one form makes the keys equal and hands the pair to stack rank, which
 * is the order the board shows. Canonical equivalence only: a pair ICU equates
 * through an ignorable character still parts here.
 */
function collatedSql(
  expression: Prisma.Sql,
  key: keyof typeof ASSIGNED_TREE_SORT_TEXT_ORDERING
): Prisma.Sql {
  const ordering: ListQueryTextOrdering = ASSIGNED_TREE_SORT_TEXT_ORDERING[key];
  return Prisma.sql`normalize(${expression}, NFC) ${Prisma.raw(
    `COLLATE "${LIST_QUERY_TEXT_COLLATION[ordering]}"`
  )}`;
}
