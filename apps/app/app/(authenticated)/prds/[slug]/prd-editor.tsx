"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import {
  type DocumentDetail,
  DocumentType,
} from "@repo/api/src/types/document";
import { EntityType } from "@repo/api/src/types/entity-link";
import { InlinePresence, OptionalDocumentRoom } from "@repo/collaboration";
import {
  ResizablePanel,
  ResizablePanelGroup,
} from "@repo/design-system/components/ui/resizable";
import { RichTextToolbar } from "@repo/rich-text/rich-text-toolbar";
import { Loader2Icon } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import { NewPlanModal } from "@/app/(authenticated)/implementation-plans/components/new-plan-modal";
import { VersionSelector } from "@/app/(authenticated)/implementation-plans/components/version-selector";
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
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";
import { ExecutionLogDialog } from "@/components/execution-log/execution-log-dialog";
import { GenerationStatusBanner } from "@/components/generation-status-banner";
import { MoveEntityDialog } from "@/components/move-entity-dialog";
import { RenameDialog } from "@/components/rename-dialog";
import { useDocumentActions } from "@/hooks/document-editing/use-document-actions";
import { useDocumentContent } from "@/hooks/document-editing/use-document-content";
import { useDocumentMetadata } from "@/hooks/document-editing/use-document-metadata";
import { useDocumentUIState } from "@/hooks/document-editing/use-document-ui-state";
import { useEditorSession } from "@/hooks/document-editing/use-editor-session";
import { useInlineEditMode } from "@/hooks/document-editing/use-inline-edit-mode";
import { usePrdActions } from "@/hooks/document-editing/use-prd-actions";
import {
  useDismissDocumentGenerationStatus,
  useDocumentGenerationStatus,
} from "@/hooks/queries/use-documents";
import { usePrdJudgesFeedback } from "@/hooks/queries/use-judges";
import { useExecutionLogDialog } from "@/hooks/use-execution-log-dialog";
import { RequestChangesModal } from "../../implementation-plans/components/request-changes-modal";
import { AssociatedArtifactsSection } from "./components/associated-artifacts-section";
import { PRDEditorHeader } from "./components/prd-editor-header";
import { PRDMetadataBar } from "./components/prd-metadata-bar";

type PRDEditorProps = {
  prd: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
};

