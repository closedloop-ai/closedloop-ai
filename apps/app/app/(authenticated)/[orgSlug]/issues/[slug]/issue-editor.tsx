"use client";

import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { BackendMismatchModal } from "@repo/app/compute/components/backend-mismatch-modal";
import { CustomFieldsSection } from "@repo/app/custom-fields/components/custom-fields-section";
import { DocumentEditorScaffold } from "@repo/app/documents/components/document-editor-scaffold";
import { EvaluationSection } from "@repo/app/documents/components/evaluation-section";
import { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
import { BranchesSection } from "@repo/app/documents/components/relationships/branches-section";
import { PreviewSection } from "@repo/app/documents/components/relationships/preview-section";
import { useCommentPermalinkBuilder } from "@repo/app/documents/components/use-comment-permalink-builder";
import { useDocumentGenerationStatus } from "@repo/app/documents/hooks/use-documents";
import { useFeatureModals } from "@repo/app/documents/hooks/use-feature-modals";
import { useFeatureJudgesFeedback } from "@repo/app/judges-analytics/hooks/use-judges";
import { resolveFeatureJudgesRefetchInterval } from "@repo/app/judges-analytics/lib/feature-judges-refetch";
import { useEffect, useRef } from "react";
import { ExecutePlanModal } from "@/app/(authenticated)/[orgSlug]/implementation-plans/components/execute-plan-modal";
import { ArtifactRunInFlightSlot } from "@/components/document-editor/artifact-run-in-flight-slot";
import {
  renderDocumentChatPanelSlot,
  renderDocumentChatTabSlot,
} from "@/components/document-editor/document-editor-chat-slots";
import {
  FloatingTargetPicker,
  resolveFloatingTargetPickerSource,
} from "@/components/engineer/floating-target-picker";
import { useFeatureActions } from "@/hooks/document-editing/use-feature-actions";
import { usePlanActions } from "@/hooks/document-editing/use-plan-actions";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { ContextSection } from "./components/context-section";
import { IssueEditorHeader } from "./components/issue-editor-header";
import { PlanSection } from "./components/plan-section";
import { useIssueState } from "./use-issue-state";

type IssueEditorProps = {
  document: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
};

export function IssueEditor({
  document,
  currentVersion,
  onVersionChange,
}: Readonly<IssueEditorProps>) {
  const feature = document;
  const orgSlug = useOrgSlug();
  const { hasPlan, isReady, linkedPlanId } = useIssueState(feature);

  const planActions = usePlanActions({ documentId: linkedPlanId });
  const featureActions = useFeatureActions({ documentId: feature.id });
  const modals = useFeatureModals();

  const { data: generationStatus } = useDocumentGenerationStatus(
    linkedPlanId ?? "",
    { enabled: !!linkedPlanId, polling: true }
  );
  const {
    data: featureGenerationStatus,
    isLoading: featureGenerationStatusLoading,
  } = useDocumentGenerationStatus(feature.id, { polling: true });

  // Feature judge feedback materializes server-side slightly after the
  // evaluate_feature loop reports SUCCESS. Poll the judges report until the
  // completed run's feedback appears so the refetch is not a single-shot race
  // that strands the user on the empty state (FEA-3899).
  const { data: judgesReport, refetch: refetchJudgesReport } =
    useFeatureJudgesFeedback(feature.id, {
      refetchInterval: (query) =>
        resolveFeatureJudgesRefetchInterval({
          generationStatus: featureGenerationStatus,
          judges: query.state.data,
          queryStatus: query.state.status,
          nowMs: Date.now(),
        }),
    });

  const activeTargetPicker = resolveFloatingTargetPickerSource(
    {
      multiTargetState: featureActions.multiTargetState,
      onSelect: featureActions.selectTarget,
    },
    {
      multiTargetState: planActions.multiTargetState,
      onSelect: planActions.selectTarget,
    }
  );

  // Refetch the feature evaluation judges when an evaluate-feature loop
  // succeeds. Edge-triggered on the latest run key.
  const latestRefetchedEvaluationRunKey = useRef<string | null>(null);
  useEffect(() => {
    const runKey =
      featureGenerationStatus?.runKey ??
      featureGenerationStatus?.loopId ??
      featureGenerationStatus?.correlationId ??
      null;
    if (
      featureGenerationStatus?.command !== RunLoopCommand.EvaluateFeature ||
      featureGenerationStatus.status !== "SUCCESS" ||
      !runKey ||
      latestRefetchedEvaluationRunKey.current === runKey
    ) {
      return;
    }
    latestRefetchedEvaluationRunKey.current = runKey;
    refetchJudgesReport().catch(() => undefined);
  }, [featureGenerationStatus, refetchJudgesReport]);

  const redirectPath = getFeatureRedirectPath(feature, orgSlug);
  const buildPermalinkUrl = useCommentPermalinkBuilder({
    documentType: feature.type,
    documentSlug: feature.slug,
    orgSlug,
  });

  return (
    <DocumentEditorScaffold
      buildPermalinkUrl={buildPermalinkUrl}
      currentVersion={currentVersion}
      deleteDialogTitle="Issue"
      detailsSections={() => (
        <>
          <EvaluationSection
            documentId={feature.id}
            judgeItems={judgesReport ?? null}
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
            generatePlanModalSession={modals.generatePlan}
          />
          <BranchesSection
            documentId={feature.id}
            generationStatus={generationStatus}
            onStartBuild={modals.execute.openModal}
            planId={linkedPlanId}
            projectId={feature.projectId ?? ""}
          />
          <PreviewSection documentId={feature.id} />
        </>
      )}
      document={feature}
      feedArtifactType={FeedArtifactType.Feature}
      floatingChildren={() => (
        <IssueFloatingChildren
          activeTargetPicker={activeTargetPicker}
          executeModal={modals.execute}
          featureActions={featureActions}
          linkedPlanId={linkedPlanId}
          planActions={planActions}
        />
      )}
      hideRepositoriesInMetadataBar
      moveDialogTeamId={feature.project?.teams?.[0]?.id ?? null}
      onVersionChange={onVersionChange}
      redirectPath={redirectPath}
      renderChatPanel={renderDocumentChatPanelSlot}
      renderChatTab={renderDocumentChatTabSlot}
      // Persisted panel-layout storage key: intentionally kept as
      // "feature-editor" (pre-rename value) so existing Issue-editor users do
      // not lose their saved split and fall back to the 75/25 default.
      renderEmptyContent={() => (
        <ArtifactRunInFlightSlot
          generationStatus={featureGenerationStatus}
          variant="panel"
        />
      )}
      renderHeader={(ctx) => (
        <>
          <IssueEditorHeader
            displayTitle={feature.title}
            feature={feature}
            generationStatus={featureGenerationStatus}
            generationStatusLoading={featureGenerationStatusLoading}
            hasPlan={hasPlan}
            isEvaluating={featureActions.isEvaluating}
            isReady={isReady}
            onDelete={ctx.chrome.openDeleteDialog}
            onEvaluateFeature={featureActions.handleEvaluateFeature}
            onGeneratePlan={modals.generatePlan.openModal}
            onMoveToProject={ctx.chrome.openMoveDialog}
            onStartBuild={modals.execute.openModal}
            onToggleMetadataPanel={ctx.chrome.toggleMetadataPanel}
          />
          <ArtifactRunInFlightSlot
            generationStatus={featureGenerationStatus}
            variant="banner"
          />
        </>
      )}
      resizableAutoSaveId="feature-editor"
    />
  );
}

function getFeatureRedirectPath(
  feature: DocumentDetail,
  orgSlug: string
): string {
  const teamId = feature.project?.teams?.[0]?.id;
  const projectId = feature.project?.id;
  if (teamId && projectId) {
    return `/${orgSlug}/teams/${teamId}/projects/${projectId}`;
  }
  return `/${orgSlug}`;
}

type IssueFloatingChildrenProps = {
  linkedPlanId: string | null;
  planActions: ReturnType<typeof usePlanActions>;
  featureActions: ReturnType<typeof useFeatureActions>;
  executeModal: ReturnType<typeof useFeatureModals>["execute"];
  activeTargetPicker: ReturnType<typeof resolveFloatingTargetPickerSource>;
};

function IssueFloatingChildren({
  linkedPlanId,
  planActions,
  featureActions,
  executeModal,
  activeTargetPicker,
}: Readonly<IssueFloatingChildrenProps>) {
  return (
    <>
      {executeModal.open && (
        <ExecutePlanModal
          isLoading={planActions.isExecuting}
          onConfirm={planActions.handleExecute}
          onOpenChange={executeModal.setOpen}
          open={executeModal.open}
          planId={linkedPlanId}
        />
      )}
      <FloatingTargetPicker
        multiTargetState={activeTargetPicker.multiTargetState}
        onSelect={activeTargetPicker.onSelect}
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
      <BackendMismatchModal
        mismatchData={featureActions.backendMismatchState}
        onConfirmOriginal={featureActions.confirmOriginalBackend}
        onConfirmPreferred={featureActions.confirmPreferredBackend}
        onOpenChange={(open) => {
          if (!open) {
            featureActions.dismissBackendMismatch();
          }
        }}
        open={!!featureActions.backendMismatchState}
      />
    </>
  );
}
