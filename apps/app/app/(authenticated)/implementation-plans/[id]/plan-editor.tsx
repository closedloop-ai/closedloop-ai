"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import {
  ARTIFACT_STATUS_OPTIONS,
  type ArtifactStatus,
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
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SettingsIcon,
  TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import {
  ArtifactStatusBadge,
  artifactStatusLabels,
} from "@/components/status-badge";
import { formatRelativeTime } from "@/lib/date-utils";
import { usePlanEditor } from "./use-plan-editor";

type PlanEditorProps = {
  plan: ArtifactWithWorkstream;
};

export function PlanEditor({ plan }: PlanEditorProps) {
  const {
    isPending,
    content,
    setContent,
    lastSaved,
    isSaving,
    status,
    approver,
    showMetadataPanel,
    setShowMetadataPanel,
    showDeleteDialog,
    setShowDeleteDialog,
    isDraft,
    handleSave,
    handleStatusChange,
    handleApproverChange,
    handleApproverBlur,
    handleApprove,
    handleExport,
    handleCopyMarkdown,
    handleDelete,
    handleRegenerate,
  } = usePlanEditor(plan);

  return (
    <div className="flex h-full flex-col">
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-3">
        <div className="flex items-center gap-4">
          <Link href="/implementation-plans">
            <Button size="sm" variant="ghost">
              <ArrowLeftIcon className="mr-2 h-4 w-4" />
              Back to Plans
            </Button>
          </Link>

          <div className="flex items-center gap-2">
            <span className="font-medium">{plan.title}</span>
            <span className="font-mono text-muted-foreground text-sm">
              v{plan.version}
            </span>
            <ArtifactStatusBadge status={status} />
          </div>

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

          {/* Approve button - only shown for Draft plans */}
          {isDraft ? (
            <Button
              disabled={isPending}
              onClick={handleApprove}
              size="sm"
              variant="outline"
            >
              <CheckIcon className="mr-2 h-4 w-4" />
              Approve
            </Button>
          ) : null}

          <Button onClick={handleExport} size="sm" variant="outline">
            <DownloadIcon className="mr-2 h-4 w-4" />
            Export
          </Button>

          <Button onClick={handleCopyMarkdown} size="sm" variant="outline">
            <CopyIcon className="mr-2 h-4 w-4" />
            Copy MD
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
            <DropdownMenuContent align="end" className="w-[180px]">
              <DropdownMenuItem disabled={isPending} onClick={handleRegenerate}>
                <RefreshCwIcon className="mr-2 h-4 w-4" />
                Regenerate Plan
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => setShowDeleteDialog(true)}
              >
                <TrashIcon className="mr-2 h-4 w-4" />
                Delete Plan
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
              placeholder="Start writing your implementation plan..."
              value={content}
            />
          </div>
        </div>

        {/* Metadata Panel */}
        {showMetadataPanel ? (
          <div className="w-80 overflow-auto border-l bg-muted/30 p-4">
            <h3 className="mb-4 font-semibold">Plan Details</h3>

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
                    {ARTIFACT_STATUS_OPTIONS.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {artifactStatusLabels[opt] ?? opt}
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

              <div className="border-t pt-4">
                <div className="space-y-1 text-muted-foreground text-sm">
                  <p>Version: v{plan.version}</p>
                  <p>
                    Created:{" "}
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                    }).format(new Date(plan.createdAt))}
                  </p>
                  <p>
                    Updated:{" "}
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                    }).format(new Date(plan.updatedAt))}
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        isPending={isPending}
        itemName={plan.title}
        onConfirm={handleDelete}
        onOpenChange={setShowDeleteDialog}
        open={showDeleteDialog}
        title="Implementation Plan"
      />
    </div>
  );
}
