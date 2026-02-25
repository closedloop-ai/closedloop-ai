"use client";

import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Separator } from "@repo/design-system/components/ui/separator";
import { SidebarTrigger } from "@repo/design-system/components/ui/sidebar";
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
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import {
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/underline-tabs";
import { useDeleteIssue } from "@/hooks/queries/use-issues";
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
      <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator className="mr-2 h-4" orientation="vertical" />
        <Breadcrumb>
          <BreadcrumbList>
            {teamId && teamName ? (
              <>
                <BreadcrumbItem>
                  <BreadcrumbLink href={`/teams/${teamId}/projects`}>
                    {teamName}
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </>
            ) : null}
            {teamId && projectId && projectName ? (
              <>
                <BreadcrumbItem>
                  <BreadcrumbLink
                    href={`/teams/${teamId}/projects/${projectId}`}
                  >
                    {projectName}
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </>
            ) : null}
            <BreadcrumbItem>
              <BreadcrumbPage>{issue.title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost">
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
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        <div className="flex h-full">
          {/* Main Content Area */}
          <Tabs
            className="flex-1"
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
                <h1 className="mb-4 font-bold text-2xl">{issue.title}</h1>
                <p className="text-muted-foreground">
                  {issue.description || "No description provided."}
                </p>
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
          <div className="w-[300px] border-l">
            <IssueMetadataPanel issue={issue} />
          </div>
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
