"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import {
  type DocumentDetail,
  DocumentStatus,
  DocumentType,
  PullRequestState,
} from "@repo/api/src/types/document";
import { InlinePresence, OptionalDocumentRoom } from "@repo/collaboration";
import {
  ResizablePanel,
  ResizablePanelGroup,
} from "@repo/design-system/components/ui/resizable";
import { RichTextToolbar } from "@repo/rich-text/rich-text-toolbar";
import { Loader2Icon } from "lucide-react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { BackendMismatchModal } from "@/components/backend-mismatch-modal";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { AttachmentsRow } from "@/components/document-editor/attachments-row";
import { CollaborativeEditor } from "@/components/document-editor/collaborative-editor";
import { DocumentChatPanel } from "@/components/document-editor/document-chat-panel";
import { DocumentEditorDetails } from "@/components/document-editor/document-editor-details";
import { EditableDocumentTitle } from "@/components/document-editor/editable-document-title";
import { EditorToolbarActions } from "@/components/document-editor/editor-toolbar-actions";
import { EditorToolbarRow } from "@/components/document-editor/editor-toolbar-row";
import { EvaluationSection } from "@/components/document-editor/evaluation-section";
import { InlineEditEditorShell } from "@/components/document-editor/inline-edit-editor-shell";
import { BranchesSection } from "@/components/document-editor/relationships/branches-section";
import { PreviewSection } from "@/components/document-editor/relationships/preview-section";
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";
import { ExecutionLogDialog } from "@/components/execution-log/execution-log-dialog";
import { GenerationStatusBanner } from "@/components/generation-status-banner";
import { MoveEntityDialog } from "@/components/move-entity-dialog";
import { useDocumentActions } from "@/hooks/document-editing/use-document-actions";
import { useDocumentContent } from "@/hooks/document-editing/use-document-content";
import { useDocumentMetadata } from "@/hooks/document-editing/use-document-metadata";
import { useDocumentUIState } from "@/hooks/document-editing/use-document-ui-state";
import { useEditorSession } from "@/hooks/document-editing/use-editor-session";
import { useInlineEditMode } from "@/hooks/document-editing/use-inline-edit-mode";
import { usePlanActions } from "@/hooks/document-editing/use-plan-actions";
import {
  useDismissDocumentGenerationStatus,
  useDocumentGenerationStatus,
  useDocumentPullRequest,
  usePreviewDeployment,
} from "@/hooks/queries/use-documents";
import {
  useCodeJudgesFeedback,
  usePlanJudgesFeedback,
} from "@/hooks/queries/use-judges";
import { useInitialAdditionalRepos } from "@/hooks/queries/use-loops";
import { useExecutionLogDialog } from "@/hooks/use-execution-log-dialog";
import { useMultiRepoExecuteEnabled } from "@/hooks/use-multi-repo-execute-enabled";
import { usePreviewDeploymentPolling } from "@/hooks/use-preview-deployment-polling";
import { ExecutePlanModal } from "../components/execute-plan-modal";
import { RequestChangesModal } from "../components/request-changes-modal";
import { VersionSelector } from "../components/version-selector";
import { LinearExportDialog } from "./components/linear-export-dialog";
import { PlanContextSection } from "./components/plan-context-section";
import { PlanEditorHeader } from "./components/plan-editor-header";
import { PlanMetadataBar } from "./components/plan-metadata-bar";
import { PlanMetadataPanel } from "./components/plan-metadata-panel";
import { RegeneratePlanModal } from "./components/regenerate-plan-modal";

