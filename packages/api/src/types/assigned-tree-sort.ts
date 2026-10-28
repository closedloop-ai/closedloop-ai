import {
  compareListQueryText,
  ListQueryTextOrdering,
} from "./list-query-ordering-semantics.ts";

/**
 * The root sort columns the assignee-scoped tree read applies IN SQL
 * (ISS-12636).
 *
 * The spellings are the client's own `SortKey` strings
 * (`packages/app/documents/components/table/sort-keys.ts`), so a board sends
 * the column it already persists in the URL rather than translating it. That
 * vocabulary is WIDER than this one and deliberately so:
 *
 *  - `stackRank` is the DEFAULT and needs no member here. It is already
 *    server-side — `ITEM_SORT_CONFIGS` has no entry for it, so the client
 *    preserves the order the query returned, which `STACK_RANK_ORDER_BY_SQL`
 *    produces.
 *  - `status` and `priority` are absent because which ordering the server
 *    would reproduce is an open product question ISS-12636 records: ISS-9437
 *    left three alternative Status orderings resolved per viewer by PostHog in
 *    the browser, so "the default the client resolves today" is one of three
 *    and nothing here can pick between them.
 *
 * `assigned-tree-sort-vocabulary.test.ts` pins every member below to a
 * `SortKey`, so a spelling cannot drift from the column the client asks for.
 */
export const AssignedTreeSortKey = {
  Title: "title",
  Type: "type",
  Updated: "updated",
  Assignee: "assignee",
  Slug: "slug",
} as const;
export type AssignedTreeSortKey =
  (typeof AssignedTreeSortKey)[keyof typeof AssignedTreeSortKey];

/** Canonical member list, for the route's query enum and the parity suites. */
export const ASSIGNED_TREE_SORT_KEYS: readonly AssignedTreeSortKey[] =
  Object.freeze(Object.values(AssignedTreeSortKey));

export const AssignedTreeSortDirection = {
  Asc: "asc",
  Desc: "desc",
} as const;
export type AssignedTreeSortDirection =
  (typeof AssignedTreeSortDirection)[keyof typeof AssignedTreeSortDirection];

/** One resolved root ordering: which column, which way. */
export type AssignedTreeSort = {
  key: AssignedTreeSortKey;
  direction: AssignedTreeSortDirection;
};

/**
 * Which collation class ranks each column's text key, read by BOTH mirrors so
 * neither carries its own collation name.
 *
 * `Updated` is absent because it is an instant, not text. Exhaustive over the
 * keys that are: a member added above without an entry here fails `tsc` rather
 * than reaching the database under the cluster's default collation.
 */
export const ASSIGNED_TREE_SORT_TEXT_ORDERING: Readonly<
  Record<
    Exclude<AssignedTreeSortKey, typeof AssignedTreeSortKey.Updated>,
    ListQueryTextOrdering
  >
> = Object.freeze({
  [AssignedTreeSortKey.Title]: ListQueryTextOrdering.Collated,
  // `Collated`, not `CodeUnit`, even though the value is an enum spelling:
  // `ITEM_SORT_CONFIGS.type` compares it with `localeCompare`, and the class
  // has to follow the comparator this mirrors rather than the kind of value it
  // holds. Today's members agree under both classes, so declaring `CodeUnit`
  // would read as equivalent and part from the board on the first member that
  // separates them — `_` sorts after every uppercase letter under `C` and as
  // punctuation under ICU.
  [AssignedTreeSortKey.Type]: ListQueryTextOrdering.Collated,
  [AssignedTreeSortKey.Assignee]: ListQueryTextOrdering.Collated,
  // `Natural`, not `CodeUnit`, because the board ALREADY ranks slugs with
  // `numeric: true` (`compareSlugValues`): ISS-9 before ISS-10. Ranking by code
  // unit here would renumber a column the reader is looking at.
  [AssignedTreeSortKey.Slug]: ListQueryTextOrdering.Natural,
});

/**
 * One root's already-resolved sort values — the values the BOARD compares, not
 * the columns they came from.
 *
 * `type` is the mapped `DocumentType` for a document and the `ArtifactType`
 * spelling otherwise, which is what `getItemSortType` reads;
 * `assigneeDisplayName` is `getUserDisplayName`'s result, or null when nobody is
 * assigned. Resolving them at the edges keeps this comparator free of the row
 * shape, so the query's mirror and the board's own rows can both be held against
 * it.
 */
