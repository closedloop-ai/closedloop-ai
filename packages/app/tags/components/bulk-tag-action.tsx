"use client";

import { TagEntityType } from "@repo/api/src/types/tag";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  type TableBulkActionDescriptor,
  TableBulkActionLifecycle,
  type TableBulkActionOption,
  TableBulkActionUndo,
  type TableBulkSelectionControls,
} from "@repo/design-system/components/ui/table-bulk-actions";
import type { CountNoun } from "@repo/design-system/lib/count-noun";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { TagIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { getFriendlyError } from "../../shared/api/api-error";
import { useApiClientOptional } from "../../shared/api/use-api-client-optional";
import {
  subscribeToSignedInIdentityChange,
  watchSignedInIdentity,
} from "../../shared/auth/signed-in-identity";
import { TagChip } from "../../shared/components/tag-chip";
import { useBatchTagPerItem } from "../hooks/use-batch-tag-per-item";
import { tagsListQuery } from "../hooks/use-tags";
import {
  appliedTagMessage,
  BULK_REMOVE_TAG_ACTION_ID,
  BULK_REMOVE_TAG_ACTION_LABEL,
  BULK_TAG_ACTION_ID,
  BULK_TAG_ACTION_LABEL,
  BULK_TAG_EMPTY_LABEL,
} from "../lib/bulk-tag-labels";
import {
  BulkTagMutation,
  type BulkTagMutation as BulkTagMutationValue,
} from "../lib/bulk-tag-mutation";
import { performBulkTagMutation } from "../lib/bulk-tag-operation";
import {
  type BulkTagTarget,
  parseBulkTagOptions,
} from "../lib/bulk-tag-outcome";
import { BulkTagPicker } from "./bulk-tag-picker";

/** Add and Remove descriptors backed by one interaction lifecycle owner. */
export function useBulkTagFamilyActions({
  addTargets,
  removeTargets,
  queryClient,
  noun,
}: {
  addTargets: readonly BulkTagTarget[];
  removeTargets: readonly BulkTagTarget[];
  queryClient?: QueryClient;
  noun?: CountNoun;
}): readonly TableBulkActionDescriptor[] {
  return useBulkTagActionDescriptors({
    configurations: [
      { operation: BulkTagMutation.Add, targets: addTargets },
      { operation: BulkTagMutation.Remove, targets: removeTargets },
    ],
    queryClient,
    noun,
  });
}

function useBulkTagActionDescriptors({
  configurations,
  queryClient,
  noun,
}: {
  configurations: readonly BulkTagActionConfiguration[];
  queryClient?: QueryClient;
  noun?: CountNoun;
}): readonly TableBulkActionDescriptor[] {
  const apiClient = useApiClientOptional();
  const [openOperation, setOpenOperation] = useState<BulkTagMutationValue>();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [outcome, setOutcome] = useState<BulkTagInteractionOutcome>();
  const outcomeRef = useRef(outcome);
  const generation = useRef(0);
  const mounted = useRef(false);
  const observedSelection = useRef<ObservedBulkTagSelection | undefined>(
    undefined
  );
  const interactionEligibility = useRef<
    | {
        operation: BulkTagMutationValue;
        rowIds: readonly string[];
        key: string;
      }
    | undefined
  >(undefined);

  const endInteraction = useCallback(() => {
    generation.current += 1;
    outcomeRef.current = undefined;
    interactionEligibility.current = undefined;
    if (mounted.current) {
      setOutcome(undefined);
      setOpenOperation(undefined);
    }
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      outcomeRef.current = undefined;
    };
  }, []);

  // An outcome or an open picker belongs to the account that produced it.
  useEffect(
    () => subscribeToSignedInIdentityChange(endInteraction),
    [endInteraction]
  );

  useLayoutEffect(() => {
    const active = interactionEligibility.current;
    const activeTargets = configurations.find(
      ({ operation }) => operation === active?.operation
    )?.targets;
    if (
      active &&
      activeTargets &&
      active.key !== selectedEligibilityKey(active.rowIds, activeTargets)
    ) {
      endInteraction();
    }
  }, [configurations, endInteraction]);
  // This owner publishes inline failures only while their interaction is current.
  const addMutation = useBatchTagPerItem(BulkTagMutation.Add, queryClient, {
    suppressDefaultErrorToast: true,
  });
  const removeMutation = useBatchTagPerItem(
    BulkTagMutation.Remove,
    queryClient,
    { suppressDefaultErrorToast: true }
  );
  // Always stale, so each opening reads the catalog once and never twice.
  const tags = useQuery({
    ...tagsListQuery(apiClient),
    enabled: Boolean(openOperation),
    select: parseBulkTagOptions,
    staleTime: 0,
  });
  const options = (tags.data ?? []).map((tag) => ({
    id: tag.id,
    label: tag.name,
    content: <TagChip tag={tag} />,
  }));

  async function apply(
    operation: BulkTagMutationValue,
    targets: readonly BulkTagTarget[],
    rowIds: readonly string[],
    option: TableBulkActionOption,
    selection: TableBulkSelectionControls
  ): Promise<boolean> {
    if (pendingRef.current) {
      return false;
    }
    const byRow = new Map(targets.map((target) => [target.rowId, target]));
    const eligibleTargets = rowIds.flatMap((rowId) => {
      const target = byRow.get(rowId);
      return target?.canApply && target.artifactId ? [target] : [];
    });
    if (rowIds.length === 0 || eligibleTargets.length !== rowIds.length) {
      return false;
    }
    const submittedSelectionGeneration = selection.getGeneration?.();
    const selectedTargets = rowIds.flatMap((rowId) => {
      const target = byRow.get(rowId);
      return target?.canApply && target.artifactId ? [target] : [];
    });
    pendingRef.current = true;
    setPending(true);
    interactionEligibility.current = {
      operation,
      rowIds,
      key: selectedEligibilityKey(rowIds, targets),
    };
    const identity = watchSignedInIdentity();
    const submittedGeneration = generation.current;
    const canPublish = () =>
      mounted.current &&
      identity.isCurrent() &&
      generation.current === submittedGeneration &&
      selection.getGeneration?.() === submittedSelectionGeneration;
    try {
      const { succeededIds, failedIds, messages } =
        await performBulkTagMutation({
          targets: selectedTargets,
          isCurrent: identity.isCurrent,
          operation,
          applyBatch: (entityIds) =>
            (operation === BulkTagMutation.Remove
              ? removeMutation
              : addMutation
            ).mutateAsync({
              tagId: option.id,
              entityType: TagEntityType.Artifact,
              entityIds,
            }),
        });
      // Closing the picker does not cancel the save; its result is dropped.
      if (!canPublish()) {
        return false;
      }
      const nextOutcome: BulkTagInteractionOutcome = {
        operation,
        generation: submittedGeneration,
        selectionGeneration: submittedSelectionGeneration,
        submittedKey: selectedRowKey(rowIds),
        failedKey: selectedRowKey(failedIds),
        errorMessage: messages.join(" ") || undefined,
      };
      outcomeRef.current = nextOutcome;
      setOutcome(nextOutcome);
      selection.reportResult?.({ appliedIds: succeededIds, failedIds });
      if (operation === BulkTagMutation.Add && succeededIds.length > 0) {
        toast.success(
          appliedTagMessage(option.label, succeededIds.length, noun)
        );
      }
      if (failedIds.length === 0) {
        setOpenOperation(undefined);
        return true;
      }
      return false;
    } finally {
      identity.dispose();
      pendingRef.current = false;
      if (mounted.current) {
        setPending(false);
      }
    }
  }

  if (!apiClient) {
    return [];
  }
  return configurations.map(({ operation, targets }) => {
    const byRow = new Map(targets.map((target) => [target.rowId, target]));
    const presentation = bulkTagActionPresentation(operation);
    return {
      canRetrySelection: (rowIds) => {
        const current = outcomeRef.current;
        return Boolean(
          current?.operation === operation &&
            current.generation === generation.current &&
            isFailedSelection(current, rowIds)
        );
      },
      onLifecycle: (event) => {
        if (event.kind === TableBulkActionLifecycle.Dispose) {
          endInteraction();
          observedSelection.current = undefined;
          return;
        }
        const next = {
          generation: event.selection.getGeneration?.(),
          key: selectedRowKey(event.rowIds),
        };
        const previous = observedSelection.current;
        observedSelection.current = next;
        const current = outcomeRef.current;
        const preservesFailedSelection = Boolean(
          current &&
            previous &&
            canPreserveFailedSelection(current, previous, next)
        );
        if (
          previous &&
          (previous.generation !== next.generation ||
            previous.key !== next.key) &&
          !preservesFailedSelection
        ) {
          endInteraction();
          return;
        }
        if (current && preservesFailedSelection) {
          const nextOutcome = {
            ...current,
            selectionGeneration: next.generation,
            submittedKey: next.key,
          };
          outcomeRef.current = nextOutcome;
          setOutcome(nextOutcome);
          interactionEligibility.current = {
            operation: current.operation,
            rowIds: event.rowIds,
            key: selectedEligibilityKey(
              event.rowIds,
              configurations.find(
                ({ operation: candidate }) => candidate === current.operation
              )?.targets ?? []
            ),
          };
        }
      },
      emptyLabel: BULK_TAG_EMPTY_LABEL,
      icon: presentation.icon,
      id: presentation.id,
      isPending: pending,
      kind: "picker",
      label: presentation.label,
      onSelect: (rowIds, option, selection) =>
        apply(operation, targets, rowIds, option, selection),
      options,
      undo: TableBulkActionUndo.NotImplemented,
      render: ({ rowIds, selectOption }) => {
        if (
          rowIds.length === 0 ||
          !rowIds.every(
            (id) => byRow.get(id)?.canApply && byRow.get(id)?.artifactId
          )
        ) {
          return null;
        }
        return (
          <BulkTagPicker
            actionLabel={presentation.label}
            catalogError={
              tags.isError && !tags.data
                ? getFriendlyError(tags.error).description
                : undefined
            }
            errorMessage={
              outcome?.operation === operation
                ? outcome.errorMessage
                : undefined
            }
            icon={presentation.icon}
            isLoading={tags.isPending}
            isPending={pending}
            onOpenChange={(next) => {
              if (next) {
                interactionEligibility.current = {
                  operation,
                  rowIds,
                  key: selectedEligibilityKey(rowIds, targets),
                };
                setOpenOperation(operation);
                return;
              }
              endInteraction();
            }}
            onSelect={selectOption}
            open={openOperation === operation}
            options={options}
            presentation="rail"
          />
        );
      },
    } satisfies TableBulkActionDescriptor;
  });
}