type PlanEditorProps = {
  plan: DocumentDetail;
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
  const chatFlag = useFeatureFlag("interactive-chat");
  const multiRepoEnabled = useMultiRepoExecuteEnabled();
  const executionLogDialog = useExecutionLogDialog();

  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showRegenerateModal, setShowRegenerateModal] = useState(false);
  const [showComments, setShowComments] = useState(true);

  const session = useEditorSession({
    artifact: plan,
    currentVersion,
    onVersionChange,
  });
  const contentController = useDocumentContent({
    artifact: plan,
    isLatestVersion: currentVersion === plan.latestVersion,
    setEditorContent: session.setEditorContent,
    onVersionCreated: (updatedArtifact) =>
      onVersionChange(updatedArtifact.version.version),
  });
  const metadata = useDocumentMetadata({
    artifact: plan,
  });
  const actions = useDocumentActions({
    artifact: plan,
    redirectPath: getPlanRedirectPath(plan),
  });
  const planActions = usePlanActions({
    documentId: plan.id,
    slug: plan.slug,
  });
  const uiState = useDocumentUIState({
    documentType: DocumentType.ImplementationPlan,
  });
  const editMode = useInlineEditMode({
    readOnly: session.isViewingHistorical,
    editor: session.editor,
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

  // Auto-reveal comments when threads reappear after being fully resolved.
  // Edge-triggered only (0 -> >0) so we don't override the user's manual toggle.
  const prevThreadCount = useRef(session.openThreadCount);
  useEffect(() => {
    if (prevThreadCount.current === 0 && session.openThreadCount > 0) {
      setShowComments(true);
    }
    prevThreadCount.current = session.openThreadCount;
  }, [session.openThreadCount]);

  // Comments are only visible while editing — they're meaningless in read-only view.
  const commentsVisible = resolveCommentsVisible(
    editMode.isEditing,
    showComments
  );
  const shellExpanded = resolveShellExpanded(
    editMode.isEditing,
    session.isViewingHistorical
  );

  // Fetch generation status with adaptive polling (stops when terminal)
  const { data: generationStatus, invalidateCache: invalidateArtifactCache } =
    useDocumentGenerationStatus(plan.id, { polling: true });
  const dismissGenerationStatus = useDismissDocumentGenerationStatus();

  // Fetch additionalRepos from the latest PLAN loop for this document.
  // generationStatus.loopId can point to newer non-PLAN loops (EVALUATE_PLAN,
  // EXECUTE, etc.) that intentionally omit plan-specific state like
  // additionalRepos — using it would cause regenerate to forget the last
  // plan's multi-repo selection.
  const { initialAdditionalRepos, isLoadingInitialAdditionalRepos } =
    useInitialAdditionalRepos(plan.id);

  const { data: pullRequest } = useDocumentPullRequest(plan.id);
  const { data: judgesReport } = usePlanJudgesFeedback(plan.id);
  const { data: codeJudgesReport } = useCodeJudgesFeedback(plan.id);

  // Preview deployment artifact (Artifact of type DEPLOYMENT)
  const {
    data: previewDeployment = null,
    refetch: refetchPreviewLinks,
    isRefetching: isRefreshingPreviewDeployment,
  } = usePreviewDeployment(plan.id);

  // Adaptive polling for preview deployment status
  const isGenerationRunning = !!(
    generationStatus?.status &&
    ["RUNNING", "QUEUED", "IN_PROGRESS", "PENDING"].includes(
      generationStatus.status.toUpperCase()
    )
  );
  usePreviewDeploymentPolling({
    previewState: previewDeployment?.status ?? null,
    hasPreviewRef: !!previewDeployment?.deployment.ref,
    pullRequestNumber: pullRequest?.number,
    isGenerationRunning,
    refetch: refetchPreviewLinks,
  });

  // Derived state
  const isDraft = metadata.status === DocumentStatus.Draft;
  const isApproved = metadata.status === DocumentStatus.Approved;
  const isPending =
    contentController.isSaving ||
    metadata.isUpdating ||
    actions.isDeleting ||
    planActions.isApproving ||
    planActions.isRegenerating ||
    planActions.isExecuting ||
    planActions.isEvaluatingPlan ||
    planActions.isEvaluatingCode;

  const canEvaluateCode =
    pullRequest?.state === PullRequestState.Open &&
    pullRequest.headBranch.length > 0;
  const evaluateCodeHandler = useCallback(() => {
    if (!(canEvaluateCode && pullRequest)) {
      return;
    }
    planActions.handleEvaluateCode(pullRequest.headBranch, plan.targetRepo);
  }, [
    canEvaluateCode,
    pullRequest,
    plan.targetRepo,
    planActions.handleEvaluateCode,
  ]);

  const handleRegenerate = useCallback(() => {
    if (multiRepoEnabled) {
      setShowRegenerateModal(true);
      return;
    }
    planActions.handleRegenerate(undefined);
  }, [multiRepoEnabled, planActions.handleRegenerate]);

  // Create version display component for header
  const versionDisplay = (
    <VersionSelector
      currentVersion={currentVersion}
      latestVersion={plan.latestVersion}
      onVersionChange={onVersionChange}
    />
  );

  const toolbarLeftContent = (
    <RichTextToolbar
      className="border-0 bg-transparent p-0"
      editor={session.editor}
      hasLiveblocksExtension={!!session.liveblocksRoomId}
      onPasteMarkdown={session.setEditorContent}
      readOnly={!editMode.isEditing}
    />
  );

  const toolbarRightContent = (
    <>
      {session.liveblocksRoomId && (
        <Suspense fallback={null}>
          <InlinePresence />
        </Suspense>
      )}
      {versionDisplay}
      <EditorToolbarActions
        canRestoreVersion={true}
        canSaveVersion={currentVersion === plan.latestVersion}
        isRestoring={isPending}
        isSaving={contentController.isSaving}
        onRestoreVersion={contentController.restoreVersion}
        onSaveVersion={contentController.saveContent}
        onToggleComments={setShowComments}
        openThreadCount={session.openThreadCount}
        showComments={showComments}
      />
    </>
  );

  const header = showHeader ? (
    <PlanEditorHeader
      canShowPanel={chatFlag?.enabled === true}
      isApproved={isApproved}
      isDraft={isDraft}
      isExecuting={planActions.isExecuting}
      isPending={isPending}
      onApprove={planActions.handleApprove}
      onCopyMarkdown={actions.handleCopy}
      onDelete={uiState.openDeleteDialog}
      onEvaluateCode={canEvaluateCode ? evaluateCodeHandler : undefined}
      onEvaluatePlan={planActions.handleEvaluatePlan}
      onExecute={openExecuteModal}
      onExportMarkdown={actions.handleDownload}
      onExportToLinear={openLinearExportDialog}
      onMove={() => setShowMoveDialog(true)}
      onRegenerate={handleRegenerate}
      onRequestChanges={openRequestChangesModal}
      onRestoreVersion={contentController.restoreVersion}
      onToggleMetadataPanel={uiState.toggleMetadataPanel}
      plan={plan}
      pullRequest={pullRequest ?? null}
      showRestore={session.isViewingHistorical}
    />
  ) : null;

  return (
    <>
      {header}

      {/* Content area: main content + chat panel on right */}
      <ResizablePanelGroup autoSaveId="plan-editor" direction="horizontal">
        <ResizablePanel defaultSize={75} minSize={50}>
          <div className="h-full overflow-y-auto overflow-x-hidden bg-background">
            <OptionalDocumentRoom roomId={session.liveblocksRoomId}>
              {/* Loading spinner — visible until editor content is fully loaded */}
              <div
                className={
                  session.isEditorReady
                    ? "hidden"
                    : "flex flex-1 items-center justify-center py-24"
                }
              >
                <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>

              {/* Content wrapper — hidden until Liveblocks Y.Doc sync completes */}
              <div
                className={
                  session.isEditorReady
                    ? undefined
                    : "invisible h-0 overflow-hidden"
                }
              >
                {/* Generation Status Banner */}
                <GenerationStatusBanner
                  generationStatus={generationStatus}
                  isDismissFailurePending={dismissGenerationStatus.isPending}
                  onDismissFailure={async (runKey) => {
                    await dismissGenerationStatus.mutateAsync({
                      documentId: plan.id,
                      runKey,
                    });
                  }}
                  onGenerationComplete={invalidateArtifactCache}
                />

                <InlineEditEditorShell
                  expanded={shellExpanded}
                  toolbar={
                    <EditorToolbarRow
                      leftContent={toolbarLeftContent}
                      rightContent={toolbarRightContent}
                    />
                  }
                >
                  <CollaborativeEditor
                    externalToolbar
                    headerContent={
                      <div className="space-y-4 px-5 pt-10">
                        <EditableDocumentTitle
                          documentId={plan.id}
                          initialTitle={plan.title}
                        />
                        <PlanMetadataBar
                          documentId={plan.id}
                          metadata={metadata}
                        />
                        <AttachmentsRow documentId={plan.id} />
                      </div>
                    }
                    key={currentVersion}
                    liveblocksRoomId={session.liveblocksRoomId}
                    onBodyClick={editMode.enterEditMode}
                    onChange={contentController.updateContent}
                    onContentReady={session.handleEditorReady}
                    onEditorInstance={session.handleEditorInstance}
                    onOpenThreadCountChange={session.handleThreadCountChange}
                    placeholder="Add description..."
                    readOnly={!editMode.isEditing}
                    showComments={commentsVisible}
                    value={contentController.content}
                  />
                </InlineEditEditorShell>

                <DocumentEditorDetails
                  createdAt={plan.version.createdAt}
                  documentId={plan.id}
                  updatedAt={plan.updatedAt}
                >
                  <EvaluationSection
                    documentId={plan.id}
                    judgeItems={judgesReport ?? null}
                    title="Agent Evaluation"
                  />
                  <PlanContextSection
                    planId={plan.id}
                    projectId={plan.projectId}
                  />
                  <BranchesSection
                    documentId={plan.id}
                    generationStatus={generationStatus}
                    onStartBuild={openExecuteModal}
                    planId={plan.id}
                    projectId={plan.projectId ?? ""}
                  />
                  <PreviewSection documentId={plan.id} />
                  <PlanMetadataPanel
                    additionalRepos={initialAdditionalRepos}
                    codeJudgeItems={codeJudgesReport ?? null}
                    generationStatus={generationStatus ?? null}
                    isPreviewRefreshing={isRefreshingPreviewDeployment}
                    onPreviewRefresh={refetchPreviewLinks}
                    plan={plan}
                    previewDeployment={previewDeployment}
                    pullRequest={pullRequest ?? null}
                  />
                </DocumentEditorDetails>
              </div>
            </OptionalDocumentRoom>
          </div>
        </ResizablePanel>

        <DocumentChatPanel
          document={plan}
          onViewFullTrace={executionLogDialog.handleViewFullTrace}
          visible={chatFlag?.enabled === true && uiState.showMetadataPanel}
        />
      </ResizablePanelGroup>

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
        documentId={plan.id}
        onOpenChange={setShowLinearExportDialog}
        open={showLinearExportDialog}
      />

      {/* Move Dialog */}
      <MoveEntityDialog
        entity={{
          id: plan.id,
          projectId: plan.projectId,
        }}
        onOpenChange={setShowMoveDialog}
        open={showMoveDialog}
      />

      {/* Execution Log Dialog */}
      <ExecutionLogDialog
        initialSessionId={executionLogDialog.selectedSessionId}
        onOpenChange={executionLogDialog.setDialogOpen}
        open={executionLogDialog.dialogOpen}
        trace={executionLogDialog.dialogTrace}
      />

      {/* Execute Plan Modal — conditionally mounted so each open is a fresh
          instance (no need to reset internal state on close). */}
      {showExecuteModal && (
        <ExecutePlanModal
          isLoading={planActions.isExecuting}
          onConfirm={planActions.handleExecute}
          onOpenChange={setShowExecuteModal}
          open={showExecuteModal}
          planId={plan.id}
        />
      )}

      {/* Regenerate Plan Modal — prompts the user to confirm the additional
          repos selection before regeneration, avoiding the race where a
          still-loading useLoop silently drops the repos. Only mounted when the
          multi-repo flag is on; otherwise onRegenerate calls handleRegenerate
          directly. */}
      {multiRepoEnabled && (
        <RegeneratePlanModal
          initialAdditionalRepos={initialAdditionalRepos}
          isLoadingInitialRepos={isLoadingInitialAdditionalRepos}
          isSubmitting={planActions.isRegenerating}
          key={plan.id}
          onConfirm={planActions.handleRegenerate}
          onOpenChange={setShowRegenerateModal}
          open={showRegenerateModal}
          targetRepo={plan.targetRepo ?? ""}
        />
      )}

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
    </>
  );
}

function FloatingTargetPicker({
  multiTargetState,
  onSelect,
}: Readonly<{
  multiTargetState: {
    availableTargets: { id: string; machineName: string; status: string }[];
  } | null;
  onSelect: (targetId: string) => void;
}>) {
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

function getPlanRedirectPath(plan: DocumentDetail): string {
  const teamId = plan.project?.teams?.[0]?.id;
  if (teamId) {
    return `/teams/${teamId}/projects/${plan.project?.id ?? ""}`;
  }
  return "/implementation-plans";
}

function resolveCommentsVisible(
  isEditing: boolean,
  userToggledOn: boolean
): boolean {
  return isEditing && userToggledOn;
}

function resolveShellExpanded(
  isEditing: boolean,
  isViewingHistorical: boolean
): boolean {
  return isEditing || isViewingHistorical;
}
