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
import { RichTextEditor } from "@repo/design-system/components/ui/rich-text-editor/rich-text-editor";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import {
  ArrowLeftIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SettingsIcon,
  TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { GenerationStatusBanner } from "@/components/generation-status-banner";
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
  const router = useRouter();
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
    generationStatus,
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b bg-background px-4 py-3">
        <div className="flex items-center gap-4">
          <Link
            href={
              plan.project?.teams?.[0]?.id
                ? `/teams/${plan.project.teams[0].id}/projects/${plan.project.id}`
                : "/implementation-plans"
            }
          >
            <Button size="sm" variant="ghost">
              <ArrowLeftIcon className="mr-2 h-4 w-4" />
              {plan.project?.teams?.[0]?.id
                ? "Back to Project"
                : "Back to Plans"}
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

      {/* Generation Status Banner */}
      <GenerationStatusBanner
        artifactId={plan.id}
        onComplete={() => router.refresh()}
      />

      {/* Content Area with Optional Metadata Panel */}
      <div className="flex min-h-0 flex-1">
        {/* Scrollable Editor */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 w-full flex-1 flex-col">
            <RichTextEditor
              onChange={setContent}
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

              {/* GitHub Action Run Link */}
              {generationStatus?.htmlUrl ? (
                <div className="border-t pt-4">
                  <div className="space-y-2">
                    <Label className="text-muted-foreground text-xs">
                      Generation
                    </Label>
                    <a
                      className="flex items-center gap-1 text-primary text-sm hover:underline"
                      href={generationStatus.htmlUrl}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      View GitHub Workflow
                      <ExternalLinkIcon className="h-3 w-3" />
                    </a>
                  </div>
                </div>
              ) : null}
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
