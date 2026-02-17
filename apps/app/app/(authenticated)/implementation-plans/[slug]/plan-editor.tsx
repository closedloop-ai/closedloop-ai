"use client";

import {
  type ArtifactDetail,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import { useState } from "react";
import { CollaborativeEditor } from "@/components/artifact-editor/collaborative-editor";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { GenerationStatusBanner } from "@/components/generation-status-banner";
import { MoveArtifactDialog } from "@/components/move-artifact-dialog";
import { useArtifactActions } from "@/hooks/artifact-editing/use-artifact-actions";
import { useArtifactContent } from "@/hooks/artifact-editing/use-artifact-content";
import { useArtifactMetadata } from "@/hooks/artifact-editing/use-artifact-metadata";
import { useArtifactUIState } from "@/hooks/artifact-editing/use-artifact-ui-state";
import { useEditorSession } from "@/hooks/artifact-editing/use-editor-session";
import { usePlanActions } from "@/hooks/artifact-editing/use-plan-actions";
import {
  useArtifactGenerationStatus,
  useArtifactPullRequest,
} from "@/hooks/queries/use-artifacts";
import { useWorkstreamPreviewDeployment } from "@/hooks/queries/use-external-links";
import { useJudgesFeedback } from "@/hooks/queries/use-judges";
import { usePreviewDeploymentPolling } from "@/hooks/use-preview-deployment-polling";
import { ExecutePlanModal } from "../components/execute-plan-modal";
import { RequestChangesModal } from "../components/request-changes-modal";
import { VersionSelector } from "../components/version-selector";
import { LinearExportDialog } from "./components/linear-export-dialog";
import { PlanEditorHeader } from "./components/plan-editor-header";
import { PlanMetadataPanel } from "./components/plan-metadata-panel";

type PlanEditorProps = {
  plan: ArtifactDetail;
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
  const content = useArtifactContent({
    artifact: plan,
    onVersionCreated: () => {
      if (currentVersion !== latestVersion) {
        onVersionChange(latestVersion);
      }
    },
  });

  const session = useEditorSession({
    artifact: plan,
    currentVersion,
    latestVersion,
    content,
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
    artifactType: ArtifactType.ImplementationPlan,
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

  // Move dialog state
  const [showMoveDialog, setShowMoveDialog] = useState(false);

  // Fetch generation status and pull request data
  const { data: generationStatus } = useArtifactGenerationStatus(plan.id);
  const { data: pullRequest } = useArtifactPullRequest(plan.id);
  const { data: judgesReport } = useJudgesFeedback(plan.id);

  // Preview deployment via ExternalLink
  const workstreamId = plan.workstreamId ?? "";
  const {
    previewDeployment,
    refetch: refetchPreviewLinks,
    isRefetching: isRefreshingPreviewDeployment,
  } = useWorkstreamPreviewDeployment(workstreamId);

  // Adaptive polling for preview deployment status
  const isGenerationRunning = !!(
    generationStatus?.status &&
    ["RUNNING", "QUEUED", "IN_PROGRESS", "PENDING"].includes(
      generationStatus.status.toUpperCase()
    )
  );
  usePreviewDeploymentPolling({
    previewState: previewDeployment?.state ?? null,
    hasPreviewRef: !!previewDeployment?.ref,
    pullRequestNumber: pullRequest?.number,
    isGenerationRunning,
    refetch: refetchPreviewLinks,
  });

  // Derived state
  const isDraft = metadata.status === "DRAFT";
  const isApproved = metadata.status === "APPROVED";
  const isPending =
    content.isSaving ||
    metadata.isUpdating ||
    actions.isDeleting ||
    planActions.isApproving ||
    planActions.isRegenerating ||
    planActions.isExecuting ||
    planActions.isComputeModeLoading;

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
      <PlanEditorHeader
        canEdit={!session.isViewingHistorical}
        isApproved={isApproved}
        isDraft={isDraft}
        isEditing={session.isEditing}
        isExecuting={planActions.isExecuting}
        isPending={isPending}
        isSaving={content.isSaving}
        lastSaved={content.lastSaved}
        onApprove={planActions.handleApprove}
        onCopyMarkdown={actions.handleCopy}
        onDelete={uiState.openDeleteDialog}
        onDiscard={session.handleDiscard}
        onEdit={session.handleEdit}
        onExecute={openExecuteModal}
        onExportMarkdown={actions.handleDownload}
        onExportToLinear={openLinearExportDialog}
        onMove={() => setShowMoveDialog(true)}
        onRegenerate={planActions.handleRegenerate}
        onRequestChanges={openRequestChangesModal}
        onRestoreVersion={session.handleRestoreVersion}
        onSave={session.handlePublish}
        onToggleMetadataPanel={uiState.toggleMetadataPanel}
        openThreadCount={session.openThreadCount}
        plan={plan}
        pullRequest={pullRequest ?? null}
        showMetadataPanel={uiState.showMetadataPanel}
        showRestore={session.isViewingHistorical}
        status={metadata.status}
        versionDisplay={versionDisplay}
      />

      {/* Generation Status Banner */}
      <GenerationStatusBanner artifactId={plan.id} />

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
          liveblocksRoomId={session.liveblocksRoomId}
          metadataPanel={
            <PlanMetadataPanel
              approver={metadata.approver}
              generationStatus={generationStatus ?? null}
              isPreviewRefreshing={isRefreshingPreviewDeployment}
              judgesReport={judgesReport ?? null}
              onApproverSelect={metadata.handleApproverSelect}
              onOwnerChange={metadata.handleOwnerChange}
              onPreviewRefresh={refetchPreviewLinks}
              onStatusChange={metadata.handleStatusChange}
              owner={metadata.owner}
              plan={plan}
              previewDeployment={previewDeployment}
              pullRequest={pullRequest ?? null}
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

      {/* Move Dialog */}
      <MoveArtifactDialog
        artifact={plan}
        onOpenChange={setShowMoveDialog}
        open={showMoveDialog}
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
