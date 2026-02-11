"use client";

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
import { PullRequestLink } from "@/components/pull-request-link";
import { PullRequestStatusBadge } from "@/components/pull-request-status-badge";
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
import type {
  ArtifactDisplayStatus,
  ProjectArtifact,
  ProjectArtifactSubtype,
} from "@/types/teams";
import { ArtifactSubtypeBadge } from "./artifact-subtype-badge";

type ArtifactsTableProps = {
  artifacts: ProjectArtifact[];
  onStatusChange?: (artifactId: string, status: ArtifactDisplayStatus) => void;
  onDelete?: (artifactId: string) => Promise<boolean>;
};

/**
 * Section configuration for grouping artifacts by subtype.
 * Each section defines a title and which artifact subtypes it contains.
 */
const ARTIFACT_SECTIONS: {
  title: string;
  subtypes: Set<ProjectArtifactSubtype>;
}[] = [
  {
    title: "Documents",
    subtypes: new Set<ProjectArtifactSubtype>(["PROJECT_BRIEF", "PRD"]),
  },
  {
    title: "Implementation Plans",
    subtypes: new Set<ProjectArtifactSubtype>([
      "IMPLEMENTATION_PLAN",
      "IMPLEMENTATION_STRATEGY",
    ]),
  },
  {
    title: "Issues",
    subtypes: new Set<ProjectArtifactSubtype>(["ISSUE", "BUG"]),
  },
  {
    title: "Branches",
    subtypes: new Set<ProjectArtifactSubtype>(["BRANCH"]),
  },
];

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

type ArtifactSectionProps = {
  title: string;
  artifacts: ProjectArtifact[];
  onRowClick: (artifact: ProjectArtifact) => void;
  onStatusChange?: (artifactId: string, status: ArtifactDisplayStatus) => void;
  onRequestDelete: (artifact: ProjectArtifact) => void;
};

function ArtifactSection({
  title,
  artifacts,
  onRowClick,
  onStatusChange,
  onRequestDelete,
}: ArtifactSectionProps) {
  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-0 py-3 text-left font-semibold text-lg hover:opacity-80">
        <ChevronDown className="h-4 w-4 transition-transform group-data-[state=closed]:-rotate-90" />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Artifact</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Link</TableHead>
              <TableHead>Preview</TableHead>
              <TableHead className="w-[50px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {artifacts.map((artifact) => {
              const Icon =
                ARTIFACT_SUBTYPE_ICONS[artifact.subtype] || FileTextIcon;
              const route = getArtifactRoute(artifact);
              const isExternal = isExternalLink(artifact);
              const isClickable = isNavigableArtifact(artifact);

              return (
                <TableRow
                  className={
                    isClickable ? "cursor-pointer hover:bg-muted/50" : ""
                  }
                  key={artifact.id}
                  onClick={() => onRowClick(artifact)}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{artifact.name}</span>
                      <GenerationStatusIndicator
                        generationStatus={artifact.generationStatus}
                      />
                      {artifact.pullRequest && (
                        <div className="hidden sm:flex">
                          <PullRequestStatusBadge
                            pullRequest={artifact.pullRequest}
                          />
                        </div>
                      )}
                      <PullRequestLink pullRequest={artifact.pullRequest} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <ArtifactSubtypeBadge subtype={artifact.subtype} />
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Select
                      onValueChange={(value) =>
                        onStatusChange?.(
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
                    <PreviewLink url={artifact.previewUrl} />
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
                          onClick={() => onRequestDelete(artifact)}
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
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ArtifactsTable({
  artifacts,
  onStatusChange,
  onDelete,
}: ArtifactsTableProps) {
  const router = useRouter();
  const deleteConfirmation = useDeleteConfirmation({
    onDelete: onDelete ?? (async () => false),
    getId: (artifact: ProjectArtifact) => artifact.id,
  });

  const sections = useMemo(
    () =>
      ARTIFACT_SECTIONS.map((section) => ({
        title: section.title,
        artifacts: artifacts.filter((a) => section.subtypes.has(a.subtype)),
      })).filter((section) => section.artifacts.length > 0),
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
    <div className="space-y-6">
      {sections.map((section) => (
        <ArtifactSection
          artifacts={section.artifacts}
          key={section.title}
          onRequestDelete={deleteConfirmation.requestDelete}
          onRowClick={handleRowClick}
          onStatusChange={onStatusChange}
          title={section.title}
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
