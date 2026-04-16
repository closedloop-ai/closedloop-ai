"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import {
  type DocumentDetail,
  DocumentStatus,
  DocumentType,
  PullRequestState,
} from "@repo/api/src/types/document";
import { EntityType } from "@repo/api/src/types/entity-link";
import { InlinePresence, OptionalDocumentRoom } from "@repo/collaboration";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@repo/design-system/components/ui/resizable";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { TiptapToolbar } from "@repo/rich-text";
import { Loader2Icon } from "lucide-react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { BackendMismatchModal } from "@/components/backend-mismatch-modal";
import { DocumentChatDrawer } from "@/components/chat/DocumentChatDrawer";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { CollaborativeEditor } from "@/components/document-editor/collaborative-editor";
import { EditableDocumentTitle } from "@/components/document-editor/editable-document-title";
import { EditorToolbarActions } from "@/components/document-editor/editor-toolbar-actions";
import { EditorToolbarRow } from "@/components/document-editor/editor-toolbar-row";
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";
import { ExecutionLogDialog } from "@/components/execution-log/execution-log-dialog";
import { ExecutionLogSummary } from "@/components/execution-log/execution-log-summary";
import { GenerationStatusBanner } from "@/components/generation-status-banner";
import { MoveEntityDialog } from "@/components/move-entity-dialog";
import { useDocumentActions } from "@/hooks/document-editing/use-document-actions";
import { useDocumentContent } from "@/hooks/document-editing/use-document-content";
import { useDocumentMetadata } from "@/hooks/document-editing/use-document-metadata";
import { useDocumentUIState } from "@/hooks/document-editing/use-document-ui-state";
import { useEditorSession } from "@/hooks/document-editing/use-editor-session";
import { usePlanActions } from "@/hooks/document-editing/use-plan-actions";
import {
  useDismissDocumentGenerationStatus,
  useDocumentGenerationStatus,
  useDocumentPullRequest,
} from "@/hooks/queries/use-documents";
import { useWorkstreamPreviewDeployment } from "@/hooks/queries/use-external-links";
import {
  useCodeJudgesFeedback,
  usePlanJudgesFeedback,
} from "@/hooks/queries/use-judges";
import { useLoop } from "@/hooks/queries/use-loops";
import { useExecutionLogDialog } from "@/hooks/use-execution-log-dialog";
import { useMultiRepoPlanEnabled } from "@/hooks/use-multi-repo-plan-enabled";
import { usePreviewDeploymentPolling } from "@/hooks/use-preview-deployment-polling";
import { ExecutePlanModal } from "../components/execute-plan-modal";
import { RequestChangesModal } from "../components/request-changes-modal";
import { VersionSelector } from "../components/version-selector";
import { LinearExportDialog } from "./components/linear-export-dialog";
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
  const multiRepoEnabled = useMultiRepoPlanEnabled();
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
    redirectPath: plan.project?.teams?.[0]?.id
      ? `/teams/${plan.project.teams[0].id}/projects/${plan.project.id}`
      : "/implementation-plans",
  });
  const planActions = usePlanActions({
    documentId: plan.id,
    slug: plan.slug,
  });
  const uiState = useDocumentUIState({
    documentType: DocumentType.ImplementationPlan,
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

  // Fetch generation status with adaptive polling (stops when terminal)
  const { data: generationStatus, invalidateCache: invalidateArtifactCache } =
    useDocumentGenerationStatus(plan.id, { polling: true });
  const dismissGenerationStatus = useDismissDocumentGenerationStatus();

  // Fetch additionalRepos from the loop tied to the current generation status.
  // Returns loading: true while a known loopId is still in flight so the
  // regenerate modal can block confirmation rather than default to "no repos".
  const { initialAdditionalRepos, isLoadingInitialAdditionalRepos } =
    useInitialAdditionalRepos(generationStatus?.loopId);

  const { data: pullRequest } = useDocumentPullRequest(plan.id);
  const { data: judgesReport } = usePlanJudgesFeedback(plan.id);
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

  // Create version display component for header
  const versionDisplay = (
    <VersionSelector
      currentVersion={currentVersion}
      latestVersion={plan.latestVersion}
      onVersionChange={onVersionChange}
    />
  );

  const toolbarLeftContent = (
    <TiptapToolbar
      className="border-0 bg-transparent p-0"
      editor={session.editor}
      hasLiveblocksExtension={!!session.liveblocksRoomId}
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
      onRegenerate={() => {
        if (multiRepoEnabled) {
          setShowRegenerateModal(true);
        } else {
          planActions.handleRegenerate(undefined);
        }
      }}
      onRequestChanges={openRequestChangesModal}
      onRestoreVersion={contentController.restoreVersion}
      onToggleMetadataPanel={uiState.toggleMetadataPanel}
      plan={plan}
      pullRequest={pullRequest ?? null}
      showMetadataPanel={uiState.showMetadataPanel}
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
                {/* Toolbar Row */}
                <EditorToolbarRow
                  leftContent={toolbarLeftContent}
                  rightContent={toolbarRightContent}
                />

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

                <div className="flex min-h-[200px] flex-col">
                  <CollaborativeEditor
                    externalToolbar
                    headerContent={
                      <div className="space-y-4 px-5 pt-10">
                        <EditableDocumentTitle
                          documentId={plan.id}
                          initialTitle={plan.title}
                        />
                        <PlanMetadataBar metadata={metadata} />
                      </div>
                    }
                    key={currentVersion}
                    liveblocksRoomId={session.liveblocksRoomId}
                    onChange={contentController.updateContent}
                    onContentReady={session.handleEditorReady}
                    onEditorInstance={session.handleEditorInstance}
                    onOpenThreadCountChange={session.handleThreadCountChange}
                    placeholder="Add description..."
                    readOnly={session.isViewingHistorical}
                    showComments={showComments}
                    value={contentController.content}
                  />
                </div>

                {/* Details section */}
                <div className="border-t px-4 py-4">
                  <PlanMetadataPanel
                    additionalRepos={initialAdditionalRepos}
                    codeJudgeItems={codeJudgesReport ?? null}
                    generationStatus={generationStatus ?? null}
                    isPreviewRefreshing={isRefreshingPreviewDeployment}
                    judgeItems={judgesReport ?? null}
                    onPreviewRefresh={refetchPreviewLinks}
                    plan={plan}
                    previewDeployment={previewDeployment}
                    pullRequest={pullRequest ?? null}
                    variant="detailsOnly"
                  />
                </div>
              </div>
            </OptionalDocumentRoom>
          </div>
        </ResizablePanel>

        {/* Right panel: Chat + Execution Log tabs */}
        {chatFlag?.enabled === true && uiState.showMetadataPanel && (
          <>
            <ResizableHandle className="z-20 after:w-[3px]! hover:after:bg-primary" />
            <ResizablePanel defaultSize={25} maxSize={40} minSize={15}>
              <Tabs className="flex h-full flex-col" defaultValue="chat">
                <TabsList className="mx-3 mt-3 w-auto">
                  <TabsTrigger value="chat">Chat</TabsTrigger>
                  <TabsTrigger value="execution-log">Execution Log</TabsTrigger>
                </TabsList>
                <TabsContent
                  className="min-h-0 flex-1 overflow-hidden"
                  value="chat"
                >
                  <DocumentChatDrawer
                    documentId={plan.id}
                    documentSlug={plan.slug}
                    documentTitle={plan.title}
                    documentType="plan"
                  />
                </TabsContent>
                <TabsContent
                  className="min-h-0 flex-1 overflow-y-auto p-4"
                  value="execution-log"
                >
                  <ExecutionLogSummary
                    documentId={plan.id}
                    onViewFullTrace={executionLogDialog.handleViewFullTrace}
                  />
                </TabsContent>
              </Tabs>
            </ResizablePanel>
          </>
        )}
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
          entityType: EntityType.Document,
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

      {/* Execute Plan Modal */}
      <ExecutePlanModal
        isLoading={planActions.isExecuting}
        onConfirm={planActions.handleExecute}
        onOpenChange={setShowExecuteModal}
        open={showExecuteModal}
      />

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

function useInitialAdditionalRepos(loopId: string | null | undefined) {
  const enabled = Boolean(loopId);
  const { data: loop, isLoading } = useLoop(loopId ?? "", { enabled });
  return {
    initialAdditionalRepos: loop?.additionalRepos ?? undefined,
    isLoadingInitialAdditionalRepos: enabled && isLoading,
  };
}
