"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import {
  DocumentType,
  type DocumentWithProject,
  type GenerationStatus,
} from "@repo/api/src/types/document";
import {
  PRD_REQUEST_CHANGES_FEATURE_FLAG_KEY,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import { FavoriteButton } from "@repo/app/documents/components/favorite-button";
import {
  RunActionMenuItem,
  RunInFlightMenuNote,
} from "@repo/app/documents/components/run-action-availability";
import {
  isCommandDisabled,
  isRunInFlightForCommand,
} from "@repo/app/documents/lib/generation-status-utils";
import { DOCUMENT_TYPE_ICONS } from "@repo/app/projects/lib/project-constants";
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
  BoxIcon,
  ChevronDownIcon,
  DownloadIcon,
  FolderIcon,
  GaugeIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PencilIcon,
  RotateCcwIcon,
  TrashIcon,
} from "lucide-react";
import { useId } from "react";
import {
  type BreadcrumbEntry,
  Header,
} from "@/app/(authenticated)/components/header";
import { useOrgSlug } from "@/hooks/use-org-slug";

type PRDEditorHeaderProps = {
  prd: DocumentWithProject;
  canShowPanel?: boolean;
  onToggleMetadataPanel: () => void;
  onDecomposeFeatures: () => void;
  onEvaluatePrd: () => void;
  onGeneratePlan: () => void;
  onGeneratePrd: () => void;
  onRequestChanges: () => void;
  isGenerating?: boolean;
  isEvaluating?: boolean;
  isRequestingChanges?: boolean;
  generationStatus?: GenerationStatus;
  generationStatusLoading?: boolean;
  onRename: () => void;
  onExport: () => void;
  onMove: () => void;
  showRestore?: boolean;
  onRestoreVersion?: () => void;
  onDelete: () => void;
  isPending?: boolean;
};

export function PRDEditorHeader({
  prd,
  canShowPanel = true,
  onToggleMetadataPanel,
  onDecomposeFeatures,
  onEvaluatePrd,
  onGeneratePlan,
  onGeneratePrd,
  onRequestChanges,
  isGenerating = false,
  isEvaluating = false,
  isRequestingChanges = false,
  generationStatus,
  generationStatusLoading = false,
  onRename,
  onExport,
  onMove,
  showRestore = false,
  onRestoreVersion,
  onDelete,
  isPending = false,
}: Readonly<PRDEditorHeaderProps>) {
  const orgSlug = useOrgSlug();
  const reasonId = useId();
  const requestChangesFlag = useFeatureFlag(
    PRD_REQUEST_CHANGES_FEATURE_FLAG_KEY
  );
  // ISS-5508: closed by default. OFF, every run item below keeps the native
  // `disabled` it has always rendered and no explanation exists.
  const explainUnavailable = useFeatureFlagEnabledOptional(
    ARTIFACT_RUN_ACTION_UNAVAILABLE_REASON_FEATURE_FLAG_KEY
  );
  const runInFlight = (targetCommand: RunLoopCommand) =>
    explainUnavailable &&
    isRunInFlightForCommand({ generationStatus, targetCommand });
  // A run may only be named as the cause when it is the ONLY blocker — a run
  // finishing does not settle a pending local mutation, so claiming it would
  // promise an availability that never arrives.
  const generatePrdRunInFlight =
    runInFlight(RunLoopCommand.GeneratePrd) && !isGenerating;
  const evaluatePrdRunInFlight =
    runInFlight(RunLoopCommand.EvaluatePrd) && !isEvaluating;
  // Also gated on the item RENDERING at all: "Amend PRD" is behind its own flag,
  // and without this the menu could show a note explaining an item that is not
  // on screen.
  const requestPrdChangesRunInFlight =
    requestChangesFlag?.enabled === true &&
    runInFlight(RunLoopCommand.RequestPrdChanges) &&
    !(isGenerating || isRequestingChanges);
  const anyRunInFlight =
    generatePrdRunInFlight ||
    evaluatePrdRunInFlight ||
    requestPrdChangesRunInFlight;

  const breadcrumbs: BreadcrumbEntry[] = prd.project?.teams?.[0]?.id
    ? [
        {
          label: prd.project.teams[0].name,
          href: `/${orgSlug}/teams/${prd.project.teams[0].id}/projects`,
        },
        {
          label: prd.project.name,
          href: `/${orgSlug}/teams/${prd.project.teams[0].id}/projects/${prd.project.id}`,
        },
        { label: prd.title },
      ]
    : [{ label: "Library", href: `/${orgSlug}/prds` }, { label: prd.title }];

  const overflowMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="More options" size="icon" variant="ghost">
          <MoreHorizontalIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[160px]">
        <DropdownMenuItem onClick={() => onRename()}>
          <PencilIcon className="h-4 w-4" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport()}>
          <DownloadIcon className="h-4 w-4" />
          Export .md
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
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const PrdIcon = DOCUMENT_TYPE_ICONS[DocumentType.Prd];
  const PlanIcon = DOCUMENT_TYPE_ICONS[DocumentType.ImplementationPlan];

  return (
    <Header
      afterBreadcrumbs={<FavoriteButton artifactId={prd.id} />}
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
          <RunActionMenuItem
            disabled={isCommandDisabled({
              generationStatus,
              isLoading: generationStatusLoading,
              targetCommand: RunLoopCommand.GeneratePrd,
              localMutationPending: isGenerating,
            })}
            onActivate={() => onGeneratePrd()}
            reasonId={reasonId}
            runInFlight={generatePrdRunInFlight}
          >
            <PrdIcon className="h-4 w-4" />
            {isGenerating ? "Generating PRD..." : "Generate PRD"}
          </RunActionMenuItem>
          <DropdownMenuItem onClick={() => onDecomposeFeatures()}>
            <BoxIcon className="h-4 w-4" />
            Decompose into Issues
          </DropdownMenuItem>
          <RunActionMenuItem
            disabled={isCommandDisabled({
              generationStatus,
              isLoading: generationStatusLoading,
              targetCommand: RunLoopCommand.EvaluatePrd,
              localMutationPending: isEvaluating,
            })}
            onActivate={() => onEvaluatePrd()}
            reasonId={reasonId}
            runInFlight={evaluatePrdRunInFlight}
          >
            <GaugeIcon className="h-4 w-4" />
            {isEvaluating ? "Evaluating PRD..." : "Evaluate PRD"}
          </RunActionMenuItem>
          <DropdownMenuItem onClick={() => onGeneratePlan()}>
            <PlanIcon className="h-4 w-4" />
            Generate Implementation Plan
          </DropdownMenuItem>
          {requestChangesFlag?.enabled && (
            <RunActionMenuItem
              disabled={isCommandDisabled({
                generationStatus,
                isLoading: generationStatusLoading,
                targetCommand: RunLoopCommand.RequestPrdChanges,
                localMutationPending: isGenerating || isRequestingChanges,
              })}
              onActivate={() => onRequestChanges()}
              reasonId={reasonId}
              runInFlight={requestPrdChangesRunInFlight}
            >
              <MessageSquareIcon className="h-4 w-4" />
              {isRequestingChanges ? "Amending PRD..." : "Amend PRD"}
            </RunActionMenuItem>
          )}
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
