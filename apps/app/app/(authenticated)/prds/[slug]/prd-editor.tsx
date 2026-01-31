"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { NewPlanModal } from "@/app/(authenticated)/implementation-plans/components/new-plan-modal";
import { VersionSelector } from "@/app/(authenticated)/implementation-plans/components/version-selector";
import { EditorContent } from "@/components/artifact-editor/editor-content";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { RenameDialog } from "@/components/rename-dialog";
import { useArtifactActions } from "@/hooks/artifact-editing/use-artifact-actions";
import { useArtifactContent } from "@/hooks/artifact-editing/use-artifact-content";
import { useArtifactMetadata } from "@/hooks/artifact-editing/use-artifact-metadata";
import { useArtifactUIState } from "@/hooks/artifact-editing/use-artifact-ui-state";
import { PRDEditorHeader } from "./components/prd-editor-header";
import { PRDMetadataPanel } from "./components/prd-metadata-panel";

type PRDEditorProps = {
  prd: ArtifactWithWorkstream;
  currentVersion: number;
  latestVersion: number;
  onVersionChange: (version: number) => void;
};

export function PRDEditor({
  prd,
  currentVersion,
  latestVersion,
  onVersionChange,
}: PRDEditorProps) {
  // Use focused hooks instead of monolithic usePRDEditor
  const content = useArtifactContent({
    artifact: prd,
  });

  const metadata = useArtifactMetadata({
    artifact: prd,
  });

  const actions = useArtifactActions({
    artifact: prd,
    redirectPath: prd.project?.teams?.[0]?.id
      ? `/teams/${prd.project.teams[0].id}/projects/${prd.project.id}`
      : "/prds",
  });

  const uiState = useArtifactUIState({
    artifactType: "PRD",
  });

  // Type assertion for PRD-specific UI state
  // Since useArtifactUIState returns a union type based on artifactType,
  // TypeScript can't narrow it automatically. We assert the PRD type here.
  const {
    showRenameDialog,
    setShowRenameDialog,
    openRenameDialog,
    showGeneratePlanModal,
    setShowGeneratePlanModal,
    openGeneratePlanModal,
  } = uiState as Extract<
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
      <PRDEditorHeader
        isPending={isPending}
        isSaving={content.isSaving}
        lastSaved={content.lastSaved}
        onDelete={uiState.openDeleteDialog}
        onExport={actions.handleDownload}
        onGeneratePlan={openGeneratePlanModal}
        onRename={openRenameDialog}
        onSave={content.saveContent}
        onToggleMetadataPanel={uiState.toggleMetadataPanel}
        prd={prd}
        showMetadataPanel={uiState.showMetadataPanel}
        status={metadata.status}
        versionDisplay={versionDisplay}
      />

      {/* Content Area with Optional Metadata Panel */}
      <div className="flex min-h-0 flex-1">
        {/* Scrollable Editor */}
        <EditorContent
          onChange={content.updateContent}
          placeholder="Start writing your PRD..."
          value={content.content}
        />

        {/* Metadata Panel */}
        {uiState.showMetadataPanel ? (
          <PRDMetadataPanel
            approver={metadata.approver}
            onApproverBlur={metadata.handleApproverBlur}
            onApproverChange={metadata.handleApproverChange}
            onOwnerChange={metadata.handleOwnerChange}
            onStatusChange={metadata.handleStatusChange}
            onTargetBranchBlur={metadata.handleTargetBranchBlur}
            onTargetBranchChange={metadata.handleTargetBranchChange}
            onTargetRepoBlur={metadata.handleTargetRepoBlur}
            onTargetRepoChange={metadata.handleTargetRepoChange}
            owner={metadata.owner}
            prd={prd}
            status={metadata.status}
            targetBranch={metadata.targetBranch}
            targetRepo={metadata.targetRepo}
            teamMembers={metadata.teamMembers}
          />
        ) : null}
      </div>

      {/* Rename Dialog */}
      <RenameDialog
        currentFileName={prd.fileName ?? ""}
        currentTitle={prd.title}
        description="Update the title and file name for this PRD."
        isPending={isPending}
        onOpenChange={setShowRenameDialog}
        onRename={actions.handleRename}
        open={showRenameDialog}
        title="Rename PRD"
      />

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        isPending={isPending}
        itemName={prd.title}
        onConfirm={actions.handleDelete}
        onOpenChange={uiState.setShowDeleteDialog}
        open={uiState.showDeleteDialog}
        title="PRD"
      />

      {/* Generate Implementation Plan Modal */}
      <NewPlanModal
        onOpenChange={setShowGeneratePlanModal}
        open={showGeneratePlanModal}
        sourcePrd={prd}
      />
    </div>
  );
}
