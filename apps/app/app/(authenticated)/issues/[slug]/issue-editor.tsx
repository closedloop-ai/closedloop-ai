"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { VersionSelector } from "@/app/(authenticated)/implementation-plans/components/version-selector";
import { EditorContent } from "@/components/artifact-editor/editor-content";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { RenameDialog } from "@/components/rename-dialog";
import { useArtifactActions } from "@/hooks/artifact-editing/use-artifact-actions";
import { useArtifactContent } from "@/hooks/artifact-editing/use-artifact-content";
import { useArtifactMetadata } from "@/hooks/artifact-editing/use-artifact-metadata";
import { useArtifactUIState } from "@/hooks/artifact-editing/use-artifact-ui-state";
import { IssueEditorHeader } from "./components/issue-editor-header";
import { IssueMetadataPanel } from "./components/issue-metadata-panel";

type IssueEditorProps = {
  issue: ArtifactWithWorkstream;
  currentVersion: number;
  latestVersion: number;
  onVersionChange: (version: number) => void;
};

export function IssueEditor({
  issue,
  currentVersion,
  latestVersion,
  onVersionChange,
}: IssueEditorProps) {
  const content = useArtifactContent({
    artifact: issue,
  });

  const metadata = useArtifactMetadata({
    artifact: issue,
  });

  const actions = useArtifactActions({
    artifact: issue,
    redirectPath: issue.project?.teams?.[0]?.id
      ? `/teams/${issue.project.teams[0].id}/projects/${issue.project.id}`
      : "/",
  });

  const uiState = useArtifactUIState({
    artifactType: "ISSUE",
  });

  // Type assertion for ISSUE-specific UI state
  const { showRenameDialog, setShowRenameDialog, openRenameDialog } =
    uiState as Extract<
      ReturnType<typeof useArtifactUIState>,
      { showRenameDialog: boolean }
    >;

  // Determine if any operation is pending
  const isPending =
    content.isSaving ||
    metadata.isUpdating ||
    actions.isDeleting ||
    actions.isRenaming;

  // Create version display component for header
  const versionDisplay = (
    <VersionSelector
      currentVersion={currentVersion}
      latestVersion={latestVersion}
      onVersionChange={onVersionChange}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <IssueEditorHeader
        isPending={isPending}
        isSaving={content.isSaving}
        issue={issue}
        lastSaved={content.lastSaved}
        onDelete={uiState.openDeleteDialog}
        onExport={actions.handleDownload}
        onRename={openRenameDialog}
        onSave={content.saveContent}
        onToggleMetadataPanel={uiState.toggleMetadataPanel}
        showMetadataPanel={uiState.showMetadataPanel}
        status={metadata.status}
        versionDisplay={versionDisplay}
      />

      {/* Content Area with Optional Metadata Panel */}
      <div className="flex min-h-0 flex-1">
        {/* Scrollable Editor */}
        <EditorContent
          onChange={content.updateContent}
          placeholder="Start writing your issue..."
          value={content.content}
        />

        {/* Metadata Panel */}
        {uiState.showMetadataPanel ? (
          <IssueMetadataPanel
            approver={metadata.approver}
            issue={issue}
            onApproverBlur={metadata.handleApproverBlur}
            onApproverChange={metadata.handleApproverChange}
            onOwnerChange={metadata.handleOwnerChange}
            onStatusChange={metadata.handleStatusChange}
            onTargetBranchBlur={metadata.handleTargetBranchBlur}
            onTargetBranchChange={metadata.handleTargetBranchChange}
            onTargetRepoBlur={metadata.handleTargetRepoBlur}
            onTargetRepoChange={metadata.handleTargetRepoChange}
            owner={metadata.owner}
            status={metadata.status}
            targetBranch={metadata.targetBranch}
            targetRepo={metadata.targetRepo}
            teamMembers={metadata.teamMembers}
          />
        ) : null}
      </div>

      {/* Rename Dialog */}
      <RenameDialog
        currentFileName={issue.fileName ?? ""}
        currentTitle={issue.title}
        description="Update the title and file name for this issue."
        isPending={isPending}
        onOpenChange={setShowRenameDialog}
        onRename={actions.handleRename}
        open={showRenameDialog}
        title="Rename Issue"
      />

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        isPending={isPending}
        itemName={issue.title}
        onConfirm={actions.handleDelete}
        onOpenChange={uiState.setShowDeleteDialog}
        open={uiState.showDeleteDialog}
        title="Issue"
      />
    </div>
  );
}
