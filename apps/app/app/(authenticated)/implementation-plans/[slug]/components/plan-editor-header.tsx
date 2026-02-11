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
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SettingsIcon,
  TrashIcon,
} from "lucide-react";
import { EditorHeader } from "@/components/artifact-editor/editor-header";

type PlanEditorHeaderProps = {
  /**
   * The plan artifact being edited
   */
  plan: ArtifactWithWorkstream;
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
   * Whether the plan is in DRAFT status
   */
  isDraft: boolean;
  /**
   * Whether the plan is APPROVED
   */
  isApproved: boolean;
  /**
   * Pull request information if plan has been executed
   */
  pullRequest?: { htmlUrl: string; number: number } | null;
  /**
   * Whether the plan is currently executing
   */
  isExecuting: boolean;
  /**
   * Callback when metadata panel toggle is clicked
   */
  onToggleMetadataPanel: () => void;
  /**
   * Callback when edit button is clicked
   */
  onEdit: () => void;
  /**
   * Callback when approve button is clicked
   */
  onApprove: () => void;
  /**
   * Callback when request changes button is clicked
   */
  onRequestChanges: () => void;
  /**
   * Callback when execute button is clicked
   */
  onExecute: () => void;
  /**
   * Callback when save button is clicked
   */
  onSave: () => void;
  /**
   * Callback when discard button is clicked (exit edit mode without saving)
   */
  onDiscard: () => void;
  /**
   * Callback when copy markdown menu item is clicked
   */
  onCopyMarkdown: () => void;
  /**
   * Callback when export markdown menu item is clicked
   */
  onExportMarkdown: () => void;
  /**
   * Callback when export to Linear menu item is clicked
   */
  onExportToLinear: () => void;
  /**
   * Callback when regenerate menu item is clicked
   */
  onRegenerate: () => void;
  /**
   * Callback when delete menu item is clicked
   */
  onDelete: () => void;
  /**
   * Whether to show the restore option
   */
  showRestore?: boolean;
  /**
   * Callback when restore version is clicked
   */
  onRestoreVersion?: () => void;
  /**
   * Version selector component to display
   */
  versionDisplay?: React.ReactNode;
  /**
   * Whether any async operation is in progress (disables buttons)
   */
  isPending?: boolean;
  /**
   * Number of unresolved comment threads
   */
  openThreadCount?: number;
};

function ThreadCountBadge({
  count,
  onClick,
}: {
  count: number;
  onClick?: () => void;
}) {
  if (count <= 0) {
    return null;
  }
  return (
    <Button onClick={onClick} size="sm" title="View comments" variant="ghost">
      <MessageSquareIcon className="mr-1 h-4 w-4" />
      {count}
    </Button>
  );
}

export function PlanEditorHeader({
  plan,
  status,
  isEditing,
  canEdit,
  isSaving,
  lastSaved,
  showMetadataPanel,
  isDraft,
  isApproved,
  pullRequest,
  isExecuting,
  onToggleMetadataPanel,
  onDiscard,
  onEdit,
  onApprove,
  onRequestChanges,
  onExecute,
  onSave,
  onCopyMarkdown,
  onExportMarkdown,
  onExportToLinear,
  onRegenerate,
  onDelete,
  showRestore = false,
  onRestoreVersion,
  openThreadCount = 0,
  versionDisplay,
  isPending = false,
}: PlanEditorHeaderProps) {
  // Determine the back href based on project association
  const backHref = plan.project?.teams?.[0]?.id
    ? `/teams/${plan.project.teams[0].id}/projects/${plan.project.id}`
    : "/implementation-plans";

  const backLabel = plan.project?.teams?.[0]?.id
    ? "Back to Project"
    : "Back to Plans";

  // Plan-specific toolbar actions
  const rightActions = (
    <>
      {isEditing ? (
        <>
          <Button
            disabled={isPending}
            onClick={onDiscard}
            size="sm"
            variant="outline"
          >
            Discard
          </Button>
          <Button disabled={isPending} onClick={onSave} size="sm">
            {isSaving ? "Publishing..." : "Publish"}
          </Button>
        </>
      ) : (
        <>
          <ThreadCountBadge count={openThreadCount} onClick={onEdit} />

          <Button
            onClick={onToggleMetadataPanel}
            size="sm"
            variant={showMetadataPanel ? "secondary" : "outline"}
          >
            <SettingsIcon className="mr-2 h-4 w-4" />
            Details
          </Button>

          {/* Approve button - only shown for Draft plans */}
          {isDraft ? (
            <Button
              disabled={isPending}
              onClick={onApprove}
              size="sm"
              variant="outline"
            >
              <CheckIcon className="mr-2 h-4 w-4" />
              Approve
            </Button>
          ) : null}

          {/* Execute button - only enabled when plan is approved */}
          <Button
            disabled={isPending || !isApproved || isExecuting}
            onClick={onExecute}
            size="sm"
            title={
              isApproved ? "" : "Approve the plan first to enable execution"
            }
            variant={isApproved ? "default" : "outline"}
          >
            <PlayIcon className="mr-2 h-4 w-4" />
            Execute
          </Button>

          {/* PR Link - shown when a PR has been created */}
          {pullRequest ? (
            <a
              href={pullRequest.htmlUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <Button size="sm" variant="outline">
                <GitPullRequestIcon className="mr-2 h-4 w-4" />
                PR #{pullRequest.number}
              </Button>
            </a>
          ) : null}

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
        <DropdownMenuContent align="end" className="w-[180px]">
          {showRestore ? (
            <>
              <DropdownMenuItem onClick={onRestoreVersion}>
                <RotateCcwIcon className="mr-2 h-4 w-4" />
                Restore Version
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem disabled={isPending} onClick={onRequestChanges}>
            <MessageSquareIcon className="mr-2 h-4 w-4" />
            Request Changes
          </DropdownMenuItem>
          <DropdownMenuItem disabled={isPending} onClick={onRegenerate}>
            <RefreshCwIcon className="mr-2 h-4 w-4" />
            Regenerate Plan
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onExportMarkdown}>
            <DownloadIcon className="mr-2 h-4 w-4" />
            Export Markdown
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onExportToLinear}>
            <ExternalLinkIcon className="mr-2 h-4 w-4" />
            Export to Linear
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCopyMarkdown}>
            <CopyIcon className="mr-2 h-4 w-4" />
            Copy Markdown
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={onDelete}
          >
            <TrashIcon className="mr-2 h-4 w-4" />
            Delete Plan
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
      title={plan.title}
      versionDisplay={versionDisplay}
    />
  );
}
