"use client";

import {
  ArtifactSubtype,
  type ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { generateArtifactRoomId } from "@repo/collaboration/room-utils";
import { useState } from "react";
import { NewPlanModal } from "@/app/(authenticated)/implementation-plans/components/new-plan-modal";
import { VersionSelector } from "@/app/(authenticated)/implementation-plans/components/version-selector";
import { CollaborativeEditor } from "@/components/artifact-editor/collaborative-editor";
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
  const [isEditing, setIsEditing] = useState(false);
  const [contentResetKey, setContentResetKey] = useState<number | undefined>(
    undefined
  );
  const [contentResetValue, setContentResetValue] = useState<
    string | undefined
  >(undefined);

  const isViewingHistorical = currentVersion !== latestVersion;
  // The existence of a room ID controls whether liveblocks is loaded.
  // Liveblocks can't function properly when the editor is read-only.
  const liveblocksRoomId =
    isEditing && prd.documentSlug
      ? generateArtifactRoomId(prd.organizationId, prd.documentSlug)
      : null;

  const exitEditMode = () => {
    setIsEditing(false);
    setContentResetKey(undefined);
    setContentResetValue(undefined);
  };

  // Use focused hooks instead of monolithic usePRDEditor
  const content = useArtifactContent({
    artifact: prd,
    onVersionCreated: () => {
      if (isViewingHistorical) {
        onVersionChange(latestVersion);
      }
    },
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
    artifactSubtype: ArtifactSubtype.Prd,
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
        exitEditMode();
        onVersionChange(version);
      }}
    />
  );

  const handleEdit = () => {
    if (!isViewingHistorical) {
      setIsEditing(true);
    }
  };

  const handleRestoreVersion = () => {
    setContentResetValue(prd.content ?? "");
    setContentResetKey((key) => (key ?? 0) + 1);
    setIsEditing(true);
  };

  const handlePublish = () => {
    content.saveContent();
    exitEditMode();
  };

  const handleDiscard = () => {
    if (content.hasUnsavedChanges) {
      content.discardChanges();
    }
    exitEditMode();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <PRDEditorHeader
        canEdit={!isViewingHistorical}
        isEditing={isEditing}
        isPending={isPending}
        isSaving={content.isSaving}
        lastSaved={content.lastSaved}
        onDelete={uiState.openDeleteDialog}
        onDiscard={handleDiscard}
        onEdit={handleEdit}
        onExport={actions.handleDownload}
        onGeneratePlan={openGeneratePlanModal}
        onRename={openRenameDialog}
        onRestoreVersion={handleRestoreVersion}
        onSave={handlePublish}
        onToggleMetadataPanel={uiState.toggleMetadataPanel}
        prd={prd}
        showMetadataPanel={uiState.showMetadataPanel}
        showRestore={isViewingHistorical}
        status={metadata.status}
        versionDisplay={versionDisplay}
      />

      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: wraps TipTap rich text editor */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: wraps TipTap rich text editor */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        onClick={isEditing || isViewingHistorical ? undefined : handleEdit}
        onKeyDown={isEditing || isViewingHistorical ? undefined : handleEdit}
      >
        <CollaborativeEditor
          contentResetKey={contentResetKey}
          contentResetValue={contentResetValue}
          liveblocksRoomId={liveblocksRoomId}
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
          readOnly={!isEditing}
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
