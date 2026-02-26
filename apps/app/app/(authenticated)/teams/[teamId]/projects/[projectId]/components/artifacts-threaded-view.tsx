"use client";

import {
  type ArtifactStatus,
  ArtifactType,
  type ArtifactWithWorkstream,
  type PullRequestInfo,
  ReviewDecision,
} from "@repo/api/src/types/artifact";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { parsePreviewDeploymentMetadata } from "@repo/api/src/types/external-link-utils";
import type { WorkstreamState } from "@repo/api/src/types/workstream";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  ArrowRightIcon,
  ChevronDown,
  ExternalLinkIcon,
  FileTextIcon,
  FolderIcon,
  GitPullRequestIcon,
  MoreHorizontalIcon,
  TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EmptyState } from "@/components/empty-state";
import { GenerationStatusIndicator } from "@/components/generation-status-indicator";
import { MoveArtifactDialog } from "@/components/move-artifact-dialog";
import { PreviewLink } from "@/components/preview-link";
import {
  previewDeploymentStateColors,
  prReviewDecisionColors,
  prStatusColors,
  StatusBadge,
  WorkstreamStateBadge,
} from "@/components/status-badge";
import { useExternalLinks } from "@/hooks/queries/use-external-links";
import { useDeleteConfirmation } from "@/hooks/use-delete-confirmation";
import { matchesFilter } from "@/lib/artifact-filter";
import {
  getArtifactRoute,
  isNavigableArtifact,
} from "@/lib/artifact-navigation";
import {
  ARTIFACT_STATUS_COLORS,
  ARTIFACT_STATUS_LABELS,
  ARTIFACT_TYPE_ICONS,
} from "@/lib/project-constants";
import { ArtifactTypeBadge } from "./artifact-type-badge";

type ArtifactsThreadedViewProps = {
  artifacts: ArtifactWithWorkstream[];
  projectId: string;
  filterText: string;
  onStatusChange?: (artifactId: string, status: ArtifactStatus) => void;
  onDelete?: (artifactId: string) => Promise<boolean>;
};

type WorkstreamGroup = {
  id: string | null;
  groupKey: string;
  title: string;
  state: WorkstreamState | null;
  artifacts: ArtifactWithWorkstream[];
};

/** Defines display order of artifact types within a workstream group. */
const TYPE_ORDER: Record<string, number> = {
  [ArtifactType.Prd]: 0,
  [ArtifactType.ImplementationPlan]: 1,
  [ArtifactType.Template]: 2,
};

const UNASSIGNED_KEY_PREFIX = "unassigned:" as const;

function sortArtifactsByType(
  artifacts: ArtifactWithWorkstream[]
): ArtifactWithWorkstream[] {
  return [...artifacts].sort(
    (a, b) => (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99)
  );
}

/**
 * Derive a group title. For groups with a workstream title, use it directly.
 * For unassigned groups, use the PRD artifact's title if one exists.
 */
function deriveGroupTitle(
  workstreamTitle: string | null | undefined,
  artifacts: ArtifactWithWorkstream[]
): string {
  if (workstreamTitle) {
    return workstreamTitle;
  }
  const prd = artifacts.find((a) => a.type === "PRD");
  return prd?.title ?? "Unassigned";
}

function groupByWorkstream(
  artifacts: ArtifactWithWorkstream[]
): WorkstreamGroup[] {
  const groups = new Map<string, WorkstreamGroup>();
  const workstreamTitles = new Map<string, string | null | undefined>();

  for (const artifact of artifacts) {
    // PRDs without a workstream get their own group (each PRD is a standalone thread).
    // All other unassigned artifact types share a single "Unassigned" group.
    const key =
      artifact.workstreamId ??
      (artifact.type === "PRD"
        ? `${UNASSIGNED_KEY_PREFIX}${artifact.id}`
        : `${UNASSIGNED_KEY_PREFIX}shared`);

    if (!groups.has(key)) {
      groups.set(key, {
        id: artifact.workstreamId,
        groupKey: key,
        title: "",
        state: artifact.workstream?.state ?? null,
        artifacts: [],
      });
      workstreamTitles.set(key, artifact.workstream?.title);
    }
    const group = groups.get(key);
    if (group) {
      group.artifacts.push(artifact);
    }
  }

  for (const [key, group] of groups) {
    group.title = deriveGroupTitle(workstreamTitles.get(key), group.artifacts);
    group.artifacts = sortArtifactsByType(group.artifacts);
  }

  const sorted = [...groups.values()].sort((a, b) => {
    if (a.id === null && b.id === null) {
      return a.title.localeCompare(b.title);
    }
    if (a.id === null) {
      return 1;
    }
    if (b.id === null) {
      return -1;
    }
    return a.title.localeCompare(b.title);
  });

  return sorted;
}

