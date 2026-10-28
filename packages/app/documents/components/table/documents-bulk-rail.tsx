"use client";

import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  ARTIFACT_BULK_ACTION_SCOPE,
  ArtifactBulkAction,
} from "@repo/api/src/types/artifact-bulk-action";
import { BULK_PRIORITY_ACTION_ID } from "@repo/app/documents/components/table/bulk-priority-picker";
import { BULK_STATUS_ACTION_ID } from "@repo/app/documents/components/table/bulk-status-picker";
import {
  type DocumentsBulkActionDescriptor,
  DocumentsBulkActionId,
} from "@repo/app/documents/components/table/documents-bulk-action-ids";
import { useDocumentsBulkActionDescriptors } from "@repo/app/documents/components/table/documents-bulk-actions";
import {
  bulkReceiptFromCommittedIds,
  invalidateForBulkArtifactMutation,
} from "@repo/app/documents/hooks/bulk-artifact-invalidation";
import { useFavoriteArtifacts } from "@repo/app/documents/hooks/use-artifact-favorites";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import {
  descriptorBulkExecutor,
  registeredArtifactDescriptors,
} from "@repo/app/shared/bulk-actions/registered-artifact-actions";
import { documentBulkKind } from "@repo/app/shared/bulk-actions/row-kind";
import { useArtifactBulkActions } from "@repo/app/shared/bulk-actions/use-artifact-bulk-actions";
import {
  ARTIFACT_NOUN,
  ArtifactBulkActionBar,
} from "@repo/app/shared/components/generic-artifact-surface/bulk-action-bar";
import { BULK_TAG_ACTION_ID } from "@repo/app/tags/lib/bulk-tag-labels";
import {
  type TableBulkActionDescriptor,
  TableBulkActionUndo,
} from "@repo/design-system/components/ui/table-bulk-actions";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { useQueryClient } from "@tanstack/react-query";
import { Layers2Icon, MergeIcon, TrashIcon } from "lucide-react";

/**
 * The project all-artifacts selection, on the shared artifact rail (ISS-9329).
 *
 * This is `ArtifactBulkActionBar`'s production host. The registry determines
 * kind-compatible actions; the document-only merge action remains a host extra.
 */
export function DocumentsBulkRail({
  canBulkDelete,
  canBulkMove,
  canMerge,
  onBulkDelete,
  onBulkMove,
  onClear,
  onMerge,
  onRetain,
  selectedIds,
  selectedRows,
  users = [],
}: {
  canBulkDelete: boolean;
  canBulkMove: boolean;
  canMerge: boolean;
  onBulkDelete: () => void;
  onBulkMove: () => void;
  onClear: () => void;
  onMerge: () => void;
  onRetain: (rowIds: readonly string[]) => void;
  selectedIds: readonly string[];
  selectedRows: readonly DocumentRowData[];
  users?: readonly User[];
}) {
  const queryClient = useQueryClient();
  const favorites = useFavoriteArtifacts();
  const mutations = useDocumentsBulkActionDescriptors(
    selectedRows,
    selectedIds,
    ARTIFACT_NOUN
  );
  const candidates = documentsRailActions({
    canBulkDelete,
    canBulkMove,
    canMerge,
    mutations,
    onBulkDelete,
    onBulkMove,
    onMerge,
  });
  const candidateById = new Map(
    candidates.map((action) => [action.id, action])
  );
  const presentations: Partial<
    Record<ArtifactBulkAction, TableBulkActionDescriptor>
  > = {
    [ArtifactBulkAction.ChangeStatus]: candidateById.get(BULK_STATUS_ACTION_ID),
    [ArtifactBulkAction.ChangePriority]: candidateById.get(
      BULK_PRIORITY_ACTION_ID
    ),
    [ArtifactBulkAction.AddTag]: candidateById.get(BULK_TAG_ACTION_ID),
    [ArtifactBulkAction.ChangeProject]: candidateById.get(
      DOCUMENTS_RAIL_MOVE_ACTION_ID
    ),
    [ArtifactBulkAction.Delete]: candidateById.get(
      DOCUMENTS_RAIL_DELETE_ACTION_ID
    ),
  };
  const selection = { clear: onClear, retain: onRetain };
  const executors = Object.fromEntries(
    Object.entries(presentations).flatMap(([action, descriptor]) =>
      descriptor &&
      action !== ArtifactBulkAction.ChangeStatus &&
      action !== ArtifactBulkAction.ChangePriority
        ? [[action, descriptorBulkExecutor(descriptor, selection)]]
        : []
    )
  );
  const rows = selectedRows.map((row) => ({
    id: row.id,
    kind: documentBulkKind(row.type),
    label: row.title || row.slug || row.id,
  }));
  const merge = candidateById.get(DOCUMENTS_RAIL_MERGE_ACTION_ID);
  const entries = useArtifactBulkActions({
    rows: rows.length === selectedIds.length ? rows : [],
    host: {
      executors,
      canPerform: (action) =>
        action !== ArtifactBulkAction.ChangeFavorite ||
        favorites.data !== undefined,
    },
    extras: merge
      ? [
          {
            id: merge.id,
            supportedIds: [...selectedIds],
            execute: (value) =>
              descriptorBulkExecutor(merge, selection)(rows, value),
          },
        ]
      : [],
  });
  const actions = registeredArtifactDescriptors({
    entries,
    presentations,
    extras: merge ? [merge] : [],
    favoriteIds: new Set(favorites.data?.map((favorite) => favorite.id) ?? []),
    users,
    onCommitted: (ids) =>
      invalidateForBulkArtifactMutation(
        queryClient,
        bulkReceiptFromCommittedIds(ids)
      ),
  });
  // The count statement lives on `DocumentsSelectionBar`, the host that renders
  // unconditionally, because this component unmounts on the clear it would need
  // to announce.
  return (
    <ArtifactBulkActionBar
      actions={actions}
      onClear={onClear}
      onRetainSelection={onRetain}
      rowIds={selectedIds}
    />
  );
}

