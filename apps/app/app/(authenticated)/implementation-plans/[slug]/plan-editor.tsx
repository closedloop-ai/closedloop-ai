"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import {
  type ArtifactDetail,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import { InlinePresence, OptionalArtifactRoom } from "@repo/collaboration";
import { Button } from "@repo/design-system/components/ui/button";
import { Toggle } from "@repo/design-system/components/ui/toggle";
import { MessageSquareDotIcon } from "lucide-react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ArtifactChatPanel } from "@/components/artifact-editor/artifact-chat-panel";
import { CollaborativeEditor } from "@/components/artifact-editor/collaborative-editor";
import { EditorToolbarRow } from "@/components/artifact-editor/editor-toolbar-row";
import { MetadataPanel } from "@/components/artifact-editor/metadata-panel";
import { SaveIndicator } from "@/components/artifact-editor/save-indicator";
import { StatusMetadataSection } from "@/components/artifact-editor/status-metadata-section";
import { BackendMismatchModal } from "@/components/backend-mismatch-modal";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";
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
import {
  useCodeJudgesFeedback,
  useJudgesFeedback,
} from "@/hooks/queries/use-judges";
import { useOrganizationUsers } from "@/hooks/queries/use-users";
import { usePreviewDeploymentPolling } from "@/hooks/use-preview-deployment-polling";
import { transformApiUserToSelectUser } from "@/lib/user-utils";
import { ExecutePlanModal } from "../components/execute-plan-modal";
import { RequestChangesModal } from "../components/request-changes-modal";
import { VersionSelector } from "../components/version-selector";
import { LinearExportDialog } from "./components/linear-export-dialog";
import { PlanEditorHeader } from "./components/plan-editor-header";
import { PlanMetadataPanel } from "./components/plan-metadata-panel";

type PlanEditorProps = {
  plan: ArtifactDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
  showHeader?: boolean;
};

