/**
 * Parent/child row lineage for `GridTableV2` — ISS-8921.
 *
 * The whole safety property of nesting lives in this module's SHAPE, not in a
 * caller remembering to guard: a row's tree metadata is `null` for a caller that
 * supplied no child accessor, and {@link treeRowAriaProps} is the only thing
 * that turns metadata into attributes. A flat table therefore has no tree data
 * to leak — the absence is structural rather than a branch that could be
 * inverted by mistake.
 *
 * Pure data, no React and no DOM, for the reason `grid-table-v2-rows` was
 * extracted before it: the flattening, the sibling bookkeeping and the ARIA
 * derivation are unit-testable without rendering a table, and the component file
 * is held against a hard 1,000-line ceiling.
 */

/** 1-based `aria-level` of a root row: `aria-level` has no zero. */
export const FIRST_TREE_LEVEL = 1;

/**
 * One row's position in its subtree, as the WAI-ARIA `treegrid` pattern spells
 * it. Every field maps to exactly one attribute in {@link treeRowAriaProps} —
 * nothing here is derived twice.
 */
export type GridTreeRowMeta = {
  /** `aria-level`, 1-based. */
  level: number;
  /** `aria-posinset` among the row's OWN siblings, 1-based. */
  posInSet: number;
  /** `aria-setsize`: how many siblings that set holds. */
  setSize: number;
  /** Whether the row owns children. `aria-expanded` is emitted only when true. */
  hasChildren: boolean;
  isExpanded: boolean;
};

/**
 * A row the body is about to paint.
 *
 * `tree` is `null` EXACTLY when the caller supplied no `getChildren`, which is
 * what makes flatness inert: the flat path constructs no metadata, so no ARIA
 * derivation downstream has anything to emit.
 */
export type GridRenderRow<T> = {
  item: T;
  rowId: string;
  tree: GridTreeRowMeta | null;
};

/**
 * The visible rows one sibling set paints, in visible order: each item followed
 * by its descendants while it is expanded.
 *
 * Without `getChildren` this is the identity — one `tree: null` row per item, in
 * the input order — so a caller that never opted into nesting gets precisely the
 * list it passed in.
 */
export function flattenRenderRows<T>({
  expandedRowIds,
  getChildren,
  getRowId,
  items,
  visited,
}: {
  items: readonly T[];
  getRowId: (item: T) => string;
  getChildren?: (item: T) => readonly T[] | undefined;
  expandedRowIds?: ExpandedRowLookup;
  /**
   * Cycle guard to walk under, for a caller flattening one list of many that
   * together form a single painted body. Omitted, the call owns a private one
   * and the guard spans exactly this call — which is only the whole body when
   * the whole body came from one list. Prefer {@link createSiblingFlattener}
   * over passing this by hand; it exists so the shared case cannot be reached
   * by remembering to thread a set.
   */
  visited?: Set<string>;
}): GridRenderRow<T>[] {
  if (getChildren === undefined) {
    return items.map((item) => ({ item, rowId: getRowId(item), tree: null }));
  }
  const rows: GridRenderRow<T>[] = [];
  appendTreeRows({
    expandedRowIds: expandedRowIds ?? EMPTY_ROW_IDS,
    getChildren,
    getRowId,
    items,
    level: FIRST_TREE_LEVEL,
    rows,
    visited: visited ?? new Set<string>(),
  });
  return rows;
}

/**
 * The ARIA a nested row declares, or nothing at all for a flat one.
 *
 * `aria-expanded` is emitted ONLY for a row that owns children: ARIA gives it
 * the meaning "this row has content that can be shown", so putting it on a leaf
 * announces an affordance that does not exist and invites the user to press a
 * key that does nothing (WCAG 4.1.2 Name, Role, Value).
 *
 * The other three are unconditional inside a treegrid because a treegrid's rows
 * are a set: `aria-level` without `aria-posinset`/`aria-setsize` leaves a screen
 * reader able to say how deep a row is but not "3 of 7", and a partial set is
 * the case ARIA explicitly calls out as worse than none.
 */
