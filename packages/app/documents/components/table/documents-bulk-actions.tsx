"use client";

import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { TableBulkActions } from "@repo/design-system/components/ui/table-bulk-actions";
import type { CountNoun } from "@repo/design-system/lib/count-noun";
import { useBulkPriorityAction } from "./bulk-priority-picker";
import { useBulkStatusAction } from "./bulk-status-picker";
import { useBulkTagAction } from "./bulk-tag-picker";
import type { DocumentsBulkActionDescriptor } from "./documents-bulk-action-ids";

/**
 * The project table's bulk operations, as ONE ordered descriptor list
 * (ISS-8942).
 *
 * A component rather than a hook called by the view, because each descriptor
 * owns a mutation and a tag read: mounted only while a selection exists, those
 * stay exactly as costly as the two pickers this replaces.
 */
export function DocumentsBulkActions({
  onClear,
  onRetain,
  rowIds,
  selectedRows,
}: {
  onClear: () => void;
  onRetain: (rowIds: readonly string[]) => void;
  rowIds: readonly string[];
  selectedRows: readonly DocumentRowData[];
}) {
  const actions = useDocumentsBulkActionDescriptors(selectedRows, rowIds);
  return (
    <TableBulkActions
      actions={actions}
      rowIds={rowIds}
      selection={{ clear: onClear, retain: onRetain }}
    />
  );
}

/**
 * The project table's mutation descriptors, in order. Exported so the rail host
 * (ISS-9329) renders the SAME list this bar does: two assemblies of these three
 * hooks would be two answers to which mutations the project surface offers, and
 * a flag flip between the bars would silently change the set.
 *
 * The return type is keyed by `DocumentsBulkActionId`, not by bare `string`,
 * because this is the path a new bulk control arrives by: naming it there is
 * what makes the rail host's permission `Record` fail without its rule.
 */
export function useDocumentsBulkActionDescriptors(
  selectedRows: readonly DocumentRowData[],
  rowIds: readonly string[],
  noun?: CountNoun
): readonly DocumentsBulkActionDescriptor[] {
  const statusAction = useBulkStatusAction(selectedRows, rowIds);
  const tagAction = useBulkTagAction(noun);
  // Hooks are unconditional; only the descriptor's presence in the list is
  // gated, so the closed-flag bar renders exactly the two actions it does today.
  const priorityAction = useBulkPriorityAction();
  const priorityEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY
  );
  // Accumulated rather than filtered out of a sparse literal: a type predicate
  // over the nulls would widen the ids back to `string`.
  const actions: DocumentsBulkActionDescriptor[] = [];
  if (statusAction) {
    actions.push(statusAction);
  }
  if (priorityEnabled) {
    actions.push(priorityAction);
  }
  actions.push(tagAction);
  return actions;
}
