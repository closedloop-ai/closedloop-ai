"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
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
  ChevronDown,
  ExternalLinkIcon,
  FileTextIcon,
  MoreHorizontalIcon,
  TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EmptyState } from "@/components/empty-state";
import { GenerationStatusIndicator } from "@/components/generation-status-indicator";
import { PreviewLink } from "@/components/preview-link";
import { useDeleteConfirmation } from "@/hooks/use-delete-confirmation";
import {
  getArtifactRoute,
  isExternalLink,
  isNavigableArtifact,
} from "@/lib/artifact-navigation";
import {
  ARTIFACT_STATUS_COLORS,
  ARTIFACT_STATUS_LABELS,
  ARTIFACT_SUBTYPE_ICONS,
} from "@/lib/project-constants";
import type { ArtifactDisplayStatus, ProjectArtifact } from "@/types/teams";
import { ArtifactSubtypeBadge } from "./artifact-subtype-badge";

type ArtifactsThreadedViewProps = {
  artifacts: ProjectArtifact[];
  onStatusChange?: (artifactId: string, status: ArtifactDisplayStatus) => void;
  onDelete?: (artifactId: string) => Promise<boolean>;
};

const WORKSTREAM_STATE_LABELS: Record<string, string> = {
  INITIATED: "Initiated",
  REQUIREMENTS_GENERATING: "Generating Requirements",
  REQUIREMENTS_PENDING_APPROVAL: "Requirements Review",
  DESIGN_IN_PROGRESS: "Designing",
  DESIGN_PENDING_APPROVAL: "Design Review",
  IMPLEMENTATION_PLANNING: "Planning",
  IMPLEMENTATION_IN_PROGRESS: "Implementing",
  IMPLEMENTATION_PENDING_REVIEW: "Implementation Review",
  CODE_REVIEW_RUNNING: "Code Review",
  CODE_REVIEW_PENDING_APPROVAL: "Code Review Approval",
  VISUAL_QA_RUNNING: "Visual QA",
  VISUAL_QA_PENDING_APPROVAL: "Visual QA Approval",
  MERGING: "Merging",
  DEPLOYED: "Deployed",
  COMPLETED: "Completed",
  BLOCKED: "Blocked",
  CANCELLED: "Cancelled",
};

function getWorkstreamStateBadgeVariant(
  state: string
): "default" | "secondary" | "destructive" | "outline" {
  switch (state) {
    case "COMPLETED":
    case "DEPLOYED":
      return "default";
    case "BLOCKED":
    case "CANCELLED":
      return "destructive";
    case "INITIATED":
      return "outline";
    default:
      return "secondary";
  }
}

type WorkstreamGroup = {
  id: string | null;
  title: string;
  state: string | null;
  artifacts: ProjectArtifact[];
  /** Raw workstream title from API, used during group construction. */
  _workstreamTitle?: string | null;
};

/** Defines display order of artifact subtypes within a workstream group. */
const SUBTYPE_ORDER: Record<string, number> = {
  PRD: 0,
  IMPLEMENTATION_PLAN: 1,
  IMPLEMENTATION_STRATEGY: 2,
  ISSUE: 3,
  BUG: 4,
  BRANCH: 5,
  DESIGNS: 6,
  PROJECT_BRIEF: 7,
  TEMPLATE: 8,
};

function sortArtifactsBySubtype(
  artifacts: ProjectArtifact[]
): ProjectArtifact[] {
  return [...artifacts].sort(
    (a, b) =>
      (SUBTYPE_ORDER[a.subtype] ?? 99) - (SUBTYPE_ORDER[b.subtype] ?? 99)
  );
}

/**
 * Derive a group title. For groups with a workstream title, use it directly.
 * For unassigned groups, use the PRD artifact's name if one exists.
 */
function deriveGroupTitle(
  workstreamTitle: string | null | undefined,
  artifacts: ProjectArtifact[]
): string {
  if (workstreamTitle) {
    return workstreamTitle;
  }
  const prd = artifacts.find((a) => a.subtype === "PRD");
  return prd?.name ?? "Unassigned";
}

