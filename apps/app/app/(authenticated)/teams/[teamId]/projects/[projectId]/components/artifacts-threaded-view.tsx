"use client";

import type {
  ArtifactStatus,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
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
  FileTextIcon,
  FolderIcon,
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
import { useDeleteConfirmation } from "@/hooks/use-delete-confirmation";
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
  onStatusChange?: (artifactId: string, status: ArtifactStatus) => void;
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
  artifacts: ArtifactWithWorkstream[];
  _workstreamTitle?: string | null;
};

/** Defines display order of artifact types within a workstream group. */
const TYPE_ORDER: Record<string, number> = {
  PRD: 0,
  IMPLEMENTATION_PLAN: 1,
  TEMPLATE: 2,
};

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
  const groups = new Map<string | null, WorkstreamGroup>();

  for (const artifact of artifacts) {
    const key = artifact.workstreamId ?? null;

    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        title: "",
        state: artifact.workstream?.state ?? null,
        artifacts: [],
        _workstreamTitle: artifact.workstream?.title,
      });
    }
    groups.get(key)!.artifacts.push(artifact);
  }

  for (const group of groups.values()) {
    group.title = deriveGroupTitle(group._workstreamTitle, group.artifacts);
    group.artifacts = sortArtifactsByType(group.artifacts);
  }

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
}: {
  artifact: ArtifactWithWorkstream;
  onRowClick: (artifact: ArtifactWithWorkstream) => void;
  onRequestDelete: (artifact: ArtifactWithWorkstream) => void;
  onRequestMove: (artifact: ArtifactWithWorkstream) => void;
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

  return (
    <div
      {...interactiveProps}
      className={`flex items-center gap-3 rounded-md px-3 py-2 ${
        isClickable ? "cursor-pointer hover:bg-muted/50" : ""
      }`}
    >
      <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-sm">{artifact.title}</span>
        <GenerationStatusIndicator
          generationStatus={artifact.generationStatus}
        />
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
}: {
  group: WorkstreamGroup;
  onRowClick: (artifact: ArtifactWithWorkstream) => void;
  onRequestDelete: (artifact: ArtifactWithWorkstream) => void;
  onRequestMove: (artifact: ArtifactWithWorkstream) => void;
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
              onRequestMove={onRequestMove}
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
  projectId,
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

  const workstreamGroups = useMemo(
    () => groupByWorkstream(artifacts),
    [artifacts]
  );

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

  return (
    <div className="space-y-3">
      {workstreamGroups.map((group) => (
        <WorkstreamSection
          group={group}
          key={group.id ?? "unassigned"}
          onRequestDelete={deleteConfirmation.requestDelete}
          onRequestMove={handleRequestMove}
          onRowClick={handleRowClick}
        />
      ))}

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
