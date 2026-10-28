"use client";

import { DocumentsBulkActions } from "@repo/app/documents/components/table/documents-bulk-actions";
import { DocumentsBulkRail } from "@repo/app/documents/components/table/documents-bulk-rail";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { ArtifactSelectionAnnouncer } from "@repo/app/shared/components/generic-artifact-surface/bulk-action-bar";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Button } from "@repo/design-system/components/ui/button";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { cn } from "@repo/design-system/lib/utils";
import { Layers2Icon, MergeIcon, TrashIcon } from "lucide-react";

type DocumentsSelectionBarProps = {
  canBulkDelete: boolean;
  /**
   * False inside the Artifact List shell, which owns the selection announcer
   * (ISS-12640: one polite selection status per surface).
   */
  announcesSelection?: boolean;
  canBulkMove: boolean;
  /** A newly offered move stays behind the existing rail gate. */
  canBulkMoveOnRail?: boolean;
  canUseDocumentActions: boolean;
  canMerge: boolean;
  manualPlacementEnabled?: boolean;
  onBulkDelete: () => void;
  onBulkMove: () => void;
  onClear: () => void;
  onMerge: () => void;
  onRetain: (rowIds: readonly string[]) => void;
  selectedIds: string[];
  selectedRows: readonly DocumentRowData[];
  users?: readonly User[];
};

/** Floating action bar for the current Documents selection. */
export function DocumentsSelectionBar({
  canBulkDelete,
  announcesSelection = true,
  canBulkMove,
  canBulkMoveOnRail = false,
  canUseDocumentActions,
  canMerge,
  manualPlacementEnabled = false,
  onBulkDelete,
  onBulkMove,
  onClear,
  onMerge,
  onRetain,
  selectedIds,
  selectedRows,
  users,
}: Readonly<DocumentsSelectionBarProps>) {
  // ISS-9329's ONE read site. It picks between two whole bar shapes rather than
  // handing a boolean to each control, so the rollout can never leave half the
  // selection bar on the rail and half on the chrome below.
  const railEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY
  );
  if (selectedIds.length > 0 && !canUseDocumentActions) {
    return (
      <div className="pointer-events-none sticky bottom-3 z-50 mt-4 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-4 rounded-2xl border bg-background px-[18px] py-3 shadow-md">
          <span className="shrink-0 font-medium text-muted-foreground text-xs">
            {selectedIds.length} {selectedIds.length === 1 ? "item" : "items"}{" "}
            selected
          </span>
          <Button
            className="h-8 text-xs"
            onClick={onClear}
            size="sm"
            variant="outline"
          >
            Clear Selected
          </Button>
        </div>
      </div>
    );
  }
  if (railEnabled) {
    // The announcer sits ABOVE the selection guard, not inside the rail: a live
    // region only announces what changes while it is ALREADY mounted, so a
    // region that arrives with the first selection and leaves with the clear
    // misses both moments it exists for (ISS-9574).
    return (
      <>
        {announcesSelection ? (
          <ArtifactSelectionAnnouncer count={selectedIds.length} />
        ) : null}
        {selectedIds.length > 0 ? (
          <DocumentsBulkRail
            canBulkDelete={canBulkDelete}
            canBulkMove={canBulkMove || canBulkMoveOnRail}
            canMerge={canMerge}
            onBulkDelete={onBulkDelete}
            onBulkMove={onBulkMove}
            onClear={onClear}
            onMerge={onMerge}
            onRetain={onRetain}
            selectedIds={selectedIds}
            selectedRows={selectedRows}
            users={users}
          />
        ) : null}
      </>
    );
  }
  if (selectedIds.length === 0) {
    return null;
  }
  return (
    <div
      className={cn(
        "pointer-events-none sticky bottom-3 z-50 mt-4 flex justify-center",
        manualPlacementEnabled && "min-w-0"
      )}
    >
      <div
        className={cn(
          "pointer-events-auto flex items-center rounded-2xl border bg-background px-[18px] py-3 shadow-md",
          manualPlacementEnabled
            ? "max-w-full flex-wrap justify-center gap-2"
            : "gap-4"
        )}
      >
        <span className="shrink-0 font-medium text-muted-foreground text-xs">
          {selectedIds.length} {selectedIds.length === 1 ? "item" : "items"}{" "}
          selected
        </span>
        <div
          className={cn(
            "flex items-center gap-2",
            manualPlacementEnabled && "min-w-0 flex-wrap justify-center"
          )}
        >
          <Button
            className="h-8 text-xs"
            onClick={onClear}
            size="sm"
            variant="outline"
          >
            Clear Selected
          </Button>
          {canMerge && (
            <Button
              className="h-8 text-xs"
              onClick={onMerge}
              size="sm"
              variant="outline"
            >
              <MergeIcon className="h-4 w-4" />
              Merge
            </Button>
          )}
          {canBulkMove && (
            <Button
              className="h-8 text-xs"
              onClick={onBulkMove}
              size="sm"
              variant="outline"
            >
              <Layers2Icon className="h-4 w-4" />
              Move to Project
            </Button>
          )}
          <DocumentsBulkActions
            onClear={onClear}
            onRetain={onRetain}
            rowIds={selectedIds}
            selectedRows={selectedRows}
          />
          {canBulkDelete && (
            <Button
              className="h-8 text-xs"
              onClick={onBulkDelete}
              size="sm"
              variant="outline"
            >
              <TrashIcon className="h-4 w-4" />
              Delete
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
