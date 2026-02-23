"use client";

import {
  type ArtifactDetail,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import { useState } from "react";
import { NewPlanModal } from "@/app/(authenticated)/implementation-plans/components/new-plan-modal";
import { VersionSelector } from "@/app/(authenticated)/implementation-plans/components/version-selector";
import { CollaborativeEditor } from "@/components/artifact-editor/collaborative-editor";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { MoveArtifactDialog } from "@/components/move-artifact-dialog";
import { RenameDialog } from "@/components/rename-dialog";
import { useArtifactActions } from "@/hooks/artifact-editing/use-artifact-actions";
import { useArtifactContent } from "@/hooks/artifact-editing/use-artifact-content";
import { useArtifactMetadata } from "@/hooks/artifact-editing/use-artifact-metadata";
import { useArtifactUIState } from "@/hooks/artifact-editing/use-artifact-ui-state";
import { useEditorSession } from "@/hooks/artifact-editing/use-editor-session";
import { PRDEditorHeader } from "./components/prd-editor-header";
import { PRDMetadataPanel } from "./components/prd-metadata-panel";

type PRDEditorProps = {
  prd: ArtifactDetail;
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
  const content = useArtifactContent({
    artifact: prd,
    onVersionCreated: () => {
      if (currentVersion !== latestVersion) {
        onVersionChange(latestVersion);
      }
    },
  });

  const session = useEditorSession({
    artifact: prd,
    currentVersion,
    latestVersion,
    content,
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
    artifactType: ArtifactType.Prd,
  });

  // Type assertion: useArtifactUIState returns a union; narrow to the PRD/Issue branch
  const {
    showRenameDialog,
    setShowRenameDialog,
    openRenameDialog,
    showGeneratePlanModal,
    setShowGeneratePlanModal,
    openGeneratePlanModal,
  } = uiState as Extract<
    ReturnType<typeof useArtifactUIState>,
    { showGeneratePlanModal: boolean }
  >;

  // Move dialog state
  const [showMoveDialog, setShowMoveDialog] = useState(false);

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
      onVersionChange={(version) => {
        session.exitEditMode();
        onVersionChange(version);
      }}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <PRDEditorHeader
        canEdit={!session.isViewingHistorical}
        isEditing={session.isEditing}
        isPending={isPending}
        isSaving={content.isSaving}
        lastSaved={content.lastSaved}
        onDelete={uiState.openDeleteDialog}
        onDiscard={session.handleDiscard}
        onEdit={session.handleEdit}
        onExport={actions.handleDownload}
        onGeneratePlan={openGeneratePlanModal}
        onMove={() => setShowMoveDialog(true)}
        onRename={openRenameDialog}
        onRestoreVersion={session.handleRestoreVersion}
        onSave={session.handlePublish}
        onToggleMetadataPanel={uiState.toggleMetadataPanel}
        openThreadCount={session.openThreadCount}
        prd={prd}
        showMetadataPanel={uiState.showMetadataPanel}
        showRestore={session.isViewingHistorical}
        status={metadata.status}
        versionDisplay={versionDisplay}
      />

      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: wraps TipTap rich text editor */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: wraps TipTap rich text editor */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        onClick={
          session.isEditing || session.isViewingHistorical
            ? undefined
            : session.handleEdit
        }
        onKeyDown={
          session.isEditing || session.isViewingHistorical
            ? undefined
            : session.handleEdit
        }
      >
        <CollaborativeEditor
          contentResetKey={session.contentResetKey}
          contentResetValue={session.contentResetValue}
          key={session.latestVersion}
          liveblocksRoomId={session.liveblocksRoomId}
          metadataPanel={
            <PRDMetadataPanel
              approver={metadata.approver}
              onApproverSelect={metadata.handleApproverSelect}
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
          }
          onChange={content.updateContent}
          onEditorInstance={session.handleEditorInstance}
          onOpenThreadCountChange={session.handleThreadCountChange}
          readOnly={!session.isEditing}
          showMetadataPanel={uiState.showMetadataPanel}
          value={content.content}
        />
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

      {/* Move Dialog */}
      <MoveArtifactDialog
        artifact={prd}
        onOpenChange={setShowMoveDialog}
        open={showMoveDialog}
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
        sourceArtifact={prd}
      />
    </div>
  );
}