function ArtifactLink({ artifact }: { artifact: ArtifactWithWorkstream }) {
  const route = getArtifactRoute(artifact);
  if (!route) {
    return null;
  }
  return (
    <Link
      className="text-primary text-xs hover:underline"
      href={route}
      onClick={(e: React.MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
    >
      View
    </Link>
  );
}

function ArtifactRow({
  artifact,
  onRowClick,
  onRequestDelete,
  onRequestMove,
  workstreamPreviewUrl,
  siblingPlan,
}: {
  artifact: ArtifactWithWorkstream;
  onRowClick: (artifact: ArtifactWithWorkstream) => void;
  onRequestDelete: (artifact: ArtifactWithWorkstream) => void;
  onRequestMove: (artifact: ArtifactWithWorkstream) => void;
  workstreamPreviewUrl?: string | null;
  siblingPlan?: ArtifactWithWorkstream | null;
}) {
  const Icon = ARTIFACT_TYPE_ICONS[artifact.type] || FileTextIcon;
  const isClickable = isNavigableArtifact(artifact);

  const interactiveProps = isClickable
    ? {
        onClick: () => onRowClick(artifact),
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onRowClick(artifact);
          }
        },
        role: "button" as const,
        tabIndex: 0,
      }
    : {};

  const isImplementationPlan =
    artifact.type === ArtifactType.ImplementationPlan;
  const pr = isImplementationPlan ? (artifact.pullRequest ?? null) : null;
  const isPipelineGreen =
    artifact.generationStatus?.status === "SUCCESS" &&
    artifact.generationStatus?.command === "execute";

  return (
    <div
      {...interactiveProps}
      className={`flex items-center gap-3 rounded-md px-3 py-2 ${
        isClickable ? "cursor-pointer hover:bg-muted/50" : ""
      }`}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-sm">{artifact.title}</span>
        <GenerationStatusIndicator
          generationStatus={artifact.generationStatus}
        />
        {pr && <StatusBadge colorMap={prStatusColors} status={pr.state} />}
        {pr?.reviewDecision &&
          (pr.reviewDecision === ReviewDecision.Approved ||
            pr.reviewDecision === ReviewDecision.ChangesRequested) && (
            <StatusBadge
              colorMap={prReviewDecisionColors}
              status={pr.reviewDecision}
            />
          )}
        {artifact.type === ArtifactType.Prd && siblingPlan != null && (
          <span
            className={`text-xs ${ARTIFACT_STATUS_COLORS[siblingPlan.status] ?? "text-muted-foreground"}`}
          >
            Plan:{" "}
            {ARTIFACT_STATUS_LABELS[siblingPlan.status] ?? siblingPlan.status}
          </span>
        )}
        {isImplementationPlan && isPipelineGreen && workstreamPreviewUrl && (
          <div
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="none"
          >
            <PreviewLink url={workstreamPreviewUrl} />
          </div>
        )}
      </div>
      <ArtifactTypeBadge type={artifact.type} />
      <span
        className={`text-xs ${ARTIFACT_STATUS_COLORS[artifact.status] ?? "text-muted-foreground"}`}
      >
        {ARTIFACT_STATUS_LABELS[artifact.status] ?? artifact.status}
      </span>
      <div
        className="flex items-center gap-1"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="none"
      >
        <ArtifactLink artifact={artifact} />
      </div>
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="none"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="h-7 w-7" size="icon" variant="ghost">
              <MoreHorizontalIcon className="h-3.5 w-3.5" />
              <span className="sr-only">Open menu</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onRequestMove(artifact)}>
              <FolderIcon className="mr-2 h-4 w-4" />
              Move to project
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
              onClick={() => onRequestDelete(artifact)}
            >
              <TrashIcon className="mr-2 h-4 w-4" />
              Delete artifact
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function WorkstreamSection({
  group,
  onRowClick,
  onRequestDelete,
  onRequestMove,
  previewUrl,
  previewDeploymentState,
}: {
  group: WorkstreamGroup;
  onRowClick: (artifact: ArtifactWithWorkstream) => void;
  onRequestDelete: (artifact: ArtifactWithWorkstream) => void;
  onRequestMove: (artifact: ArtifactWithWorkstream) => void;
  previewUrl?: string | null;
  previewDeploymentState?: string | null;
}) {
  const siblingPlan =
    group.artifacts.find((a) => a.type === ArtifactType.ImplementationPlan) ??
    null;

  return (
    <Collapsible className="rounded-lg border">
      <CollapsibleTrigger className="group flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30">
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">
          {group.title}
        </span>
        <span className="text-muted-foreground text-xs">
          {group.artifacts.length}{" "}
          {group.artifacts.length === 1 ? "artifact" : "artifacts"}
        </span>
        {group.state && <WorkstreamStateBadge state={group.state} />}
        {previewDeploymentState && (
          <StatusBadge
            className="px-1.5 py-0 text-xs"
            colorMap={previewDeploymentStateColors}
            defaultStyle="bg-muted text-muted-foreground border-muted"
            status={previewDeploymentState.toUpperCase()}
          />
        )}
        {previewUrl && <PreviewLink url={previewUrl} />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t px-1 py-1">
          {group.artifacts.map((artifact) => (
            <ArtifactRow
              artifact={artifact}
              key={artifact.id}
              onRequestDelete={onRequestDelete}
              onRequestMove={onRequestMove}
              onRowClick={onRowClick}
              siblingPlan={
                artifact.type === ArtifactType.Prd ? siblingPlan : undefined
              }
              workstreamPreviewUrl={previewUrl}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ArtifactsThreadedView({
  artifacts,
  projectId,
  filterText,
  onStatusChange: _onStatusChange,
  onDelete,
}: ArtifactsThreadedViewProps) {
  const router = useRouter();
  const deleteConfirmation = useDeleteConfirmation({
    onDelete: onDelete ?? (async () => false),
    getId: (artifact: ArtifactWithWorkstream) => artifact.id,
  });

  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] =
    useState<ArtifactWithWorkstream | null>(null);

  // Fetch preview deployment links for this project
  const { data: externalLinks = [] } = useExternalLinks({
    projectId,
    type: ExternalLinkType.PreviewDeployment,
  });

  // Build workstreamId -> { url, deploymentState } map
  const previewUrlsByWorkstream = useMemo(() => {
    const map = new Map<
      string,
      { url: string; deploymentState: string | null }
    >();
    for (const link of externalLinks) {
      if (link.workstreamId) {
        const parsed = parsePreviewDeploymentMetadata(link.metadata);
        map.set(link.workstreamId, {
          url: link.externalUrl,
          deploymentState: parsed?.state ?? null,
        });
      }
    }
    return map;
  }, [externalLinks]);

  // Group artifacts by workstream, then drop groups with no matching artifacts.
  // Filtering is done after grouping so deriveGroupTitle always has the full
  // group (prevents fallback to "Unassigned" when a group's PRD is filtered out).
  const workstreamGroups = useMemo(
    () =>
      groupByWorkstream(artifacts).filter((group) =>
        group.artifacts.some((a) => matchesFilter(a, filterText))
      ),
    [artifacts, filterText]
  );

  // Derive unique branches from artifacts that have pull requests
  const branches = useMemo(() => {
    const seen = new Set<string>();
    const result: { artifact: ArtifactWithWorkstream; pr: PullRequestInfo }[] =
      [];
    for (const a of artifacts) {
      if (a.pullRequest && !seen.has(a.pullRequest.headBranch)) {
        seen.add(a.pullRequest.headBranch);
        result.push({ artifact: a, pr: a.pullRequest });
      }
    }
    return result;
  }, [artifacts]);

  function handleRowClick(artifact: ArtifactWithWorkstream): void {
    if (isNavigableArtifact(artifact)) {
      const route = getArtifactRoute(artifact);
      if (route) {
        router.push(route);
      }
    }
  }

  function handleRequestMove(artifact: ArtifactWithWorkstream): void {
    setSelectedArtifact(artifact);
    setMoveDialogOpen(true);
  }

  if (artifacts.length === 0) {
    return (
      <EmptyState
        className="rounded-md border"
        description="Artifacts will appear here as you work on this project."
        icon={FileTextIcon}
        title="No artifacts yet"
      />
    );
  }

  if (workstreamGroups.length === 0 && filterText) {
    return (
      <EmptyState
        className="rounded-md border"
        description="Try a different search term."
        icon={FileTextIcon}
        title="No matching artifacts"
      />
    );
  }

  return (
    <div className="space-y-3">
      {workstreamGroups.map((group) => {
        const preview = group.id
          ? previewUrlsByWorkstream.get(group.id)
          : undefined;
        return (
          <WorkstreamSection
            group={group}
            key={group.groupKey}
            onRequestDelete={deleteConfirmation.requestDelete}
            onRequestMove={handleRequestMove}
            onRowClick={handleRowClick}
            previewDeploymentState={preview?.deploymentState ?? null}
            previewUrl={preview?.url ?? null}
          />
        );
      })}

      {branches.length > 0 && <BranchesSection branches={branches} />}

      <DeleteConfirmationDialog
        isPending={deleteConfirmation.isPending}
        itemName={deleteConfirmation.itemToDelete?.title ?? ""}
        onConfirm={deleteConfirmation.confirmDelete}
        onOpenChange={deleteConfirmation.setOpen}
        open={deleteConfirmation.isOpen}
        title="Artifact"
      />

      {selectedArtifact && (
        <MoveArtifactDialog
          artifact={selectedArtifact}
          currentProjectId={projectId}
          onOpenChange={setMoveDialogOpen}
          open={moveDialogOpen}
        />
      )}
    </div>
  );
}

type BranchEntry = {
  artifact: ArtifactWithWorkstream;
  pr: PullRequestInfo;
};

function BranchRow({ pr }: { pr: PullRequestInfo }) {
  return (
    <div className="flex items-center gap-3 rounded-md px-3 py-2">
      <GitPullRequestIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate font-mono text-xs">{pr.headBranch}</span>
        <ArrowRightIcon className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-muted-foreground text-xs">
          {pr.baseBranch}
        </span>
        <StatusBadge colorMap={prStatusColors} status={pr.state} />
        {pr.reviewDecision &&
          (pr.reviewDecision === ReviewDecision.Approved ||
            pr.reviewDecision === ReviewDecision.ChangesRequested) && (
            <StatusBadge
              colorMap={prReviewDecisionColors}
              status={pr.reviewDecision}
            />
          )}
      </div>
      <span className="text-muted-foreground text-xs">
        #{pr.number} {pr.title}
      </span>
      <a
        aria-label={`Open PR #${pr.number} on GitHub`}
        className="text-muted-foreground transition-colors hover:text-primary"
        href={pr.htmlUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        <ExternalLinkIcon className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

function BranchesSection({ branches }: { branches: BranchEntry[] }) {
  return (
    <Collapsible className="rounded-lg border">
      <CollapsibleTrigger className="group flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30">
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
        <GitPullRequestIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">
          Branches
        </span>
        <span className="text-muted-foreground text-xs">
          {branches.length} {branches.length === 1 ? "branch" : "branches"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t px-1 py-1">
          {branches.map((entry) => (
            <BranchRow key={entry.pr.headBranch} pr={entry.pr} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
