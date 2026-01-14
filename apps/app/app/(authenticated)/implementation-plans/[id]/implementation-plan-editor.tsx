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
import { Tabs, TabsList, TabsTrigger } from "@repo/design-system/components/ui/tabs";
import {
  ArrowLeftIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  TrashIcon,
  EyeIcon,
  CodeIcon,
  CheckIcon,
  PencilIcon,
  SettingsIcon,
} from "lucide-react";
import Link from "next/link";
import {
  updateImplementationPlan,
  deleteImplementationPlan,
} from "@/app/actions/implementation-plans";
import type { ImplementationPlan, PRD } from "@repo/database/generated/client";
import { ImplementationPlanStatusBadge } from "../components/implementation-plan-status-badge";

const STATUS_OPTIONS = ["Draft", "Ready", "In Progress", "Generating", "Failed", "Archived"];
const PLAN_TYPE_OPTIONS = ["Standard", "Quick", "Detailed", "Technical"];

type ImplementationPlanWithPRD = ImplementationPlan & {
  sourcePrd: Pick<PRD, "id" | "title">;
};

type ImplementationPlanEditorProps = {
  plan: ImplementationPlanWithPRD;
};

type ViewMode = "rendered" | "markdown";

export function ImplementationPlanEditor({ plan }: ImplementationPlanEditorProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [content, setContent] = useState(plan.content);
  const [lastSaved, setLastSaved] = useState<Date>(plan.updatedAt);
  const [isSaving, setIsSaving] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("rendered");

  // Editable metadata state
  const [status, setStatus] = useState(plan.status);
  const [approver, setApprover] = useState(plan.approver || "");
  const [planType, setPlanType] = useState(plan.planType);
  const [targetRelease, setTargetRelease] = useState(plan.targetRelease || "");
  const [engineeringTeam, setEngineeringTeam] = useState(plan.engineeringTeam || "");
  const [showMetadataPanel, setShowMetadataPanel] = useState(false);

  // Dialogs
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const isDraft = status === "Draft";

  const handleSave = useCallback(() => {
    setIsSaving(true);
    startTransition(async () => {
      const result = await updateImplementationPlan({ id: plan.id, content });
      if (result.data) {
        setLastSaved(new Date());
        toast.success("Changes saved");
      } else if (result.error) {
        toast.error("Failed to save changes");
      }
      setIsSaving(false);
    });
  }, [plan.id, content]);

  const handleMetadataUpdate = useCallback((updates: Partial<{ status: string; approver: string; planType: string; targetRelease: string; engineeringTeam: string }>) => {
    startTransition(async () => {
      const result = await updateImplementationPlan({ id: plan.id, ...updates });
      if (result.data) {
        setLastSaved(new Date());
        toast.success("Changes saved");
      } else if (result.error) {
        toast.error("Failed to save changes");
      }
    });
  }, [plan.id]);

  const handleStatusChange = (newStatus: string) => {
    setStatus(newStatus);
    handleMetadataUpdate({ status: newStatus });
  };

  const handleApproverChange = (newApprover: string) => {
    setApprover(newApprover);
  };

  const handleApproverBlur = () => {
    if (approver !== (plan.approver || "")) {
      handleMetadataUpdate({ approver: approver || undefined });
    }
  };

  const handlePlanTypeChange = (newPlanType: string) => {
    setPlanType(newPlanType);
    handleMetadataUpdate({ planType: newPlanType });
  };

  const handleTargetReleaseChange = (newTargetRelease: string) => {
    setTargetRelease(newTargetRelease);
  };

  const handleTargetReleaseBlur = () => {
    if (targetRelease !== (plan.targetRelease || "")) {
      handleMetadataUpdate({ targetRelease: targetRelease || undefined });
    }
  };

  const handleEngineeringTeamChange = (newEngineeringTeam: string) => {
    setEngineeringTeam(newEngineeringTeam);
  };

  const handleEngineeringTeamBlur = () => {
    if (engineeringTeam !== (plan.engineeringTeam || "")) {
      handleMetadataUpdate({ engineeringTeam: engineeringTeam || undefined });
    }
  };

  const handleApprove = () => {
    startTransition(async () => {
      const result = await updateImplementationPlan({ id: plan.id, status: "Ready" });
      if (result.data) {
        setStatus("Ready");
        setLastSaved(new Date());
        toast.success("Plan approved");
      } else if (result.error) {
        toast.error("Failed to approve plan");
      }
    });
  };

  const handleModify = () => {
    // TODO: Implement modify functionality
    // For now, just switch to markdown view for editing
    setViewMode("markdown");
  };

  const handleExport = () => {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${plan.title.toLowerCase().replace(/\s+/g, "-")}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(content);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
    }
  };

  const handleDelete = () => {
    startTransition(async () => {
      await deleteImplementationPlan(plan.id);
      router.push("/implementation-plans");
    });
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
          <Link href="/implementation-plans">
            <Button variant="ghost" size="sm">
              <ArrowLeftIcon className="mr-2 h-4 w-4" />
              Back to Plans
            </Button>
          </Link>

          <div className="flex items-center gap-2">
            <span className="font-medium">{plan.title}</span>
            <span className="text-sm text-muted-foreground font-mono">v{plan.version}</span>
            <ImplementationPlanStatusBadge status={status} />
          </div>

          <span className="text-sm text-muted-foreground">
            {isSaving ? "Saving..." : `Last saved: ${formatLastSaved(lastSaved)}`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* View Mode Toggle */}
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
            <TabsList className="h-8">
              <TabsTrigger value="rendered" className="h-6 px-2 text-xs">
                <EyeIcon className="mr-1 h-3 w-3" />
                Rendered
              </TabsTrigger>
              <TabsTrigger value="markdown" className="h-6 px-2 text-xs">
                <CodeIcon className="mr-1 h-3 w-3" />
                Markdown
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <Button
            onClick={() => setShowMetadataPanel(!showMetadataPanel)}
            variant={showMetadataPanel ? "secondary" : "outline"}
            size="sm"
          >
            <SettingsIcon className="mr-2 h-4 w-4" />
            Details
          </Button>

          {/* Modify button (replaces Regenerate) */}
          <Button onClick={handleModify} variant="outline" size="sm">
            <PencilIcon className="mr-2 h-4 w-4" />
            Modify
          </Button>

          {/* Approve button - only shown for Draft plans */}
          {isDraft && (
            <Button onClick={handleApprove} variant="default" size="sm" disabled={isPending}>
              <CheckIcon className="mr-2 h-4 w-4" />
              Approve
            </Button>
          )}

          <Button onClick={handleExport} variant="outline" size="sm">
            <DownloadIcon className="mr-2 h-4 w-4" />
            Export
          </Button>

          <Button onClick={handleCopyMarkdown} variant="outline" size="sm">
            <CopyIcon className="mr-2 h-4 w-4" />
            Copy MD
          </Button>

          {viewMode === "markdown" && (
            <Button onClick={handleSave} disabled={isPending} size="sm">
              {isSaving ? "Saving..." : "Save"}
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <MoreHorizontalIcon className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[180px]">
              <DropdownMenuItem asChild>
                <Link href={`/prds/${plan.sourcePrd.id}`}>
                  View Source PRD
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setShowDeleteDialog(true)}
                className="text-destructive focus:text-destructive"
              >
                <TrashIcon className="mr-2 h-4 w-4" />
                Delete Plan
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Content Area with Optional Metadata Panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Scrollable Content */}
        <div className="flex-1 overflow-auto">
          <div className="max-w-4xl mx-auto p-4">
            {viewMode === "rendered" ? (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <MarkdownPreview content={content} />
              </div>
            ) : (
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Implementation plan content..."
                className="min-h-[calc(100vh-200px)] font-mono text-sm resize-none border-0 focus-visible:ring-0 p-0 shadow-none"
              />
            )}
          </div>
        </div>

        {/* Metadata Panel */}
        {showMetadataPanel && (
          <div className="w-80 border-l bg-muted/30 p-4 overflow-auto">
            <h3 className="font-semibold mb-4">Plan Details</h3>

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
                <Label>Plan Type</Label>
                <Select value={planType} onValueChange={handlePlanTypeChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLAN_TYPE_OPTIONS.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Target Release</Label>
                <Input
                  value={targetRelease}
                  onChange={(e) => handleTargetReleaseChange(e.target.value)}
                  onBlur={handleTargetReleaseBlur}
                  placeholder="e.g., v2.0"
                />
              </div>

              <div className="space-y-2">
                <Label>Engineering Team</Label>
                <Input
                  value={engineeringTeam}
                  onChange={(e) => handleEngineeringTeamChange(e.target.value)}
                  onBlur={handleEngineeringTeamBlur}
                  placeholder="e.g., Platform"
                />
              </div>

              <div className="pt-4 border-t">
                <div className="text-sm text-muted-foreground space-y-1">
                  <p>Created by: {plan.createdBy}</p>
                  <p>Source PRD: {plan.sourcePrd.title}</p>
                  <p>Version: v{plan.version}</p>
                  <p>Created: {new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(plan.createdAt))}</p>
                  <p>Updated: {new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(plan.updatedAt))}</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Implementation Plan</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{plan.title}"? This action cannot be
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
    </div>
  );
}

