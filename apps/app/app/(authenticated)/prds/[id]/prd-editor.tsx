"use client";

import type { PRD } from "@repo/database/generated/client";
import { Badge } from "@repo/design-system/components/ui/badge";
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
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { NewImplementationPlanModal } from "@/app/(authenticated)/implementation-plans/components/new-implementation-plan-modal";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { RenameDialog } from "@/components/rename-dialog";
import { PRDStatusBadge } from "@/components/status-badge";
import {
  PRD_STATUS_OPTIONS,
  PRD_TEMPLATE_OPTIONS,
  type PRDStatus,
  type PRDTemplate,
} from "@/lib/types";
import { formatRelativeTime } from "@/lib/utils";
import { usePRDEditor } from "./use-prd-editor";

type PRDEditorProps = {
  prd: PRD;
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
    tags,
    template,
    newTag,
    setNewTag,
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
    handleTemplateChange,
    handleAddTag,
    handleRemoveTag,
    handleTagKeyDown,
    handleRename,
    handleDuplicate,
    handleExport,
    handleCopyMarkdown,
    handleDelete,
  } = usePRDEditor(prd);

  return (
    <div className="flex h-full flex-col">
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-3">
        <div className="flex items-center gap-4">
          <Link href="/prds">
            <Button size="sm" variant="ghost">
              <ArrowLeftIcon className="mr-2 h-4 w-4" />
              Back to Library
            </Button>
          </Link>

          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <FileTextIcon className="h-4 w-4" />
            <span>{prd.fileName}</span>
            <span className="font-mono">v{prd.version}</span>
          </div>

          <PRDStatusBadge status={status} />

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
            variant="outline"
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
        {showMetadataPanel && (
          <div className="w-80 overflow-auto border-l bg-muted/30 p-4">
            <h3 className="mb-4 font-semibold">PRD Details</h3>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  onValueChange={(v) => handleStatusChange(v as PRDStatus)}
                  value={status}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRD_STATUS_OPTIONS.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
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

              <div className="space-y-2">
                <Label>Template</Label>
                <Select
                  onValueChange={(v) => handleTemplateChange(v as PRDTemplate)}
                  value={template}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRD_TEMPLATE_OPTIONS.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Tags</Label>
                <div className="flex gap-2">
                  <Input
                    className="flex-1"
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={handleTagKeyDown}
                    placeholder="Add tag"
                    value={newTag}
                  />
                  <Button
                    onClick={handleAddTag}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Add
                  </Button>
                </div>
                {tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {tags.map((tag) => (
                      <Badge className="gap-1" key={tag} variant="secondary">
                        {tag}
                        <button
                          className="ml-1 hover:text-destructive"
                          onClick={() => handleRemoveTag(tag)}
                          type="button"
                        >
                          <XIcon className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
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
        )}
      </div>

      {/* Rename Dialog */}
      <RenameDialog
        currentFileName={prd.fileName}
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
      <NewImplementationPlanModal
        defaultPrdId={prd.id}
        defaultPrdTitle={prd.title}
        onOpenChange={setShowGeneratePlanModal}
        open={showGeneratePlanModal}
        trigger={null}
      />
    </div>
  );
}
