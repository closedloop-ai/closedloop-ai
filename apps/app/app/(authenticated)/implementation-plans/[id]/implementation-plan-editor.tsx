"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
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
import {
  ArrowLeftIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  TrashIcon,
  CheckIcon,
  SettingsIcon,
} from "lucide-react";
import Link from "next/link";
import type { ImplementationPlan, PRD } from "@repo/database/generated/client";
import { ImplementationPlanStatusBadge } from "../components/implementation-plan-status-badge";
import { formatRelativeTime } from "@/lib/utils";
import { IMPL_PLAN_STATUS_OPTIONS, IMPL_PLAN_TYPE_OPTIONS, type ImplPlanStatus, type ImplPlanType } from "@/lib/types";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { useImplementationPlanEditor } from "./use-implementation-plan-editor";

type ImplementationPlanWithPRD = ImplementationPlan & {
  sourcePrd: Pick<PRD, "id" | "title">;
};

type ImplementationPlanEditorProps = {
  plan: ImplementationPlanWithPRD;
};

export function ImplementationPlanEditor({ plan }: ImplementationPlanEditorProps) {
  const {
    isPending,
    content,
    setContent,
    lastSaved,
    isSaving,
    status,
    approver,
    planType,
    targetRelease,
    engineeringTeam,
    showMetadataPanel,
    setShowMetadataPanel,
    showDeleteDialog,
    setShowDeleteDialog,
    isDraft,
    handleSave,
    handleStatusChange,
    handleApproverChange,
    handleApproverBlur,
    handlePlanTypeChange,
    handleTargetReleaseChange,
    handleTargetReleaseBlur,
    handleEngineeringTeamChange,
    handleEngineeringTeamBlur,
    handleApprove,
    handleExport,
    handleCopyMarkdown,
    handleDelete,
  } = useImplementationPlanEditor(plan);

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
            {isSaving ? "Saving..." : `Last saved: ${formatRelativeTime(lastSaved)}`}
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

          {/* Approve button - only shown for Draft plans */}
          {isDraft && (
            <Button onClick={handleApprove} variant="outline" size="sm" disabled={isPending}>
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

          <Button onClick={handleSave} disabled={isPending}>
            {isSaving ? "Saving..." : "Save"}
          </Button>

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
        {/* Scrollable Editor */}
        <div className="flex-1 overflow-auto">
          <div className="max-w-4xl mx-auto p-4">
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Start writing your implementation plan..."
              className="min-h-[calc(100vh-200px)] font-mono text-sm resize-none border-0 focus-visible:ring-0 p-0 shadow-none"
            />
          </div>
        </div>

        {/* Metadata Panel */}
        {showMetadataPanel && (
          <div className="w-80 border-l bg-muted/30 p-4 overflow-auto">
            <h3 className="font-semibold mb-4">Plan Details</h3>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={status} onValueChange={(v) => handleStatusChange(v as ImplPlanStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {IMPL_PLAN_STATUS_OPTIONS.map((opt) => (
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
                <Select value={planType} onValueChange={(v) => handlePlanTypeChange(v as ImplPlanType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {IMPL_PLAN_TYPE_OPTIONS.map((opt) => (
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
      <DeleteConfirmationDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title="Implementation Plan"
        itemName={plan.title}
        onConfirm={handleDelete}
        isPending={isPending}
      />
    </div>
  );
}
