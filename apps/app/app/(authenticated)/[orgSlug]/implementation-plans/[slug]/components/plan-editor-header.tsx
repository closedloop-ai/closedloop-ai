"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import type {
  DocumentWithProject,
  GenerationStatus,
  PullRequestInfo,
} from "@repo/api/src/types/document";
import { FavoriteButton } from "@repo/app/documents/components/favorite-button";
import { isCommandDisabled } from "@repo/app/documents/lib/generation-status-utils";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Link } from "@repo/navigation/link";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderIcon,
  GaugeIcon,
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
import { useOrgSlug } from "@/hooks/use-org-slug";

type PlanEditorHeaderProps = {
  plan: DocumentWithProject;
  canShowPanel?: boolean;
  isDraft: boolean;
  isApproved: boolean;
  pullRequests?: PullRequestInfo[] | null;
  isExecuting: boolean;
  generationStatus?: GenerationStatus;
  generationStatusLoading?: boolean;
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
  onEvaluatePlan: () => void;
  /** Present only when an open PR with a head branch is available; menu item is omitted when undefined. */
  onEvaluateCode?: () => void;
  showRestore?: boolean;
  onRestoreVersion?: () => void;
  isPending?: boolean;
};

export function PlanEditorHeader({
  plan,
  canShowPanel = true,
  isDraft,
  isApproved,
  pullRequests,
  isExecuting,
  generationStatus,
  generationStatusLoading = false,
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
  onEvaluatePlan,
  onEvaluateCode,
  showRestore = false,
  onRestoreVersion,
  isPending = false,
}: PlanEditorHeaderProps) {
  const orgSlug = useOrgSlug();
  const branchPrFlag = useFeatureFlag("branch-pr");
  const branchPrEnabled = branchPrFlag?.enabled === true;

  const breadcrumbs: BreadcrumbEntry[] = plan.project?.teams?.[0]?.id
    ? [
        {
          label: plan.project.teams[0].name,
          href: `/${orgSlug}/teams/${plan.project.teams[0].id}/projects`,
        },
        {
          label: plan.project.name,
          href: `/${orgSlug}/teams/${plan.project.teams[0].id}/projects/${plan.project.id}`,
        },
        { label: plan.title },
      ]
    : [
        { label: "Plans", href: `/${orgSlug}/implementation-plans` },
        { label: plan.title },
      ];

  const overflowMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="More options" size="icon" variant="ghost">
          <MoreHorizontalIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[280px]">
        {pullRequests && pullRequests.length > 0 ? (
          <>
            {pullRequests.map((pr) => (
              <DropdownMenuItem asChild key={pr.id}>
                {branchPrEnabled && pr.externalLinkId ? (
                  <Link href={`/${orgSlug}/build/${pr.externalLinkId}`}>
                    <GitPullRequestIcon className="h-4 w-4" />
                    {pr.repoFullName ? `${pr.repoFullName} ` : ""}
                    PR #{pr.number}
                  </Link>
                ) : (
                  <a
                    href={pr.htmlUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    <GitPullRequestIcon className="h-4 w-4" />
                    {pr.repoFullName ? `${pr.repoFullName} ` : ""}
                    PR #{pr.number}
                    <ExternalLinkIcon className="ml-auto h-3 w-3" />
                  </a>
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onClick={() => onExportMarkdown()}>
          <DownloadIcon className="h-4 w-4" />
          Export Markdown
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExportToLinear()}>
          <ExternalLinkIcon className="h-4 w-4" />
          Export to Linear
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onCopyMarkdown()}>
          <CopyIcon className="h-4 w-4" />
          Copy Markdown
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onMove()}>
          <FolderIcon className="h-4 w-4" />
          Move...
        </DropdownMenuItem>
        {showRestore ? (
          <DropdownMenuItem onClick={() => onRestoreVersion?.()}>
            <RotateCcwIcon className="h-4 w-4" />
            Restore Version
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onDelete()} variant="destructive">
          <TrashIcon className="h-4 w-4" />
          Delete Plan
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Header
      afterBreadcrumbs={<FavoriteButton artifactId={plan.id} />}
      breadcrumbs={breadcrumbs}
      moreMenu={overflowMenu}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button disabled={isPending} size="sm">
            Actions
            <ChevronDownIcon className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isDraft ? (
            <DropdownMenuItem onClick={() => onApprove()}>
              <CheckIcon className="h-4 w-4" />
              Approve
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            disabled={
              !isApproved ||
              isCommandDisabled({
                generationStatus,
                isLoading: generationStatusLoading,
                targetCommand: "execute",
                localMutationPending: isExecuting,
              })
            }
            onClick={() => onExecute()}
          >
            <PlayIcon className="h-4 w-4" />
            Execute
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={
              isPending ||
              isCommandDisabled({
                generationStatus,
                isLoading: generationStatusLoading,
                targetCommand: "request_changes",
              })
            }
            onClick={() => onRequestChanges()}
          >
            <MessageSquareIcon className="h-4 w-4" />
            Request Changes
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={
              isPending ||
              isCommandDisabled({
                generationStatus,
                isLoading: generationStatusLoading,
                targetCommand: "plan",
              })
            }
            onClick={() => onRegenerate()}
          >
            <RefreshCwIcon className="h-4 w-4" />
            Regenerate Plan
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={
              isPending ||
              isCommandDisabled({
                generationStatus,
                isLoading: generationStatusLoading,
                targetCommand: "evaluate_plan",
              })
            }
            onClick={() => onEvaluatePlan()}
          >
            <GaugeIcon className="h-4 w-4" />
            Evaluate Plan
          </DropdownMenuItem>
          {onEvaluateCode ? (
            <DropdownMenuItem
              disabled={
                isPending ||
                isCommandDisabled({
                  generationStatus,
                  isLoading: generationStatusLoading,
                  targetCommand: "evaluate_code",
                })
              }
              onClick={() => onEvaluateCode()}
            >
              <GaugeIcon className="h-4 w-4" />
              Evaluate PR
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {canShowPanel && (
        <Button
          aria-label="Toggle chat panel"
          onClick={() => onToggleMetadataPanel()}
          size="icon"
          title="Toggle chat panel"
          variant="ghost"
        >
          <PanelRightIcon className="h-4 w-4" />
        </Button>
      )}
    </Header>
  );
}
