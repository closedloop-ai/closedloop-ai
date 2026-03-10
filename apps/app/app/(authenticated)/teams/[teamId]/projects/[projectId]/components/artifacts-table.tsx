"use client";

import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type {
  ArtifactStatus,
  ArtifactType,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import {
  ChevronDown,
  FileTextIcon,
  FolderIcon,
  MoreHorizontalIcon,
  TrashIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { ColumnVisibilityPopover } from "@/components/custom-fields/column-visibility-popover";
import { CustomFieldCell } from "@/components/custom-fields/custom-field-cell";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EmptyState } from "@/components/empty-state";
import { GenerationStatusIndicator } from "@/components/generation-status-indicator";
import { MoveArtifactDialog } from "@/components/move-artifact-dialog";
import { SortableColumnHeader } from "@/components/sortable-column-header";
import { useMergeArtifacts } from "@/hooks/queries/use-artifacts";
import { useProjectJudgeScores } from "@/hooks/queries/use-judges";
import { useCustomFieldColumnVisibility } from "@/hooks/use-custom-field-column-visibility";
import { useDeleteConfirmation } from "@/hooks/use-delete-confirmation";
import { useSortParams } from "@/hooks/use-sort-params";
import { matchesFilter } from "@/lib/artifact-filter";
import { formatScorePercent } from "@/lib/evaluation-utils";
import {
  getArtifactRoute,
  isNavigableArtifact,
} from "@/lib/artifact-navigation";
import { deriveCustomFieldColumns } from "@/lib/custom-field-utils";
import { formatRelativeTime } from "@/lib/date-utils";
import {
  ARTIFACT_STATUS_COLORS,
  ARTIFACT_STATUS_LABELS,
  ARTIFACT_TYPE_ICONS,
} from "@/lib/project-constants";
import type { SortConfig, SortDirection } from "@/lib/table-utils";
import { sortTableData } from "@/lib/table-utils";
import { getUserDisplayName } from "@/lib/user-utils";
import { ArtifactTypeBadge } from "./artifact-type-badge";
import { MergeArtifactsDialog } from "./merge-artifacts-dialog";
import { SortableArtifactRow } from "./sortable-artifact-row";

type ArtifactsTableProps = {
  artifacts: ArtifactWithWorkstream[];
  projectId: string;
  filterText: string;
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
  showJudgeScores?: boolean;
}[] = [
  {
    title: "Documents",
    types: new Set<ArtifactType>(["PRD"]),
  },
  {
    title: "Implementation Plans",
    types: new Set<ArtifactType>(["IMPLEMENTATION_PLAN"]),
    showJudgeScores: true,
  },
];

const ARTIFACT_SORT_COLUMNS = [
  "title",
  "type",
  "status",
  "assignee",
  "updatedAt",
] as const;

type ArtifactSortColumn = (typeof ARTIFACT_SORT_COLUMNS)[number];

const ARTIFACT_SORT_CONFIGS: Record<
  ArtifactSortColumn,
  SortConfig<ArtifactWithWorkstream>
> = {
  title: { key: "title", columnType: "string" },
  type: { key: "type", columnType: "string" },
  status: { key: "status", columnType: "string" },
  assignee: {
    key: "assignee",
    comparator: (a, b) => {
      const aName = a.assignee ? getUserDisplayName(a.assignee) : "";
      const bName = b.assignee ? getUserDisplayName(b.assignee) : "";
      return aName.localeCompare(bName);
    },
  },
  updatedAt: { key: "updatedAt", columnType: "date" },
};

type ArtifactSectionProps = {
  title: string;
  artifacts: ArtifactWithWorkstream[];
  projectId: string;
  onRowClick: (artifact: ArtifactWithWorkstream) => void;
  onStatusChange?: (artifactId: string, status: ArtifactStatus) => void;
  onRequestDelete: (artifact: ArtifactWithWorkstream) => void;
  sortBy: ArtifactSortColumn | null;
  sortDir: SortDirection;
  onSort: (column: ArtifactSortColumn, direction: SortDirection) => void;
  selectedIds?: Set<string>;
  onSelectChange?: (id: string, checked: boolean) => void;
  onSelectAllInSection?: (
    sectionArtifactIds: string[],
    checked: boolean
  ) => void;
  visibleCustomFieldColumns: CustomFieldValueDetail[];
  judgeScoresMap?: Record<string, JudgeFeedbackItem[]>;
};

function ArtifactSection({
  title,
  artifacts,
  projectId,
  onRowClick,
  onStatusChange,
  onRequestDelete,
  sortBy,
  sortDir,
  onSort,
  selectedIds,
  onSelectChange,
  onSelectAllInSection,
  visibleCustomFieldColumns,
  judgeScoresMap,
}: Readonly<ArtifactSectionProps>) {
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] =
    useState<ArtifactWithWorkstream | null>(null);

  // When column sort is active, use it; otherwise fall back to DnD sortOrder
  const sortedArtifacts = useMemo(() => {
    if (sortBy) {
      return sortTableData(artifacts, sortBy, ARTIFACT_SORT_CONFIGS, sortDir);
    }
    return [...artifacts].sort((a, b) => {
      const orderA = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    });
  }, [artifacts, sortBy, sortDir]);

  // Memoize artifact IDs to provide a stable reference for SortableContext
  const sortedArtifactIds = useMemo(
    () => sortedArtifacts.map((a) => a.id),
    [sortedArtifacts]
  );

  const allSectionSelected =
    sortedArtifacts.length > 0 &&
    sortedArtifacts.every((a) => selectedIds?.has(a.id));

  const someSectionSelected =
    !allSectionSelected && sortedArtifacts.some((a) => selectedIds?.has(a.id));

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
              <TableHead className="w-10">
                <Checkbox
                  aria-label={`Select all in ${title}`}
                  checked={
                    allSectionSelected ||
                    (someSectionSelected ? "indeterminate" : false)
                  }
                  onCheckedChange={(checked) =>
                    onSelectAllInSection?.(sortedArtifactIds, !!checked)
                  }
                  onClick={(e) => e.stopPropagation()}
                />
              </TableHead>
              <SortableColumnHeader
                column="title"
                label="Artifact"
                onSort={onSort}
                sortBy={sortBy}
                sortDir={sortDir}
              />
              <SortableColumnHeader
                column="type"
                label="Type"
                onSort={onSort}
                sortBy={sortBy}
                sortDir={sortDir}
              />
              <SortableColumnHeader
                column="status"
                label="Status"
                onSort={onSort}
                sortBy={sortBy}
                sortDir={sortDir}
              />
              <SortableColumnHeader
                column="assignee"
                label="Assignee"
                onSort={onSort}
                sortBy={sortBy}
                sortDir={sortDir}
              />
              <SortableColumnHeader
                column="updatedAt"
                label="Updated"
                onSort={onSort}
                sortBy={sortBy}
                sortDir={sortDir}
              />
              {judgeScoresMap && <TableHead>Judges</TableHead>}
              {visibleCustomFieldColumns.map((field) => (
                <TableHead key={field.customFieldId}>{field.name}</TableHead>
              ))}
              <TableHead className="w-[50px]" />
            </TableRow>
          </TableHeader>
          <SortableContext
            id={title}
            items={sortedArtifactIds}
            strategy={verticalListSortingStrategy}
          >
            <TableBody>
              {sortedArtifacts.map((artifact) => {
                const Icon = ARTIFACT_TYPE_ICONS[artifact.type] || FileTextIcon;
                const isClickable = isNavigableArtifact(artifact);

                return (
                  <SortableArtifactRow
                    artifact={artifact}
                    className={
                      isClickable ? "cursor-pointer hover:bg-muted/50" : ""
                    }
                    key={artifact.id}
                    onClick={() => onRowClick(artifact)}
                    onSelectChange={onSelectChange}
                    selectedIds={selectedIds}
                  >
                    <TableCell className="max-w-[320px]">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          {isDisplayableSlug(artifact.slug) && (
                            <span className="font-mono text-muted-foreground text-xs">
                              {artifact.slug}
                            </span>
                          )}
                          <span
                            className="truncate font-medium"
                            title={artifact.title}
                          >
                            {artifact.title}
                          </span>
                        </div>
                        <div className="px-3">
                          <GenerationStatusIndicator
                            className="text-xs"
                            generationStatus={artifact.generationStatus}
                          />
                        </div>
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
                              className={
                                ARTIFACT_STATUS_COLORS[artifact.status]
                              }
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
                    <TableCell>
                      <AssigneeAvatar assignee={artifact.assignee} />
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground text-sm">
                        {formatRelativeTime(artifact.updatedAt)}
                      </span>
                    </TableCell>
                    {judgeScoresMap && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <JudgeScoreCell
                          judges={judgeScoresMap[artifact.id]}
                        />
                      </TableCell>
                    )}
                    {visibleCustomFieldColumns.map((colDef) => {
                      const fieldValue = artifact.customFields?.find(
                        (f) => f.customFieldId === colDef.customFieldId
                      );
                      return (
                        <TableCell
                          key={colDef.customFieldId}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {fieldValue ? (
                            <CustomFieldCell value={fieldValue} />
                          ) : (
                            <span className="text-muted-foreground text-sm">
                              —
                            </span>
                          )}
                        </TableCell>
                      );
                    })}
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            className="h-8 w-8"
                            size="icon"
                            variant="ghost"
                          >
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
                  </SortableArtifactRow>
                );
              })}
            </TableBody>
          </SortableContext>
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
  filterText,
  onStatusChange,
  onDelete,
}: Readonly<ArtifactsTableProps>) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const { mutateAsync: mergeArtifacts, isPending: isMergePending } =
    useMergeArtifacts();
  const { data: judgeScoresMap } = useProjectJudgeScores(projectId);
  const { sortBy, sortDir, setSort } = useSortParams<ArtifactSortColumn>({
    defaultColumn: null,
    defaultDirection: "desc",
    validColumns: ARTIFACT_SORT_COLUMNS,
  });

  // Custom field columns derived from artifacts' customFields data
  const customFieldColumns = useMemo(
    () => deriveCustomFieldColumns(artifacts),
    [artifacts]
  );

  const {
    handleToggleColumn,
    visibleColumnsRecord,
    visibleCustomFieldColumns,
  } = useCustomFieldColumnVisibility(customFieldColumns);

  const deleteConfirmation = useDeleteConfirmation({
    onDelete: onDelete ?? (async () => false),
    getId: (artifact: ArtifactWithWorkstream) => artifact.id,
  });

  const filteredArtifacts = useMemo(
    () => artifacts.filter((a) => matchesFilter(a, filterText)),
    [artifacts, filterText]
  );

  const sections = useMemo(
    () =>
      ARTIFACT_SECTIONS.map((section) => ({
        title: section.title,
        artifacts: filteredArtifacts.filter((a) => section.types.has(a.type)),
        showJudgeScores: section.showJudgeScores,
      })).filter((section) => section.artifacts.length > 0),
    [filteredArtifacts]
  );

  function handleRowClick(artifact: ArtifactWithWorkstream): void {
    if (isNavigableArtifact(artifact)) {
      const route = getArtifactRoute(artifact);
      if (route) {
        router.push(route);
      }
    }
  }

  function handleSelectChange(id: string, checked: boolean): void {
    if (checked) {
      setSelectedIds((prev) => new Set([...prev, id]));
    } else {
      setSelectedIds((prev) => new Set([...prev].filter((x) => x !== id)));
    }
  }

  function handleSelectAllInSection(
    sectionArtifactIds: string[],
    checked: boolean
  ): void {
    if (checked) {
      setSelectedIds((prev) => new Set([...prev, ...sectionArtifactIds]));
    } else {
      const sectionSet = new Set(sectionArtifactIds);
      setSelectedIds(
        (prev) => new Set([...prev].filter((x) => !sectionSet.has(x)))
      );
    }
  }

  const selectedArtifactsList = artifacts.filter((a) => selectedIds.has(a.id));
  const canMerge = getMergeDisabledReason() === null;

  async function handleMerge(
    primaryId: string,
    secondaryId: string
  ): Promise<void> {
    setMergeError(null);
    try {
      const updatedArtifact = await mergeArtifacts({
        primaryArtifactId: primaryId,
        secondaryArtifactId: secondaryId,
      });
      setSelectedIds(new Set());
      setMergeDialogOpen(false);
      const route = getArtifactRoute(updatedArtifact);
      toast.success("Artifacts merged", {
        action: route
          ? { label: "View", onClick: () => router.push(route) }
          : undefined,
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to merge artifacts";
      setMergeError(msg);
    }
  }

  function getMergeDisabledReason(): string | null {
    if (selectedIds.size === 1) {
      return "Select exactly 2 artifacts to merge";
    }
    if (selectedIds.size > 2) {
      return "Merge requires exactly 2 artifacts";
    }
    const pid0 = selectedArtifactsList[0]?.projectId;
    const pid1 = selectedArtifactsList[1]?.projectId;
    if (selectedIds.size === 2 && (!(pid0 && pid1) || pid0 !== pid1)) {
      return "Both artifacts must be from the same project";
    }
    return null;
  }

  const mergeDisabledReason = getMergeDisabledReason();

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

  if (filteredArtifacts.length === 0 && filterText) {
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
    <div className="space-y-6">
      {customFieldColumns.length > 0 && (
        <div className="flex justify-end">
          <ColumnVisibilityPopover
            fields={customFieldColumns.map((f) => ({
              customFieldId: f.customFieldId,
              name: f.name,
            }))}
            onToggle={handleToggleColumn}
            visibleColumns={visibleColumnsRecord}
          />
        </div>
      )}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-md border bg-muted/50 px-4 py-2">
          <span className="font-medium text-sm">
            {selectedIds.size} selected
          </span>
          <Button
            onClick={() => setSelectedIds(new Set())}
            size="sm"
            variant="ghost"
          >
            Clear Selection
          </Button>
          {canMerge ? (
            <Button
              disabled={isMergePending}
              onClick={() => setMergeDialogOpen(true)}
              size="sm"
              variant="outline"
            >
              Merge
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button disabled size="sm" variant="outline">
                    Merge
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{mergeDisabledReason}</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
      {sections.map((section) => (
        <ArtifactSection
          artifacts={section.artifacts}
          judgeScoresMap={
            section.showJudgeScores ? judgeScoresMap : undefined
          }
          key={section.title}
          onRequestDelete={deleteConfirmation.requestDelete}
          onRowClick={handleRowClick}
          onSelectAllInSection={handleSelectAllInSection}
          onSelectChange={handleSelectChange}
          onSort={setSort}
          onStatusChange={onStatusChange}
          projectId={projectId}
          selectedIds={selectedIds}
          sortBy={sortBy}
          sortDir={sortDir}
          title={section.title}
          visibleCustomFieldColumns={visibleCustomFieldColumns}
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
      {mergeDialogOpen && selectedArtifactsList.length === 2 && (
        <MergeArtifactsDialog
          artifacts={
            selectedArtifactsList as [
              ArtifactWithWorkstream,
              ArtifactWithWorkstream,
            ]
          }
          error={mergeError}
          isPending={isMergePending}
          onConfirm={handleMerge}
          onOpenChange={setMergeDialogOpen}
          open={mergeDialogOpen}
        />
      )}
    </div>
  );
}

function JudgeScoreCell({
  judges,
}: Readonly<{ judges: JudgeFeedbackItem[] | undefined }>) {
  if (!judges || judges.length === 0) {
    return <span className="text-muted-foreground text-sm">-</span>;
  }

  const mean = judges.reduce((sum, j) => sum + j.score, 0) / judges.length;
  const allPassing = judges.every((j) => j.score >= j.threshold);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`cursor-default font-medium text-sm ${allPassing ? "text-success-foreground" : "text-destructive-foreground"}`}
        >
          {formatScorePercent(mean)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs" side="top">
        <div className="space-y-1.5 py-1">
          {judges.map((j) => {
            const passing = j.score >= j.threshold;
            return (
              <div
                className="flex items-center justify-between gap-4 text-xs"
                key={j.judgeScoreId}
              >
                <span className="truncate">
                  {j.promptName ?? j.caseId}
                </span>
                <span
                  className={`shrink-0 font-medium ${passing ? "text-success-foreground" : "text-destructive-foreground"}`}
                >
                  {formatScorePercent(j.score)}
                </span>
              </div>
            );
          })}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
