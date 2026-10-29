"use client";

import {
  ArtifactBulkAction,
  type ArtifactBulkAction as ArtifactBulkActionValue,
} from "@repo/api/src/types/artifact-bulk-action";
import {
  BATCH_ITEM_FAILURE_MESSAGE,
  BatchItemFailureCode,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  type TableBulkActionDescriptor,
  type TableBulkActionOption,
  TableBulkActionUndo,
  type TableBulkCommandDescriptor,
  type TableBulkPickerDescriptor,
  type TableBulkSelectionControls,
} from "@repo/design-system/components/ui/table-bulk-actions";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { StarIcon, UserRoundIcon } from "lucide-react";
import { UNASSIGNED_ASSIGNEE_LABEL } from "../lib/user-utils";
import { batchMutationSelectionOutcome } from "./batch-mutation-selection";
import { BULK_SELECTION_CHANGED_MESSAGE } from "./bulk-selection-copy";
import type { MixedBulkActionRequest } from "./mixed-action-confirmation";
import type {
  ArtifactBulkActionEntry,
  ArtifactBulkExecution,
  ArtifactBulkExecutor,
} from "./registry";

/** Adapt existing picker executors without maintaining another kind-support list. */
export function descriptorBulkExecutor(
  descriptor: TableBulkActionDescriptor,
  selection: TableBulkSelectionControls
): ArtifactBulkExecutor {
  return async (rows, value) => {
    const ids = rows.map((row) => row.id);
    if (descriptor.kind === "command") {
      descriptor.onSelect(ids, selection);
      return {
        results: ids.map((id) =>
          batchItemFailed(id, BatchItemFailureCode.OutcomeUnknown)
        ),
        transactionIds: [],
      };
    }
    const option = descriptor.options.find(
      (candidate) => candidate.id === value
    );
    let reportedResult:
      | { appliedIds: readonly string[]; failedIds: readonly string[] }
      | undefined;
    const applied = option
      ? await descriptor.onSelect(ids, option, {
          ...selection,
          reportResult: (result) => {
            reportedResult = result;
          },
        })
      : false;
    return {
      results: descriptorExecutionResults(ids, applied, reportedResult),
      transactionIds: [],
    };
  };
}

/** Render registry-selected controls while retaining each host's existing picker. */
export function registeredArtifactDescriptors(input: {
  entries: readonly ArtifactBulkActionEntry[];
  presentations: Partial<
    Record<ArtifactBulkActionValue, TableBulkActionDescriptor>
  >;
  extras?: readonly TableBulkActionDescriptor[];
  favoriteIds: ReadonlySet<string>;
  users: readonly User[];
  onCommitted: (
    ids: readonly string[],
    action: ArtifactBulkActionValue
  ) => void;
  onMixedSelection?: (request: MixedBulkActionRequest) => boolean;
}): TableBulkActionDescriptor[] {
  return input.entries.flatMap((entry) => {
    if (entry.id === ArtifactBulkAction.ChangeFavorite) {
      const presentation =
        input.presentations[ArtifactBulkAction.ChangeFavorite];
      return [
        presentation?.kind === "command"
          ? registryCommandDescriptor(
              entry,
              presentation,
              input.onMixedSelection
            )
          : (presentation ??
            favoriteDescriptor(
              entry,
              input.favoriteIds,
              input.onCommitted,
              input.onMixedSelection
            )),
      ];
    }
    if (entry.id === ArtifactBulkAction.ChangeOwner) {
      return [
        ownerDescriptor(
          entry,
          input.users,
          input.onCommitted,
          input.onMixedSelection
        ),
      ];
    }
    const descriptor =
      input.presentations[entry.id as ArtifactBulkActionValue] ??
      input.extras?.find((extra) => extra.id === entry.id);
    if (descriptor?.kind === "picker") {
      return [
        registryPickerDescriptor(
          entry,
          descriptor,
          input.onCommitted,
          input.onMixedSelection
        ),
      ];
    }
    if (descriptor?.kind === "command") {
      return [
        registryCommandDescriptor(entry, descriptor, input.onMixedSelection),
      ];
    }
    return descriptor ? [descriptor] : [];
  });
}

