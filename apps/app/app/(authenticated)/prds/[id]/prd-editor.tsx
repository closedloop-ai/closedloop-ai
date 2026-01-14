"use client";

import { useState, useTransition, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  ArrowLeftIcon,
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SparklesIcon,
  TrashIcon,
  XIcon,
  SettingsIcon,
} from "lucide-react";
import Link from "next/link";
import { updatePRD, deletePRD, duplicatePRD, renamePRD } from "@/app/actions/prds";
import { NewImplementationPlanModal } from "@/app/(authenticated)/implementation-plans/components/new-implementation-plan-modal";
import type { PRD } from "@repo/database/generated/client";
import { PRDStatusBadge } from "../components/prd-status-badge";

const STATUS_OPTIONS = ["Draft", "Review", "Approved", "Archived"];
const TEMPLATE_OPTIONS = ["Standard PRD", "Feature Brief", "Bug Fix", "Technical Spec"];

type PRDEditorProps = {
  prd: PRD;
};

export function PRDEditor({ prd }: PRDEditorProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [content, setContent] = useState(prd.content);
  const [lastSaved, setLastSaved] = useState<Date>(prd.updatedAt);
  const [isSaving, setIsSaving] = useState(false);

  // Editable metadata state
  const [status, setStatus] = useState(prd.status);
  const [approver, setApprover] = useState(prd.approver);
  const [tags, setTags] = useState<string[]>(prd.tags ?? []);
  const [template, setTemplate] = useState(prd.template);
  const [newTag, setNewTag] = useState("");
  const [showMetadataPanel, setShowMetadataPanel] = useState(false);

  // Dialogs
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showGeneratePlanModal, setShowGeneratePlanModal] = useState(false);
  const [newTitle, setNewTitle] = useState(prd.title);
  const [newFileName, setNewFileName] = useState(prd.fileName);

  const handleSave = useCallback(() => {
    setIsSaving(true);
    startTransition(async () => {
      const result = await updatePRD({ id: prd.id, content });
      if (result.data) {
        setLastSaved(new Date());
        toast.success("Changes saved");
      } else if (result.error) {
        toast.error("Failed to save changes");
      }
      setIsSaving(false);
    });
  }, [prd.id, content]);

  const handleMetadataUpdate = useCallback((updates: Partial<{ status: string; approver: string; tags: string[]; template: string }>) => {
    startTransition(async () => {
      const result = await updatePRD({ id: prd.id, ...updates });
      if (result.data) {
        setLastSaved(new Date());
        toast.success("Changes saved");
      } else if (result.error) {
        toast.error("Failed to save changes");
      }
    });
  }, [prd.id]);

  const handleStatusChange = (newStatus: string) => {
    setStatus(newStatus);
    handleMetadataUpdate({ status: newStatus });
  };

  const handleApproverChange = (newApprover: string) => {
    setApprover(newApprover);
  };

  const handleApproverBlur = () => {
    if (approver !== prd.approver) {
      handleMetadataUpdate({ approver });
    }
  };

  const handleTemplateChange = (newTemplate: string) => {
    setTemplate(newTemplate);
    handleMetadataUpdate({ template: newTemplate });
  };

  const handleAddTag = () => {
    if (newTag.trim() && !tags.includes(newTag.trim())) {
      const newTags = [...tags, newTag.trim()];
      setTags(newTags);
      setNewTag("");
      handleMetadataUpdate({ tags: newTags });
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    const newTags = tags.filter((tag) => tag !== tagToRemove);
    setTags(newTags);
    handleMetadataUpdate({ tags: newTags });
  };

  const handleTagKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddTag();
    }
  };

  const handleRename = () => {
    startTransition(async () => {
      await renamePRD(prd.id, newTitle, newFileName);
      setShowRenameDialog(false);
    });
  };

  const handleDuplicate = () => {
    startTransition(async () => {
      const result = await duplicatePRD(prd.id);
      if (result.data) {
        router.push(`/prds/${result.data.id}`);
      }
    });
  };

  const handleExport = () => {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = prd.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDelete = () => {
    startTransition(async () => {
      await deletePRD(prd.id);
      router.push("/prds");
    });
  };

  const handleGenerateImplementationPlan = () => {
    setShowGeneratePlanModal(true);
  };

  const formatLastSaved = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - new Date(date).getTime();
    const minutes = Math.floor(diff / 60000);

    if (minutes < 1) return "Just now";
    if (minutes === 1) return "1 min ago";
    if (minutes < 60) return `${minutes} min ago`;

    const hours = Math.floor(minutes / 60);
    if (hours === 1) return "1 hour ago";
    if (hours < 24) return `${hours} hours ago`;

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(date));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 bg-background flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-4">
          <Link href="/prds">
            <Button variant="ghost" size="sm">
              <ArrowLeftIcon className="mr-2 h-4 w-4" />
              Back to Library
            </Button>
          </Link>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <FileTextIcon className="h-4 w-4" />
            <span>{prd.fileName}</span>
            <span className="font-mono">v{prd.version}</span>
          </div>

          <PRDStatusBadge status={status} />

          <span className="text-sm text-muted-foreground">
            {isSaving ? "Saving..." : `Last saved: ${formatLastSaved(lastSaved)}`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => setShowMetadataPanel(!showMetadataPanel)}
            variant={showMetadataPanel ? "secondary" : "outline"}
            size="sm"
          >
            <SettingsIcon className="mr-2 h-4 w-4" />
            Details
          </Button>

          <Button onClick={handleGenerateImplementationPlan} variant="outline">
            <SparklesIcon className="mr-2 h-4 w-4" />
            Generate Implementation Plan
          </Button>

          <Button onClick={handleSave} disabled={isPending}>
            {isSaving ? "Saving..." : "Save"}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <MoreHorizontalIcon className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[160px]">
              <DropdownMenuItem onClick={() => setShowRenameDialog(true)}>
                <PencilIcon className="mr-2 h-4 w-4" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleDuplicate} disabled={isPending}>
                <CopyIcon className="mr-2 h-4 w-4" />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExport}>
                <DownloadIcon className="mr-2 h-4 w-4" />
                Export .md
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setShowDeleteDialog(true)}
                className="text-destructive focus:text-destructive"
              >
                <TrashIcon className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Content Area with Optional Metadata Panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Scrollable Editor */}
        <div className="flex-1 overflow-auto">
          <div className="max-w-4xl mx-auto p-4">
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Start writing your PRD..."
              className="min-h-[calc(100vh-200px)] font-mono text-sm resize-none border-0 focus-visible:ring-0 p-0 shadow-none"
            />
          </div>
        </div>

        {/* Metadata Panel */}
        {showMetadataPanel && (
          <div className="w-80 border-l bg-muted/30 p-4 overflow-auto">
            <h3 className="font-semibold mb-4">PRD Details</h3>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={status} onValueChange={handleStatusChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((opt) => (
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
                  value={approver}
                  onChange={(e) => handleApproverChange(e.target.value)}
                  onBlur={handleApproverBlur}
                  placeholder="Approver name"
                />
              </div>

              <div className="space-y-2">
                <Label>Template</Label>
                <Select value={template} onValueChange={handleTemplateChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_OPTIONS.map((opt) => (
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
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={handleTagKeyDown}
                    placeholder="Add tag"
                    className="flex-1"
                  />
                  <Button type="button" variant="outline" size="sm" onClick={handleAddTag}>
                    Add
                  </Button>
                </div>
                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="gap-1">
                        {tag}
                        <button
                          type="button"
                          onClick={() => handleRemoveTag(tag)}
                          className="ml-1 hover:text-destructive"
                        >
                          <XIcon className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>

              <div className="pt-4 border-t">
                <div className="text-sm text-muted-foreground space-y-1">
                  <p>Version: v{prd.version}</p>
                  <p>Created: {new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(prd.createdAt))}</p>
                  <p>Updated: {new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(prd.updatedAt))}</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Rename Dialog */}
      <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename PRD</DialogTitle>
            <DialogDescription>
              Update the title and file name for this PRD.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="rename-title">Title</Label>
              <Input
                id="rename-title"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rename-filename">File name</Label>
              <Input
                id="rename-filename"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRenameDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleRename} disabled={isPending}>
              {isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete PRD</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{prd.title}"? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isPending}>
              {isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Generate Implementation Plan Modal */}
      <NewImplementationPlanModal
        defaultPrdId={prd.id}
        defaultPrdTitle={prd.title}
        open={showGeneratePlanModal}
        onOpenChange={setShowGeneratePlanModal}
        trigger={null}
      />
    </div>
  );
}
