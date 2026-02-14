"use client";

import type {
  ArtifactStatus,
  ArtifactType,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
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

type ArtifactsTableProps = {
  artifacts: ArtifactWithWorkstream[];
  projectId: string;
  onStatusChange?: (artifactId: string, status: ArtifactStatus) => void;
  onDelete?: (artifactId: string) => Promise<boolean>;
};

/**
 * Section configuration for grouping artifacts by type.
 * Each section defines a title and which artifact types it contains.
 */
const ARTIFACT_SECTIONS: {
  title: string;
  types: Set<ArtifactType>;
}[] = [
  {
    title: "Documents",
    types: new Set<ArtifactType>(["PRD"]),
  },
  {
    title: "Implementation Plans",
    types: new Set<ArtifactType>(["IMPLEMENTATION_PLAN"]),
  },
];

function ArtifactLinkCell({ route }: { route: string | null }) {
  if (!route) {
    return <span className="text-muted-foreground text-sm">n/a</span>;
  }
  return (
    <Link className="text-primary text-sm hover:underline" href={route}>
      View
    </Link>
  );
}

type ArtifactSectionProps = {
  title: string;
  artifacts: ArtifactWithWorkstream[];
  projectId: string;
  onRowClick: (artifact: ArtifactWithWorkstream) => void;
  onStatusChange?: (artifactId: string, status: ArtifactStatus) => void;
  onRequestDelete: (artifact: ArtifactWithWorkstream) => void;
};

function ArtifactSection({
  title,
  artifacts,
  projectId,
  onRowClick,
  onStatusChange,
  onRequestDelete,
}: ArtifactSectionProps) {
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] =
    useState<ArtifactWithWorkstream | null>(null);

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
              <TableHead className="w-[50px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {artifacts.map((artifact) => {
              const Icon = ARTIFACT_TYPE_ICONS[artifact.type] || FileTextIcon;
              const route = getArtifactRoute(artifact);
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
                      <span className="font-medium">{artifact.title}</span>
                      <GenerationStatusIndicator
                        generationStatus={artifact.generationStatus}
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    <ArtifactTypeBadge type={artifact.type} />
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Select
                      onValueChange={(value) =>
                        onStatusChange?.(artifact.id, value as ArtifactStatus)
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
                                    value as ArtifactStatus
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
                    <ArtifactLinkCell route={route} />
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
                          onClick={() => {
                            setSelectedArtifact(artifact);
                            setMoveDialogOpen(true);
                          }}
                        >
                          <FolderIcon className="mr-2 h-4 w-4" />
                          Move...
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
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CollapsibleContent>
      {selectedArtifact && (
        <MoveArtifactDialog
          artifact={selectedArtifact}
          currentProjectId={projectId}
          onOpenChange={setMoveDialogOpen}
          open={moveDialogOpen}
        />
      )}
    </Collapsible>
  );
}

export function ArtifactsTable({
  artifacts,
  projectId,
  onStatusChange,
  onDelete,
}: ArtifactsTableProps) {
  const router = useRouter();
  const deleteConfirmation = useDeleteConfirmation({
    onDelete: onDelete ?? (async () => false),
    getId: (artifact: ArtifactWithWorkstream) => artifact.id,
  });

  const sections = useMemo(
    () =>
      ARTIFACT_SECTIONS.map((section) => ({
        title: section.title,
        artifacts: artifacts.filter((a) => section.types.has(a.type)),
      })).filter((section) => section.artifacts.length > 0),
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
          projectId={projectId}
          title={section.title}
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
    </div>
  );
}