function groupByWorkstream(artifacts: ProjectArtifact[]): WorkstreamGroup[] {
  const groups = new Map<string | null, WorkstreamGroup>();

  for (const artifact of artifacts) {
    const key = artifact.workstreamId ?? null;

    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        title: "", // resolved after all artifacts are collected
        state: artifact.workstreamState ?? null,
        artifacts: [],
        _workstreamTitle: artifact.workstreamTitle,
      });
    }
    groups.get(key)!.artifacts.push(artifact);
  }

  // Resolve titles and sort artifacts within each group
  for (const group of groups.values()) {
    group.title = deriveGroupTitle(group._workstreamTitle, group.artifacts);
    group.artifacts = sortArtifactsBySubtype(group.artifacts);
  }

  // Sort: workstreams with IDs first (by title), unassigned last
  const sorted = [...groups.values()].sort((a, b) => {
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

function ArtifactLink({ artifact }: { artifact: ProjectArtifact }) {
  const route = getArtifactRoute(artifact);
  if (!route) {
    return null;
  }
  if (isExternalLink(artifact)) {
    return (
      <a
        className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
        href={route}
        onClick={(e) => e.stopPropagation()}
        rel="noopener noreferrer"
        target="_blank"
      >
        View
        <ExternalLinkIcon className="h-3 w-3" />
      </a>
    );
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
}: {
  artifact: ProjectArtifact;
  onRowClick: (artifact: ProjectArtifact) => void;
  onRequestDelete: (artifact: ProjectArtifact) => void;
}) {
  const Icon = ARTIFACT_SUBTYPE_ICONS[artifact.subtype] || FileTextIcon;
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

  return (
    <div
      {...interactiveProps}
      className={`flex items-center gap-3 rounded-md px-3 py-2 ${
        isClickable ? "cursor-pointer hover:bg-muted/50" : ""
      }`}
    >
      <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm">{artifact.name}</span>
      <GenerationStatusIndicator generationStatus={artifact.generationStatus} />
      <ArtifactSubtypeBadge subtype={artifact.subtype} />
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
        <PreviewLink url={artifact.previewUrl} />
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
}: {
  group: WorkstreamGroup;
  onRowClick: (artifact: ProjectArtifact) => void;
  onRequestDelete: (artifact: ProjectArtifact) => void;
}) {
  return (
    <Collapsible className="rounded-lg border">
      <CollapsibleTrigger className="group flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30">
        <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">
          {group.title}
        </span>
        <span className="text-muted-foreground text-xs">
          {group.artifacts.length}{" "}
          {group.artifacts.length === 1 ? "artifact" : "artifacts"}
        </span>
        {group.state && (
          <Badge variant={getWorkstreamStateBadgeVariant(group.state)}>
            {WORKSTREAM_STATE_LABELS[group.state] ?? group.state}
          </Badge>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t px-1 py-1">
          {group.artifacts.map((artifact) => (
            <ArtifactRow
              artifact={artifact}
              key={artifact.id}
              onRequestDelete={onRequestDelete}
              onRowClick={onRowClick}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ArtifactsThreadedView({
  artifacts,
  onStatusChange: _onStatusChange,
  onDelete,
}: ArtifactsThreadedViewProps) {
  const router = useRouter();
  const deleteConfirmation = useDeleteConfirmation({
    onDelete: onDelete ?? (async () => false),
    getId: (artifact: ProjectArtifact) => artifact.id,
  });

  const workstreamGroups = useMemo(
    () => groupByWorkstream(artifacts),
    [artifacts]
  );

  function handleRowClick(artifact: ProjectArtifact): void {
    if (isNavigableArtifact(artifact)) {
      const route = getArtifactRoute(artifact);
      if (route) {
        router.push(route);
      }
    }
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

  return (
    <div className="space-y-3">
      {workstreamGroups.map((group) => (
        <WorkstreamSection
          group={group}
          key={group.id ?? "unassigned"}
          onRequestDelete={deleteConfirmation.requestDelete}
          onRowClick={handleRowClick}
        />
      ))}

      <DeleteConfirmationDialog
        isPending={deleteConfirmation.isPending}
        itemName={deleteConfirmation.itemToDelete?.name ?? ""}
        onConfirm={deleteConfirmation.confirmDelete}
        onOpenChange={deleteConfirmation.setOpen}
        open={deleteConfirmation.isOpen}
        title="Artifact"
      />
    </div>
  );
}
