/**
 * Which rows a `GridTableV2` body actually paints, and the keys its roving
 * tabindex names them by.
 *
 * Extracted from `grid-table-v2.tsx` for the reason `grid-table-navigation` was
 * extracted before it: these are pure data helpers with no React and no DOM, so
 * they are unit-testable without rendering a table, and the component file is
 * held against a hard 1,000-line ceiling that every new prop eats into.
 *
 * `GridTableV2Group` comes from the sibling `grid-table-v2-types`, which owns
 * the component's public contract, so this module takes no edge — runtime or
 * type — back to the component it was lifted out of.
 */

import {
  createSiblingFlattener,
  type ExpandedRowLookup,
  type GridRenderRow,
} from "@closedloop-ai/design-system/lib/grid-table-v2-tree";
import type { GridTableV2Group } from "@closedloop-ai/design-system/lib/grid-table-v2-types";

/** Separator between a row id and a column id in a roving-tabindex cell key. */
const CELL_KEY_SEPARATOR = "::";
/** Separator between a group key and its subgroup key in a collapse key. */
const GROUP_KEY_SEPARATOR = "/";
/** Column-key stand-in for the fixed leading identity cell. */
export const LEAD_CELL_COLUMN_KEY = "__lead__";
/** Column-key stand-in for the optional leading utility cell before it. */
export const UTILITY_CELL_COLUMN_KEY = "__utility__";
/**
 * The leading identity cell's `data-column-id`.
 *
 * Deliberately NOT {@link LEAD_CELL_COLUMN_KEY}, which is the roving-tabindex
 * key: the two carry different strings and mean different things, and collapsing
 * them would change what a persisted cell key resolves to. This is the one a
 * caller matches on to find the identity column in the DOM, and it had been a
 * bare literal at four sites in `table-grid-header-v2.tsx` plus a private copy in
 * every test that reads it.
 */
export const LEADING_COLUMN_DATA_ID = "__leading__";

/**
 * The roving-tabindex key of one DATA row's cell.
 *
 * The leading domain tag is what keeps a caller's row id from ever colliding
 * with an after-row's: a data row whose id happens to equal an after-row
 * sentinel would otherwise compose the same key, and a key is the grid's whole
 * identity for a cell — two cells answering to one key are two cells at
 * `tabIndex={0}`, which is the single-tab-stop contract broken. The tag sits in
 * the FIRST segment, where no row id can reach it, so the separation is
 * structural rather than a prefix a row id could mimic.
 */
export function buildCellKey(rowId: string, columnKey: string): string {
  return buildDomainCellKey(DATA_ROW_KEY_DOMAIN, rowId, columnKey);
}

/** The same, for a row painted into one of the grid's after-row slots. */
export function buildAfterRowCellKey(
  rowId: string,
  columnKey: string
): string {
  return buildDomainCellKey(AFTER_ROW_KEY_DOMAIN, rowId, columnKey);
}

/**
 * The same, for one of the grid's CHROME rows — the column-header row and the
 * group-section headers (ISS-8930). A third domain rather than a third prefix
 * for the reason the second one exists: a caller's row id lives in the SECOND
 * segment and can never reach the first, so a data row cannot compose a chrome
 * cell's key however it is named.
 */
export function buildChromeCellKey(
  rowId: string,
  columnKey: string
): string {
  return buildDomainCellKey(CHROME_ROW_KEY_DOMAIN, rowId, columnKey);
}

/**
 * The key a nested subgroup is collapsed under. Composed here, beside the cell
 * key, because it has THREE call sites that must agree: the two group headers
 * that WRITE it into `collapsedGroups`, and the reader below that decides
 * whether the subgroup's rows were painted.
 *
 * Keeping the reader in this module while the writers stayed in the component
 * is what made a shared helper necessary rather than merely tidy: a separator
 * changed on the writing side alone would leave the reader silently failing to
 * recognise a collapsed subgroup, and `collectRenderedGroupItems` now feeds
 * `onSelectAllRows` — so the drift would hand a host rows the user cannot see
 * rather than merely widening a lookup that tolerated it.
 */
export function buildSubgroupKey(
  groupKey: string,
  subgroupKey: string
): string {
  return `${groupKey}${GROUP_KEY_SEPARATOR}${subgroupKey}`;
}

/**
 * The items a grouped body actually paints, in visible order. Mirrors the body
 * render exactly: a COLLAPSED group (or subgroup) contributes nothing, and a
 * group with `subgroups` paints its subgroups' items rather than its own.
 *
 * `expandSiblings` is applied to each band's item list the way the body applies
 * it at the render site — it is how parent/child lineage (ISS-8921) reaches a
 * grouped body, where the two hierarchies compose: grouping decides which
 * ROOTS are visible, then lineage expands each root's open descendants beneath
 * it. Absent, it is the identity, so a caller that supplied no child accessor
 * gets exactly the list it always did.
 */
export function collectRenderedGroupItems<T>(
  groups: readonly GridTableV2Group<T>[],
  collapsedGroups: ReadonlySet<string>,
  expandSiblings?: (items: readonly T[]) => readonly T[]
): T[] {
  return collectRenderedGroupValues(
    groups,
    collapsedGroups,
    expandSiblings ?? identitySiblings
  );
}

/**
 * Every roving-tabindex key the DATA rows of one render emit, in visible order.
 *
 * Exact by construction: it is derived from the items that PAINTED, which is
 * what lets the grid tell a remembered cell that is still on screen from one
 * whose row has gone (`grid-table-v2.tsx`'s staleness fallback). On a windowed
 * body those are the window's items rather than the whole population, for the
 * same reason — a key no painted cell answers to takes the grid out of the tab
 * order.
 */
