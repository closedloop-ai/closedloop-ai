"use client";

import {
  type ArtifactDetail,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import {
  ExternalLinkType,
  type PreviewDeploymentMetadata,
} from "@repo/api/src/types/external-link";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { useExternalLinksByWorkstream } from "@/hooks/queries/use-external-links";
import { useJudgesFeedback } from "@/hooks/queries/use-judges";
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

const PREVIEW_POLL_MAX_MS = 45 * 60_000;
const PREVIEW_POLL_FAST_MS = 15_000;
const PREVIEW_POLL_MEDIUM_MS = 30_000;
const PREVIEW_POLL_SLOW_MS = 60_000;

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
    data: previewLinks,
    refetch: refetchPreviewLinks,
    isRefetching: isRefreshingPreviewDeployment,
  } = useExternalLinksByWorkstream(
    workstreamId,
    ExternalLinkType.PreviewDeployment,
    {
      enabled: !!workstreamId,
    }
  );

  // Parse the first preview deployment external link into PreviewDeploymentMetadata
  const previewDeployment = useMemo(():
    | (PreviewDeploymentMetadata & {
        url: string | null;
      })
    | null => {
    const link = previewLinks?.find(
      (link) => link.type === ExternalLinkType.PreviewDeployment
    );
    if (!link) {
      return null;
    }
    const meta = link.metadata as PreviewDeploymentMetadata | null;
    return {
      state: meta?.state ?? null,
      environment: meta?.environment ?? null,
      ref: meta?.ref ?? null,
      sha: meta?.sha ?? null,
      url: link.externalUrl || null,
    };
  }, [previewLinks]);

  // Preview deployment polling
  const pollStartRef = useRef<number | null>(null);
  const pollStoppedRef = useRef(false);
  const emptyRefreshCountRef = useRef(0);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refetchRef = useRef(refetchPreviewLinks);
  refetchRef.current = refetchPreviewLinks;

  // Reset poll start when the PR changes (new execution = new deployment)
  const pullRequestNumber = pullRequest?.number;
  const prevPrRef = useRef(pullRequestNumber);
  if (prevPrRef.current !== pullRequestNumber) {
    prevPrRef.current = pullRequestNumber;
    pollStartRef.current = null;
    pollStoppedRef.current = false;
    emptyRefreshCountRef.current = 0;
  }

  // Poll for preview deployment status when a PR exists; stops on terminal states
  const previewState = previewDeployment?.state;
  const isGenerationRunning =
    generationStatus?.status &&
    ["RUNNING", "QUEUED", "IN_PROGRESS", "PENDING"].includes(
      generationStatus.status.toUpperCase()
    );
  useEffect(() => {
    const hasPreviewRef = !!previewDeployment?.ref;
    if (
      !(pullRequestNumber || hasPreviewRef || isGenerationRunning) ||
      pollStoppedRef.current
    ) {
      return;
    }

    const normalized = previewState?.toUpperCase();
    const isTerminal =
      normalized === "READY" ||
      normalized === "SUCCESS" ||
      normalized === "FAILURE" ||
      normalized === "ERROR" ||
      normalized === "INACTIVE";

    if (isTerminal) {
      return;
    }

    if (pollStartRef.current === null) {
      pollStartRef.current = Date.now();
    }

    function trackEmptyPollResponse() {
      emptyRefreshCountRef.current += 1;
      if (emptyRefreshCountRef.current >= 3) {
        pollStoppedRef.current = true;
      }
    }

    // Self-scheduling poll loop: each tick schedules the next via setTimeout
    function schedulePoll() {
      if (pollStoppedRef.current || pollStartRef.current === null) {
        return;
      }

      const elapsed = Date.now() - pollStartRef.current;
      if (elapsed > PREVIEW_POLL_MAX_MS) {
        return;
      }

      let interval = PREVIEW_POLL_SLOW_MS;
      if (elapsed < 5 * 60_000) {
        interval = PREVIEW_POLL_FAST_MS;
      } else if (elapsed < 15 * 60_000) {
        interval = PREVIEW_POLL_MEDIUM_MS;
      }

      pollTimeoutRef.current = setTimeout(async () => {
        try {
          const result = await refetchRef.current();
          if (result.data?.length) {
            emptyRefreshCountRef.current = 0;
          } else {
            trackEmptyPollResponse();
          }
        } catch (err) {
          console.warn("[preview-poll] refetch failed:", {
            message: err instanceof Error ? err.message : String(err),
          });
          trackEmptyPollResponse();
        }
        schedulePoll();
      }, interval);
    }

    schedulePoll();

    return () => {
      clearTimeout(pollTimeoutRef.current);
    };
  }, [
    pullRequestNumber,
    previewState,
    isGenerationRunning,
    previewDeployment?.ref,
  ]);

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
              onPreviewRefresh={async () => {
                await refetchPreviewLinks();
                return previewDeployment;
              }}
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
