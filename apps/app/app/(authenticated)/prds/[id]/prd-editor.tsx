"use client";

import {
  ArtifactStatus,
  type ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import {
  ArrowLeftIcon,
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SettingsIcon,
  SparklesIcon,
  TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { NewPlanModal } from "@/app/(authenticated)/implementation-plans/components/new-plan-modal";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { RenameDialog } from "@/components/rename-dialog";
import {
  ArtifactStatusBadge,
  artifactStatusLabels,
} from "@/components/status-badge";
import { formatRelativeTime } from "@/lib/date-utils";
import { usePRDEditor } from "./use-prd-editor";

type PRDEditorProps = {
  prd: ArtifactWithWorkstream;
};

export function PRDEditor({ prd }: PRDEditorProps) {
  const {
    isPending,
    content,
    setContent,
    lastSaved,
    isSaving,
    status,
    approver,
    targetRepo,
    targetBranch,
    showMetadataPanel,
    setShowMetadataPanel,
    showRenameDialog,
    setShowRenameDialog,
    showDeleteDialog,
    setShowDeleteDialog,
    showGeneratePlanModal,
    setShowGeneratePlanModal,
    handleSave,
    handleStatusChange,
    handleApproverChange,
    handleApproverBlur,
    handleTargetRepoChange,
    handleTargetRepoBlur,
    handleTargetBranchChange,
    handleTargetBranchBlur,
    handleRename,
    handleDuplicate,
    handleExport,
    handleDelete,
  } = usePRDEditor(prd);

  return (
    <div className="flex h-full flex-col">
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-3">
        <div className="flex items-center gap-4">
          <Link
            href={
              prd.project?.teams?.[0]?.id
                ? `/teams/${prd.project.teams[0].id}/projects/${prd.project.id}`
                : "/prds"
            }
          >
            <Button size="sm" variant="ghost">
              <ArrowLeftIcon className="mr-2 h-4 w-4" />
              {prd.project?.teams?.[0]?.id
                ? "Back to Project"
                : "Back to Library"}
            </Button>
          </Link>

          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <FileTextIcon className="h-4 w-4" />
            <span>{prd.fileName ?? prd.title}</span>
            <span className="font-mono">v{prd.version}</span>
          </div>

          <ArtifactStatusBadge status={status} />

          <span className="text-muted-foreground text-sm">
            {isSaving
              ? "Saving..."
              : `Last saved: ${formatRelativeTime(lastSaved)}`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => setShowMetadataPanel(!showMetadataPanel)}
            size="sm"
            variant={showMetadataPanel ? "secondary" : "outline"}
          >
            <SettingsIcon className="mr-2 h-4 w-4" />
            Details
          </Button>

          <Button
            onClick={() => setShowGeneratePlanModal(true)}
            size="sm"
            variant="default"
          >
            <SparklesIcon className="mr-2 h-4 w-4" />
            Generate Implementation Plan
          </Button>

          <Button disabled={isPending} onClick={handleSave}>
            {isSaving ? "Saving..." : "Save"}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost">
                <MoreHorizontalIcon className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[160px]">
              <DropdownMenuItem onClick={() => setShowRenameDialog(true)}>
                <PencilIcon className="mr-2 h-4 w-4" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem disabled={isPending} onClick={handleDuplicate}>
                <CopyIcon className="mr-2 h-4 w-4" />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExport}>
                <DownloadIcon className="mr-2 h-4 w-4" />
                Export .md
              </DropdownMenuItem>
              <DropdownMenuSeparator />
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
      </div>

      {/* Content Area with Optional Metadata Panel */}
      <div className="flex flex-1 overflow-hidden">
        {/* Scrollable Editor */}
        <div className="flex-1 overflow-auto">
          <div className="mx-auto max-w-4xl p-4">
            <Textarea
              className="min-h-[calc(100vh-200px)] resize-none border-0 p-0 font-mono text-sm shadow-none focus-visible:ring-0"
              onChange={(e) => setContent(e.target.value)}
              placeholder="Start writing your PRD..."
              value={content}
            />
          </div>
        </div>

        {/* Metadata Panel */}
        {showMetadataPanel ? (
          <div className="w-80 overflow-auto border-l bg-muted/30 p-4">
            <h3 className="mb-4 font-semibold">PRD Details</h3>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  onValueChange={(v) => handleStatusChange(v as ArtifactStatus)}
                  value={status}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(ArtifactStatus).map((statusOption) => (
                      <SelectItem key={statusOption} value={statusOption}>
                        {artifactStatusLabels[statusOption] ?? statusOption}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Approver</Label>
                <Input
                  onBlur={handleApproverBlur}
                  onChange={(e) => handleApproverChange(e.target.value)}
                  placeholder="Approver name"
                  value={approver}
                />
              </div>

              <div className="space-y-4 border-t pt-4">
                <h4 className="font-medium text-sm">Plan Generation</h4>

                <div className="space-y-2">
                  <Label>
                    Target Repository{" "}
                    <span className="text-muted-foreground text-xs">
                      (owner/repo)
                    </span>
                  </Label>
                  <Input
                    onBlur={handleTargetRepoBlur}
                    onChange={(e) => handleTargetRepoChange(e.target.value)}
                    placeholder="owner/repo"
                    value={targetRepo}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Target Branch</Label>
                  <Input
                    onBlur={handleTargetBranchBlur}
                    onChange={(e) => handleTargetBranchChange(e.target.value)}
                    placeholder="main"
                    value={targetBranch}
                  />
                </div>
              </div>

              <div className="border-t pt-4">
                <div className="space-y-1 text-muted-foreground text-sm">
                  <p>Version: v{prd.version}</p>
                  <p>
                    Created:{" "}
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                    }).format(new Date(prd.createdAt))}
                  </p>
                  <p>
                    Updated:{" "}
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                    }).format(new Date(prd.updatedAt))}
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Rename Dialog */}
      <RenameDialog
        currentFileName={prd.fileName ?? ""}
        currentTitle={prd.title}
        description="Update the title and file name for this PRD."
        isPending={isPending}
        onOpenChange={setShowRenameDialog}
        onRename={handleRename}
        open={showRenameDialog}
        title="Rename PRD"
      />

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        isPending={isPending}
        itemName={prd.title}
        onConfirm={handleDelete}
        onOpenChange={setShowDeleteDialog}
        open={showDeleteDialog}
        title="PRD"
      />

      {/* Generate Implementation Plan Modal */}
      <NewPlanModal
        onOpenChange={setShowGeneratePlanModal}
        open={showGeneratePlanModal}
        sourcePrd={prd}
      />
    </div>
  );
}