export function treeRowAriaProps(tree: GridTreeRowMeta | null): {
  "aria-level"?: number;
  "aria-posinset"?: number;
  "aria-setsize"?: number;
  "aria-expanded"?: boolean;
} {
  if (tree === null) {
    return {};
  }
  return {
    "aria-level": tree.level,
    "aria-posinset": tree.posInSet,
    "aria-setsize": tree.setSize,
    ...(tree.hasChildren ? { "aria-expanded": tree.isExpanded } : {}),
  };
}

/**
 * Every row id in the tree that owns children, INCLUDING ids inside collapsed
 * subtrees.
 *
 * Collapsed descendants are deliberately in scope: this is the bound applied to
 * the expansion set, and pruning to the VISIBLE rows instead would forget a
 * grandchild's open state the moment its parent closed, so re-opening a parent
 * would silently collapse everything under it.
 */
export function collectExpandableRowIds<T>({
  getChildren,
  getRowId,
  items,
}: {
  items: readonly T[];
  getRowId: (item: T) => string;
  getChildren: (item: T) => readonly T[] | undefined;
}): Set<string> {
  const expandable = new Set<string>();
  appendExpandableRowIds({
    expandable,
    getChildren,
    getRowId,
    items,
    visited: new Set<string>(),
  });
  return expandable;
}

/**
 * The expansion set after one toggle, bounded to the rows that can actually
 * hold one.
 *
 * The bound is the point. The set is long-lived component state fed by user
 * toggles against whatever data is mounted at the time, so a session that pages
 * or filters through thousands of rows would otherwise accumulate an id per row
 * ever opened and never release one. Intersecting with the ids the CURRENT tree
 * can expand caps it at the mounted data, and does so on every write rather than
 * on a sweep that could be skipped.
 */
export function nextExpandedRowIds({
  expandableRowIds,
  expanded,
  previous,
  rowId,
}: {
  previous: ReadonlySet<string>;
  rowId: string;
  expanded: boolean;
  expandableRowIds: ReadonlySet<string>;
}): Set<string> {
  const next = new Set<string>();
  for (const id of previous) {
    if (expandableRowIds.has(id)) {
      next.add(id);
    }
  }
  if (expanded) {
    next.add(rowId);
  } else {
    next.delete(rowId);
  }
  return next;
}

/**
 * A flattener whose cycle guard spans EVERY list it is handed — one walk's
 * worth of state, for a body assembled from more than one sibling list.
 *
 * whitlockk review: a grouped body paints a band at a time, and a bare
 * {@link flattenRenderRows} guards for the length of ONE call, so an id
 * appearing in two bands painted twice. Two rows under one id compose the same
 * cell keys, and a key is the grid's whole identity for a cell: it put two cells
 * at `tabIndex={0}` — the single-tab-stop contract broken — while every row
 * lookup resolved to whichever copy the scan reached first. Threading one guard
 * across the bands restores this module's stated contract, that a repeated id
 * paints once at the first place it legitimately appeared, for a grouped body
 * too, and it keeps the set arithmetic honest with it: the dropped row stops
 * consuming an `aria-posinset` in the band that repeated it.
 *
 * One per PASS, not per render. A component that walks the same rows twice
 * before returning must take a flattener for each walk, or the second finds
 * every id visited and paints an empty body.
 *
 * So a started walk never crosses a component boundary as a prop (ISS-10335):
 * React owns how many times it invokes a body for one commit, and the second
 * invocation of a body holding a spent walk paints nothing. Pass THIS function
 * and start the walk where the rows are built.
 */
export function createSiblingFlattener<T>({
  expandedRowIds,
  getChildren,
  getRowId,
}: {
  getRowId: (item: T) => string;
  getChildren?: (item: T) => readonly T[] | undefined;
  expandedRowIds?: ExpandedRowLookup;
}): (items: readonly T[]) => GridRenderRow<T>[] {
  const visited = new Set<string>();
  return (items: readonly T[]) =>
    flattenRenderRows({
      expandedRowIds,
      getChildren,
      getRowId,
      items,
      visited,
    });
}

