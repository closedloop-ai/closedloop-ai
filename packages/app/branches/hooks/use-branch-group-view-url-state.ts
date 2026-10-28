"use client";

import {
  EMPTY_TABLE_COLLAPSED_GROUPS,
  overlayLinkedCollapsedGroups,
  type TableCollapsedGroups,
} from "@repo/app/shared/lib/table-collapsed-groups";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { useCallback, useRef, useState } from "react";
import {
  type BranchGroupViewParams,
  writeBranchGroupViewParams,
} from "../lib/branch-filter-params";
import type { BranchAppliedArrangement } from "../lib/branch-saved-views";

/**
 * The persisted half of the grouping view: `useBranchViewState`'s grouping,
 * collapse state, their setters, and the arrangement apply.
 */
export type BranchGroupViewSource = {
  applyArrangement: (arrangement: BranchAppliedArrangement) => void;
  collapsedGroups: TableCollapsedGroups;
  grouping: TableGroupingState;
  setCollapsedGroups: (collapsedGroups: TableCollapsedGroups) => void;
  setGrouping: (grouping: TableGroupingState) => void;
};

/**
 * ISS-9582: the grouping axis and band collapse a Branches list SHOWS — what the
 * opening link stated, over what the reader's saved view restored.
 *
 * Same precedence as `statedPageSize` in `useUrlSyncedBranchServerState`, which
 * is the only caller: a link states the view it was copied from, so it wins over
 * the recipient's stored view for the visit. Stating is not persisting — the
 * link reaches the saved view only when the reader changes the grouping or a
 * band, and that gesture writes the whole view they are looking at.
 *
 * This hook never touches the URL. Every list-URL write in this domain has to
 * re-assert the facets, the page and the page size from state in ONE
 * `replace`, because a second writer starts from a snapshot that may not hold
 * the first one's change yet (the ISS-4728 trap). So it hands out
 * `writeViewParams`, and the caller runs it inside its own replaces.
 *
 * No feature flag is read here. The Group controls and the bands are gated by
 * `branches-list-column-controls` in the surface; with it closed nothing renders
 * a band, so a stated grouping has nothing to act on and only rides along in the
 * URL. Deciding here instead would decide on a flag that may not have answered
 * yet, on the one visit a shared link exists for.
 */
export function useBranchGroupViewUrlState(
  linked: BranchGroupViewParams | null,
  source: BranchGroupViewSource | undefined
) {
  // `null` once the reader acts or applies a view: from then on the saved view
  // holds what is on screen. Without a saved view behind the list (a unit mount)
  // it is also where gestures land, so the controls still work.
  const [stated, setStated] = useState<BranchGroupViewParams | null>(linked);
  const grouping = stated?.grouping ?? source?.grouping ?? EMPTY_TABLE_GROUPING;
  const collapsedGroups = stated
    ? overlayLinkedCollapsedGroups(
        source?.collapsedGroups ?? EMPTY_TABLE_COLLAPSED_GROUPS,
        stated
      )
    : (source?.collapsedGroups ?? EMPTY_TABLE_COLLAPSED_GROUPS);

  // Assigned every render, so a view that restores AFTER mount is what the next
  // page or filter write carries. The handlers below also set it before they
  // return, because their caller's replace runs before the next render.
  const latest = useRef({ collapsedGroups, grouping });
  latest.current = { collapsedGroups, grouping };

  const commit = useCallback(
    (next: BranchGroupViewParams) => {
      latest.current = next;
      if (source) {
        setStated(null);
        source.setGrouping(next.grouping);
        source.setCollapsedGroups(next.collapsedGroups);
        return;
      }
      setStated(next);
    },
    [source]
  );

  const setGrouping = useCallback(
    (next: TableGroupingState) =>
      commit({
        collapsedGroups: latest.current.collapsedGroups,
        grouping: next,
      }),
    [commit]
  );

  const setCollapsedGroups = useCallback(
    (next: TableCollapsedGroups) =>
      commit({ collapsedGroups: next, grouping: latest.current.grouping }),
    [commit]
  );

  // A named view (or the default) replaces what is on screen, the link's
  // statement included. The caller's filter apply runs next and carries these
  // params in its own replace.
  const applyArrangement = useCallback(
    (arrangement: BranchAppliedArrangement) => {
      const next = {
        collapsedGroups: arrangement.collapsedGroups,
        grouping: arrangement.grouping,
      };
      latest.current = next;
      if (source) {
        setStated(null);
        source.applyArrangement(arrangement);
        return;
      }
      setStated(next);
    },
    [source]
  );

  const writeViewParams = useCallback((params: URLSearchParams) => {
    writeBranchGroupViewParams(
      params,
      latest.current.grouping,
      latest.current.collapsedGroups
    );
  }, []);

  return {
    applyArrangement,
    collapsedGroups,
    grouping,
    setCollapsedGroups,
    setGrouping,
    writeViewParams,
  };
}
