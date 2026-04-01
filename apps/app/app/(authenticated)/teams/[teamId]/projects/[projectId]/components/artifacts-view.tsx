"use client";

import {
  type ArtifactStatus,
  ArtifactType,
  type ArtifactWithWorkstream,
  getRoutePrefixForType,
} from "@repo/api/src/types/artifact";
import { EntityType } from "@repo/api/src/types/entity-link";
import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
import type { TreeEntity, TreeNode } from "@repo/api/src/types/project-tree";
import type { WorkstreamState } from "@repo/api/src/types/workstream";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { FileTextIcon, FolderIcon, MergeIcon, TrashIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  ArtifactRow,
  type ArtifactRowItem,
  type RowEditHandlers,
} from "@/components/artifact-table/artifact-row";
import { ArtifactTableHeader } from "@/components/artifact-table/table-header";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EmptyState } from "@/components/empty-state";
import { MoveEntityDialog } from "@/components/move-entity-dialog";
import { useMergeArtifacts } from "@/hooks/queries/use-artifacts";
import { useProjectTree } from "@/hooks/queries/use-project-tree";
import type { ArtifactColumn } from "@/hooks/use-column-visibility";
import { useSortParams } from "@/hooks/use-sort-params";
import { matchesFilter } from "@/lib/artifact-filter";
import { comparePriorityValues } from "@/lib/priority-sort";
import type { SortConfig } from "@/lib/table-utils";
import { sortTableData } from "@/lib/table-utils";
import type { FilterCategory } from "../page";
import { MergeArtifactsDialog } from "./merge-artifacts-dialog";

// ---- Types ----

type ArtifactsViewProps = {
  artifacts: ArtifactWithWorkstream[];
  features: FeatureWithWorkstream[];
  projectId: string;
  teamId: string;
  filterText: string;
  filterCategory: FilterCategory;
  visibleColumns: ArtifactColumn[];
  onStatusChange?: (artifactId: string, status: ArtifactStatus) => void;
  onDelete?: (item: ArtifactRowItem) => Promise<boolean>;
  /** Edit handlers for inline cell editing (assignee, priority, due date). */
  editHandlers?: RowEditHandlers;
};

// ---- Workstream grouping (reused from threaded view) ----

type WorkstreamGroup = {
  id: string | null;
  groupKey: string;
  title: string;
  state: WorkstreamState | null;
  items: ArtifactRowItem[];
};

const TYPE_ORDER: Record<string, number> = {
  [ArtifactType.Prd]: 0,
  feature: 1,
  [ArtifactType.ImplementationPlan]: 2,
  [ArtifactType.Template]: 3,
};

const UNASSIGNED_KEY_PREFIX = "unassigned:" as const;

function getItemTypeOrder(item: ArtifactRowItem): number {
  if (item.kind === "feature") {
    return TYPE_ORDER.feature;
  }
  if (item.kind === "project") {
    return 99;
  }
  return TYPE_ORDER[item.data.type] ?? 99;
}

function getItemTitle(item: ArtifactRowItem): string {
  if (item.kind === "project") {
    return item.data.name;
  }
  return item.data.title;
}

function sortItemsByType(items: ArtifactRowItem[]): ArtifactRowItem[] {
  return [...items].sort((a, b) => getItemTypeOrder(a) - getItemTypeOrder(b));
}

function deriveGroupTitle(
  workstreamTitle: string | null | undefined,
  items: ArtifactRowItem[]
): string {
  if (workstreamTitle) {
    return workstreamTitle;
  }
  const prd = items.find((i) => i.kind === "artifact" && i.data.type === "PRD");
  if (prd?.kind === "artifact") {
    return prd.data.title;
  }
  return "Unassigned";
}

