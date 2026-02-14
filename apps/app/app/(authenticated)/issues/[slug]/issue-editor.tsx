"use client";

import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { EditorContent } from "@/components/artifact-editor/editor-content";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { RenameDialog } from "@/components/rename-dialog";
import { useDeleteIssue, useUpdateIssue } from "@/hooks/queries/use-issues";
import { IssueEditorHeader } from "./components/issue-editor-header";
import { IssueMetadataPanel } from "./components/issue-metadata-panel";

type IssueEditorProps = {
  issue: IssueWithWorkstream;
};

export function IssueEditor({ issue }: Readonly<IssueEditorProps>) {
  const router = useRouter();
  const updateIssue = useUpdateIssue();
  const deleteIssue = useDeleteIssue();

  // Description content state
  const [description, setDescription] = useState(issue.description ?? "");
  const [lastSaved, setLastSaved] = useState<Date>(issue.updatedAt);

  // Sync description when issue changes (e.g., after mutation invalidation)
  useEffect(() => {
    setDescription(issue.description ?? "");
    setLastSaved(issue.updatedAt);
  }, [issue.description, issue.updatedAt]);

  const hasUnsavedChanges = description !== (issue.description ?? "");

  // UI state
  const [showMetadataPanel, setShowMetadataPanel] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);

  const isPending = updateIssue.isPending || deleteIssue.isPending;

  const saveDescription = useCallback(() => {
    if (!hasUnsavedChanges) {
      toast.info("No changes to save");
      return;
    }

    updateIssue.mutate(
      { id: issue.id, description },
      {
        onSuccess: () => {
          toast.success("Issue saved");
          setLastSaved(new Date());
        },
      }
    );
  }, [description, hasUnsavedChanges, issue.id, updateIssue]);

  const handleDelete = useCallback(async (): Promise<boolean> => {
    const redirectPath = issue.project?.teams?.[0]?.id
      ? `/teams/${issue.project.teams[0].id}/projects/${issue.project.id}`
      : "/";

    const result = await deleteIssue.mutateAsync(issue.id, {
      onSuccess: () => {
        toast.success("Issue deleted");
        router.push(redirectPath);
      },
    });
    return !!result;
  }, [deleteIssue, issue.id, issue.project, router]);

  const handleRename = useCallback(
    async (title: string): Promise<boolean> => {
      const result = await updateIssue.mutateAsync(
        { id: issue.id, title },
        {
          onSuccess: () => {
            toast.success("Issue renamed");
          },
        }
      );
      return !!result;
    },
    [issue.id, updateIssue]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <IssueEditorHeader
        isPending={isPending}
        isSaving={updateIssue.isPending}
        issue={issue}
        lastSaved={lastSaved}
        onDelete={() => setShowDeleteDialog(true)}
        onRename={() => setShowRenameDialog(true)}
        onSave={saveDescription}
        onToggleMetadataPanel={() => setShowMetadataPanel((prev) => !prev)}
        showMetadataPanel={showMetadataPanel}
      />

      <div className="flex min-h-0 flex-1">
        <EditorContent
          onChange={setDescription}
          placeholder="Describe the issue..."
          value={description}
        />

        {showMetadataPanel ? <IssueMetadataPanel issue={issue} /> : null}
      </div>

      <RenameDialog
        currentFileName=""
        currentTitle={issue.title}
        description="Update the title for this issue."
        isPending={isPending}
        onOpenChange={setShowRenameDialog}
        onRename={(title) => handleRename(title)}
        open={showRenameDialog}
        title="Rename Issue"
      />

      <DeleteConfirmationDialog
        isPending={isPending}
        itemName={issue.title}
        onConfirm={handleDelete}
        onOpenChange={setShowDeleteDialog}
        open={showDeleteDialog}
        title="Issue"
      />
    </div>
  );
}
