"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
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
import { ExecutePlanModal } from "@/app/(authenticated)/implementation-plans/components/execute-plan-modal";
import { VersionSelector } from "@/app/(authenticated)/implementation-plans/components/version-selector";
import { BackendMismatchModal } from "@/components/backend-mismatch-modal";
import { CustomFieldsSection } from "@/components/custom-fields/custom-fields-section";
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
import { MoveEntityDialog } from "@/components/move-entity-dialog";
import { useDocumentActions } from "@/hooks/document-editing/use-document-actions";
import { useDocumentContent } from "@/hooks/document-editing/use-document-content";
import { useDocumentMetadata } from "@/hooks/document-editing/use-document-metadata";
import { useDocumentUIState } from "@/hooks/document-editing/use-document-ui-state";
import { useEditorSession } from "@/hooks/document-editing/use-editor-session";
import { useInlineEditMode } from "@/hooks/document-editing/use-inline-edit-mode";
import { usePlanActions } from "@/hooks/document-editing/use-plan-actions";
import { useDocumentGenerationStatus } from "@/hooks/queries/use-documents";
import { useExecutionLogDialog } from "@/hooks/use-execution-log-dialog";
import { ContextSection } from "./components/context-section";
import { FeatureEditorHeader } from "./components/feature-editor-header";
import { FeatureMetadataBar } from "./components/feature-metadata-bar";
import { PlanSection } from "./components/plan-section";
import { useFeatureState } from "./use-feature-state";

type FeaturePageProps = {
  feature: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
};