function registryCommandDescriptor(
  entry: ArtifactBulkActionEntry,
  descriptor: Extract<TableBulkActionDescriptor, { kind: "command" }>,
  onMixedSelection?: (request: MixedBulkActionRequest) => boolean
): TableBulkActionDescriptor {
  return {
    ...descriptor,
    onSelect: (
      _ids: readonly string[],
      selection: TableBulkSelectionControls
    ) => {
      Promise.resolve(
        confirmOrRunRegisteredAction(
          entry,
          descriptor.label,
          selection,
          () => {
            descriptor.onSelect(entry.supportedIds, selection);
            return Promise.resolve(true);
          },
          onMixedSelection
        )
      ).catch(() => undefined);
    },
  };
}

function registryPickerDescriptor(
  entry: ArtifactBulkActionEntry,
  descriptor: Extract<TableBulkActionDescriptor, { kind: "picker" }>,
  onCommitted: (
    ids: readonly string[],
    action: ArtifactBulkActionValue
  ) => void,
  onMixedSelection?: (request: MixedBulkActionRequest) => boolean
): TableBulkActionDescriptor {
  return {
    ...descriptor,
    render:
      descriptor.render && entry.supportedIds.length > 0
        ? (context) =>
            descriptor.render?.({ ...context, rowIds: entry.supportedIds })
        : undefined,
    onSelect: (_ids, option, selection) =>
      confirmOrRunRegisteredAction(
        entry,
        descriptor.label,
        selection,
        () => {
          if (descriptor.undo === TableBulkActionUndo.Supported) {
            return Promise.resolve(
              descriptor.onSelect(
                entry.supportedIds,
                option,
                applicableSelectionControls(entry, selection)
              )
            );
          }
          return settleRegisteredArtifactAction(
            entry,
            option.id,
            selection,
            onCommitted
          );
        },
        onMixedSelection
      ),
  };
}

function favoriteDescriptor(
  entry: ArtifactBulkActionEntry,
  favoriteIds: ReadonlySet<string>,
  onCommitted: (
    ids: readonly string[],
    action: ArtifactBulkActionValue
  ) => void,
  onMixedSelection?: (request: MixedBulkActionRequest) => boolean
): TableBulkActionDescriptor {
  const allFavorite = entry.supportedIds.every((id) => favoriteIds.has(id));
  const presentation = {
    icon: <StarIcon />,
    id: ArtifactBulkAction.ChangeFavorite,
    kind: "command",
    label: "Favorite",
    pressed: allFavorite,
    undo: TableBulkActionUndo.NotImplemented,
  } satisfies Omit<TableBulkCommandDescriptor, "onSelect">;
  return {
    ...presentation,
    onSelect: (
      _ids: readonly string[],
      selection: TableBulkSelectionControls
    ) => {
      Promise.resolve(
        confirmOrRunRegisteredAction(
          entry,
          presentation.label,
          selection,
          () =>
            settleRegisteredArtifactAction(
              entry,
              !allFavorite,
              selection,
              onCommitted
            ),
          onMixedSelection
        )
      ).catch(() => undefined);
    },
  };
}

function ownerDescriptor(
  entry: ArtifactBulkActionEntry,
  users: readonly User[],
  onCommitted: (
    ids: readonly string[],
    action: ArtifactBulkActionValue
  ) => void,
  onMixedSelection?: (request: MixedBulkActionRequest) => boolean
): TableBulkActionDescriptor {
  const presentation = {
    emptyLabel: "No matches",
    icon: <UserRoundIcon />,
    id: ArtifactBulkAction.ChangeOwner,
    kind: "picker",
    label: "Assign owner",
    options: [
      { id: "", label: UNASSIGNED_ASSIGNEE_LABEL },
      ...users.map((user) => ({ id: user.id, label: user.name })),
    ],
    undo: TableBulkActionUndo.NotImplemented,
  } satisfies Omit<TableBulkPickerDescriptor, "onSelect">;
  return {
    ...presentation,
    onSelect: (
      _ids: readonly string[],
      option: TableBulkActionOption,
      selection: TableBulkSelectionControls
    ) =>
      confirmOrRunRegisteredAction(
        entry,
        presentation.label,
        selection,
        () =>
          settleRegisteredArtifactAction(
            entry,
            option.id || null,
            selection,
            onCommitted
          ),
        onMixedSelection
      ),
  };
}

