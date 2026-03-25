"use client";

import { isActiveGenerationStatus } from "@repo/api/src/types/artifact";
import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { ExecutePlanModal } from "@/app/(authenticated)/implementation-plans/components/execute-plan-modal";
import { BackendMismatchModal } from "@/components/backend-mismatch-modal";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";
import { usePlanActions } from "@/hooks/artifact-editing/use-plan-actions";
import { useArtifactGenerationStatus } from "@/hooks/queries/use-artifacts";
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
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showExecuteModal, setShowExecuteModal] = useState(false);
  const [showMetadataPanel, setShowMetadataPanel] = useLocalStorageState(
    "panel:metadata:FEATURE",
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
    artifactId: linkedPlanId,
  });

  const { data: generationStatus } = useArtifactGenerationStatus(
    linkedPlanId ?? "",
    {
      enabled: !!linkedPlanId,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        if (status && isActiveGenerationStatus(status)) {
          return 5000;
        }
        return false;
      },
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
                  hasPlan={hasPlan}
                  onStartBuild={() => setShowExecuteModal(true)}
                  projectId={feature.projectId ?? ""}
                />
                <PreviewSection featureId={feature.id} />
              </div>
            </div>
          </div>

          {/* Right Sidebar */}
          {showMetadataPanel && (
            <FeatureMetadataPanel
              feature={feature}
              teamIds={feature.project?.teams.map((team) => team.id) ?? []}
            />
          )}
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
