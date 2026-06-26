"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { EvaluationSection } from "@repo/app/documents/components/evaluation-section";
import { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
import { GenerationStatusBanner } from "@repo/app/documents/components/generation-status-banner";
import { RenameDialog } from "@repo/app/documents/components/rename-dialog";
import {
  useDismissDocumentGenerationStatus,
  useDocumentGenerationStatus,
} from "@repo/app/documents/hooks/use-documents";
import { usePrdModals } from "@repo/app/documents/hooks/use-prd-modals";
import { usePrdJudgesFeedback } from "@repo/app/judges-analytics/hooks/use-judges";
import { NewPlanModal } from "@/app/(authenticated)/[orgSlug]/implementation-plans/components/new-plan-modal";
import { DocumentChatTab } from "@/components/document-editor/document-chat-tab";
import {
  DocumentEditorScaffold,
  type ScaffoldSlotContext,
} from "@/components/document-editor/document-editor-scaffold";
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";
import { usePrdActions } from "@/hooks/document-editing/use-prd-actions";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { RequestChangesModal } from "../../implementation-plans/components/request-changes-modal";
import { AssociatedArtifactsSection } from "./components/associated-artifacts-section";
import { PRDEditorHeader } from "./components/prd-editor-header";

type PRDEditorProps = {
  document: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
};

export function PRDEditor({
  document,
  currentVersion,
  onVersionChange,
}: Readonly<PRDEditorProps>) {
  const orgSlug = useOrgSlug();
  const prd = document;
  const prdActions = usePrdActions({ documentId: prd.id });
  const modals = usePrdModals();
  const { data: judgesReport } = usePrdJudgesFeedback(prd.id);

  const {
    data: generationStatus,
    isLoading: generationStatusLoading,
    invalidateCache: invalidateArtifactCache,
  } = useDocumentGenerationStatus(prd.id, { polling: true });
  const dismissGenerationStatus = useDismissDocumentGenerationStatus();

  const redirectPath = prd.project?.teams?.[0]?.id
    ? `/${orgSlug}/teams/${prd.project.teams[0].id}/projects/${prd.project.id}`
    : `/${orgSlug}/prds`;

  return (
    <DocumentEditorScaffold
      banner={() => (
        <GenerationStatusBanner
          generationStatus={generationStatus}
          isDismissFailurePending={dismissGenerationStatus.isPending}
          onDismissFailure={(runKey) => {
            dismissGenerationStatus.mutate({
              documentId: prd.id,
              runKey,
            });
          }}
          onGenerationComplete={invalidateArtifactCache}
        />
      )}
      currentVersion={currentVersion}
      deleteDialogTitle="PRD"
      detailsSections={() => (
        <>
          <EvaluationSection
            documentId={prd.id}
            judgeItems={judgesReport ?? null}
            title="Agent Evaluation"
          />
          <AssociatedArtifactsSection prdId={prd.id} />
        </>
      )}
      document={prd}
      feedArtifactType={FeedArtifactType.Prd}
      floatingChildren={(ctx) => (
        <PRDFloatingChildren
          ctx={ctx}
          generatePlanModal={modals.generatePlan}
          prd={prd}
          prdActions={prdActions}
          renameModal={modals.rename}
          requestChangesModal={modals.requestChanges}
        />
      )}
      onVersionChange={onVersionChange}
      redirectPath={redirectPath}
      renderChatTab={(ctx) => <DocumentChatTab document={ctx.document} />}
      renderHeader={(ctx) => (
        <PRDEditorHeader
          canShowPanel={ctx.chatEnabled || ctx.feedEnabled}
          generationStatus={generationStatus}
          generationStatusLoading={generationStatusLoading}
          isEvaluating={prdActions.isEvaluating}
          isGenerating={prdActions.isGenerating}
          isPending={ctx.isPending}
          isRequestingChanges={prdActions.isRequestingChanges}
          onDecomposeFeatures={prdActions.handleDecomposeFeatures}
          onDelete={ctx.chrome.openDeleteDialog}
          onEvaluatePrd={prdActions.handleEvaluatePrd}
          onExport={ctx.actions.handleDownload}
          onGeneratePlan={modals.generatePlan.openModal}
          onGeneratePrd={() => prdActions.handleGeneratePrd()}
          onMove={ctx.chrome.openMoveDialog}
          onRename={modals.rename.openModal}
          onRequestChanges={modals.requestChanges.openModal}
          onRestoreVersion={ctx.contentController.restoreVersion}
          onToggleMetadataPanel={ctx.chrome.toggleMetadataPanel}
          prd={prd}
          showRestore={ctx.session.isViewingHistorical}
        />
      )}
      resizableAutoSaveId="prd-editor"
    />
  );
}

type PRDFloatingChildrenProps = {
  ctx: ScaffoldSlotContext;
  prd: DocumentDetail;
  prdActions: ReturnType<typeof usePrdActions>;
  renameModal: ReturnType<typeof usePrdModals>["rename"];
  requestChangesModal: ReturnType<typeof usePrdModals>["requestChanges"];
  generatePlanModal: ReturnType<typeof usePrdModals>["generatePlan"];
};

function PRDFloatingChildren({
  ctx,
  prd,
  prdActions,
  renameModal,
  requestChangesModal,
  generatePlanModal,
}: Readonly<PRDFloatingChildrenProps>) {
  return (
    <>
      {prdActions.decomposeTargetState && (
        <LoopDispatchTargetSelector
          availableTargets={prdActions.decomposeTargetState.availableTargets}
          onSelect={(targetId) => {
            prdActions.clearDecomposeTargetState();
            prdActions.handleDecomposeFeatures(targetId);
          }}
        />
      )}
      <RequestChangesModal
        isSubmitting={prdActions.isRequestingChanges}
        onOpenChange={requestChangesModal.setOpen}
        onSubmit={prdActions.handleRequestChanges}
        open={requestChangesModal.open}
      />
      <RenameDialog
        currentFileName={prd.fileName ?? ""}
        currentTitle={prd.title}
        description="Update the title and file name for this PRD."
        isPending={ctx.isPending}
        onOpenChange={renameModal.setOpen}
        onRename={ctx.actions.handleRename}
        open={renameModal.open}
        title="Rename PRD"
      />
      <NewPlanModal
        key={generatePlanModal.mountKey}
        onOpenChange={generatePlanModal.onOpenChange}
        open={generatePlanModal.open}
        source={prd}
      />
    </>
  );
}