function confirmOrRunRegisteredAction(
  entry: ArtifactBulkActionEntry,
  actionLabel: string,
  selection: TableBulkSelectionControls,
  execute: () => Promise<boolean>,
  onMixedSelection?: (request: MixedBulkActionRequest) => boolean
): Promise<boolean> | boolean {
  const generation = selection.getGeneration?.();
  const executeCurrentSelection = () => {
    if (
      generation !== undefined &&
      selection.getGeneration?.() !== generation
    ) {
      toast.error(BULK_SELECTION_CHANGED_MESSAGE);
      return Promise.resolve(false);
    }
    return execute();
  };
  const partition = entry.partition;
  if (partition && partition.inapplicableRows.length > 0) {
    return (
      onMixedSelection?.({
        ...partition,
        actionLabel,
        execute: executeCurrentSelection,
      }) ?? false
    );
  }
  return executeCurrentSelection();
}

/** Apply one registry entry and reconcile its per-item result with selection. */
export async function settleRegisteredArtifactAction(
  entry: ArtifactBulkActionEntry,
  value: string | boolean | null,
  selection: TableBulkSelectionControls,
  onCommitted: (ids: readonly string[], action: ArtifactBulkActionValue) => void
): Promise<boolean> {
  const generation = selection.getGeneration?.();
  let execution: ArtifactBulkExecution | undefined;
  try {
    execution = await entry.execute(value);
  } catch {
    execution = undefined;
  }
  if (!execution) {
    toast.error(
      BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.OutcomeUnknown]
    );
    return false;
  }
  const outcome = batchMutationSelectionOutcome(
    execution.results,
    entry.supportedIds
  );
  onCommitted(outcome.appliedIds, entry.id as ArtifactBulkActionValue);
  if (selection.getGeneration?.() === generation) {
    const remaining = new Set([
      ...outcome.failedIds,
      ...(entry.partition?.inapplicableRows.map((row) => row.id) ?? []),
    ]);
    const retainedIds = (
      entry.partition?.selectedRows.map((row) => row.id) ?? entry.supportedIds
    ).filter((id) => remaining.has(id));
    if (retainedIds.length > 0) {
      selection.retain(retainedIds);
    } else {
      selection.clear();
    }
  }
  if (outcome.failureCode) {
    toast.error(
      execution.failureMessage ??
        BATCH_ITEM_FAILURE_MESSAGE[outcome.failureCode]
    );
  }
  return outcome.failedIds.length === 0;
}

function descriptorExecutionResults(
  ids: readonly string[],
  applied: boolean,
  reportedResult?: {
    appliedIds: readonly string[];
    failedIds: readonly string[];
  }
) {
  if (!reportedResult) {
    return ids.map((id) =>
      applied
        ? batchItemApplied(id)
        : batchItemFailed(id, BatchItemFailureCode.OutcomeUnknown)
    );
  }
  const appliedIds = new Set(reportedResult.appliedIds);
  const failedIds = new Set(reportedResult.failedIds);
  return ids.map((id) =>
    appliedIds.has(id) && !failedIds.has(id)
      ? batchItemApplied(id)
      : batchItemFailed(id, BatchItemFailureCode.OutcomeUnknown)
  );
}

function applicableSelectionControls(
  entry: ArtifactBulkActionEntry,
  selection: TableBulkSelectionControls
): TableBulkSelectionControls {
  const partition = entry.partition;
  if (!partition || partition.inapplicableRows.length === 0) {
    return selection;
  }
  const inapplicableIds = new Set(
    partition.inapplicableRows.map((row) => row.id)
  );
  const selectedIds = partition.selectedRows.map((row) => row.id);
  const retainWithInapplicable = (rowIds: readonly string[]) => {
    const remainingIds = new Set([...rowIds, ...inapplicableIds]);
    selection.retain(selectedIds.filter((id) => remainingIds.has(id)));
  };
  return {
    clear: () => retainWithInapplicable([]),
    getGeneration: selection.getGeneration,
    reportResult: selection.reportResult,
    retain: retainWithInapplicable,
  };
}