export function FeaturePage({
  feature,
  currentVersion,
  onVersionChange,
}: Readonly<FeaturePageProps>) {
  const chatFlag = useFeatureFlag("interactive-chat");
  const executionLogDialog = useExecutionLogDialog();

  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showExecuteModal, setShowExecuteModal] = useState(false);
  const [showComments, setShowComments] = useState(true);

  const { hasPlan, isReady, linkedPlanId } = useFeatureState(feature);

  const session = useEditorSession({
    artifact: feature,
    currentVersion,
    onVersionChange,
  });
  const contentController = useDocumentContent({
    artifact: feature,
    isLatestVersion: currentVersion === feature.latestVersion,
    setEditorContent: session.setEditorContent,
    onVersionCreated: (updatedArtifact) =>
      onVersionChange(updatedArtifact.version.version),
  });
  const metadata = useDocumentMetadata({ artifact: feature });
  const actions = useDocumentActions({
    artifact: feature,
    redirectPath: getFeatureRedirectPath(feature),
  });
  const uiState = useDocumentUIState({ documentType: DocumentType.Feature });
  const editMode = useInlineEditMode({
    readOnly: session.isViewingHistorical,
    editor: session.editor,
  });
  const planActions = usePlanActions({ documentId: linkedPlanId });

  const { data: generationStatus } = useDocumentGenerationStatus(
    linkedPlanId ?? "",
    {
      enabled: !!linkedPlanId,
      polling: true,
    }
  );

  // Auto-reveal comments when threads reappear after being fully resolved.
  // Edge-triggered only (0 -> >0) so we don't override the user's manual toggle.
  const prevThreadCount = useRef(session.openThreadCount);
  useEffect(() => {
    if (prevThreadCount.current === 0 && session.openThreadCount > 0) {
      setShowComments(true);
    }
    prevThreadCount.current = session.openThreadCount;
  }, [session.openThreadCount]);

  return (
    <>
      <FeatureEditorHeader
        displayTitle={feature.title}
        feature={feature}
        hasPlan={hasPlan}
        isReady={isReady}
        onDelete={uiState.openDeleteDialog}
        onGeneratePlan={() => setShowGenerateModal(true)}
        onMoveToProject={() => setShowMoveDialog(true)}
        onStartBuild={() => setShowExecuteModal(true)}
        onToggleMetadataPanel={uiState.toggleMetadataPanel}
      />

      <ResizablePanelGroup autoSaveId="feature-editor" direction="horizontal">
        <ResizablePanel defaultSize={75} minSize={50}>
          <div className="h-full overflow-y-auto overflow-x-hidden bg-background">
            <OptionalDocumentRoom roomId={session.liveblocksRoomId}>
              <div
                className={
                  session.isEditorReady
                    ? "hidden"
                    : "flex flex-1 items-center justify-center py-24"
                }
              >
                <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>

              <div
                className={
                  session.isEditorReady
                    ? undefined
                    : "invisible h-0 overflow-hidden"
                }
              >
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
                          <VersionSelector
                            currentVersion={currentVersion}
                            latestVersion={feature.latestVersion}
                            onVersionChange={onVersionChange}
                          />
                          <EditorToolbarActions
                            canRestoreVersion={true}
                            canSaveVersion={
                              currentVersion === feature.latestVersion
                            }
                            isRestoring={contentController.isSaving}
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
                          documentId={feature.id}
                          initialTitle={feature.title}
                        />
                        <FeatureMetadataBar
                          documentId={feature.id}
                          metadata={metadata}
                        />
                        <AttachmentsRow documentId={feature.id} />
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
                  createdAt={feature.version.createdAt}
                  documentId={feature.id}
                  updatedAt={feature.updatedAt}
                >
                  <EvaluationSection
                    documentId={feature.id}
                    judgeItems={null}
                    title="Agent Evaluation"
                  />
                  <CustomFieldsSection
                    entityId={feature.id}
                    entityType={CustomFieldEntityType.Document}
                    values={feature.customFields}
                  />
                  <ContextSection
                    featureId={feature.id}
                    projectId={feature.projectId ?? undefined}
                  />
                  <PlanSection
                    feature={feature}
                    generationStatus={generationStatus}
                    onGenerateModalChange={setShowGenerateModal}
                    showGenerateModal={showGenerateModal}
                  />
                  <BranchesSection
                    documentId={feature.id}
                    generationStatus={generationStatus}
                    onStartBuild={() => setShowExecuteModal(true)}
                    planId={linkedPlanId}
                    projectId={feature.projectId ?? ""}
                  />
                  <PreviewSection documentId={feature.id} />
                </DocumentEditorDetails>
              </div>
            </OptionalDocumentRoom>
          </div>
        </ResizablePanel>

        <DocumentChatPanel
          document={feature}
          documentType="feature"
          onViewFullTrace={executionLogDialog.handleViewFullTrace}
          visible={chatFlag?.enabled === true && uiState.showMetadataPanel}
        />
      </ResizablePanelGroup>

      <ExecutionLogDialog
        initialSessionId={executionLogDialog.selectedSessionId}
        onOpenChange={executionLogDialog.setDialogOpen}
        open={executionLogDialog.dialogOpen}
        trace={executionLogDialog.dialogTrace}
      />

      <DeleteConfirmationDialog
        isPending={actions.isDeleting}
        itemName={feature.title}
        onConfirm={actions.handleDelete}
        onOpenChange={uiState.setShowDeleteDialog}
        open={uiState.showDeleteDialog}
        title="Feature"
      />

      <MoveEntityDialog
        entity={{
          id: feature.id,
          entityType: EntityType.Document,
          projectId: feature.projectId,
        }}
        onOpenChange={setShowMoveDialog}
        open={showMoveDialog}
        teamId={feature.project?.teams?.[0]?.id ?? null}
      />

      <ExecutePlanModal
        isLoading={planActions.isExecuting}
        onConfirm={planActions.handleExecute}
        onOpenChange={setShowExecuteModal}
        open={showExecuteModal}
      />

      {planActions.multiTargetState && (
        <div className="fixed right-4 bottom-4 z-50 rounded-lg border bg-background p-4 shadow-lg">
          <p className="mb-2 text-muted-foreground text-sm">
            Multiple compute targets are online. Select one:
          </p>
          <LoopDispatchTargetSelector
            availableTargets={planActions.multiTargetState.availableTargets}
            onSelect={planActions.selectTarget}
          />
        </div>
      )}

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

function getFeatureRedirectPath(feature: DocumentDetail): string {
  const teamId = feature.project?.teams?.[0]?.id;
  const projectId = feature.project?.id;
  if (teamId && projectId) {
    return `/teams/${teamId}/projects/${projectId}`;
  }
  return "/";
}
