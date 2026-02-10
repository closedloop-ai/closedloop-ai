"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import {
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
import { PreviewLink } from "@/components/preview-link";
import { useDeleteConfirmation } from "@/hooks/use-delete-confirmation";
import {
  ARTIFACT_STATUS_COLORS,
  ARTIFACT_STATUS_LABELS,
  ARTIFACT_SUBTYPE_ICONS,
} from "@/lib/project-constants";
import type {
  ArtifactDisplayStatus,
  ProjectArtifact,
  ProjectArtifactSubtype,
} from "@/types/teams";
import { ArtifactSubtypeBadge } from "./artifact-subtype-badge";

type ArtifactsThreadedViewProps = {
  artifacts: ProjectArtifact[];
  onStatusChange?: (artifactId: string, status: ArtifactDisplayStatus) => void;
  onDelete?: (artifactId: string) => Promise<boolean>;
};

const NAVIGABLE_SUBTYPES = new Set<ProjectArtifactSubtype>([
  "PRD",
  "IMPLEMENTATION_PLAN",
  "IMPLEMENTATION_STRATEGY",
  "ISSUE",
  "BUG",
]);

function isNavigableArtifact(artifact: ProjectArtifact): boolean {
  return NAVIGABLE_SUBTYPES.has(artifact.subtype);
}

function isExternalLink(artifact: ProjectArtifact): boolean {
  switch (artifact.subtype) {
    case "DESIGNS":
      return artifact.link?.startsWith("http") ?? false;
    case "BRANCH":
      return true;
    default:
      return false;
  }
}

/**
 * Get the route to navigate to for viewing/editing an artifact.
 * PRDs and Implementation Plans link to their existing editor pages using documentSlug.
 */
function getArtifactRoute(artifact: ProjectArtifact): string | null {
  switch (artifact.subtype) {
    case "PRD":
      return artifact.documentSlug ? `/prds/${artifact.documentSlug}` : null;
    case "IMPLEMENTATION_PLAN":
    case "IMPLEMENTATION_STRATEGY":
      return artifact.documentSlug
        ? `/implementation-plans/${artifact.documentSlug}`
        : null;
    case "ISSUE":
    case "BUG":
      return artifact.documentSlug ? `/issues/${artifact.documentSlug}` : null;
    case "DESIGNS":
    case "BRANCH":
      return artifact.link || null;
    case "PROJECT_BRIEF":
    case "TEMPLATE":
      return null;
    default:
      return null;
  }
}

function ArtifactLinkCell({
  artifact,
  route,
  isExternal,
}: {
  artifact: ProjectArtifact;
  route: string | null;
  isExternal: boolean;
}) {
  if (!route) {
    return <span className="text-muted-foreground text-sm">n/a</span>;
  }
  if (isExternal) {
    return (
      <a
        className="inline-flex items-center gap-1 text-primary text-sm hover:underline"
        href={route}
        rel="noopener noreferrer"
        target="_blank"
      >
        {artifact.link || "External Link"}
        <ExternalLinkIcon className="h-3 w-3" />
      </a>
    );
  }
  return (
    <Link className="text-primary text-sm hover:underline" href={route}>
      {artifact.link || "View"}
    </Link>
  );
}

type ArtifactNode = ProjectArtifact & {
  children: ArtifactNode[];
  depth: number;
};

/**
 * Build a tree structure from flat artifact list using parentId relationships.
 */
function buildArtifactTree(artifacts: ProjectArtifact[]): ArtifactNode[] {
  const artifactMap = new Map<string, ArtifactNode>();
  const rootNodes: ArtifactNode[] = [];

  // First pass: create nodes
  for (const artifact of artifacts) {
    artifactMap.set(artifact.id, {
      ...artifact,
      children: [],
      depth: 0,
    });
  }

  // Second pass: build parent-child relationships
  for (const artifact of artifacts) {
    const node = artifactMap.get(artifact.id);
    if (!node) {
      continue;
    }

    if (artifact.parentId) {
      const parent = artifactMap.get(artifact.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        // Parent not found, treat as root
        rootNodes.push(node);
      }
    } else {
      // No parent, this is a root node
      rootNodes.push(node);
    }
  }

  // Third pass: calculate depths by traversing from root nodes
  function setDepths(node: ArtifactNode, depth: number): void {
    node.depth = depth;
    for (const child of node.children) {
      setDepths(child, depth + 1);
    }
  }

  for (const rootNode of rootNodes) {
    setDepths(rootNode, 0);
  }

  return rootNodes;
}

