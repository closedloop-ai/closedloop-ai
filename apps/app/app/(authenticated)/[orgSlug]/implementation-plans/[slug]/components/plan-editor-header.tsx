"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import type {
  DocumentWithProject,
  GenerationStatus,
  PullRequestInfo,
} from "@repo/api/src/types/document";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { FavoriteButton } from "@repo/app/documents/components/favorite-button";
import {
  RunActionMenuItem,
  RunInFlightMenuNote,
} from "@repo/app/documents/components/run-action-availability";
import {
  isCommandDisabled,
  isRunInFlightForCommand,
} from "@repo/app/documents/lib/generation-status-utils";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ARTIFACT_RUN_ACTION_UNAVAILABLE_REASON_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
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
import { useId } from "react";
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
  const reasonId = useId();
  const branchPrFlag = useFeatureFlag("branch-pr");
  const branchPrEnabled = branchPrFlag?.enabled === true;
  // ISS-5508: closed by default. OFF, every run item below keeps the native
  // `disabled` it has always rendered and no explanation exists.
  const explainUnavailable = useFeatureFlagEnabledOptional(
    ARTIFACT_RUN_ACTION_UNAVAILABLE_REASON_FEATURE_FLAG_KEY
  );
  // `RunLoopCommand`, not a bare string, at every call below (PR #4714 review,
  // wongk). These names have to agree with what the item's `onActivate` actually
  // dispatches to `POST /documents/:id/run-loop`; a duplicated literal agrees by
  // coincidence and keeps agreeing right up until the wire vocabulary changes,
  // at which point the explanation silently attaches to a command nothing sends
  // and the item just greys out unexplained again — this ticket's own bug. The
  // parameter is typed to the enum rather than the wider
  // `GenerationStatus["command"]` so a hand-typed near-miss ("evaluate_pr") is a
  // compile error here and not a branch that is merely never true.
  const runInFlight = (targetCommand: RunLoopCommand) =>
    explainUnavailable &&
    isRunInFlightForCommand({ generationStatus, targetCommand });
  // A run may only be named as the cause when it is the ONLY blocker — a run
  // finishing does not approve a draft plan or settle a pending local mutation,
  // so claiming it would promise an availability that never arrives.
  const executeRunInFlight =
    runInFlight(RunLoopCommand.Execute) && isApproved && !isExecuting;
  const requestChangesRunInFlight =
    runInFlight(RunLoopCommand.RequestChanges) && !isPending;
  const regenerateRunInFlight = runInFlight(RunLoopCommand.Plan) && !isPending;
  const evaluatePlanRunInFlight =
    runInFlight(RunLoopCommand.EvaluatePlan) && !isPending;
  // Also gated on the item RENDERING at all: "Evaluate PR" only exists when an
  // evaluatable PR is present, and without this the menu could show a note
  // explaining an item that is not on screen.
  const evaluateCodeRunInFlight =
    onEvaluateCode !== undefined &&
    runInFlight(RunLoopCommand.EvaluateCode) &&
    !isPending;
  const anyRunInFlight =
    executeRunInFlight ||
    requestChangesRunInFlight ||
    regenerateRunInFlight ||
    evaluatePlanRunInFlight ||
    evaluateCodeRunInFlight;

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
          <RunActionMenuItem
            disabled={
              !isApproved ||
              isCommandDisabled({
                generationStatus,
                isLoading: generationStatusLoading,
                targetCommand: RunLoopCommand.Execute,
                localMutationPending: isExecuting,
              })
            }
            onActivate={() => onExecute()}
            reasonId={reasonId}
            runInFlight={executeRunInFlight}
          >
            <PlayIcon className="h-4 w-4" />
            Execute
          </RunActionMenuItem>
          <RunActionMenuItem
            disabled={
              isPending ||
              isCommandDisabled({
                generationStatus,
                isLoading: generationStatusLoading,
                targetCommand: RunLoopCommand.RequestChanges,
              })
            }
            onActivate={() => onRequestChanges()}
            reasonId={reasonId}
            runInFlight={requestChangesRunInFlight}
          >
            <MessageSquareIcon className="h-4 w-4" />
            Request Changes
          </RunActionMenuItem>
          <RunActionMenuItem
            disabled={
              isPending ||
              isCommandDisabled({
                generationStatus,
                isLoading: generationStatusLoading,
                targetCommand: RunLoopCommand.Plan,
              })
            }
            onActivate={() => onRegenerate()}
            reasonId={reasonId}
            runInFlight={regenerateRunInFlight}
          >
            <RefreshCwIcon className="h-4 w-4" />
            Regenerate Plan
          </RunActionMenuItem>
          <RunActionMenuItem
            disabled={
              isPending ||
              isCommandDisabled({
                generationStatus,
                isLoading: generationStatusLoading,
                targetCommand: RunLoopCommand.EvaluatePlan,
              })
            }
            onActivate={() => onEvaluatePlan()}
            reasonId={reasonId}
            runInFlight={evaluatePlanRunInFlight}
          >
            <GaugeIcon className="h-4 w-4" />
            Evaluate Plan
          </RunActionMenuItem>
          {onEvaluateCode ? (
            <RunActionMenuItem
              disabled={
                isPending ||
                isCommandDisabled({
                  generationStatus,
                  isLoading: generationStatusLoading,
                  targetCommand: RunLoopCommand.EvaluateCode,
                })
              }
              onActivate={() => onEvaluateCode()}
              reasonId={reasonId}
              runInFlight={evaluateCodeRunInFlight}
            >
              <GaugeIcon className="h-4 w-4" />
              Evaluate PR
            </RunActionMenuItem>
          ) : null}
          {anyRunInFlight ? (
            <>
              <DropdownMenuSeparator />
              <RunInFlightMenuNote id={reasonId} />
            </>
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