/** Shared empty set, so the flat path allocates nothing per render. */
const EMPTY_ROW_IDS: ReadonlySet<string> = new Set<string>();

/**
 * Walk one sibling set into `rows`.
 *
 * `visited` is a cycle guard, not an optimisation. `getChildren` is caller
 * data — a malformed lineage where a row is its own ancestor is reachable at
 * runtime — and an unguarded walk on one recurses until the stack dies, taking
 * the whole render with it. Skipping a repeat id degrades a corrupt tree to a
 * finite one instead, which is the graceful half of the bad-data contract; the
 * row is still painted once, at the first place it legitimately appeared.
 */
function appendTreeRows<T>({
  expandedRowIds,
  getChildren,
  getRowId,
  items,
  level,
  rows,
  visited,
}: {
  items: readonly T[];
  getRowId: (item: T) => string;
  getChildren: (item: T) => readonly T[] | undefined;
  expandedRowIds: ExpandedRowLookup;
  level: number;
  rows: GridRenderRow<T>[];
  visited: Set<string>;
}): void {
  // The siblings that will actually PAINT, resolved before any of the set
  // arithmetic below. A row the guard drops must not keep consuming an
  // `aria-posinset` or counting toward `aria-setsize`: siblings `[x, dup, z]`
  // whose middle id was already visited would otherwise publish "1 of 3" and
  // "3 of 3" with no row 2 anywhere — telling a screen-reader user there is a
  // row to find that no amount of navigating will reach. The guard's job is to
  // make a corrupt lineage finite, not to leave a set describing rows that are
  // not there.
  const siblings: { item: T; rowId: string }[] = [];
  for (const item of items) {
    const rowId = getRowId(item);
    if (visited.has(rowId)) {
      continue;
    }
    visited.add(rowId);
    siblings.push({ item, rowId });
  }
  const setSize = siblings.length;
  for (const [index, { item, rowId }] of siblings.entries()) {
    const children = getChildren(item) ?? [];
    const hasChildren = children.length > 0;
    const isExpanded = hasChildren && expandedRowIds.has(rowId);
    rows.push({
      item,
      rowId,
      tree: { hasChildren, isExpanded, level, posInSet: index + 1, setSize },
    });
    if (isExpanded) {
      appendTreeRows({
        expandedRowIds,
        getChildren,
        getRowId,
        items: children,
        level: level + 1,
        rows,
        visited,
      });
    }
  }
}

/** The {@link collectExpandableRowIds} walk, same cycle guard, ignoring state. */
function appendExpandableRowIds<T>({
  expandable,
  getChildren,
  getRowId,
  items,
  visited,
}: {
  items: readonly T[];
  getRowId: (item: T) => string;
  getChildren: (item: T) => readonly T[] | undefined;
  expandable: Set<string>;
  visited: Set<string>;
}): void {
  for (const item of items) {
    const rowId = getRowId(item);
    if (visited.has(rowId)) {
      continue;
    }
    visited.add(rowId);
    const children = getChildren(item) ?? [];
    if (children.length === 0) {
      continue;
    }
    expandable.add(rowId);
    appendExpandableRowIds({
      expandable,
      getChildren,
      getRowId,
      items: children,
      visited,
    });
  }
}

/**
 * How the walk asks whether one row is open.
 *
 * Membership, not a set: `.has` is the only thing the walk ever calls, and a
 * `Set` satisfies this structurally, so the internal state keeps passing its own
 * set unchanged. What it buys is the CONTROLLED case — there the answer lives in
 * the host's predicate, and typing this as `ReadonlySet<string>` forced the grid
 * to walk the entire lineage on every render to materialise a set nothing
 * enumerates (marisolashgrove, PR #7325). Nothing bounded is lost: the walk only
 * ever asks about rows it has already reached, so an id the host still calls
 * open cannot paint a row the tree does not contain.
 */
export type ExpandedRowLookup = {
  has: (rowId: string) => boolean;
};
