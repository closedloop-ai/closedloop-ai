"use client";

import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { ExecutePlanModal } from "@/app/(authenticated)/implementation-plans/components/execute-plan-modal";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { usePlanActions } from "@/hooks/artifact-editing/use-plan-actions";
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
  const { handleExecute, isExecuting } = usePlanActions({
    artifactId: linkedPlanId,
  });

  const teamId = issue.project?.teams?.[0]?.id;
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
            <div className="mx-auto flex max-w-[750px] flex-col py-8">
              <div className="flex flex-col gap-1.5">
                <EditableIssueTitle
                  initialTitle={issue.title}
                  issueId={issue.id}
                  onTitleChange={setDisplayTitle}
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
                  issue={issue}
                  onGenerateModalChange={setShowGenerateModal}
                  showGenerateModal={showGenerateModal}
                />
                <BranchesSection
                  hasPlan={hasPlan}
                  issueId={issue.id}
                  onStartBuild={() => setShowExecuteModal(true)}
                />
                <PreviewSection issueId={issue.id} />
              </div>
            </div>
          </div>

          {/* Right Sidebar */}
          {showMetadataPanel && <IssueMetadataPanel issue={issue} />}
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
    </>
  );
}