// Simple Markdown preview component
function MarkdownPreview({ content }: { content: string }) {
  // Convert markdown to HTML with basic formatting
  const html = content
    // Headers
    .replace(/^### (.+)$/gm, '<h3 class="text-lg font-semibold mt-6 mb-2">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-xl font-semibold mt-8 mb-3">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-2xl font-bold mt-8 mb-4">$1</h1>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Code blocks
    .replace(/```[\s\S]*?```/g, (match) => {
      const code = match.slice(3, -3).trim();
      return `<pre class="bg-muted p-4 rounded-lg overflow-x-auto my-4"><code class="text-sm">${escapeHtml(code)}</code></pre>`;
    })
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="bg-muted px-1.5 py-0.5 rounded text-sm">$1</code>')
    // Checkboxes
    .replace(/^- \[x\] (.+)$/gm, '<div class="flex items-center gap-2 my-1"><input type="checkbox" checked disabled class="h-4 w-4" /><span class="line-through text-muted-foreground">$1</span></div>')
    .replace(/^- \[ \] (.+)$/gm, '<div class="flex items-center gap-2 my-1"><input type="checkbox" disabled class="h-4 w-4" /><span>$1</span></div>')
    // Unordered lists
    .replace(/^- (.+)$/gm, '<li class="ml-4">$1</li>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr class="my-6 border-border" />')
    // Line breaks
    .replace(/\n\n/g, '</p><p class="my-4">')
    .replace(/\n/g, '<br />');

  return (
    <div
      className="markdown-content"
      dangerouslySetInnerHTML={{ __html: `<p class="my-4">${html}</p>` }}
    />
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
