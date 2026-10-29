"use client";

import {
  TableBulkActionBar,
  TableBulkActionButton,
  TableSelectionAnnouncer,
} from "@repo/design-system/components/ui/table-bulk-action-bar";
import {
  type TableBulkActionDescriptor,
  TableBulkActionLifecycle,
  TableBulkActions,
  type TableBulkSelectionControls,
} from "@repo/design-system/components/ui/table-bulk-actions";
import { useIsomorphicLayoutEffect } from "@repo/design-system/hooks/use-isomorphic-layout-effect";
import { type CountNoun, pluralize } from "@repo/design-system/lib/count-noun";
import { XIcon } from "lucide-react";
import { useRef } from "react";

/**
 * The artifact bulk rail, and the live region that tells a screen-reader user
 * what is selected.
 *
 * WHY EVERY ACTION ARRIVES AS A DESCRIPTOR (ISS-9329 AC2). This used to hold a
 * private three-action list — favourite, assign owner, clear — so a host could
 * not add an operation without editing this file, while the repo's two other
 * production bars already spoke `TableBulkActionDescriptor`. A third private
 * vocabulary is the thing the shared model exists to stop.
 *
 * WHY EACH CONTROL IS ITS OWN TAB STOP. APG's toolbar pattern makes a group of
 * controls ONE tab stop with arrow keys inside it, which is right for a dense
 * always-present strip. This bar is neither: it appears only when a selection
 * exists, and it is what a keyboard user Tabs to straight out of the grid.
 * Keeping each control its own tab stop is APG's own carve-out for a small
 * toolbar, and it is what keeps every action reachable without a pointer —
 * `TableBulkActions` renders a native `<button>` or a Radix trigger per
 * descriptor.
 */
export function ArtifactBulkActionBar({
  actions,
  getSelectionGeneration,
  minimumSelectedRows = 0,
  noun = ARTIFACT_NOUN,
  onClear,
  onRetainSelection,
  rowIds,
}: {
  actions: readonly TableBulkActionDescriptor[];
  /** Optional for old consumers; shared selection owners expose synchronous resets. */
  getSelectionGeneration?: () => number;
  /** Existing list rails appear at two rows; artifact hosts retain their default. */
  minimumSelectedRows?: number;
  /** The surface's row noun; artifact hosts retain their existing default. */
  noun?: CountNoun;
  onClear: () => void;
  /**
   * Narrow the selection to the rows a partly-successful command did NOT
   * change, so the retry is the same click on what is actually left. The
   * Sessions rail's contract reused rather than a second one invented, and
   * required rather than optional: a host that cannot narrow the selection
   * cannot honestly offer a batch command whose parts fail independently.
   */
  onRetainSelection: (rowIds: readonly string[]) => void;
  rowIds: readonly string[];
}) {
  const selection: TableBulkSelectionControls = {
    clear: onClear,
    retain: onRetainSelection,
    ...(getSelectionGeneration
      ? { getGeneration: getSelectionGeneration }
      : {}),
  };
  const latest = useRef({ actions, rowIds, selection });
  latest.current = { actions, rowIds, selection };
  const previousActions = useRef<readonly TableBulkActionDescriptor[]>([]);
  const previousSelection = useRef<string | undefined>(undefined);
  const selectionKey = JSON.stringify([
    getSelectionGeneration?.(),
    [...rowIds].sort(),
    actions.map((action) => action.id),
  ]);

  useIsomorphicLayoutEffect(() => {
    const next = latest.current;
    const activeIds = new Set(next.actions.map((action) => action.id));
    for (const action of previousActions.current) {
      if (!activeIds.has(action.id)) {
        action.onLifecycle?.({
          kind: TableBulkActionLifecycle.Dispose,
          rowIds: next.rowIds,
          selection: next.selection,
        });
      }
    }
    if (previousSelection.current !== selectionKey) {
      for (const action of next.actions) {
        action.onLifecycle?.({
          kind: TableBulkActionLifecycle.Selection,
          rowIds: next.rowIds,
          selection: next.selection,
        });
      }
    }
    previousActions.current = next.actions;
    previousSelection.current = selectionKey;
  }, [selectionKey]);

  useIsomorphicLayoutEffect(
    () => () => {
      const current = latest.current;
      for (const action of current.actions) {
        action.onLifecycle?.({
          kind: TableBulkActionLifecycle.Dispose,
          rowIds: current.rowIds,
          selection: current.selection,
        });
      }
    },
    []
  );

  if (
    rowIds.length < minimumSelectedRows &&
    !actions.some((action) => action.canRetrySelection?.(rowIds, selection))
  ) {
    return null;
  }
  return (
    <TableBulkActionBar
      actionLabel={selectionSentence(rowIds.length, noun)}
      actions={
        <>
          <TableBulkActions
            actions={actions}
            rowIds={rowIds}
            selection={selection}
          />
          <TableBulkActionButton label="Clear selection" onClick={onClear}>
            <XIcon />
          </TableBulkActionButton>
        </>
      }
    />
  );
}

/**
 * The selected-count announcement, this surface's NOUN over the shared region
 * (ISS-9574). The sentence and the always-mounted rule that makes it audible
 * are `TableSelectionAnnouncer`'s, so the Sessions grid and this one cannot
 * drift into two wordings of the same fact.
 */
export function ArtifactSelectionAnnouncer({ count }: { count: number }) {
  return <TableSelectionAnnouncer count={count} noun={ARTIFACT_NOUN} />;
}

/**
 * What one row on this surface IS. The bar's own label, its hosts' action
 * labels and the shared announcer all read it, so the visible count and the
 * announced one cannot come to disagree about the word.
 */
export const ARTIFACT_NOUN: CountNoun = {
  one: "artifact",
  other: "artifacts",
};

export function selectionSentence(
  count: number,
  noun: CountNoun = ARTIFACT_NOUN
): string {
  return `${count} ${pluralize(noun, count)} selected`;
}
