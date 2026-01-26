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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import {
  ExternalLinkIcon,
  FileTextIcon,
  MoreHorizontalIcon,
  TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EmptyState } from "@/components/empty-state";
import { useDeleteConfirmation } from "@/hooks/use-delete-confirmation";
import {
  ARTIFACT_STATUS_COLORS,
  ARTIFACT_STATUS_LABELS,
  ARTIFACT_TYPE_ICONS,
} from "@/lib/project-constants";
import type { ArtifactDisplayStatus, ProjectArtifact } from "@/types/teams";
import { ArtifactTypeBadge } from "./artifact-type-badge";

type ArtifactsTableProps = {
  artifacts: ProjectArtifact[];
  onStatusChange?: (artifactId: string, status: ArtifactDisplayStatus) => void;
  onDelete?: (artifactId: string) => void;
};

/**
 * Get the route to navigate to for viewing/editing an artifact
 * PRDs and Implementation Plans link to their existing editor pages
 */
function getArtifactRoute(artifact: ProjectArtifact): string | null {
  switch (artifact.type) {
    case "PRD":
      return `/prds/${artifact.id}`;
    case "IMPLEMENTATION_PLAN":
      return `/implementation-plans/${artifact.id}`;
    case "DESIGNS":
      return artifact.link || null;
    default:
      return null;
  }
}

/**
 * Render the link cell for an artifact
 */
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

export function ArtifactsTable({
  artifacts,
  onStatusChange,
  onDelete,
}: ArtifactsTableProps) {
  const router = useRouter();
  const deleteConfirmation = useDeleteConfirmation({
    onDelete: onDelete ?? (() => {}),
    getId: (artifact: ProjectArtifact) => artifact.id,
  });

  const handleStatusChange = (
    artifactId: string,
    status: ArtifactDisplayStatus
  ) => {
    onStatusChange?.(artifactId, status);
  };

  const handleRowClick = (artifact: ProjectArtifact) => {
    // Only navigate for PRD and Implementation Plan types
    if (artifact.type === "PRD" || artifact.type === "IMPLEMENTATION_PLAN") {
      const route = getArtifactRoute(artifact);
      if (route) {
        router.push(route);
      }
    }
  };

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
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Artifact</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Link</TableHead>
            <TableHead className="w-[50px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {artifacts.map((artifact) => {
            const Icon = ARTIFACT_TYPE_ICONS[artifact.type] || FileTextIcon;
            const route = getArtifactRoute(artifact);
            const isExternal =
              artifact.type === "DESIGNS" &&
              (artifact.link?.startsWith("http") ?? false);

            const isClickable =
              artifact.type === "PRD" ||
              artifact.type === "IMPLEMENTATION_PLAN";

            return (
              <TableRow
                className={
                  isClickable ? "cursor-pointer hover:bg-muted/50" : ""
                }
                key={artifact.id}
                onClick={() => handleRowClick(artifact)}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{artifact.name}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <ArtifactTypeBadge type={artifact.type} />
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Select
                    onValueChange={(value) =>
                      handleStatusChange(
                        artifact.id,
                        value as ArtifactDisplayStatus
                      )
                    }
                    value={artifact.status}
                  >
                    <SelectTrigger className="h-7 w-[140px] border-0 bg-input/30 px-2 text-sm hover:bg-input/50 focus:ring-0 focus:ring-offset-0">
                      <SelectValue>
                        <span
                          className={ARTIFACT_STATUS_COLORS[artifact.status]}
                        >
                          {ARTIFACT_STATUS_LABELS[artifact.status]}
                        </span>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(ARTIFACT_STATUS_LABELS).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            <span
                              className={
                                ARTIFACT_STATUS_COLORS[
                                  value as ArtifactDisplayStatus
                                ]
                              }
                            >
                              {label}
                            </span>
                          </SelectItem>
                        )
                      )}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <ArtifactLinkCell
                    artifact={artifact}
                    isExternal={isExternal}
                    route={route}
                  />
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
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
                        onClick={() =>
                          deleteConfirmation.requestDelete(artifact)
                        }
                      >
                        <TrashIcon className="mr-2 h-4 w-4" />
                        Delete artifact
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

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
