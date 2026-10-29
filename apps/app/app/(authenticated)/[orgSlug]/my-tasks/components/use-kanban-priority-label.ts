"use client";

import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { priorityLabel } from "@repo/design-system/lib/priority-order";

/** What a board card renders in its priority chip; `undefined` means no chip. */
export type KanbanPriorityLabel = (
  priority: DocumentRowData["priority"]
) => string | undefined;

/**
 * The board's ONE read of the priority-surfaces gate (ISS-9094).
 *
 * WHY A RESOLVER AND NOT A BOOLEAN. `no-threaded-feature-flag` wants the key
 * read once, in the module that swaps on it, with the boolean never leaving
 * that module — and it reports a key read TWICE in one module for the same
 * reason, since two reads can settle at different moments and leave the module
 * holding two answers. The board has two card components that both need the
 * decision, so neither "read it in each card" (two reads, one module) nor
 * "read it in the board and pass it down" (a threaded boolean) is available.
 * Reading it HERE and handing out the resolved shape is the remedy the rule
 * names: a second module reading the key is the fix, not a second violation.
 *
 * `…Optional` because the board mounts in tests with no flag provider, where
 * this must resolve closed rather than throw.
 *
 * AN UNSET PRIORITY GETS NO CHIP, either way. `priorityLabel` answers
 * "No priority" for a null and `KanbanArtifactCard` renders any truthy label
 * as an accent Chip, so labelling an unset priority would grow a chip on
 * exactly the rows with nothing to say, and only once the gate opened.
 * `priorityLabel`'s own docstring reserves those words for menus and group
 * headers; a grid cell renders the empty value instead, and a board card is
 * that cell's neighbour here.
 *
 * Gate closed, a set priority passes through as the raw enum member, which is
 * what the board printed before this ticket.
 */
export function useKanbanPriorityLabel(): KanbanPriorityLabel {
  const labelPriority = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY
  );

  return (priority) => {
    if (!priority) {
      return undefined;
    }
    return labelPriority ? priorityLabel(priority) : priority;
  };
}