type BulkTagInteractionOutcome = {
  operation: BulkTagMutationValue;
  generation: number;
  selectionGeneration: number | undefined;
  submittedKey: string;
  failedKey: string;
  errorMessage?: string;
};

type ObservedBulkTagSelection = {
  generation: number | undefined;
  key: string;
};

type BulkTagActionConfiguration = {
  operation: BulkTagMutationValue;
  targets: readonly BulkTagTarget[];
};

function selectedRowKey(rowIds: readonly string[]): string {
  return JSON.stringify([...rowIds].sort());
}

function isFailedSelection(
  outcome: BulkTagInteractionOutcome,
  rowIds: readonly string[]
): boolean {
  return rowIds.length > 0 && selectedRowKey(rowIds) === outcome.failedKey;
}

/** Preserves retry only across the submitted-to-failed selection transition. */
function canPreserveFailedSelection(
  outcome: BulkTagInteractionOutcome,
  previous: ObservedBulkTagSelection,
  next: ObservedBulkTagSelection
): boolean {
  return (
    outcome.failedKey !== selectedRowKey([]) &&
    next.key === outcome.failedKey &&
    (previous.key === outcome.submittedKey ||
      previous.key === outcome.failedKey)
  );
}

/** Only selected identities and permissions can invalidate their active interaction. */
function selectedEligibilityKey(
  rowIds: readonly string[],
  targets: readonly BulkTagTarget[]
): string {
  const byRow = new Map(targets.map((target) => [target.rowId, target]));
  return JSON.stringify(
    [...rowIds].sort().map((rowId) => {
      const target = byRow.get(rowId);
      return {
        rowId,
        artifactId: target?.artifactId,
        canApply: target?.canApply ?? false,
      };
    })
  );
}

function bulkTagActionPresentation(operation: BulkTagMutationValue) {
  if (operation === BulkTagMutation.Remove) {
    return {
      icon: <XIcon />,
      id: BULK_REMOVE_TAG_ACTION_ID,
      label: BULK_REMOVE_TAG_ACTION_LABEL,
    };
  }
  return {
    icon: <TagIcon />,
    id: BULK_TAG_ACTION_ID,
    label: BULK_TAG_ACTION_LABEL,
  };
}
