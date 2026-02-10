"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  DownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RotateCcwIcon,
  SettingsIcon,
  SparklesIcon,
  TrashIcon,
} from "lucide-react";
import { EditorHeader } from "@/components/artifact-editor/editor-header";

type PRDEditorHeaderProps = {
  /**
   * The PRD artifact being edited
   */
  prd: ArtifactWithWorkstream;
  /**
   * Status of the artifact
   */
  status: string;
  /**
   * Whether the editor is in edit mode
   */
  isEditing: boolean;
  /**
   * Whether the document can be edited in the current view
   */
  canEdit: boolean;
  /**
   * Whether content is currently being saved
   */
  isSaving: boolean;
  /**
   * Last saved timestamp
   */
  lastSaved: Date;
  /**
   * Whether the metadata panel is visible
   */
  showMetadataPanel: boolean;
  /**
   * Callback when metadata panel toggle is clicked
   */
  onToggleMetadataPanel: () => void;
  /**
   * Callback when generate plan button is clicked
   */
  onGeneratePlan: () => void;
  /**
   * Callback when edit button is clicked
   */
  onEdit: () => void;
  /**
   * Callback when save button is clicked
   */
  onSave: () => void;
  /**
   * Callback when rename menu item is clicked
   */
  onRename: () => void;
  /**
   * Callback when export menu item is clicked
   */
  onExport: () => void;
  /**
   * Whether to show the restore option
   */
  showRestore?: boolean;
  /**
   * Callback when restore version is clicked
   */
  onRestoreVersion?: () => void;
  /**
   * Callback when delete menu item is clicked
   */
  onDelete: () => void;
  /**
   * Version selector component to display
   */
  versionDisplay?: React.ReactNode;
  /**
   * Whether any async operation is in progress (disables buttons)
   */
  isPending?: boolean;
};

export function PRDEditorHeader({
  prd,
  status,
  isEditing,
  canEdit,
  isSaving,
  lastSaved,
  showMetadataPanel,
  onToggleMetadataPanel,
  onGeneratePlan,
  onEdit,
  onSave,
  onRename,
  onExport,
  showRestore = false,
  onRestoreVersion,
  onDelete,
  versionDisplay,
  isPending = false,
}: PRDEditorHeaderProps) {
  // Determine the back href based on project association
  const backHref = prd.project?.teams?.[0]?.id
    ? `/teams/${prd.project.teams[0].id}/projects/${prd.project.id}`
    : "/prds";

  const backLabel = prd.project?.teams?.[0]?.id
    ? "Back to Project"
    : "Back to Library";

  // PRD-specific toolbar actions
  const rightActions = (
    <>
      {isEditing ? (
        <Button disabled={isPending} onClick={onSave} size="sm">
          {isSaving ? "Publishing..." : "Publish"}
        </Button>
      ) : (
        <>
          <Button
            onClick={onToggleMetadataPanel}
            size="sm"
            variant={showMetadataPanel ? "secondary" : "outline"}
          >
            <SettingsIcon className="mr-2 h-4 w-4" />
            Details
          </Button>

          <Button onClick={onGeneratePlan} size="sm" variant="default">
            <SparklesIcon className="mr-2 h-4 w-4" />
            Generate Implementation Plan
          </Button>

          <Button
            disabled={isPending || !canEdit}
            onClick={onEdit}
            size="sm"
            title={canEdit ? undefined : "Switch to the latest version to edit"}
          >
            <PencilIcon className="mr-2 h-4 w-4" />
            Edit
          </Button>
        </>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost">
            <MoreHorizontalIcon className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[160px]">
          <DropdownMenuItem onClick={onRename}>
            <PencilIcon className="mr-2 h-4 w-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onExport}>
            <DownloadIcon className="mr-2 h-4 w-4" />
            Export .md
          </DropdownMenuItem>
          {showRestore ? (
            <DropdownMenuItem onClick={onRestoreVersion}>
              <RotateCcwIcon className="mr-2 h-4 w-4" />
              Restore Version
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={onDelete}
          >
            <TrashIcon className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <EditorHeader
      backHref={backHref}
      backLabel={backLabel}
      isSaving={isSaving}
      lastSaved={lastSaved}
      rightActions={rightActions}
      status={status}
      title={prd.fileName ?? prd.title}
      versionDisplay={versionDisplay}
    />
  );
}