export type AssignedTreeSortValues = {
  title: string;
  type: string | null;
  updatedAt: Date;
  assigneeDisplayName: string | null;
  slug: string | null;
};

/**
 * Rank two roots by one column, for the DIRECTION requested.
 *
 * This has NO production call site and is not the server's sort — the query is
 * (`assigned-tree-root-sort.ts`). It exists because the two mirrors that must
 * agree live in packages neither can import from the other, and this is the one
 * module both parity suites can reach: `assigned-tree-root-sort-parity` holds
 * the SQL against it over Postgres, and `assigned-tree-sort-vocabulary` holds
 * it against the board's own `ITEM_SORT_CONFIGS` comparators.
 *
 * Returns 0 on a tie and leaves the tiebreak to the caller, which is the
 * board's own arrangement rather than an omission: `ITEM_SORT_CONFIGS` declares
 * no `tieBreak` for any of these columns and `sortItems` sorts stably, so a tie
 * keeps the order the rows arrived in — stack rank. The query's mirror appends
 * `STACK_RANK_ORDER_BY_SQL` for exactly that reason.
 *
 * The descending result is the ascending one NEGATED, including for an absent
 * value, because that is what `buildSortedGroups` does to a `comparator`: an
 * unslugged or unassigned root sorts last ascending and FIRST descending. A
 * nulls-last rule written on both directions would be a different product
 * behaviour, not a tidier version of this one.
 */
export function compareAssignedTreeSortValues(
  left: AssignedTreeSortValues,
  right: AssignedTreeSortValues,
  sort: AssignedTreeSort
): number {
  const ascending = compareAssignedTreeSortAscending(left, right, sort.key);
  return sort.direction === AssignedTreeSortDirection.Asc
    ? ascending
    : -ascending;
}

function compareAssignedTreeSortAscending(
  left: AssignedTreeSortValues,
  right: AssignedTreeSortValues,
  key: AssignedTreeSortKey
): number {
  switch (key) {
    case AssignedTreeSortKey.Title:
      return compareSortText(left.title, right.title, key);
    case AssignedTreeSortKey.Type:
      return compareSortText(left.type, right.type, key);
    case AssignedTreeSortKey.Updated:
      return left.updatedAt.getTime() - right.updatedAt.getTime();
    case AssignedTreeSortKey.Assignee:
      return compareSortText(
        left.assigneeDisplayName,
        right.assigneeDisplayName,
        key
      );
    case AssignedTreeSortKey.Slug:
      return compareSortText(left.slug, right.slug, key);
    default:
      return unrankedSortKey(key);
  }
}

/** A key added to the vocabulary without a comparison here fails `tsc`. */
function unrankedSortKey(key: never): number {
  throw new TypeError(`Unsupported assigned-tree sort key: ${String(key)}`);
}

/**
 * Absent sorts after present, then the key's declared collation decides.
 *
 * Which keys treat `""` AS absent is per-key and not a tidy global rule, because
 * the board's comparators are not uniform. Only the slug is folded: the row
 * adapter writes `artifact.slug ?? ""`, `compareSlugValues` reads that as
 * absent, and the query matches it with `NULLIF`. `a.name` is NOT folded — the
 * query orders on it bare and `getItemTitle(a).localeCompare(...)` puts `''`
 * first, so folding it here would send an empty title to the opposite end from
 * both mirrors. `getUserDisplayName` cannot return `""` (it falls back to the
 * email and then to a literal), so the assignee key never reaches the fold.
 */
function compareSortText(
  left: string | null,
  right: string | null,
  key: keyof typeof ASSIGNED_TREE_SORT_TEXT_ORDERING
): number {
  const foldsEmpty = key === AssignedTreeSortKey.Slug;
  const hasLeft = left !== null && !(foldsEmpty && left === "");
  const hasRight = right !== null && !(foldsEmpty && right === "");
  if (!(hasLeft || hasRight)) {
    return 0;
  }
  if (!hasLeft) {
    return 1;
  }
  if (!hasRight) {
    return -1;
  }
  return compareListQueryText(
    left,
    right,
    ASSIGNED_TREE_SORT_TEXT_ORDERING[key]
  );
}
