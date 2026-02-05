"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { OptionalArtifactRoom, Presence } from "@repo/collaboration";
import { generateArtifactRoomId } from "@repo/collaboration/room-utils";
import { useState } from "react";
import { NewPlanModal } from "@/app/(authenticated)/implementation-plans/components/new-plan-modal";
import { VersionSelector } from "@/app/(authenticated)/implementation-plans/components/version-selector";
import { EditorWithComments } from "@/components/artifact-editor/editor-with-comments";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { RenameDialog } from "@/components/rename-dialog";
import { useArtifactActions } from "@/hooks/artifact-editing/use-artifact-actions";
import { useArtifactContent } from "@/hooks/artifact-editing/use-artifact-content";
import { useArtifactMetadata } from "@/hooks/artifact-editing/use-artifact-metadata";
import { useArtifactUIState } from "@/hooks/artifact-editing/use-artifact-ui-state";
import { useOrganizationUsers } from "@/hooks/queries/use-users";
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

  const roomId =
    prd.documentSlug &&
    generateArtifactRoomId(prd.organizationId, prd.documentSlug);
  const isViewingHistorical = currentVersion !== latestVersion;
  const showCollaboration = isEditing;

  // Fetch organization users for @mentions in comments
  const { data: users } = useOrganizationUsers();

  const exitEditMode = () => {
    setIsEditing(false);
    setContentResetKey(undefined);
    setContentResetValue(undefined);
  };

  // Use focused hooks instead of monolithic usePRDEditor
  const content = useArtifactContent({
    artifact: prd,
    onVersionCreated: () => {
      exitEditMode();
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
    artifactType: "PRD",
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

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <PRDEditorHeader
        canEdit={!isViewingHistorical}
        isEditing={isEditing}
        isPending={isPending}
        isSaving={content.isSaving}
        lastSaved={content.lastSaved}
        onClose={exitEditMode}
        onDelete={uiState.openDeleteDialog}
        onEdit={handleEdit}
        onExport={actions.handleDownload}
        onGeneratePlan={openGeneratePlanModal}
        onRename={openRenameDialog}
        onRestoreVersion={handleRestoreVersion}
        onSave={content.saveContent}
        onToggleMetadataPanel={uiState.toggleMetadataPanel}
        prd={prd}
        showMetadataPanel={uiState.showMetadataPanel}
        showRestore={isViewingHistorical}
        status={metadata.status}
        versionDisplay={versionDisplay}
      />

      <OptionalArtifactRoom
        roomId={showCollaboration ? roomId : null}
        users={users}
      >
        {/* Presence Indicators */}
        {showCollaboration && <Presence />}

        {/* Content Area with Optional Metadata Panel */}
        <div className="flex min-h-0 flex-1">
          <EditorWithComments
            contentResetKey={contentResetKey}
            contentResetValue={contentResetValue}
            enableLiveblocks={showCollaboration}
            liveblocksRoomId={roomId}
            onChange={content.updateContent}
            placeholder="Start writing your PRD..."
            readOnly={!isEditing}
            scrollMode="outer"
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
      </OptionalArtifactRoom>

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
