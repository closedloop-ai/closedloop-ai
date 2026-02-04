"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { OptionalArtifactRoom, Presence } from "@repo/collaboration";
import { generateArtifactRoomId } from "@repo/collaboration/room-utils";
import { useState } from "react";
import { EditorWithComments } from "@/components/artifact-editor/editor-with-comments";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { GenerationStatusBanner } from "@/components/generation-status-banner";
import { useArtifactActions } from "@/hooks/artifact-editing/use-artifact-actions";
import { useArtifactContent } from "@/hooks/artifact-editing/use-artifact-content";
import { useArtifactMetadata } from "@/hooks/artifact-editing/use-artifact-metadata";
import { useArtifactUIState } from "@/hooks/artifact-editing/use-artifact-ui-state";
import { usePlanActions } from "@/hooks/artifact-editing/use-plan-actions";
import {
  useArtifactGenerationStatus,
  useArtifactPullRequest,
} from "@/hooks/queries/use-artifacts";
import { mockPlanEvaluation } from "@/mocks/evaluation-data";
import { ExecutePlanModal } from "../components/execute-plan-modal";
import { RequestChangesModal } from "../components/request-changes-modal";
import { VersionSelector } from "../components/version-selector";
import { LinearExportDialog } from "./components/linear-export-dialog";
import { PlanEditorHeader } from "./components/plan-editor-header";
import { PlanMetadataPanel } from "./components/plan-metadata-panel";

type PlanEditorProps = {
  plan: ArtifactWithWorkstream;
  currentVersion: number;
  latestVersion: number;
  onVersionChange: (version: number) => void;
};

export function PlanEditor({
  plan,
  currentVersion,
  latestVersion,
  onVersionChange,
}: PlanEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [contentResetKey, setContentResetKey] = useState<number | undefined>();
  const [contentResetValue, setContentResetValue] = useState<
    string | undefined
  >();

  const roomId =
    plan.documentSlug &&
    generateArtifactRoomId(plan.organizationId, plan.documentSlug);
  const isViewingHistorical = currentVersion !== latestVersion;
  const showCollaboration = isEditing;

  const exitEditMode = () => {
    setIsEditing(false);
    setContentResetKey(undefined);
    setContentResetValue(undefined);
  };

  // Use focused hooks instead of monolithic usePlanEditor
  const content = useArtifactContent({
    artifact: plan,
    onVersionCreated: () => {
      exitEditMode();
      if (isViewingHistorical) {
        onVersionChange(latestVersion);
      }
    },
  });

  const metadata = useArtifactMetadata({
    artifact: plan,
  });

  const actions = useArtifactActions({
    artifact: plan,
    redirectPath: plan.project?.teams?.[0]?.id
      ? `/teams/${plan.project.teams[0].id}/projects/${plan.project.id}`
      : "/implementation-plans",
  });

  const planActions = usePlanActions({
    artifact: plan,
  });

  const uiState = useArtifactUIState({
    artifactType: "IMPLEMENTATION_PLAN",
  });

  // Type assertion for Plan-specific UI state
  const {
    showRequestChangesModal,
    setShowRequestChangesModal,
    openRequestChangesModal,
    showLinearExportDialog,
    setShowLinearExportDialog,
    openLinearExportDialog,
    showExecuteModal,
    setShowExecuteModal,
    openExecuteModal,
  } = uiState as Extract<
    ReturnType<typeof useArtifactUIState>,
    { showRequestChangesModal: boolean }
  >;

  // Fetch generation status and pull request data
  const { data: generationStatus } = useArtifactGenerationStatus(plan.id);
  const { data: pullRequest } = useArtifactPullRequest(plan.id);

  // Derived state
  const isDraft = metadata.status === "DRAFT";
  const isApproved = metadata.status === "APPROVED";
  const isPending =
    content.isSaving ||
    metadata.isUpdating ||
    actions.isDeleting ||
    planActions.isApproving ||
    planActions.isRegenerating ||
    planActions.isExecuting;

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
    setContentResetValue(plan.content ?? "");
    setContentResetKey((key) => (key ?? 0) + 1);
    setIsEditing(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <PlanEditorHeader
        canEdit={!isViewingHistorical}
        isApproved={isApproved}
        isDraft={isDraft}
        isEditing={isEditing}
        isExecuting={planActions.isExecuting}
        isPending={isPending}
        isSaving={content.isSaving}
        lastSaved={content.lastSaved}
        onApprove={planActions.handleApprove}
        onCopyMarkdown={actions.handleCopy}
        onDelete={uiState.openDeleteDialog}
        onEdit={handleEdit}
        onExecute={openExecuteModal}
        onExportMarkdown={actions.handleDownload}
        onExportToLinear={openLinearExportDialog}
        onRegenerate={planActions.handleRegenerate}
        onRequestChanges={openRequestChangesModal}
        onRestoreVersion={handleRestoreVersion}
        onSave={content.saveContent}
        onToggleMetadataPanel={uiState.toggleMetadataPanel}
        plan={plan}
        pullRequest={pullRequest ?? null}
        showMetadataPanel={uiState.showMetadataPanel}
        showRestore={isViewingHistorical}
        status={metadata.status}
        versionDisplay={versionDisplay}
      />

      {/* Generation Status Banner */}
      <GenerationStatusBanner artifactId={plan.id} />

      <OptionalArtifactRoom roomId={showCollaboration ? roomId : null}>
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
            placeholder="Start writing your implementation plan..."
            readOnly={!isEditing}
            scrollMode="outer"
            value={content.content}
          />

          {/* Metadata Panel */}
          {uiState.showMetadataPanel ? (
            <PlanMetadataPanel
              approver={metadata.approver}
              evaluationResults={mockPlanEvaluation}
              generationStatus={generationStatus ?? null}
              onApproverBlur={metadata.handleApproverBlur}
              onApproverChange={metadata.handleApproverChange}
              onOwnerChange={metadata.handleOwnerChange}
              onStatusChange={metadata.handleStatusChange}
              owner={metadata.owner}
              plan={plan}
              pullRequest={pullRequest ?? null}
              status={metadata.status}
              teamMembers={metadata.teamMembers}
            />
          ) : null}
        </div>
      </OptionalArtifactRoom>

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        isPending={isPending}
        itemName={plan.title}
        onConfirm={actions.handleDelete}
        onOpenChange={uiState.setShowDeleteDialog}
        open={uiState.showDeleteDialog}
        title="Implementation Plan"
      />

      {/* Request Changes Modal */}
      <RequestChangesModal
        isSubmitting={planActions.isRequestingChanges}
        onOpenChange={setShowRequestChangesModal}
        onSubmit={planActions.handleRequestChanges}
        open={showRequestChangesModal}
      />

      {/* Linear Export Dialog */}
      <LinearExportDialog
        artifactId={plan.id}
        onOpenChange={setShowLinearExportDialog}
        open={showLinearExportDialog}
      />

      {/* Execute Plan Modal */}
      <ExecutePlanModal
        isLoading={planActions.isExecuting}
        onConfirm={planActions.handleExecute}
        onOpenChange={setShowExecuteModal}
        open={showExecuteModal}
      />
    </div>
  );
}
