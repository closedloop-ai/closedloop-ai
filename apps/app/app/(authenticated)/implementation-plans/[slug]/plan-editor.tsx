"use client";

import {
  ArtifactSubtype,
  type ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { generateArtifactRoomId } from "@repo/collaboration/room-utils";
import { useEffect, useRef, useState } from "react";
import { CollaborativeEditor } from "@/components/artifact-editor/collaborative-editor";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { GenerationStatusBanner } from "@/components/generation-status-banner";
import { useArtifactActions } from "@/hooks/artifact-editing/use-artifact-actions";
import { useArtifactContent } from "@/hooks/artifact-editing/use-artifact-content";
import { useArtifactMetadata } from "@/hooks/artifact-editing/use-artifact-metadata";
import { useArtifactUIState } from "@/hooks/artifact-editing/use-artifact-ui-state";
import { usePlanActions } from "@/hooks/artifact-editing/use-plan-actions";
import {
  useArtifactGenerationStatus,
  useArtifactPreviewDeployment,
  useArtifactPullRequest,
  useRefreshPreviewDeployment,
} from "@/hooks/queries/use-artifacts";
import { useJudgesFeedback } from "@/hooks/queries/use-judges";
import { ApiError } from "@/lib/api-error";
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

const PREVIEW_POLL_MAX_MS = 45 * 60_000;
const PREVIEW_POLL_FAST_MS = 15_000;
const PREVIEW_POLL_MEDIUM_MS = 30_000;
const PREVIEW_POLL_SLOW_MS = 60_000;

const POLL_STOP_STATUSES = new Set([401, 403, 429, 404, 422]);

async function executePollRefresh(
  refreshRef: React.MutableRefObject<() => Promise<unknown>>,
  emptyRefreshCountRef: React.MutableRefObject<number>,
  pollStoppedRef: React.MutableRefObject<boolean>
) {
  try {
    const result = await refreshRef.current();
    if (result) {
      emptyRefreshCountRef.current = 0;
    } else {
      emptyRefreshCountRef.current += 1;
      if (emptyRefreshCountRef.current >= 3) {
        pollStoppedRef.current = true;
      }
    }
  } catch (err) {
    const status = err instanceof ApiError ? err.status : undefined;
    if (status && POLL_STOP_STATUSES.has(status)) {
      pollStoppedRef.current = true;
    }
    console.warn("[preview-poll] refresh failed:", {
      status,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export function PlanEditor({
  plan,
  currentVersion,
  latestVersion,
  onVersionChange,
}: PlanEditorProps) {
  const [isEditing, setIsEditing] = useState(true);
  const [contentResetKey, setContentResetKey] = useState<number | undefined>();
  const [contentResetValue, setContentResetValue] = useState<
    string | undefined
  >();

  const isViewingHistorical = currentVersion !== latestVersion;
  // The existence of a room ID controls whether liveblocks is loaded.
  // Liveblocks can't function properly when the editor is read-only.
  const liveblocksRoomId =
    isEditing && plan.documentSlug
      ? generateArtifactRoomId(plan.organizationId, plan.documentSlug)
      : null;

  const exitEditMode = () => {
    setIsEditing(false);
    setContentResetKey(undefined);
    setContentResetValue(undefined);
  };

  // Use focused hooks instead of monolithic usePlanEditor
  const content = useArtifactContent({
    artifact: plan,
    onVersionCreated: () => {
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
    artifactSubtype: ArtifactSubtype.ImplementationPlan,
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
  const { data: judgesReport } = useJudgesFeedback(plan.id);

  // Preview deployment polling
  const { data: previewDeployment } = useArtifactPreviewDeployment(plan.id);
  const {
    mutateAsync: refreshPreviewDeployment,
    isPending: isRefreshingPreviewDeployment,
  } = useRefreshPreviewDeployment(plan.id);

  const pollStartRef = useRef<number | null>(null);
  const pollStoppedRef = useRef(false);
  const emptyRefreshCountRef = useRef(0);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refreshRef = useRef(refreshPreviewDeployment);
  refreshRef.current = refreshPreviewDeployment;

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
        await executePollRefresh(
          refreshRef,
          emptyRefreshCountRef,
          pollStoppedRef
        );
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

      <CollaborativeEditor
        contentResetKey={contentResetKey}
        contentResetValue={contentResetValue}
        liveblocksRoomId={liveblocksRoomId}
        metadataPanel={
          <PlanMetadataPanel
            approver={metadata.approver}
            generationStatus={generationStatus ?? null}
            isPreviewRefreshing={isRefreshingPreviewDeployment}
            judgesReport={judgesReport ?? null}
            onApproverSelect={metadata.handleApproverSelect}
            onOwnerChange={metadata.handleOwnerChange}
            onPreviewRefresh={async () => {
              const result = await refreshPreviewDeployment();
              return result ?? null;
            }}
            onStatusChange={metadata.handleStatusChange}
            owner={metadata.owner}
            plan={plan}
            previewDeployment={previewDeployment ?? null}
            pullRequest={pullRequest ?? null}
            status={metadata.status}
            teamMembers={metadata.teamMembers}
          />
        }
        onChange={content.updateContent}
        readOnly={!isEditing}
        showMetadataPanel={uiState.showMetadataPanel}
        value={content.content}
      />

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
