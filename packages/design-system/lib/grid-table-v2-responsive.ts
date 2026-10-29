import { fitGridTemplateToWholeColumns } from "@closedloop-ai/design-system/lib/column-fold";
import { CARD_FALLBACK_BREAKPOINT } from "@closedloop-ai/design-system/lib/column-order";
import { resolveGridColumnTracks } from "@closedloop-ai/design-system/lib/grid-table-aria";
import {
  PINNED_LEAD_UTILITY_TRACK_WIDTH,
  resolveLeadingUtilityPinOffset,
} from "@closedloop-ai/design-system/lib/grid-table-pin";
import type {
  GridTableV2Group,
  GridTableV2Mode,
} from "@closedloop-ai/design-system/lib/grid-table-v2-types";

/** The single flexible track used by the canonical phone-width list. */
export const GRID_TABLE_V2_NARROW_TEMPLATE = "minmax(0, 1fr)";
/** Largest CSS viewport width painted as the canonical one-column list. */
export const GRID_TABLE_V2_NARROW_VIEWPORT_MAX_WIDTH =
  CARD_FALLBACK_BREAKPOINT - 1;
/** Asana's List view switches from columns using the viewport, not a pane. */
export const GRID_TABLE_V2_NARROW_VIEWPORT_QUERY = `(max-width: ${GRID_TABLE_V2_NARROW_VIEWPORT_MAX_WIDTH}px)`;

/** Resolves the explicit layout override before the viewport-aware default. */
export function isGridTableV2NarrowMode(
  mode: GridTableV2Mode,
  isNarrowViewport: boolean
): boolean {
  return mode === "compact" || (mode === "auto" && isNarrowViewport);
}

/**
 * Resolves the one layout description consumed by both the header and rows.
 * Narrow mode removes every non-identity track instead of mounting a second
 * renderer, keeping the grid's focus, grouping, hierarchy, and ARIA model.
 */
export function resolveGridTableV2Layout<TColumn>({
  bodyHasLeadingUtility,
  bodyUtilityInWide = true,
  columns,
  foldFitWidth,
  gridTemplateColumns,
  hasTrailingTrack,
  headerHasLeadingUtility,
  isContainerMeasured,
  isNarrowViewport,
  mode,
  pinLeadColumn,
  snapFoldToColumns,
}: {
  bodyHasLeadingUtility: boolean;
  bodyUtilityInWide?: boolean;
  columns: readonly TColumn[];
  foldFitWidth: number;
  gridTemplateColumns: string;
  hasTrailingTrack: boolean;
  headerHasLeadingUtility: boolean;
  isContainerMeasured: boolean;
  isNarrowViewport: boolean;
  mode: GridTableV2Mode;
  pinLeadColumn: boolean;
  snapFoldToColumns: boolean;
}) {
  const isNarrow = isGridTableV2NarrowMode(mode, isNarrowViewport);
  const renderedColumns = isNarrow ? [] : columns;
  const paintsBodyUtility =
    bodyHasLeadingUtility && (isNarrow || bodyUtilityInWide);
  const paintsHeaderUtility = !isNarrow && headerHasLeadingUtility;
  // A phone row keeps its utility inside the Name cell so the ARIA projection
  // remains one column while controls such as Favorite stay reachable.
  const hasLeadingUtilityTrack =
    !isNarrow && (paintsBodyUtility || headerHasLeadingUtility);
  const rendersTrailingTrack = !isNarrow && hasTrailingTrack;
  // ISS-9564: resolve the leading tracks once and hand the same description to
  // the header and every row. Deriving indices from the nodes each half happens
  // to render lets header and body disagree when a utility cell is present in
  // only one of them, so their ARIA column indices would describe two grids.
  const tracks = resolveGridColumnTracks({
    dataColumnCount: renderedColumns.length,
    hasLeadingUtility: hasLeadingUtilityTrack,
    hasTrailingTrack: rendersTrailingTrack,
  });
  let renderedGridTemplateColumns = hasLeadingUtilityTrack
    ? `${PINNED_LEAD_UTILITY_TRACK_WIDTH} ${GRID_TABLE_V2_NARROW_TEMPLATE}`
    : GRID_TABLE_V2_NARROW_TEMPLATE;
  if (!isNarrow) {
    // ISS-4889 widens the identity track so the resting fold lands on a whole
    // column. It runs only after a real measurement to avoid an SSR correction.
    renderedGridTemplateColumns =
      snapFoldToColumns && isContainerMeasured
        ? fitGridTemplateToWholeColumns(
            gridTemplateColumns,
            foldFitWidth,
            hasLeadingUtilityTrack ? 1 : 0
          )
        : gridTemplateColumns;
  }
  const pinsLeadColumn = !isNarrow && pinLeadColumn;
  const utilityColumnPinned = pinsLeadColumn && paintsBodyUtility;
  return {
    hasLeadingUtilityTrack,
    isNarrow,
    paintsBodyUtility,
    paintsHeaderUtility,
    // ISS-9223: the utility owns left:0; the identity starts after its rendered
    // track so neither a gap nor an overlap can expose scrolling columns.
    pinnedIdentityLeft: utilityColumnPinned
      ? resolveLeadingUtilityPinOffset(renderedGridTemplateColumns)
      : undefined,
    pinsLeadColumn,
    renderedColumns,
    renderedGridTemplateColumns,
    rendersTrailingTrack,
    tracks,
    utilityColumnPinned,
  } as const;
}

/**
 * Whether the current data population contains a selected row, including rows
 * hidden by a collapsed group or tree disclosure. Touch tap selection must stay
 * active while those rows are hidden without becoming a reconciliation owner.
 */
export function hasSelectedGridTableV2Row<T>({
  getChildren,
  getRowId,
  groups,
  isRowSelected,
  items,
}: {
  getChildren?: (item: T) => readonly T[] | undefined;
  getRowId: (item: T) => string;
  groups?: readonly GridTableV2Group<T>[];
  isRowSelected?: (item: T) => boolean;
  items: readonly T[];
}): boolean {
  if (!isRowSelected) {
    return false;
  }
  const pending = groups ? collectGroupItems(groups) : [...items];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) {
      continue;
    }
    const rowId = getRowId(item);
    if (visited.has(rowId)) {
      continue;
    }
    visited.add(rowId);
    if (isRowSelected(item)) {
      return true;
    }
    const children = getChildren?.(item);
    if (children) {
      pending.push(...children);
    }
  }
  return false;
}

/** Finds a row in the current flat, grouped, or nested population by identity. */
export function findGridTableV2Row<T>({
  getChildren,
  getRowId,
  groups,
  items,
  rowId,
}: {
  getChildren?: (item: T) => readonly T[] | undefined;
  getRowId: (item: T) => string;
  groups?: readonly GridTableV2Group<T>[];
  items: readonly T[];
  rowId: string;
}): T | undefined {
  const pending = groups ? collectGroupItems(groups) : [...items];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) {
      continue;
    }
    const itemId = getRowId(item);
    if (visited.has(itemId)) {
      continue;
    }
    visited.add(itemId);
    if (itemId === rowId) {
      return item;
    }
    const children = getChildren?.(item);
    if (children) {
      pending.push(...children);
    }
  }
  return undefined;
}

function collectGroupItems<T>(groups: readonly GridTableV2Group<T>[]): T[] {
  const result: T[] = [];
  const pending = [...groups];
  while (pending.length > 0) {
    const group = pending.pop();
    if (group === undefined) {
      continue;
    }
    result.push(...group.items);
    if (group.subgroups) {
      pending.push(...group.subgroups);
    }
  }
  return result;
}