/**
 * The rail's ordered operation list. Split out of the component so the
 * permission table below can be held against the actions actually produced,
 * rather than against a second hand-written list of what the rail is believed
 * to carry.
 */
export function documentsRailActions({
  canBulkDelete,
  canBulkMove,
  canMerge,
  mutations,
  onBulkDelete,
  onBulkMove,
  onMerge,
}: {
  canBulkDelete: boolean;
  canBulkMove: boolean;
  canMerge: boolean;
  mutations: readonly DocumentsBulkActionDescriptor[];
  onBulkDelete: () => void;
  onBulkMove: () => void;
  onMerge: () => void;
}): readonly DocumentsRailActionDescriptor[] {
  return [
    ...mutations.map(asRailAction),
    ...(canMerge ? [mergeAction(onMerge)] : []),
    ...(canBulkMove ? [moveAction(onBulkMove)] : []),
    ...(canBulkDelete ? [deleteAction(onBulkDelete)] : []),
  ];
}

export const DOCUMENTS_RAIL_MERGE_ACTION_ID = "documents-merge";
export const DOCUMENTS_RAIL_MOVE_ACTION_ID = "documents-move";
export const DOCUMENTS_RAIL_DELETE_ACTION_ID = "documents-delete";

/**
 * No API-key path exists for merge: `POST /documents/merge` is registered with
 * `withAuth`, session auth only, because it runs a server-side Anthropic
 * generation billed to ClosedLoop's own key and API callers must not spend that
 * budget (ISS-11795). That is its permission rule, stated by its own route.
 */
export const DOCUMENTS_RAIL_SESSION_AUTH_ONLY = "session_auth_only" as const;

/**
 * Every control this rail can render, as a CLOSED set.
 *
 * The mutation half is SPREAD from `DocumentsBulkActionId` rather than
 * respelled, which is what makes the permission table below unavoidable: a
 * control added to `useDocumentsBulkActionDescriptors` has to widen that union,
 * widening this one with it, and the exhaustive `Record` then fails `tsc` until
 * the rule exists. Respelled, the two lists drift and the missing rule is left
 * for a test to remember — the side inventory AGENTS.md's Review Lessons name.
 */