export function PRDEditor({
  prd,
  currentVersion,
  onVersionChange,
}: Readonly<PRDEditorProps>) {
  const chatFlag = useFeatureFlag("interactive-chat");
  const executionLogDialog = useExecutionLogDialog();

  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showComments, setShowComments] = useState(true);

  // Fetch generation status with adaptive polling (stops when terminal)
  const { data: generationStatus, invalidateCache: invalidateArtifactCache } =
    useDocumentGenerationStatus(prd.id, { polling: true });
  const dismissGenerationStatus = useDismissDocumentGenerationStatus();

  const { data: judgesReport } = usePrdJudgesFeedback(prd.id);

  const session = useEditorSession({
    artifact: prd,
    currentVersion,
    onVersionChange,
  });
  const contentController = useDocumentContent({
    artifact: prd,
    isLatestVersion: currentVersion === prd.latestVersion,
    setEditorContent: session.setEditorContent,
    onVersionCreated: (updatedArtifact) =>
      onVersionChange(updatedArtifact.version.version),
  });
  const metadata = useDocumentMetadata({
    artifact: prd,
  });
  const actions = useDocumentActions({
    artifact: prd,
    redirectPath: prd.project?.teams?.[0]?.id
      ? `/teams/${prd.project.teams[0].id}/projects/${prd.project.id}`
      : "/prds",
  });
  const uiState = useDocumentUIState({
    documentType: DocumentType.Prd,
  });
  const prdActions = usePrdActions({ documentId: prd.id });
  const editMode = useInlineEditMode({
    readOnly: session.isViewingHistorical,
    editor: session.editor,
  });

  // Type assertion: useDocumentUIState returns a union; narrow to the PRD/Feature branch
  const {
    showRenameDialog,
    setShowRenameDialog,
    openRenameDialog,
    showGeneratePlanModal,
    setShowGeneratePlanModal,
    openGeneratePlanModal,
    showRequestChangesModal,
    setShowRequestChangesModal,
    openRequestChangesModal,
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

  // Determine if any operation is pending
  const isPending =
    contentController.isSaving ||
    metadata.isUpdating ||
    actions.isDeleting ||
    actions.isRenaming;

  // Create version display component for header
  const versionDisplay = (
    <VersionSelector
      currentVersion={currentVersion}
      latestVersion={prd.latestVersion}
      onVersionChange={onVersionChange}
    />
  );

  return (
    <>
      {/* Header */}
      <PRDEditorHeader
        canShowPanel={chatFlag?.enabled === true}
        isEvaluating={prdActions.isEvaluating}
        isGenerating={prdActions.isGenerating}
        isPending={isPending}
        isRequestingChanges={prdActions.isRequestingChanges}
        onDecomposeFeatures={prdActions.handleDecomposeFeatures}
        onDelete={uiState.openDeleteDialog}
        onEvaluatePrd={prdActions.handleEvaluatePrd}
        onExport={actions.handleDownload}
        onGeneratePlan={openGeneratePlanModal}
        onGeneratePrd={prdActions.handleGeneratePrd}
        onMove={() => setShowMoveDialog(true)}
        onRename={openRenameDialog}
        onRequestChanges={openRequestChangesModal}
        onRestoreVersion={contentController.restoreVersion}
        onToggleMetadataPanel={uiState.toggleMetadataPanel}
        prd={prd}
        showRestore={session.isViewingHistorical}
      />

      {/* Content area: main content + chat panel on right */}
      <ResizablePanelGroup autoSaveId="prd-editor" direction="horizontal">
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
                      documentId: prd.id,
                      runKey,
                    });
                  }}
                  onGenerationComplete={invalidateArtifactCache}
                />

                <InlineEditEditorShell
                  expanded={editMode.isEditing || session.isViewingHistorical}
                  toolbar={
                    <EditorToolbarRow
                      leftContent={
                        <RichTextToolbar
                          className="border-0 bg-transparent p-0"
                          editor={session.editor}
                          hasLiveblocksExtension={!!session.liveblocksRoomId}
                          onPasteMarkdown={session.setEditorContent}
                          readOnly={!editMode.isEditing}
                        />
                      }
                      rightContent={
                        <>
                          {session.liveblocksRoomId && (
                            <Suspense fallback={null}>
                              <InlinePresence />
                            </Suspense>
                          )}
                          {versionDisplay}
                          <EditorToolbarActions
                            canRestoreVersion={true}
                            canSaveVersion={
                              currentVersion === prd.latestVersion
                            }
                            isRestoring={isPending}
                            isSaving={contentController.isSaving}
                            onRestoreVersion={contentController.restoreVersion}
                            onSaveVersion={contentController.saveContent}
                            onToggleComments={setShowComments}
                            openThreadCount={session.openThreadCount}
                            showComments={showComments}
                          />
                        </>
                      }
                    />
                  }
                >
                  <CollaborativeEditor
                    externalToolbar
                    headerContent={
                      <div className="space-y-4 px-5 pt-10">
                        <EditableDocumentTitle
                          documentId={prd.id}
                          initialTitle={prd.title}
                        />
                        <PRDMetadataBar
                          documentId={prd.id}
                          metadata={metadata}
                        />
                        <AttachmentsRow documentId={prd.id} />
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
                    showComments={editMode.isEditing && showComments}
                    value={contentController.content}
                  />
                </InlineEditEditorShell>

                <DocumentEditorDetails
                  createdAt={prd.version.createdAt}
                  documentId={prd.id}
                  updatedAt={prd.updatedAt}
                >
                  <EvaluationSection
                    documentId={prd.id}
                    judgeItems={judgesReport ?? null}
                    title="Agent Evaluation"
                  />
                  <AssociatedArtifactsSection prdId={prd.id} />
                </DocumentEditorDetails>
              </div>
            </OptionalDocumentRoom>
          </div>
        </ResizablePanel>

        <DocumentChatPanel
          document={prd}
          documentType="prd"
          onViewFullTrace={executionLogDialog.handleViewFullTrace}
          visible={chatFlag?.enabled === true && uiState.showMetadataPanel}
        />
      </ResizablePanelGroup>

      {/* Compute target selector for decompose command */}
      {prdActions.decomposeTargetState && (
        <LoopDispatchTargetSelector
          availableTargets={prdActions.decomposeTargetState.availableTargets}
          onSelect={(targetId) => {
            prdActions.clearDecomposeTargetState();
            prdActions.handleDecomposeFeatures(targetId);
          }}
        />
      )}

      {/* Execution Log Dialog */}
      <ExecutionLogDialog
        initialSessionId={executionLogDialog.selectedSessionId}
        onOpenChange={executionLogDialog.setDialogOpen}
        open={executionLogDialog.dialogOpen}
        trace={executionLogDialog.dialogTrace}
      />

      {/* Request Changes Modal */}
      <RequestChangesModal
        isSubmitting={prdActions.isRequestingChanges}
        onOpenChange={setShowRequestChangesModal}
        onSubmit={prdActions.handleRequestChanges}
        open={showRequestChangesModal}
      />

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
      <MoveEntityDialog
        entity={{
          id: prd.id,
          entityType: EntityType.Document,
          projectId: prd.projectId,
        }}
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
        source={{
          ...prd,
          sourceType: EntityType.Document,
        }}
      />
    </>
  );
}
