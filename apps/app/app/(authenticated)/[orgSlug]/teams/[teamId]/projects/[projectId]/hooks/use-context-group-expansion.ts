"use client";

import { useCallback, useState } from "react";

/**
 * Layers filter-context force-expansion on top of the persisted group
 * expansion state.
 *
 * `contextExpandedIds` are nodes retained only as context for a matching
 * descendant when a project filter is active — they default to expanded
 * (overriding stored state) so the matching descendant is visible. An explicit
 * user collapse must still win, so collapses on context nodes are tracked in
 * local state rather than the persisted store: the forced-open default only
 * applies while the filter retains the node as context, and writing it through
 * to localStorage would leak filter-session state into the unfiltered view.
 */
export function useContextGroupExpansion({
  contextExpandedIds,
  isGroupExpanded,
  toggleGroup,
}: {
  contextExpandedIds: Set<string>;
  isGroupExpanded: (key: string) => boolean;
  toggleGroup: (key: string) => void;
}) {
  const [collapsedContextIds, setCollapsedContextIds] = useState<Set<string>>(
    new Set()
  );

  const isTreeGroupExpanded = useCallback(
    (key: string) => {
      if (contextExpandedIds.has(key)) {
        return !collapsedContextIds.has(key);
      }
      return isGroupExpanded(key);
    },
    [contextExpandedIds, collapsedContextIds, isGroupExpanded]
  );

  const toggleTreeGroup = useCallback(
    (key: string) => {
      if (contextExpandedIds.has(key)) {
        setCollapsedContextIds((prev) => {
          const next = new Set(prev);
          if (next.has(key)) {
            next.delete(key);
          } else {
            next.add(key);
          }
          return next;
        });
        return;
      }
      toggleGroup(key);
    },
    [contextExpandedIds, toggleGroup]
  );

  return { isTreeGroupExpanded, toggleTreeGroup };
}