export function collectRenderedCellKeys<T>({
  dataColumnIds,
  getRowId,
  hasLeadingUtility,
  renderedItems,
}: {
  dataColumnIds: readonly string[];
  getRowId: (item: T) => string;
  hasLeadingUtility: boolean;
  renderedItems: readonly T[];
}): string[] {
  return renderedItems.flatMap((item) => {
    const rowId = getRowId(item);
    const rowKeys = [
      buildCellKey(rowId, LEAD_CELL_COLUMN_KEY),
      ...dataColumnIds.map((columnId) => buildCellKey(rowId, columnId)),
    ];
    if (hasLeadingUtility) {
      rowKeys.unshift(buildCellKey(rowId, UTILITY_CELL_COLUMN_KEY));
    }
    return rowKeys;
  });
}

/**
 * Domain tags leading every cell key. Values are opaque — a key is only ever
 * compared for equality, never parsed — so what matters is that the two differ
 * and that neither is reachable from a caller-supplied row id.
 */
const DATA_ROW_KEY_DOMAIN = "data";
const AFTER_ROW_KEY_DOMAIN = "after";
const CHROME_ROW_KEY_DOMAIN = "chrome";

function buildDomainCellKey(
  domain: string,
  rowId: string,
  columnKey: string
): string {
  return `${domain}${CELL_KEY_SEPARATOR}${rowId}${CELL_KEY_SEPARATOR}${columnKey}`;
}

/** The default `expandSiblings`: a band with no lineage paints its own items. */
function identitySiblings<T>(items: readonly T[]): readonly T[] {
  return items;
}

/**
 * The number one band's header may state (ISS-4704, ISS-9335).
 *
 * Three inputs, three answers, resolved HERE because the group header and the
 * subgroup header both ask and a second copy would drift: counts switched off,
 * no number; a band that DECLARED one, that declaration — including a
 * deliberate `null`, which is a host saying it cannot state a population and
 * must not be read as "nothing declared"; nothing declared at all, the band's
 * own rows, which for an unpaged host ARE the population.
 */
export function resolveGroupCount<T>(
  group: GridTableV2Group<T>,
  showGroupCounts: boolean
): number | undefined {
  if (!showGroupCounts) {
    return undefined;
  }
  if (group.count !== undefined) {
    return group.count ?? undefined;
  }
  return group.items.length;
}

/**
 * The collapsed-key set a host-owned collapse port implies for THIS render
 * (ISS-9335) — every band and subgroup key the host answers `true` for.
 *
 * Materialised as a set rather than threaded as a predicate because a set is
 * what the grid's own bookkeeping already consumes
 * ({@link collectRenderedGroupItems}, `collectGroupHeaderRowIds`,
 * `resolveAfterRows`), so a controlled host and an uncontrolled one reach every
 * one of those through the identical value and cannot diverge on what
 * "collapsed" means.
 *
 * Subgroup keys take the composed {@link buildSubgroupKey} form, which is the
 * key the header writes and the reader compares.
 */
export function collectCollapsedGroupKeys<T>(
  groups: readonly GridTableV2Group<T>[] | undefined,
  isCollapsed: (groupKey: string) => boolean
): Set<string> {
  const collapsed = new Set<string>();
  for (const group of groups ?? []) {
    if (isCollapsed(group.key)) {
      collapsed.add(group.key);
    }
    for (const subgroup of group.subgroups ?? []) {
      const subgroupKey = buildSubgroupKey(group.key, subgroup.key);
      if (isCollapsed(subgroupKey)) {
        collapsed.add(subgroupKey);
      }
    }
  }
  return collapsed;
}

/** Preserve the renderer's band boundaries and retained lineage in one fresh guarded pass. */
export function collectRenderedGroupRows<T>({
  collapsedGroups,
  expandedRowIds,
  getChildren,
  getRowId,
  groups,
}: {
  collapsedGroups: ReadonlySet<string>;
  expandedRowIds?: ExpandedRowLookup;
  getChildren?: (item: T) => readonly T[] | undefined;
  getRowId: (item: T) => string;
  groups: readonly GridTableV2Group<T>[];
}): GridRenderRow<T>[] {
  return collectRenderedGroupValues(
    groups,
    collapsedGroups,
    createSiblingFlattener({ expandedRowIds, getChildren, getRowId })
  );
}

function collectRenderedGroupValues<T, Value>(
  groups: readonly GridTableV2Group<T>[],
  collapsedGroups: ReadonlySet<string>,
  expandSiblings: (items: readonly T[]) => readonly Value[]
): Value[] {
  const rendered: Value[] = [];
  for (const group of groups) {
    if (collapsedGroups.has(group.key)) {
      continue;
    }
    if (group.subgroups) {
      for (const subgroup of group.subgroups) {
        if (!collapsedGroups.has(buildSubgroupKey(group.key, subgroup.key))) {
          rendered.push(...expandSiblings(subgroup.items));
        }
      }
    } else {
      rendered.push(...expandSiblings(group.items));
    }
  }
  return rendered;
}

/** The collapse set and state produced by toggling one group key. */
export function nextCollapsedGroupKeys(
  current: ReadonlySet<string>,
  key: string
): { collapsed: boolean; keys: Set<string> } {
  const keys = new Set(current);
  const collapsed = !keys.has(key);
  if (collapsed) {
    keys.add(key);
  } else {
    keys.delete(key);
  }
  return { collapsed, keys };
}
