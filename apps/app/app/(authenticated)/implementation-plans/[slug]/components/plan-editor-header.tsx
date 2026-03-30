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
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  TrashIcon,
} from "lucide-react";
import {
  type BreadcrumbEntry,
  Header,
} from "@/app/(authenticated)/components/header";

type PlanEditorHeaderProps = {
  plan: ArtifactWithWorkstream;
  showMetadataPanel: boolean;
  canShowPanel?: boolean;
  isDraft: boolean;
  isApproved: boolean;
  pullRequest?: { htmlUrl: string; number: number } | null;
  isExecuting: boolean;
  onToggleMetadataPanel: () => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  onExecute: () => void;
  onCopyMarkdown: () => void;
  onExportMarkdown: () => void;
  onMove: () => void;
  onExportToLinear: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
  showRestore?: boolean;
  onRestoreVersion?: () => void;
  isPending?: boolean;
};

export function PlanEditorHeader({
  plan,
  showMetadataPanel,
  canShowPanel = true,
  isDraft,
  isApproved,
  pullRequest,
  isExecuting,
  onToggleMetadataPanel,
  onApprove,
  onRequestChanges,
  onExecute,
  onCopyMarkdown,
  onExportMarkdown,
  onExportToLinear,
  onMove,
  onRegenerate,
  onDelete,
  showRestore = false,
  onRestoreVersion,
  isPending = false,
}: PlanEditorHeaderProps) {
  const breadcrumbs: BreadcrumbEntry[] = plan.project?.teams?.[0]?.id
    ? [
        {
          label: plan.project.teams[0].name,
          href: `/teams/${plan.project.teams[0].id}/projects`,
        },
        {
          label: plan.project.name,
          href: `/teams/${plan.project.teams[0].id}/projects/${plan.project.id}`,
        },
        { label: plan.title },
      ]
    : [
        { label: "Plans", href: "/implementation-plans" },
        { label: plan.title },
      ];

  const overflowMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost">
          <MoreHorizontalIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[180px]">
        {pullRequest ? (
          <>
            <DropdownMenuItem asChild>
              <a
                href={pullRequest.htmlUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <GitPullRequestIcon className="h-4 w-4" />
                PR #{pullRequest.number}
                <ExternalLinkIcon className="ml-auto h-3 w-3" />
              </a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onClick={onExportMarkdown}>
          <DownloadIcon className="h-4 w-4" />
          Export Markdown
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onExportToLinear}>
          <ExternalLinkIcon className="h-4 w-4" />
          Export to Linear
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onCopyMarkdown}>
          <CopyIcon className="h-4 w-4" />
          Copy Markdown
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onMove}>
          <FolderIcon className="h-4 w-4" />
          Move...
        </DropdownMenuItem>
        {showRestore ? (
          <DropdownMenuItem onClick={onRestoreVersion}>
            <RotateCcwIcon className="h-4 w-4" />
            Restore Version
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onDelete} variant="destructive">
          <TrashIcon className="h-4 w-4" />
          Delete Plan
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Header breadcrumbs={breadcrumbs}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button disabled={isPending} size="sm">
            Actions
            <ChevronDownIcon className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isDraft ? (
            <DropdownMenuItem onClick={onApprove}>
              <CheckIcon className="h-4 w-4" />
              Approve
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            disabled={!isApproved || isExecuting}
            onClick={onExecute}
          >
            <PlayIcon className="h-4 w-4" />
            Execute
          </DropdownMenuItem>
          <DropdownMenuItem disabled={isPending} onClick={onRequestChanges}>
            <MessageSquareIcon className="h-4 w-4" />
            Request Changes
          </DropdownMenuItem>
          <DropdownMenuItem disabled={isPending} onClick={onRegenerate}>
            <RefreshCwIcon className="h-4 w-4" />
            Regenerate Plan
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {overflowMenu}

      {canShowPanel && (
        <Button
          aria-label="Toggle chat panel"
          onClick={onToggleMetadataPanel}
          size="icon"
          title="Toggle chat panel"
          variant={showMetadataPanel ? "secondary" : "ghost"}
        >
          <PanelRightIcon className="h-4 w-4" />
        </Button>
      )}
    </Header>
  );
}
