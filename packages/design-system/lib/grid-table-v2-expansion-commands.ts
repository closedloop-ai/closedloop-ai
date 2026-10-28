/**
 * `GridTableV2`'s row-expansion commands (ISS-8921): the one writer of a row's
 * open state, and the keyboard handlers that reach it.
 *
 * Lifted out of `grid-table-v2.tsx` beside its render seams (marisolashgrove
 * review). It is one responsibility — "open and close a row, controlled or not"
 * — and it has no DOM and no React runtime beyond the setter it is handed, so it
 * is unit-testable without rendering a table, the same reason its
 * `grid-table-v2-rows` and `grid-table-v2-tree` siblings sit here.
 */

import type { Dispatch, SetStateAction } from "react";
import type { GridRowExpansionHandlers } from "./grid-cell-keyboard";
import { collectRenderedGroupItems } from "./grid-table-v2-rows";
import {
  collectExpandableRowIds,
  type ExpandedRowLookup,
  nextExpandedRowIds,
} from "./grid-table-v2-tree";
import type { GridTableV2Group } from "./grid-table-v2-types";

/** "No band is closed", for the traversal that wants every band's roots. */
const NO_COLLAPSED_GROUPS: ReadonlySet<string> = new Set<string>();

export function createGridRowExpansionCommands<T>({
  expandedRowIds,
  findRenderedItem,
  getChildren,
  getRowId,
  groups,
  items,
  onRowExpandedChange,
  rowExpansion,
  setInternalExpandedRowIds,
}: {
  expandedRowIds: ExpandedRowLookup;
  findRenderedItem: (rowId: string) => T | undefined;
  getChildren?: (item: T) => readonly T[] | undefined;
  getRowId: (item: T) => string;
  groups?: readonly GridTableV2Group<T>[];
  items: readonly T[];
  onRowExpandedChange?: (item: T, expanded: boolean) => void;
  /** The host's own expansion set, when it holds one. */
  rowExpansion?: { setExpanded: (rowId: string, expanded: boolean) => void };
  setInternalExpandedRowIds: Dispatch<SetStateAction<Set<string>>>;
}): {
  expansionKeys: GridRowExpansionHandlers | undefined;
  setRowExpanded: (rowId: string, expanded: boolean) => void;
} {
  const setRowExpanded = (rowId: string, expanded: boolean) => {
    if (!getChildren) {
      return;
    }
    if (rowExpansion) {
      // The host holds the set, so it owns the bound too — pruning a value this
      // component does not store is not something it can do on the host's
      // behalf.
      rowExpansion.setExpanded(rowId, expanded);
    } else {
      // The roots the internal expansion set is bounded against: every band's
      // items, INCLUDING bands the user has collapsed. A collapsed band's rows
      // keep their own open state, so pruning to the visible roots would
      // silently close every subtree inside a band the moment the band itself
      // was closed.
      //
      // Routed through the SAME band traversal the body renders with, given an
      // empty collapsed set — which is exactly "every band, nothing hidden". A
      // second copy of the subgroups-replace-their-parent rule would drift
      // silently: the two sets feed different consumers (this one bounds
      // expansion, that one decides what paints), so a divergence would prune
      // ids for rows that are on screen and collapse a user's open subtrees on
      // the next unrelated toggle.
      //
      // Inside the setter, not at render scope: this is the only branch that
      // needs it, and only the branch where this component holds the set.
      const lineageRootItems: readonly T[] = groups
        ? collectRenderedGroupItems(groups, NO_COLLAPSED_GROUPS)
        : items;
      setInternalExpandedRowIds((previous) =>
        nextExpandedRowIds({
          expandableRowIds: collectExpandableRowIds({
            getChildren,
            getRowId,
            items: lineageRootItems,
          }),
          expanded,
          previous,
          rowId,
        })
      );
    }
    const item = findRenderedItem(rowId);
    if (item) {
      onRowExpandedChange?.(item, expanded);
    }
  };
  // Undefined for a caller with no child accessor, which is what leaves
  // `ArrowLeft`/`ArrowRight` their plain column meaning on every existing grid —
  // the same "not my key" convention `selectionKeys` uses.
  const expansionKeys: GridRowExpansionHandlers | undefined = getChildren
    ? {
        canExpandRow: (rowId: string) => {
          const item = findRenderedItem(rowId);
          return item !== undefined && (getChildren(item)?.length ?? 0) > 0;
        },
        isRowExpanded: (rowId: string) => expandedRowIds.has(rowId),
        setRowExpanded,
      }
    : undefined;
  return { expansionKeys, setRowExpanded };
}
