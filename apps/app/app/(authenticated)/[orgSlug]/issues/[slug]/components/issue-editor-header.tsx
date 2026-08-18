"use client";

import type {
  DocumentWithProject,
  GenerationStatus,
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
import {
  ChevronDownIcon,
  FolderInputIcon,
  GaugeIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PlayIcon,
  SparklesIcon,
  TrashIcon,
} from "lucide-react";
import { useId } from "react";
import {
  type BreadcrumbEntry,
  Header,
} from "@/app/(authenticated)/components/header";
import { useOrgSlug } from "@/hooks/use-org-slug";

type IssueEditorHeaderProps = {
  feature: DocumentWithProject;
  displayTitle: string;
  hasPlan: boolean;
  isReady: boolean;
  isEvaluating?: boolean;
  generationStatus?: GenerationStatus;
  generationStatusLoading?: boolean;
  onToggleMetadataPanel: () => void;
  onGeneratePlan: () => void;
  onStartBuild: () => void;
  onMoveToProject: () => void;
  onDelete: () => void;
  onEvaluateFeature: () => void;
};

export function IssueEditorHeader({
  feature,
  displayTitle,
  hasPlan,
  isReady,
  isEvaluating = false,
  generationStatus,
  generationStatusLoading = false,
  onToggleMetadataPanel,
  onGeneratePlan,
  onStartBuild,
  onMoveToProject,
  onDelete,
  onEvaluateFeature,
}: Readonly<IssueEditorHeaderProps>) {
  const orgSlug = useOrgSlug();
  const reasonId = useId();
  // ISS-5508: closed by default. OFF, every item below keeps the native
  // `disabled` it has always rendered and no explanation exists.
  const explainUnavailable = useFeatureFlagEnabledOptional(
    ARTIFACT_RUN_ACTION_UNAVAILABLE_REASON_FEATURE_FLAG_KEY
  );
  const runInFlight = (targetCommand: RunLoopCommand) =>
    explainUnavailable &&
    isRunInFlightForCommand({ generationStatus, targetCommand });
  // A run may only be named as the cause when it is the ONLY blocker — a run
  // finishing does not make an unready issue ready or conjure a plan, so
  // claiming it would promise an availability that never arrives.
  const generatePlanBlocked = !isReady || hasPlan;
  const startBuildingBlocked = !hasPlan;
  const planRunInFlight =
    runInFlight(RunLoopCommand.Plan) && !generatePlanBlocked;
  const executeRunInFlight =
    runInFlight(RunLoopCommand.Execute) && !startBuildingBlocked;
  const evaluateRunInFlight =
    runInFlight(RunLoopCommand.EvaluateFeature) && !isEvaluating;
  const anyRunInFlight =
    planRunInFlight || executeRunInFlight || evaluateRunInFlight;
  const teamId = feature.project?.teams?.[0]?.id;
  const projectId = feature.project?.id;
  const teamName = feature.project?.teams?.[0]?.name;
  const projectName = feature.project?.name;

  const breadcrumbs: BreadcrumbEntry[] = [
    ...(teamId && teamName
      ? [{ label: teamName, href: `/${orgSlug}/teams/${teamId}/projects` }]
      : []),
    ...(teamId && projectId && projectName
      ? [
          {
            label: projectName,
            // FEA-4137: the project's Issues tab is `?tab=issues` now (legacy
            // `?tab=features` still resolves via the project page's tab alias).
            href: `/${orgSlug}/teams/${teamId}/projects/${projectId}?tab=issues`,
          },
        ]
      : []),
    { label: displayTitle },
  ];

  return (
    <Header
      afterBreadcrumbs={<FavoriteButton artifactId={feature.id} />}
      breadcrumbs={breadcrumbs}
      moreMenu={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label="More options" size="icon-sm" variant="ghost">
              <MoreHorizontalIcon className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[160px]">
            <DropdownMenuItem onClick={() => onMoveToProject()}>
              <FolderInputIcon className="h-4 w-4" />
              Move to Project
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onDelete()} variant="destructive">
              <TrashIcon className="h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">
            Actions
            <ChevronDownIcon className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <RunActionMenuItem
            disabled={
              generatePlanBlocked ||
              isCommandDisabled({
                generationStatus,
                isLoading: generationStatusLoading,
                targetCommand: RunLoopCommand.Plan,
              })
            }
            onActivate={() => onGeneratePlan()}
            reasonId={reasonId}
            runInFlight={planRunInFlight}
          >
            <SparklesIcon className="h-4 w-4" />
            Generate Plan
          </RunActionMenuItem>
          <RunActionMenuItem
            disabled={
              startBuildingBlocked ||
              isCommandDisabled({
                generationStatus,
                isLoading: generationStatusLoading,
                targetCommand: RunLoopCommand.Execute,
              })
            }
            onActivate={() => onStartBuild()}
            reasonId={reasonId}
            runInFlight={executeRunInFlight}
          >
            <PlayIcon className="h-4 w-4" />
            Start Building
          </RunActionMenuItem>
          <RunActionMenuItem
            disabled={isCommandDisabled({
              generationStatus,
              isLoading: generationStatusLoading,
              targetCommand: RunLoopCommand.EvaluateFeature,
              localMutationPending: isEvaluating,
            })}
            onActivate={() => onEvaluateFeature()}
            reasonId={reasonId}
            runInFlight={evaluateRunInFlight}
          >
            <GaugeIcon className="h-4 w-4" />
            {isEvaluating ? "Evaluating Issue..." : "Evaluate Issue"}
          </RunActionMenuItem>
          {anyRunInFlight ? (
            <>
              <DropdownMenuSeparator />
              <RunInFlightMenuNote id={reasonId} />
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        aria-label="Toggle chat panel"
        onClick={() => onToggleMetadataPanel()}
        size="icon-sm"
        title="Toggle chat panel"
        variant="ghost"
      >
        <PanelRightIcon className="h-4 w-4" />
      </Button>
    </Header>
  );
}
