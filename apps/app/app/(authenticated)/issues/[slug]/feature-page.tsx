"use client";

import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { toast } from "@repo/design-system/components/ui/sonner";
import { MoreHorizontalIcon, TrashIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { useDeleteIssue } from "@/hooks/queries/use-issues";
import { BranchesSection } from "./components/branches-section";
import { ContextSection } from "./components/context-section";
import { EditableIssueDescription } from "./components/editable-issue-description";
import { EditableIssueTitle } from "./components/editable-issue-title";
import { IssueMetadataPanel } from "./components/issue-metadata-panel";
import { PlanSection } from "./components/plan-section";
import { PreviewSection } from "./components/preview-section";

type FeaturePageProps = {
  issue: IssueWithWorkstream;
};

export function FeaturePage({ issue }: Readonly<FeaturePageProps>) {
  const router = useRouter();
  const deleteIssue = useDeleteIssue();

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [displayTitle, setDisplayTitle] = useState(issue.title);

  const teamId = issue.project?.teams?.[0]?.id;
  const projectId = issue.project?.id;
  const teamName = issue.project?.teams?.[0]?.name;
  const projectName = issue.project?.name;

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
      <Header
        breadcrumbs={[
          ...(teamId && teamName
            ? [{ label: teamName, href: `/teams/${teamId}/projects` }]
            : []),
          ...(teamId && projectId && projectName
            ? [
                {
                  label: projectName,
                  href: `/teams/${teamId}/projects/${projectId}`,
                },
              ]
            : []),
          { label: displayTitle },
        ]}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost">
              <MoreHorizontalIcon className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[160px]">
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => setShowDeleteDialog(true)}
            >
              <TrashIcon className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Header>

      <main className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="flex min-h-full">
          {/* Main Content Area */}
          <div className="min-w-0 flex-1 overflow-x-hidden">
            <div className="mx-auto flex max-w-[750px] flex-col gap-8 py-8">
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
                <PlanSection issue={issue} />
                <BranchesSection issueId={issue.id} />
                <PreviewSection />
              </div>
            </div>
          </div>

          {/* Right Sidebar */}
          <IssueMetadataPanel issue={issue} />
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
    </>
  );
}
