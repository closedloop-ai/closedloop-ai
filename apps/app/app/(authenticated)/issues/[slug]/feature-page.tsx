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
import { Tabs, TabsContent } from "@repo/design-system/components/ui/tabs";
import {
  FileCode2,
  GitBranchIcon,
  MoreHorizontalIcon,
  TextIcon,
  TrashIcon,
  ViewIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import {
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/underline-tabs";
import { useDeleteIssue } from "@/hooks/queries/use-issues";
import { ContextTable } from "./components/context-table";
import { EditableIssueDescription } from "./components/editable-issue-description";
import { EditableIssueTitle } from "./components/editable-issue-title";
import { FeatureBuildTab } from "./components/feature-build-tab";
import { FeaturePlanTab } from "./components/feature-plan-tab";
import { FeaturePreviewTab } from "./components/feature-preview-tab";
import { IssueMetadataPanel } from "./components/issue-metadata-panel";

type FeaturePageProps = {
  issue: IssueWithWorkstream;
};

export function FeaturePage({ issue }: Readonly<FeaturePageProps>) {
  const router = useRouter();
  const deleteIssue = useDeleteIssue();

  const [activeTab, setActiveTab] = useState("description");
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
          <Tabs
            className="min-w-0 flex-1"
            onValueChange={setActiveTab}
            value={activeTab}
          >
            <UnderlineTabsList>
              <UnderlineTabsTrigger value="description">
                <TextIcon className="h-4 w-4" />
                Description
              </UnderlineTabsTrigger>
              <UnderlineTabsTrigger value="plan">
                <FileCode2 className="h-4 w-4" />
                Plan
              </UnderlineTabsTrigger>
              <UnderlineTabsTrigger value="build">
                <GitBranchIcon className="h-4 w-4" />
                Build
              </UnderlineTabsTrigger>
              <UnderlineTabsTrigger value="preview">
                <ViewIcon className="h-4 w-4" />
                Preview
              </UnderlineTabsTrigger>
            </UnderlineTabsList>
            <div className="p-6">
              <TabsContent className="mt-0" value="description">
                <div className="mx-auto flex max-w-[750px] flex-col gap-4 py-2">
                  <EditableIssueTitle
                    initialTitle={issue.title}
                    issueId={issue.id}
                    onTitleChange={setDisplayTitle}
                  />
                  <EditableIssueDescription
                    initialDescription={issue.description || ""}
                    issueId={issue.id}
                  />
                  <ContextTable issueId={issue.id} separator />
                </div>
              </TabsContent>
              <TabsContent className="mt-0" value="plan">
                <FeaturePlanTab />
              </TabsContent>
              <TabsContent className="mt-0" value="build">
                <FeatureBuildTab />
              </TabsContent>
              <TabsContent className="mt-0" value="preview">
                <FeaturePreviewTab />
              </TabsContent>
            </div>
          </Tabs>

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
