"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { RichTextEditor } from "@repo/design-system/components/ui/rich-text-editor/rich-text-editor";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PlayIcon,
  RefreshCwIcon,
  SettingsIcon,
  TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { GenerationStatusBanner } from "@/components/generation-status-banner";
import { ArtifactStatusBadge } from "@/components/status-badge";
import { formatRelativeTime } from "@/lib/date-utils";
import { ExecutePlanModal } from "../components/execute-plan-modal";
import { RequestChangesModal } from "../components/request-changes-modal";
import { VersionSelector } from "../components/version-selector";
import { LinearExportDialog } from "./components/linear-export-dialog";
import { PlanMetadataPanel } from "./components/plan-metadata-panel";
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
    showRequestChangesModal,
    setShowRequestChangesModal,
    isRequestingChanges,
    showLinearExportDialog,
    setShowLinearExportDialog,
    showExecuteModal,
    setShowExecuteModal,
    isExecuting,
    isDraft,
    isApproved,
    generationStatus,
    pullRequest,
    handleSaveContent,
    handleStatusChange,
    handleApproverChange,
    handleApproverBlur,
    handleApprove,
    handleDownloadMarkdown,
    handleCopyMarkdown,
    handleDelete,
    handleRegenerate,
    handleRequestChanges,
    handleExecute,
  } = usePlanEditor(plan);

  // Compute back link destination
  const teamId = plan.project?.teams?.[0]?.id;
  const backHref = teamId
    ? `/teams/${teamId}/projects/${plan.project?.id}`
    : "/implementation-plans";
  const backLabel = teamId ? "Back to Project" : "Back to Plans";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b bg-background px-4 py-3">
        <div className="flex items-center gap-4">
          <Link href={backHref}>
            <Button size="sm" variant="ghost">
              <ArrowLeftIcon className="mr-2 h-4 w-4" />
              {backLabel}
            </Button>
          </Link>

          <div className="flex items-center gap-2">
            <span className="font-medium">{plan.title}</span>
            <VersionSelector
              artifactId={plan.id}
              currentVersion={plan.version}
            />
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

          <Button
            disabled={isPending}
            onClick={() => setShowRequestChangesModal(true)}
            size="sm"
            variant="outline"
          >
            <MessageSquareIcon className="mr-2 h-4 w-4" />
            Request Changes
          </Button>

          {/* Execute button - only enabled when plan is approved */}
          <Button
            disabled={isPending || !isApproved || isExecuting}
            onClick={() => setShowExecuteModal(true)}
            size="sm"
            title={
              isApproved ? "" : "Approve the plan first to enable execution"
            }
            variant={isApproved ? "default" : "outline"}
          >
            <PlayIcon className="mr-2 h-4 w-4" />
            Execute
          </Button>

          {/* PR Link - shown when a PR has been created */}
          {pullRequest ? (
            <a
              href={pullRequest.htmlUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <Button size="sm" variant="outline">
                <GitPullRequestIcon className="mr-2 h-4 w-4" />
                PR #{pullRequest.number}
              </Button>
            </a>
          ) : null}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <DownloadIcon className="mr-2 h-4 w-4" />
                Export
                <ChevronDownIcon className="ml-2 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[180px]">
              <DropdownMenuItem onClick={handleDownloadMarkdown}>
                <DownloadIcon className="mr-2 h-4 w-4" />
                Download Markdown
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowLinearExportDialog(true)}>
                <ExternalLinkIcon className="mr-2 h-4 w-4" />
                Export to Linear
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button onClick={handleCopyMarkdown} size="sm" variant="outline">
            <CopyIcon className="mr-2 h-4 w-4" />
            Copy MD
          </Button>

          <Button disabled={isPending} onClick={handleSaveContent}>
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
      <GenerationStatusBanner artifactId={plan.id} />

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
          <PlanMetadataPanel
            approver={approver}
            generationStatus={generationStatus ?? null}
            onApproverBlur={handleApproverBlur}
            onApproverChange={handleApproverChange}
            onStatusChange={handleStatusChange}
            plan={plan}
            pullRequest={pullRequest ?? null}
            status={status}
          />
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

      {/* Request Changes Modal */}
      <RequestChangesModal
        isSubmitting={isRequestingChanges}
        onOpenChange={setShowRequestChangesModal}
        onSubmit={handleRequestChanges}
        open={showRequestChangesModal}
      />

      {/* Linear Export Dialog */}
      <LinearExportDialog
        artifactId={plan.id}
        onOpenChange={setShowLinearExportDialog}
        open={showLinearExportDialog}
      />

      {/* Execute Plan Modal */}
      <ExecutePlanModal
        isLoading={isExecuting}
        onConfirm={handleExecute}
        onOpenChange={setShowExecuteModal}
        open={showExecuteModal}
      />
    </div>
  );
}
