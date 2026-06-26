"use client";

import {
  type DocumentDetail,
  DocumentStatus,
  getPrimaryRepoFromSnapshot,
  type PullRequestInfo,
  PullRequestState,
  pickPullRequestForRepo,
} from "@repo/api/src/types/document";
import { LoopCommand } from "@repo/api/src/types/loop";
import { BackendMismatchModal } from "@repo/app/compute/components/backend-mismatch-modal";
import { EvaluationSection } from "@repo/app/documents/components/evaluation-section";
import { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
import { GenerationStatusBanner } from "@repo/app/documents/components/generation-status-banner";
import { BranchesSection } from "@repo/app/documents/components/relationships/branches-section";
import { PreviewSection } from "@repo/app/documents/components/relationships/preview-section";
import {
  useDismissDocumentGenerationStatus,
  useDocumentGenerationStatus,
  useDocumentPullRequest,
} from "@repo/app/documents/hooks/use-documents";
import { usePlanModals } from "@repo/app/documents/hooks/use-plan-modals";
import {
  useCodeJudgesFeedback,
  usePlanJudgesFeedback,
} from "@repo/app/judges-analytics/hooks/use-judges";
import { useInitialAdditionalRepos } from "@repo/app/loops/hooks/use-loops";
import { useCallback } from "react";
import { DocumentChatTab } from "@/components/document-editor/document-chat-tab";
import { DocumentEditorScaffold } from "@/components/document-editor/document-editor-scaffold";
import { FloatingTargetPicker } from "@/components/engineer/floating-target-picker";
import { usePlanActions } from "@/hooks/document-editing/use-plan-actions";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { ExecutePlanModal } from "../components/execute-plan-modal";
import { RequestChangesModal } from "../components/request-changes-modal";
import { LinearExportDialog } from "./components/linear-export-dialog";
import { PlanContextSection } from "./components/plan-context-section";
import { PlanEditorHeader } from "./components/plan-editor-header";
import { PlanMetadataPanel } from "./components/plan-metadata-panel";
import { RegeneratePlanModal } from "./components/regenerate-plan-modal";

type PlanEditorProps = {
  document: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
};

export function PlanEditor({
  document,
  currentVersion,
  onVersionChange,
}: Readonly<PlanEditorProps>) {
  const plan = document;
  const orgSlug = useOrgSlug();

  const planActions = usePlanActions({ documentId: plan.id, slug: plan.slug });
  const modals = usePlanModals();

  const { initialAdditionalRepos } = useInitialAdditionalRepos(
    plan.id,
    LoopCommand.Plan
  );
  const { data: pullRequestsData } = useDocumentPullRequest(plan.id);
  const pullRequests = pullRequestsData ?? [];
  const planPrimaryRepo = getPrimaryRepoFromSnapshot(plan.repositorySnapshot);
  const primaryPr = pickPullRequestForRepo(
    pullRequests,
    planPrimaryRepo?.fullName ?? null
  );
  const { data: judgesReport } = usePlanJudgesFeedback(plan.id);
  const { data: codeJudgesReport } = useCodeJudgesFeedback(plan.id);

  const {
    data: generationStatus,
    isLoading: generationStatusLoading,
    invalidateCache: invalidateArtifactCache,
  } = useDocumentGenerationStatus(plan.id, { polling: true });
  const dismissGenerationStatus = useDismissDocumentGenerationStatus();

  const canEvaluateCode = isPrEvaluatable(primaryPr);
  const evaluateCodeHandler = useCallback(() => {
    if (!(canEvaluateCode && primaryPr?.repoFullName)) {
      return;
    }
    planActions.handleEvaluateCode(
      primaryPr.headBranch,
      primaryPr.repoFullName
    );
  }, [canEvaluateCode, primaryPr, planActions.handleEvaluateCode]);

  const handleRegenerate = useCallback(() => {
    modals.regenerate.openModal();
  }, [modals.regenerate.openModal]);

  const redirectPath = getPlanRedirectPath(plan, orgSlug);

  const extraPending =
    planActions.isApproving ||
    planActions.isRegenerating ||
    planActions.isExecuting ||
    planActions.isEvaluatingPlan ||
    planActions.isEvaluatingCode;

  return (
    <DocumentEditorScaffold
      banner={() => (
        <GenerationStatusBanner
          generationStatus={generationStatus}
          isDismissFailurePending={dismissGenerationStatus.isPending}
          onDismissFailure={(runKey) => {
            dismissGenerationStatus.mutate({
              documentId: plan.id,
              runKey,
            });
          }}
          onGenerationComplete={invalidateArtifactCache}
        />
      )}
      currentVersion={currentVersion}
      deleteDialogTitle="Implementation Plan"
      detailsSections={() => (
        <>
          <EvaluationSection
            documentId={plan.id}
            judgeItems={judgesReport ?? null}
            title="Agent Evaluation"
          />
          <PlanContextSection planId={plan.id} projectId={plan.projectId} />
          <BranchesSection
            documentId={plan.id}
            generationStatus={generationStatus}
            onStartBuild={modals.execute.openModal}
            planId={plan.id}
            projectId={plan.projectId ?? ""}
          />
          <PreviewSection documentId={plan.id} />
          <PlanMetadataPanel
            additionalRepos={initialAdditionalRepos}
            codeJudgeItems={codeJudgesReport ?? null}
            generationStatus={generationStatus ?? null}
            plan={plan}
          />
        </>
      )}
      document={plan}
      extraPending={extraPending}
      feedArtifactType={FeedArtifactType.Plan}
      floatingChildren={() => (
        <PlanFloatingChildren
          executeModal={modals.execute}
          linearExportModal={modals.linearExport}
          plan={plan}
          planActions={planActions}
          planPrimaryRepoFullName={planPrimaryRepo?.fullName ?? ""}
          regenerateModal={modals.regenerate}
          requestChangesModal={modals.requestChanges}
        />
      )}
      onVersionChange={onVersionChange}
      redirectPath={redirectPath}
      renderChatTab={(ctx) => <DocumentChatTab document={ctx.document} />}
      renderHeader={(ctx) => (
        <PlanEditorHeader
          canShowPanel={ctx.chatEnabled || ctx.feedEnabled}
          generationStatus={generationStatus}
          generationStatusLoading={generationStatusLoading}
          isApproved={ctx.metadata.status === DocumentStatus.Approved}
          isDraft={ctx.metadata.status === DocumentStatus.Draft}
          isExecuting={planActions.isExecuting}
          isPending={ctx.isPending}
          onApprove={planActions.handleApprove}
          onCopyMarkdown={ctx.actions.handleCopy}
          onDelete={ctx.chrome.openDeleteDialog}
          onEvaluateCode={canEvaluateCode ? evaluateCodeHandler : undefined}
          onEvaluatePlan={planActions.handleEvaluatePlan}
          onExecute={modals.execute.openModal}
          onExportMarkdown={ctx.actions.handleDownload}
          onExportToLinear={modals.linearExport.openModal}
          onMove={ctx.chrome.openMoveDialog}
          onRegenerate={handleRegenerate}
          onRequestChanges={modals.requestChanges.openModal}
          onRestoreVersion={ctx.contentController.restoreVersion}
          onToggleMetadataPanel={ctx.chrome.toggleMetadataPanel}
          plan={plan}
          pullRequests={pullRequests}
          showRestore={ctx.session.isViewingHistorical}
        />
      )}
      resizableAutoSaveId="plan-editor"
    />
  );
}

function isPrEvaluatable(pr: PullRequestInfo | null): boolean {
  return (
    pr?.state === PullRequestState.Open &&
    pr.headBranch.length > 0 &&
    Boolean(pr.repoFullName)
  );
}

function getPlanRedirectPath(plan: DocumentDetail, orgSlug: string): string {
  const teamId = plan.project?.teams?.[0]?.id;
  if (teamId) {
    return `/${orgSlug}/teams/${teamId}/projects/${plan.project?.id ?? ""}`;
  }
  return `/${orgSlug}/implementation-plans`;
}

type PlanFloatingChildrenProps = {
  plan: DocumentDetail;
  planActions: ReturnType<typeof usePlanActions>;
  planPrimaryRepoFullName: string;
  executeModal: ReturnType<typeof usePlanModals>["execute"];
  requestChangesModal: ReturnType<typeof usePlanModals>["requestChanges"];
  linearExportModal: ReturnType<typeof usePlanModals>["linearExport"];
  regenerateModal: ReturnType<typeof usePlanModals>["regenerate"];
};

function PlanFloatingChildren({
  plan,
  planActions,
  planPrimaryRepoFullName,
  executeModal,
  requestChangesModal,
  linearExportModal,
  regenerateModal,
}: Readonly<PlanFloatingChildrenProps>) {
  return (
    <>
      <RequestChangesModal
        isSubmitting={planActions.isRequestingChanges}
        onOpenChange={requestChangesModal.setOpen}
        onSubmit={planActions.handleRequestChanges}
        open={requestChangesModal.open}
      />
      <LinearExportDialog
        documentId={plan.id}
        onOpenChange={linearExportModal.setOpen}
        open={linearExportModal.open}
      />
      {executeModal.open && (
        <ExecutePlanModal
          isLoading={planActions.isExecuting}
          onConfirm={planActions.handleExecute}
          onOpenChange={executeModal.setOpen}
          open={executeModal.open}
          planId={plan.id}
        />
      )}
      <RegeneratePlanModal
        isSubmitting={planActions.isRegenerating}
        key={plan.id}
        onConfirm={planActions.handleRegenerate}
        onOpenChange={regenerateModal.setOpen}
        open={regenerateModal.open}
        planId={plan.id}
        projectId={plan.projectId ?? undefined}
        targetRepo={planPrimaryRepoFullName}
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
    </>
  );
}
