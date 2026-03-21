"use client";

import { isActiveGenerationStatus } from "@repo/api/src/types/artifact";
import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { ExecutePlanModal } from "@/app/(authenticated)/implementation-plans/components/execute-plan-modal";
import { ArtifactChatPanel } from "@/components/artifact-editor/artifact-chat-panel";
import { BackendMismatchModal } from "@/components/backend-mismatch-modal";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";
import { usePlanActions } from "@/hooks/artifact-editing/use-plan-actions";
import { useArtifactGenerationStatus } from "@/hooks/queries/use-artifacts";
import { useDeleteIssue } from "@/hooks/queries/use-issues";
import { useLocalStorageState } from "@/hooks/use-local-storage-state";
import { BranchesSection } from "./components/branches-section";
import { ContextSection } from "./components/context-section";
import { EditableIssueDescription } from "./components/editable-issue-description";
import { EditableIssueTitle } from "./components/editable-issue-title";
import { FeatureEditorHeader } from "./components/feature-editor-header";
import { IssueMetadataPanel } from "./components/issue-metadata-panel";
import { PlanSection } from "./components/plan-section";
import { PreviewSection } from "./components/preview-section";
import { useFeatureState } from "./use-feature-state";

type FeaturePageProps = {
  issue: IssueWithWorkstream;
};

export function FeaturePage({ issue }: Readonly<FeaturePageProps>) {
  const router = useRouter();
  const deleteIssue = useDeleteIssue();

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showExecuteModal, setShowExecuteModal] = useState(false);
  const [showMetadataPanel, setShowMetadataPanel] = useLocalStorageState(
    "panel:metadata:ISSUE",
    true
  );
  const [displayTitle, setDisplayTitle] = useState(issue.title);

  const { hasPlan, isReady, linkedPlanId } = useFeatureState(issue);
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

  const { data: generationStatus, invalidateCache } =
    useArtifactGenerationStatus(linkedPlanId ?? "", {
      enabled: !!linkedPlanId,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        if (status && isActiveGenerationStatus(status)) {
          return 5000;
        }
        return false;
      },
    });

  const handleGenerationSuccess = useEffectEvent(invalidateCache);

  useEffect(() => {
    if (generationStatus?.status === "SUCCESS") {
      handleGenerationSuccess();
    }
  }, [generationStatus?.status]);

  const teamId = issue.project?.teams.length ? issue.project.teams[0].id : null;
  const projectId = issue.project?.id;

  const handleDelete = useCallback(async (): Promise<boolean> => {
    const redirectPath =
      teamId && projectId ? `/teams/${teamId}/projects/${projectId}` : "/";

    const result = await deleteIssue.mutateAsync(issue.id, {
      onSuccess: () => {
        toast.success("Feature deleted");
        router.push(redirectPath);
      },
    });
    return !!result;
  }, [deleteIssue, issue.id, teamId, projectId, router]);

  return (
    <>
      <FeatureEditorHeader
        displayTitle={displayTitle}
        hasPlan={hasPlan}
        isReady={isReady}
        issue={issue}
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
            <div className="mx-auto flex max-w-[960px] flex-col py-8">
              <div className="flex flex-col gap-1.5">
                <EditableIssueTitle
                  initialTitle={issue.title}
                  issueId={issue.id}
                  onTitleChange={setDisplayTitle}
                />
                <IssueMetadataPanel
                  issue={issue}
                  teamIds={issue.project?.teams.map((team) => team.id) ?? []}
                  variant="bar"
                />
                <EditableIssueDescription
                  initialDescription={issue.description || ""}
                  issueId={issue.id}
                />
              </div>

              <div className="flex flex-col gap-4">
                <ContextSection
                  issueId={issue.id}
                  projectId={issue.projectId ?? undefined}
                />
                <PlanSection
                  generationStatus={generationStatus}
                  issue={issue}
                  onGenerateModalChange={setShowGenerateModal}
                  showGenerateModal={showGenerateModal}
                />
                <BranchesSection
                  generationStatus={generationStatus}
                  hasPlan={hasPlan}
                  issueId={issue.id}
                  onStartBuild={() => setShowExecuteModal(true)}
                />
                <PreviewSection issueId={issue.id} />
              </div>

              <div className="border-t px-4 py-4">
                <IssueMetadataPanel
                  issue={issue}
                  teamIds={issue.project?.teams.map((team) => team.id) ?? []}
                  variant="detailsOnly"
                />
              </div>
            </div>
          </div>

          {/* Right gutter: chat panel when metadata toggle on */}
          {showMetadataPanel && (
            <ArtifactChatPanel artifactId={issue.id} artifactType="issue" />
          )}
        </div>
      </main>

      <DeleteConfirmationDialog
        isPending={deleteIssue.isPending}
        itemName={issue.title}
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