export const DocumentsRailActionId = {
  ...DocumentsBulkActionId,
  ChangeFavorite: ArtifactBulkAction.ChangeFavorite,
  ChangeOwner: ArtifactBulkAction.ChangeOwner,
  ChangeProject: DOCUMENTS_RAIL_MOVE_ACTION_ID,
  Delete: DOCUMENTS_RAIL_DELETE_ACTION_ID,
  Merge: DOCUMENTS_RAIL_MERGE_ACTION_ID,
} as const;
export type DocumentsRailActionId =
  (typeof DocumentsRailActionId)[keyof typeof DocumentsRailActionId];

/** A descriptor this rail may carry: the shared shape, with its id pinned. */
export type DocumentsRailActionDescriptor = TableBulkActionDescriptor & {
  id: DocumentsRailActionId;
};

/** What a control on this rail requires: a scope, or no API-key path at all. */
export type DocumentsRailPermission =
  | ApiKeyScope
  | typeof DOCUMENTS_RAIL_SESSION_AUTH_ONLY;

/**
 * The permission every control on this rail requires (ISS-9329 AC4). The five
 * bulk entries defer to DOC-36 R16 rather than restating it; merge has no
 * scope to state, for the reason given above (ISS-11795).
 */
export const DOCUMENTS_RAIL_ACTION_PERMISSIONS = {
  [DocumentsRailActionId.ChangeFavorite]:
    ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.ChangeFavorite],
  [DocumentsRailActionId.ChangeOwner]:
    ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.ChangeOwner],
  [DocumentsRailActionId.ChangeStatus]:
    ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.ChangeStatus],
  [DocumentsRailActionId.ChangePriority]:
    ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.ChangePriority],
  [DocumentsRailActionId.AddTag]:
    ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.AddTag],
  [DocumentsRailActionId.ChangeProject]:
    ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.ChangeProject],
  [DocumentsRailActionId.Delete]:
    ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.Delete],
  [DocumentsRailActionId.Merge]: DOCUMENTS_RAIL_SESSION_AUTH_ONLY,
} as const satisfies Record<DocumentsRailActionId, DocumentsRailPermission>;

/**
 * `TableBulkActionBase.render` is a non-rail host's own chrome, and the
 * descriptors above carry the project bar's light outline buttons. This host IS
 * the rail — an inverted surface of icon controls — so dropping `render` is
 * what that field's contract asks for, not a workaround.
 */
function asRailAction(
  action: DocumentsBulkActionDescriptor
): DocumentsRailActionDescriptor {
  const { render: _render, ...rail } = action;
  return rail;
}

/**
 * Merge deletes the secondary artifact and rewrites the primary through a
 * generation step, and `apps/api` exposes no un-merge endpoint
 * (`UNDO_COMMAND_REGISTRY`), so it is confirmed by its dialog beforehand rather
 * than reversed after — which is what `Unsupported` means (DOC-36 R6).
 */
function mergeAction(onMerge: () => void): DocumentsRailActionDescriptor {
  return {
    icon: <MergeIcon className="h-4 w-4" />,
    id: DOCUMENTS_RAIL_MERGE_ACTION_ID,
    kind: "command",
    label: "Merge",
    onSelect: onMerge,
    undo: TableBulkActionUndo.Unsupported,
  };
}

/**
 * DOC-36 R12 reclassified change project as undoable and R15 made it flat, so
 * the reversal is a move back — simply not built, which is `NotImplemented`
 * rather than a withheld decision.
 */
function moveAction(onBulkMove: () => void): DocumentsRailActionDescriptor {
  return {
    icon: <Layers2Icon className="h-4 w-4" />,
    id: DOCUMENTS_RAIL_MOVE_ACTION_ID,
    kind: "command",
    label: "Move to Project",
    onSelect: onBulkMove,
    undo: TableBulkActionUndo.NotImplemented,
  };
}

/**
 * The one destructive action (DOC-36 R12), so the only one that confirms before
 * it runs (R8): `onSelect` REQUESTS the delete, which opens the surface's
 * existing confirmation dialog. It must never be wired to a mutation directly.
 */
function deleteAction(onBulkDelete: () => void): DocumentsRailActionDescriptor {
  return {
    icon: <TrashIcon className="h-4 w-4" />,
    id: DOCUMENTS_RAIL_DELETE_ACTION_ID,
    kind: "command",
    label: "Delete",
    onSelect: onBulkDelete,
    undo: TableBulkActionUndo.Unsupported,
  };
}