/**
 * Flatten tree into a list with depth information for rendering.
 */
function flattenTree(nodes: ArtifactNode[]): ArtifactNode[] {
  const result: ArtifactNode[] = [];

  function traverse(node: ArtifactNode): void {
    result.push(node);
    for (const child of node.children) {
      traverse(child);
    }
  }

  for (const node of nodes) {
    traverse(node);
  }

  return result;
}

type ArtifactRowProps = {
  artifact: ArtifactNode;
  onRowClick: (artifact: ProjectArtifact) => void;
  onStatusChange?: (artifactId: string, status: ArtifactDisplayStatus) => void;
  onRequestDelete: (artifact: ProjectArtifact) => void;
};

function ArtifactRow({
  artifact,
  onRowClick,
  onStatusChange,
  onRequestDelete,
}: ArtifactRowProps) {
  const Icon = ARTIFACT_SUBTYPE_ICONS[artifact.subtype] || FileTextIcon;
  const route = getArtifactRoute(artifact);
  const isExternal = isExternalLink(artifact);
  const isClickable = isNavigableArtifact(artifact);
  const indentLevel = artifact.depth;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRowClick(artifact);
    }
  };

  const handleClick = () => {
    if (isClickable) {
      onRowClick(artifact);
    }
  };

  const rowProps = isClickable
    ? {
        onClick: handleClick,
        onKeyDown: handleKeyDown,
        role: "button" as const,
        tabIndex: 0,
      }
    : {};

  return (
    <div
      {...rowProps}
      className={`grid grid-cols-[1fr,auto,auto,auto,auto,auto] items-center gap-4 border-b px-4 py-3 ${
        isClickable ? "cursor-pointer hover:bg-muted/50" : ""
      }`}
    >
      {/* Artifact name with icon and indentation */}
      <div
        className="flex items-center gap-2"
        style={{ paddingLeft: `${indentLevel * 24}px` }}
      >
        <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <span className="font-medium">{artifact.name}</span>
      </div>

      {/* Type badge */}
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="none"
      >
        <ArtifactSubtypeBadge subtype={artifact.subtype} />
      </div>

      {/* Status select */}
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="none"
      >
        <Select
          onValueChange={(value) =>
            onStatusChange?.(artifact.id, value as ArtifactDisplayStatus)
          }
          value={artifact.status}
        >
          <SelectTrigger className="h-7 w-[140px] border-0 bg-input/30 px-2 text-sm hover:bg-input/50 focus:ring-0 focus:ring-offset-0">
            <SelectValue>
              <span className={ARTIFACT_STATUS_COLORS[artifact.status]}>
                {ARTIFACT_STATUS_LABELS[artifact.status]}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(ARTIFACT_STATUS_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                <span
                  className={
                    ARTIFACT_STATUS_COLORS[value as ArtifactDisplayStatus]
                  }
                >
                  {label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Link */}
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="none"
      >
        <ArtifactLinkCell
          artifact={artifact}
          isExternal={isExternal}
          route={route}
        />
      </div>

      {/* Preview */}
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="none"
      >
        <PreviewLink url={artifact.previewUrl} />
      </div>

      {/* Actions menu */}
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="none"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="h-8 w-8" size="icon" variant="ghost">
              <MoreHorizontalIcon className="h-4 w-4" />
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

export function ArtifactsThreadedView({
  artifacts,
  onStatusChange,
  onDelete,
}: ArtifactsThreadedViewProps) {
  const router = useRouter();
  const deleteConfirmation = useDeleteConfirmation({
    onDelete: onDelete ?? (async () => false),
    getId: (artifact: ProjectArtifact) => artifact.id,
  });

  const flattenedTree = useMemo(() => {
    const tree = buildArtifactTree(artifacts);
    return flattenTree(tree);
  }, [artifacts]);

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
    <div className="space-y-0">
      {/* Header */}
      <div className="grid grid-cols-[1fr,auto,auto,auto,auto,auto] gap-4 border-b bg-muted/50 px-4 py-3 font-medium text-muted-foreground text-sm">
        <div>Artifact</div>
        <div>Type</div>
        <div>Status</div>
        <div>Link</div>
        <div>Preview</div>
        <div className="w-[50px]" />
      </div>

      {/* Rows */}
      {flattenedTree.map((artifact) => (
        <ArtifactRow
          artifact={artifact}
          key={artifact.id}
          onRequestDelete={deleteConfirmation.requestDelete}
          onRowClick={handleRowClick}
          onStatusChange={onStatusChange}
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