function groupByWorkstream(
  artifacts: ArtifactWithWorkstream[],
  features: FeatureWithWorkstream[]
): WorkstreamGroup[] {
  const groups = new Map<string, WorkstreamGroup>();
  const workstreamTitles = new Map<string, string | null | undefined>();

  for (const artifact of artifacts) {
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
        items: [],
      });
      workstreamTitles.set(key, artifact.workstream?.title);
    }
    groups.get(key)?.items.push({ kind: "artifact", data: artifact });
  }

  for (const feature of features) {
    const key = feature.workstreamId ?? `${UNASSIGNED_KEY_PREFIX}shared`;

    if (!groups.has(key)) {
      groups.set(key, {
        id: feature.workstreamId,
        groupKey: key,
        title: "",
        state: (feature.workstream?.state as WorkstreamState) ?? null,
        items: [],
      });
      workstreamTitles.set(key, feature.workstream?.title);
    }
    groups.get(key)?.items.push({ kind: "feature", data: feature });
  }

  for (const [key, group] of groups) {
    group.title = deriveGroupTitle(workstreamTitles.get(key), group.items);
    group.items = sortItemsByType(group.items);
  }

  return [...groups.values()].sort((a, b) => {
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
}

// ---- Tree-based grouping ----

/** Unified group shape used by both workstream and tree grouping paths. */
type DisplayGroup = {
  groupKey: string;
  root: ArtifactRowItem;
  children: ArtifactRowItem[];
};

/** Convert workstream groups (fallback path) to the unified DisplayGroup shape. */
function toDisplayGroups(wsGroups: WorkstreamGroup[]): DisplayGroup[] {
  const result: DisplayGroup[] = [];
  for (const g of wsGroups) {
    const [root, ...children] = g.items;
    if (root) {
      result.push({ groupKey: g.groupKey, root, children });
    }
  }
  return result;
}

function treeEntityToRowItem(
  entity: TreeEntity,
  artifactMap: Map<string, ArtifactWithWorkstream>,
  featureMap: Map<string, FeatureWithWorkstream>
): ArtifactRowItem | null {
  if (isArtifactTreeEntity(entity)) {
    const data = artifactMap.get(entity.id);
    return data ? { kind: "artifact", data } : null;
  }
  if (isFeatureTreeEntity(entity)) {
    const data = featureMap.get(entity.id);
    return data ? { kind: "feature", data } : null;
  }
  return null; // ExternalLink — no row type yet
}

function groupByProjectTree(
  nodes: TreeNode[],
  artifacts: ArtifactWithWorkstream[],
  features: FeatureWithWorkstream[]
): DisplayGroup[] {
  const artifactMap = new Map(artifacts.map((a) => [a.id, a]));
  const featureMap = new Map(features.map((f) => [f.id, f]));
  const seenIds = new Set<string>();
  const groups: DisplayGroup[] = [];

  for (const node of nodes) {
    const root = treeEntityToRowItem(node.root, artifactMap, featureMap);
    if (!root) {
      continue;
    }
    seenIds.add(node.root.id);

    const children: ArtifactRowItem[] = [];
    for (const child of node.children) {
      seenIds.add(child.id);
      const childItem = treeEntityToRowItem(child, artifactMap, featureMap);
      if (childItem) {
        children.push(childItem);
      }
    }
    groups.push({ groupKey: node.root.id, root, children });
  }

  // Orphans — items in filtered data but not in any tree node
  for (const artifact of artifacts) {
    if (!seenIds.has(artifact.id)) {
      groups.push({
        groupKey: artifact.id,
        root: { kind: "artifact", data: artifact },
        children: [],
      });
    }
  }
  for (const feature of features) {
    if (!seenIds.has(feature.id)) {
      groups.push({
        groupKey: feature.id,
        root: { kind: "feature", data: feature },
        children: [],
      });
    }
  }

  return groups;
}

// ---- Filter items by category ----

function filterByCategory(
  artifacts: ArtifactWithWorkstream[],
  features: FeatureWithWorkstream[],
  category: FilterCategory,
  filterText: string
): {
  filteredArtifacts: ArtifactWithWorkstream[];
  filteredFeatures: FeatureWithWorkstream[];
} {
  let filteredArtifacts = artifacts.filter((a) => matchesFilter(a, filterText));
  let filteredFeatures = features.filter((f) => {
    if (!filterText.trim()) {
      return true;
    }
    return f.title.toLowerCase().includes(filterText.toLowerCase().trim());
  });

  switch (category) {
    case "documents": {
      filteredArtifacts = filteredArtifacts.filter(
        (a) => a.type === ArtifactType.Prd
      );
      filteredFeatures = [];
      break;
    }
    case "features": {
      filteredArtifacts = [];
      break;
    }
    case "plans": {
      filteredArtifacts = filteredArtifacts.filter(
        (a) => a.type === ArtifactType.ImplementationPlan
      );
      filteredFeatures = [];
      break;
    }
    case "branches": {
      filteredArtifacts = filteredArtifacts.filter(
        (a) => a.type === ArtifactType.Template
      );
      filteredFeatures = [];
      break;
    }
    default: {
      break;
    }
  }

  return { filteredArtifacts, filteredFeatures };
}

// ---- Sort configs ----

const SORT_COLUMNS = [
  "title",
  "type",
  "dueDate",
  "assignee",
  "priority",
  "score",
] as const;

type SortColumn = (typeof SORT_COLUMNS)[number];

const ITEM_SORT_CONFIGS: Record<string, SortConfig<ArtifactRowItem>> = {
  title: {
    key: "title",
    comparator: (a, b) => getItemTitle(a).localeCompare(getItemTitle(b)),
  },
  type: {
    key: "type",
    comparator: (a, b) => {
      const aType = a.kind === "artifact" ? a.data.type : "FEATURE";
      const bType = b.kind === "artifact" ? b.data.type : "FEATURE";
      return aType.localeCompare(bType);
    },
  },
  dueDate: {
    key: "updatedAt",
    comparator: (a, b) => {
      const aDate = new Date(a.data.updatedAt).getTime();
      const bDate = new Date(b.data.updatedAt).getTime();
      return aDate - bDate;
    },
  },
  assignee: {
    key: "assignee",
    comparator: (a, b) => {
      const aName = a.data.assignee
        ? `${a.data.assignee.firstName} ${a.data.assignee.lastName}`
        : "";
      const bName = b.data.assignee
        ? `${b.data.assignee.firstName} ${b.data.assignee.lastName}`
        : "";
      if (!(aName || bName)) {
        return 0;
      }
      if (!aName) {
        return 1;
      }
      if (!bName) {
        return -1;
      }
      return aName.localeCompare(bName);
    },
  },
  priority: {
    key: "priority",
    comparator: compareByPriority,
  },
};

function compareByPriority(a: ArtifactRowItem, b: ArtifactRowItem): number {
  return comparePriorityValues(a.data.priority, b.data.priority);
}

// ---- Context menu state ----

type MenuState = {
  item: ArtifactRowItem;
  anchor: HTMLElement;
} | null;

// ---- Component ----

export function ArtifactsView({
  artifacts,
  features,
  projectId,
  teamId,
  filterText,
  filterCategory,
  visibleColumns,
  onDelete,
  editHandlers,
}: ArtifactsViewProps) {
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Clear selection when filter category changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when filterCategory changes
  useEffect(() => {
    setSelectedIds(new Set());
  }, [filterCategory]);

  const [menuState, setMenuState] = useState<MenuState>(null);
  const [deleteTarget, setDeleteTarget] = useState<ArtifactRowItem | null>(
    null
  );
  const [pendingBulkIds, setPendingBulkIds] = useState<Set<string>>(new Set());
  const [moveEntity, setMoveEntity] = useState<{
    id: string;
    entityType: EntityType;
    projectId?: string | null;
  } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const mergeMutation = useMergeArtifacts();

  const { sortBy, sortDir, setSort } = useSortParams<SortColumn>({
    validColumns: SORT_COLUMNS,
    defaultColumn: null,
  });

  const { filteredArtifacts, filteredFeatures } = useMemo(
    () => filterByCategory(artifacts, features, filterCategory, filterText),
    [artifacts, features, filterCategory, filterText]
  );

  const isGroupedView = filterCategory === "all";
  const showCheckbox = !isGroupedView;

  // Check if exactly 2 artifacts (not features) are selected for merge
  const selectedArtifactsForMerge = useMemo(():
    | [ArtifactWithWorkstream, ArtifactWithWorkstream]
    | null => {
    if (selectedIds.size !== 2) {
      return null;
    }
    const ids = Array.from(selectedIds);
    const a1 = artifacts.find((a) => a.id === ids[0]);
    const a2 = artifacts.find((a) => a.id === ids[1]);
    if (a1 && a2) {
      return [a1, a2];
    }
    return null;
  }, [selectedIds, artifacts]);

  const { data: treeData } = useProjectTree(projectId);

  // Build parent map: child entity id → parent title + optional parent artifact route.
  const parentMap = useMemo((): Map<
    string,
    { title: string; href: string | null }
  > => {
    if (!treeData) {
      return new Map();
    }
    const map = new Map<string, { title: string; href: string | null }>();
    for (const node of treeData.nodes) {
      let parentHref: string | null = null;
      if (isArtifactTreeEntity(node.root)) {
        const routePrefix = getRoutePrefixForType(node.root.type);
        if (routePrefix) {
          parentHref = `/${routePrefix}/${node.root.slug}`;
        }
      }
      for (const child of node.children) {
        map.set(child.id, { title: node.root.title, href: parentHref });
      }
    }
    return map;
  }, [treeData]);

  // Build groups for "All" view, sorted by root item when a sort is active.
  // Uses project tree structure when available; falls back to workstream grouping while loading.
  const groups: DisplayGroup[] = useMemo(() => {
    const ungrouped: DisplayGroup[] = treeData
      ? groupByProjectTree(treeData.nodes, filteredArtifacts, filteredFeatures)
      : toDisplayGroups(groupByWorkstream(filteredArtifacts, filteredFeatures));

    if (!sortBy) {
      return ungrouped;
    }
    const config = ITEM_SORT_CONFIGS[sortBy];
    if (!config?.comparator) {
      return ungrouped;
    }
    const { comparator } = config;
    const dirMultiplier = sortDir === "asc" ? 1 : -1;
    return [...ungrouped].sort(
      (a, b) => comparator(a.root, b.root) * dirMultiplier
    );
  }, [filteredArtifacts, filteredFeatures, sortBy, sortDir, treeData]);

  // Auto-open any groups that haven't been seen before (handles initial load and
  // async tree data arriving after the workstream fallback was already shown).
  useEffect(() => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const g of groups) {
        if (!prev.has(g.groupKey)) {
          next.add(g.groupKey);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [groups]);

  // Build flat items for filtered views
  const flatItems: ArtifactRowItem[] = useMemo(() => {
    const items: ArtifactRowItem[] = [
      ...filteredArtifacts.map(
        (a): ArtifactRowItem => ({ kind: "artifact", data: a })
      ),
      ...filteredFeatures.map(
        (f): ArtifactRowItem => ({ kind: "feature", data: f })
      ),
    ];
    if (sortBy) {
      const config = ITEM_SORT_CONFIGS[sortBy];
      if (config) {
        return sortTableData(items, sortBy, ITEM_SORT_CONFIGS, sortDir);
      }
    }
    return items;
  }, [filteredArtifacts, filteredFeatures, sortBy, sortDir]);

  const isEmpty =
    filteredArtifacts.length === 0 && filteredFeatures.length === 0;
  const hasAnyItems = artifacts.length > 0 || features.length > 0;

  // ---- Selection handlers ----

  function handleSelectionChange(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  // ---- Group toggle ----

  function toggleGroup(groupKey: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }

  // ---- Context menu handlers ----

  function handleMoreMenu(item: ArtifactRowItem, anchor: HTMLElement) {
    setMenuState({ item, anchor });
  }

  function handleRequestDelete(item: ArtifactRowItem) {
    setDeleteTarget(item);
    setDeleteDialogOpen(true);
    setMenuState(null);
  }

  function handleRequestMove(item: ArtifactRowItem) {
    if (item.kind === "artifact") {
      setMoveEntity({
        id: item.data.id,
        entityType: EntityType.Artifact,
        projectId: item.data.projectId,
      });
    } else if (item.kind === "feature") {
      setMoveEntity({
        id: item.data.id,
        entityType: EntityType.Feature,
        projectId: item.data.projectId,
      });
    }
    setMenuState(null);
  }

  async function executeBulkDelete(
    performDelete: (item: ArtifactRowItem) => Promise<boolean>
  ): Promise<boolean> {
    const itemsToDelete: ArtifactRowItem[] = [];
    let hasMissing = false;
    for (const id of pendingBulkIds) {
      const artifact = artifacts.find((a) => a.id === id);
      if (artifact) {
        itemsToDelete.push({ kind: "artifact", data: artifact });
        continue;
      }
      const feature = features.find((f) => f.id === id);
      if (feature) {
        itemsToDelete.push({ kind: "feature", data: feature });
      } else {
        hasMissing = true;
      }
    }
    const results = await Promise.all(itemsToDelete.map(performDelete));
    const allDeleted = !hasMissing && results.every(Boolean);
    if (allDeleted) {
      setDeleteDialogOpen(false);
      setPendingBulkIds(new Set());
      setSelectedIds(new Set());
    }
    return allDeleted;
  }

  async function handleConfirmDelete(): Promise<boolean> {
    if (!onDelete) {
      return false;
    }
    setDeletePending(true);
    try {
      if (pendingBulkIds.size > 0) {
        return await executeBulkDelete(onDelete);
      }
      if (!deleteTarget) {
        return false;
      }
      const result = await onDelete(deleteTarget);
      if (result) {
        setDeleteDialogOpen(false);
        setDeleteTarget(null);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(deleteTarget.data.id);
          return next;
        });
      }
      return result;
    } finally {
      setDeletePending(false);
    }
  }

  // ---- Empty state ----

  if (isEmpty) {
    if (!hasAnyItems) {
      return (
        <EmptyState
          description="Create a PRD, feature, or plan to get started."
          icon={FileTextIcon}
          title="No artifacts yet"
        />
      );
    }
    return (
      <EmptyState
        description="Try adjusting your filter or search term."
        icon={FileTextIcon}
        title="No matching artifacts"
      />
    );
  }

  return (
    <>
      <div>
        <ArtifactTableHeader
          onSort={(col, dir) => setSort(col as SortColumn, dir)}
          sortBy={sortBy}
          sortDir={sortDir}
          visibleColumns={visibleColumns}
        />
        {isGroupedView
          ? groups.map((group) => {
              const { root, children } = group;
              const isOpen = openGroups.has(group.groupKey);
              const hasChildren = children.length > 0;
              return (
                <div key={group.groupKey}>
                  <ArtifactRow
                    editHandlers={editHandlers}
                    isExpanded={hasChildren ? isOpen : false}
                    isSelected={selectedIds.has(root.data.id)}
                    item={root}
                    onMoreMenu={handleMoreMenu}
                    onSelectionChange={handleSelectionChange}
                    onToggleExpand={
                      hasChildren
                        ? () => toggleGroup(group.groupKey)
                        : undefined
                    }
                    parentHref={parentMap.get(root.data.id)?.href}
                    parentTitle={parentMap.get(root.data.id)?.title}
                    showCheckbox={false}
                    visibleColumns={visibleColumns}
                  />
                  {isOpen &&
                    children.map((child) => (
                      <ArtifactRow
                        editHandlers={editHandlers}
                        indented
                        isSelected={selectedIds.has(child.data.id)}
                        item={child}
                        key={child.data.id}
                        onMoreMenu={handleMoreMenu}
                        onSelectionChange={handleSelectionChange}
                        parentHref={parentMap.get(child.data.id)?.href}
                        parentTitle={parentMap.get(child.data.id)?.title}
                        showCheckbox={false}
                        visibleColumns={visibleColumns}
                      />
                    ))}
                </div>
              );
            })
          : flatItems.map((item) => (
              <ArtifactRow
                editHandlers={editHandlers}
                isSelected={selectedIds.has(item.data.id)}
                item={item}
                key={item.data.id}
                onMoreMenu={handleMoreMenu}
                onSelectionChange={handleSelectionChange}
                parentHref={parentMap.get(item.data.id)?.href}
                parentTitle={parentMap.get(item.data.id)?.title}
                showCheckbox={showCheckbox}
                visibleColumns={visibleColumns}
              />
            ))}

        {/* Floating selection bar */}
        {selectedIds.size > 0 && (
          <div className="pointer-events-none sticky bottom-3 z-50 mt-4 flex justify-center">
            <div className="pointer-events-auto flex items-center gap-4 rounded-2xl border bg-background px-[18px] py-3 shadow-md">
              <span className="shrink-0 font-medium text-muted-foreground text-xs">
                {selectedIds.size} {selectedIds.size === 1 ? "item" : "items"}{" "}
                selected
              </span>
              <div className="flex items-center gap-2">
                <Button
                  className="h-8 text-xs"
                  onClick={() => setSelectedIds(new Set())}
                  size="sm"
                  variant="outline"
                >
                  Clear Selected
                </Button>
                {selectedArtifactsForMerge && (
                  <Button
                    className="h-8 text-xs"
                    onClick={() => {
                      setMergeError(null);
                      setMergeDialogOpen(true);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <MergeIcon className="h-4 w-4" />
                    Merge
                  </Button>
                )}
                <Button
                  className="h-8 text-xs"
                  onClick={() => {
                    setPendingBulkIds(new Set(selectedIds));
                    setDeleteDialogOpen(true);
                  }}
                  size="sm"
                  variant="outline"
                >
                  <TrashIcon className="h-4 w-4" />
                  Delete
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Context menu dropdown (anchored to the more-menu button via virtual ref) */}
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) {
            setMenuState(null);
          }
        }}
        open={menuState !== null}
      >
        <DropdownMenuTrigger asChild>
          <span
            className="pointer-events-none fixed"
            ref={(node) => {
              if (node && menuState?.anchor) {
                const rect = menuState.anchor.getBoundingClientRect();
                node.style.top = `${rect.top}px`;
                node.style.left = `${rect.left}px`;
                node.style.width = `${rect.width}px`;
                node.style.height = `${rect.height}px`;
              }
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {(menuState?.item.kind === "artifact" ||
            menuState?.item.kind === "feature") && (
            <DropdownMenuItem onClick={() => handleRequestMove(menuState.item)}>
              <FolderIcon className="h-4 w-4" />
              Move to Project
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={() => {
              if (menuState) {
                handleRequestDelete(menuState.item);
              }
            }}
            variant="destructive"
          >
            <TrashIcon className="h-4 w-4 text-destructive" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Delete confirmation */}
      <DeleteConfirmationDialog
        isPending={deletePending}
        itemName={deleteTarget ? getItemTitle(deleteTarget) : ""}
        onConfirm={handleConfirmDelete}
        onOpenChange={setDeleteDialogOpen}
        open={deleteDialogOpen}
        title={deleteTarget?.kind === "artifact" ? "Artifact" : "Feature"}
      />

      {/* Move entity dialog */}
      {moveEntity && (
        <MoveEntityDialog
          currentProjectId={projectId}
          entity={moveEntity}
          onOpenChange={(open) => {
            if (!open) {
              setMoveEntity(null);
            }
          }}
          open={moveEntity !== null}
          teamId={teamId}
        />
      )}

      {/* Merge artifacts dialog */}
      {selectedArtifactsForMerge && (
        <MergeArtifactsDialog
          artifacts={selectedArtifactsForMerge}
          error={mergeError}
          isPending={mergeMutation.isPending}
          onConfirm={async (primaryId, secondaryId) => {
            setMergeError(null);
            try {
              await mergeMutation.mutateAsync({
                primaryArtifactId: primaryId,
                secondaryArtifactId: secondaryId,
              });
              setMergeDialogOpen(false);
              setSelectedIds(new Set());
            } catch (err) {
              setMergeError(
                err instanceof Error ? err.message : "Failed to merge artifacts"
              );
            }
          }}
          onOpenChange={setMergeDialogOpen}
          open={mergeDialogOpen}
        />
      )}
    </>
  );
}

function isArtifactTreeEntity(
  entity: TreeEntity
): entity is Extract<TreeEntity, { slug: string; type: ArtifactType }> {
  return "slug" in entity && "type" in entity;
}

function isFeatureTreeEntity(
  entity: TreeEntity
): entity is Extract<TreeEntity, { slug: string; priority: string }> {
  return "slug" in entity && "priority" in entity;
}