export function PlanEditor({
  plan,
  currentVersion,
  onVersionChange,
  showHeader = true,
}: Readonly<PlanEditorProps>) {
  const chatFlag = useFeatureFlag("the-one-flag");

  const contentController = useArtifactContent({
    artifact: plan,
    onVersionCreated: () => {
      if (currentVersion !== plan.latestVersion) {
        onVersionChange(plan.latestVersion);
      }
    },
  });

  const session = useEditorSession({
    artifact: plan,
    currentVersion,
    contentCallbacks: contentController,
    onVersionChange,
  });

  const metadata = useArtifactMetadata({
    artifact: plan,
  });

  const { data: orgUsers = [] } = useOrganizationUsers();
  const transformedOrgUsers = useMemo(
    () => orgUsers.map(transformApiUserToSelectUser),
    [orgUsers]
  );

  const actions = useArtifactActions({
    artifact: plan,
    redirectPath: plan.project?.teams?.[0]?.id
      ? `/teams/${plan.project.teams[0].id}/projects/${plan.project.id}`
      : "/implementation-plans",
  });

  const planActions = usePlanActions({
    artifactId: plan.id,
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
  } = uiState;

  // Move dialog state
  const [showMoveDialog, setShowMoveDialog] = useState(false);

  // Comments panel toggle state
  const [showComments, setShowComments] = useState(true);
  const prevThreadCount = useRef(session.openThreadCount);

  // Auto-reveal comments when threads reappear after being fully resolved
  useEffect(() => {
    if (prevThreadCount.current === 0 && session.openThreadCount > 0) {
      setShowComments(true);
    }
    prevThreadCount.current = session.openThreadCount;
  }, [session.openThreadCount]);

  // Fetch generation status and pull request data
  const { data: generationStatus } = useArtifactGenerationStatus(plan.id);
  const { data: pullRequest } = useArtifactPullRequest(plan.id);
  const { data: judgesReport } = useJudgesFeedback(plan.id);
  const { data: codeJudgesReport } = useCodeJudgesFeedback(plan.id);

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
  const isReadOnly = session.isEditing || session.isViewingHistorical;
  const isPending =
    contentController.isSaving ||
    metadata.isUpdating ||
    actions.isDeleting ||
    planActions.isApproving ||
    planActions.isRegenerating ||
    planActions.isExecuting;

  // Create version display component for header
  const versionDisplay = (
    <VersionSelector
      currentVersion={currentVersion}
      latestVersion={plan.latestVersion}
      onVersionChange={(version) => {
        session.exitEditMode();
        onVersionChange(version);
      }}
    />
  );

  const header = showHeader ? (
    <PlanEditorHeader
      canShowPanel={chatFlag?.enabled}
      isApproved={isApproved}
      isDraft={isDraft}
      isExecuting={planActions.isExecuting}
      isPending={isPending}
      onApprove={planActions.handleApprove}
      onCopyMarkdown={actions.handleCopy}
      onDelete={uiState.openDeleteDialog}
      onExecute={openExecuteModal}
      onExportMarkdown={actions.handleDownload}
      onExportToLinear={openLinearExportDialog}
      onMove={() => setShowMoveDialog(true)}
      onRegenerate={planActions.handleRegenerate}
      onRequestChanges={openRequestChangesModal}
      onRestoreVersion={session.handleRestoreVersion}
      onToggleMetadataPanel={uiState.toggleMetadataPanel}
      plan={plan}
      pullRequest={pullRequest ?? null}
      showMetadataPanel={uiState.showMetadataPanel}
      showRestore={session.isViewingHistorical}
    />
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {header}

      {/* Metadata bar below header */}
      <MetadataPanel className="pl-4" variant="bar">
        <StatusMetadataSection
          approver={metadata.approver}
          assignee={metadata.assignee}
          layout="horizontal"
          onApproverSelect={metadata.handleApproverSelect}
          onAssigneeChange={metadata.handleAssigneeChange}
          onStatusChange={metadata.handleStatusChange}
          orgUsers={transformedOrgUsers}
          status={metadata.status}
          teamMembers={metadata.teamMembers}
        />
      </MetadataPanel>

      {/* Content area: main content + chat panel on right */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <OptionalArtifactRoom roomId={session.liveblocksRoomId}>
            {/* Toolbar Row */}
            <EditorToolbarRow
              leftContent={
                <>
                  {session.isEditing && session.liveblocksRoomId && (
                    <Suspense fallback={null}>
                      <InlinePresence />
                    </Suspense>
                  )}
                  {versionDisplay}
                  <SaveIndicator
                    isSaving={contentController.isSaving}
                    lastSaved={contentController.lastSaved}
                  />
                </>
              }
              rightContent={
                <>
                  {session.openThreadCount > 0 && (
                    <Toggle
                      className="px-3"
                      onPressedChange={setShowComments}
                      pressed={showComments}
                      size="sm"
                      variant="outline"
                    >
                      <MessageSquareDotIcon className="h-4 w-4" />
                      {session.openThreadCount}
                    </Toggle>
                  )}
                  {session.isEditing ? (
                    <>
                      <Button
                        disabled={isPending}
                        onClick={session.handleDiscard}
                        size="sm"
                        variant="outline"
                      >
                        Discard
                      </Button>
                      <Button
                        disabled={isPending}
                        onClick={session.handlePublish}
                        size="sm"
                      >
                        {contentController.isSaving
                          ? "Publishing..."
                          : "Publish"}
                      </Button>
                    </>
                  ) : (
                    <Button
                      disabled={session.isViewingHistorical}
                      onClick={session.handleEdit}
                      size="sm"
                      variant="secondary"
                    >
                      Edit
                    </Button>
                  )}
                </>
              }
            />

            {/* Generation Status Banner */}
            <GenerationStatusBanner artifactId={plan.id} />

            {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: wraps TipTap rich text editor */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: wraps TipTap rich text editor */}
            <div
              className="flex min-h-[65vh] flex-col"
              onClick={isReadOnly ? undefined : session.handleEdit}
              onKeyDown={isReadOnly ? undefined : session.handleEdit}
            >
              <CollaborativeEditor
                contentResetKey={session.contentResetKey}
                contentResetValue={session.contentResetValue}
                key={currentVersion}
                liveblocksRoomId={session.liveblocksRoomId}
                onChange={contentController.updateContent}
                onEditorInstance={session.handleEditorInstance}
                onOpenThreadCountChange={session.handleThreadCountChange}
                readOnly={!session.isEditing}
                showComments={showComments}
                value={contentController.content}
              />
            </div>

            {/* Details section */}
            <div className="border-t px-4 py-4">
              <PlanMetadataPanel
                approver={metadata.approver}
                assignee={metadata.assignee}
                codeJudgeItems={codeJudgesReport ?? null}
                generationStatus={generationStatus ?? null}
                isPreviewRefreshing={isRefreshingPreviewDeployment}
                judgeItems={judgesReport ?? null}
                onApproverSelect={metadata.handleApproverSelect}
                onAssigneeChange={metadata.handleAssigneeChange}
                onPreviewRefresh={refetchPreviewLinks}
                onStatusChange={metadata.handleStatusChange}
                onTargetBranchBlur={metadata.handleTargetBranchBlur}
                onTargetBranchChange={metadata.handleTargetBranchChange}
                onTargetRepoBlur={metadata.handleTargetRepoBlur}
                onTargetRepoChange={metadata.handleTargetRepoChange}
                plan={plan}
                previewDeployment={previewDeployment}
                pullRequest={pullRequest ?? null}
                status={metadata.status}
                targetBranch={metadata.targetBranch}
                targetRepo={metadata.targetRepo}
                teamMembers={metadata.teamMembers}
                variant="detailsOnly"
              />
            </div>
          </OptionalArtifactRoom>
        </div>

        {/* Chat panel (replaces metadata sidebar) */}
        {chatFlag?.enabled !== false && uiState.showMetadataPanel && (
          <ArtifactChatPanel artifactId={plan.id} artifactType="plan" />
        )}
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

      <FloatingTargetPicker
        multiTargetState={planActions.multiTargetState}
        onSelect={planActions.selectTarget}
      />

      <BackendMismatchModal
        mismatchData={planActions.backendMismatchState}
        onConfirmOriginal={planActions.confirmOriginalBackend}
        onConfirmPreferred={planActions.confirmPreferredBackend}
        onOpenChange={(open) => {
          if (!open) {
            planActions.dismissBackendMismatch();
          }
        }}
        open={!!planActions.backendMismatchState}
      />
    </div>
  );
}

function FloatingTargetPicker({
  multiTargetState,
  onSelect,
}: {
  multiTargetState: {
    availableTargets: { id: string; machineName: string; status: string }[];
  } | null;
  onSelect: (targetId: string) => void;
}) {
  if (!multiTargetState) {
    return null;
  }
  return (
    <div className="fixed right-4 bottom-4 z-50 rounded-lg border bg-background p-4 shadow-lg">
      <p className="mb-2 text-muted-foreground text-sm">
        Multiple compute targets are online. Select one:
      </p>
      <LoopDispatchTargetSelector
        availableTargets={multiTargetState.availableTargets}
        onSelect={onSelect}
      />
    </div>
  );
}
