"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { EntityType } from "@repo/api/src/types/entity-link";
import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { ExecutePlanModal } from "@/app/(authenticated)/implementation-plans/components/execute-plan-modal";
import { BackendMismatchModal } from "@/components/backend-mismatch-modal";
import { DocumentChatDrawer } from "@/components/chat/DocumentChatDrawer";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";
import { MoveEntityDialog } from "@/components/move-entity-dialog";
import { usePlanActions } from "@/hooks/document-editing/use-plan-actions";
import { useDocumentGenerationStatus } from "@/hooks/queries/use-documents";
import { useDeleteFeature } from "@/hooks/queries/use-features";
import { useLocalStorageState } from "@/hooks/use-local-storage-state";
import { BranchesSection } from "./components/branches-section";
import { ContextSection } from "./components/context-section";
import { EditableFeatureDescription } from "./components/editable-feature-description";
import { EditableFeatureTitle } from "./components/editable-feature-title";
import { FeatureEditorHeader } from "./components/feature-editor-header";
import { FeatureMetadataPanel } from "./components/feature-metadata-panel";
import { PlanSection } from "./components/plan-section";
import { PreviewSection } from "./components/preview-section";
import { useFeatureState } from "./use-feature-state";

type FeaturePageProps = {
  feature: FeatureWithWorkstream;
};

export function FeaturePage({ feature }: Readonly<FeaturePageProps>) {
  const router = useRouter();
  const deleteFeature = useDeleteFeature();

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showExecuteModal, setShowExecuteModal] = useState(false);
  const [showMetadataPanel, setShowMetadataPanel] = useLocalStorageState(
    "panel:chat:FEATURE",
    true
  );
  const [displayTitle, setDisplayTitle] = useState(feature.title);

  const { hasPlan, isReady, linkedPlanId } = useFeatureState(feature);
  const {
    handleExecute,
    isExecuting,
    multiTargetState,
    selectTarget,
    backendMismatchState,
    confirmOriginalBackend,
    confirmPreferredBackend,
    dismissBackendMismatch,
  } = usePlanActions({
    documentId: linkedPlanId,
  });

  const { data: generationStatus } = useDocumentGenerationStatus(
    linkedPlanId ?? "",
    {
      enabled: !!linkedPlanId,
      polling: true,
    }
  );

  const teamId = feature.project?.teams.length
    ? feature.project.teams[0].id
    : null;
  const projectId = feature.project?.id;

  const handleDelete = useCallback(async (): Promise<boolean> => {
    const redirectPath =
      teamId && projectId ? `/teams/${teamId}/projects/${projectId}` : "/";

    const result = await deleteFeature.mutateAsync(feature.id, {
      onSuccess: () => {
        toast.success("Feature deleted");
        router.push(redirectPath);
      },
    });
    return !!result;
  }, [deleteFeature, feature.id, teamId, projectId, router]);

  return (
    <>
      <FeatureEditorHeader
        displayTitle={displayTitle}
        feature={feature}
        hasPlan={hasPlan}
        isReady={isReady}
        onDelete={() => setShowDeleteDialog(true)}
        onGeneratePlan={() => setShowGenerateModal(true)}
        onMoveToProject={() => setShowMoveDialog(true)}
        onStartBuild={() => setShowExecuteModal(true)}
        onToggleMetadataPanel={() => setShowMetadataPanel((prev) => !prev)}
        showMetadataPanel={showMetadataPanel}
      />

      <main className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="flex min-h-full">
          {/* Main Content Area */}
          <div className="min-w-0 flex-1 overflow-x-hidden">
            <div className="mx-auto flex max-w-[750px] flex-col py-8">
              <div className="flex flex-col gap-1.5">
                <EditableFeatureTitle
                  featureId={feature.id}
                  initialTitle={feature.title}
                  onTitleChange={setDisplayTitle}
                />
                <EditableFeatureDescription
                  featureId={feature.id}
                  initialDescription={feature.description || ""}
                />
              </div>

              <div className="flex flex-col gap-4">
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
                  featureId={feature.id}
                  generationStatus={generationStatus}
                  onStartBuild={() => setShowExecuteModal(true)}
                  planId={linkedPlanId}
                  projectId={feature.projectId ?? ""}
                />
                <PreviewSection featureId={feature.id} />
              </div>
            </div>
          </div>

          {/* Right Sidebar: metadata */}
          {showMetadataPanel && (
            <FeatureMetadataPanel
              feature={feature}
              teamIds={feature.project?.teams.map((team) => team.id) ?? []}
            />
          )}
          {/* Right Sidebar: interactive chat */}
          <FeatureFlagged flag="interactive-chat">
            <div className="flex w-[360px] flex-none flex-col border-l">
              <DocumentChatDrawer
                documentId={feature.id}
                documentSlug={feature.slug}
                documentTitle={feature.title}
                documentType="feature"
              />
            </div>
          </FeatureFlagged>
        </div>
      </main>

      <DeleteConfirmationDialog
        isPending={deleteFeature.isPending}
        itemName={feature.title}
        onConfirm={handleDelete}
        onOpenChange={setShowDeleteDialog}
        open={showDeleteDialog}
        title="Feature"
      />

      <MoveEntityDialog
        entity={{
          id: feature.id,
          entityType: EntityType.Feature,
          projectId: feature.projectId,
        }}
        onOpenChange={setShowMoveDialog}
        open={showMoveDialog}
        teamId={teamId}
      />

      <ExecutePlanModal
        isLoading={isExecuting}
        onConfirm={handleExecute}
        onOpenChange={setShowExecuteModal}
        open={showExecuteModal}
      />

      {multiTargetState && (
        <div className="fixed right-4 bottom-4 z-50 rounded-lg border bg-background p-4 shadow-lg">
          <p className="mb-2 text-muted-foreground text-sm">
            Multiple compute targets are online. Select one:
          </p>
          <LoopDispatchTargetSelector
            availableTargets={multiTargetState.availableTargets}
            onSelect={selectTarget}
          />
        </div>
      )}

      <BackendMismatchModal
        mismatchData={backendMismatchState}
        onConfirmOriginal={confirmOriginalBackend}
        onConfirmPreferred={confirmPreferredBackend}
        onOpenChange={(open) => {
          if (!open) {
            dismissBackendMismatch();
          }
        }}
        open={!!backendMismatchState}
      />
    </>
  );
}
