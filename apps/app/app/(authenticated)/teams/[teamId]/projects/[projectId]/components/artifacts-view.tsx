"use client";

import {
  ArtifactStatus,
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
import {
  ExternalLinkIcon,
  FileTextIcon,
  FilterXIcon,
  GitPullRequestIcon,
  Layers2Icon,
  Loader2,
  MergeIcon,
  TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArtifactRow,
  type ArtifactRowItem,
  type RowEditHandlers,
} from "@/components/artifact-table/artifact-row";
import { StatusSectionHeader } from "@/components/artifact-table/status-section-header";
import { ArtifactTableHeader } from "@/components/artifact-table/table-header";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EmptyState } from "@/components/empty-state";
import { MoveEntityDialog } from "@/components/move-entity-dialog";
import { useMergeArtifacts } from "@/hooks/queries/use-artifacts";
import { useParentFallbackMap } from "@/hooks/queries/use-entity-links";
import { useExternalLinks } from "@/hooks/queries/use-external-links";
import { useProjectTree } from "@/hooks/queries/use-project-tree";
import type { ArtifactColumn } from "@/hooks/use-column-visibility";
import { useGroupExpansion } from "@/hooks/use-group-expansion";
import { useSortParams } from "@/hooks/use-sort-params";
import { matchesFilter } from "@/lib/artifact-filter";
import { comparePriorityValues } from "@/lib/priority-sort";
import { ARTIFACT_STATUS_LABELS } from "@/lib/project-constants";
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
  /** Apply project-level filters (assignee, status, priority, date) to root items. */
  applyProjectFilters?: (items: ArtifactRowItem[]) => ArtifactRowItem[];
  /** Whether any project filter is currently active. */
  isFilterActive?: boolean;
  /** Callback to clear all project filters. */
  onClearFilters?: () => void;
  /** Whether to group items by their status. */
  groupByStatus?: boolean;
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
    const q = filterText.toLowerCase().trim();
    return (
      f.title.toLowerCase().includes(q) || f.slug.toLowerCase().includes(q)
    );
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

// ---- Status grouping ----

/** Fixed display order matching the ArtifactStatus enum. */
const STATUS_DISPLAY_ORDER: ArtifactStatus[] = [
  ArtifactStatus.Draft,
  ArtifactStatus.InProgress,
  ArtifactStatus.InReview,
  ArtifactStatus.Approved,
  ArtifactStatus.Executed,
  ArtifactStatus.Done,
  ArtifactStatus.Obsolete,
];

type StatusSection = {
  status: ArtifactStatus;
  label: string;
  groups: DisplayGroup[];
};

function getItemStatus(item: ArtifactRowItem): string {
  return item.data.status;
}

function groupDisplayGroupsByStatus(groups: DisplayGroup[]): StatusSection[] {
  const buckets = new Map<ArtifactStatus, DisplayGroup[]>();

  for (const group of groups) {
    const status = getItemStatus(group.root) as ArtifactStatus;
    if (!buckets.has(status)) {
      buckets.set(status, []);
    }
    buckets.get(status)?.push(group);
  }

  const sections: StatusSection[] = [];
  for (const status of STATUS_DISPLAY_ORDER) {
    const sectionGroups = buckets.get(status);
    if (sectionGroups && sectionGroups.length > 0) {
      sections.push({
        status,
        label: ARTIFACT_STATUS_LABELS[status],
        groups: sectionGroups,
      });
    }
  }

  return sections;
}

function groupFlatItemsByStatus(items: ArtifactRowItem[]): StatusSection[] {
  const buckets = new Map<ArtifactStatus, ArtifactRowItem[]>();

  for (const item of items) {
    const status = getItemStatus(item) as ArtifactStatus;
    if (!buckets.has(status)) {
      buckets.set(status, []);
    }
    buckets.get(status)?.push(item);
  }

  const sections: StatusSection[] = [];
  for (const status of STATUS_DISPLAY_ORDER) {
    const sectionItems = buckets.get(status);
    if (sectionItems && sectionItems.length > 0) {
      sections.push({
        status,
        label: ARTIFACT_STATUS_LABELS[status],
        groups: sectionItems.map((item) => ({
          groupKey: item.data.id,
          root: item,
          children: [],
        })),
      });
    }
  }

  return sections;
}

function flattenStatusSections(
  sections: StatusSection[],
  isGroupedView: boolean,
  isGroupExpanded: (key: string) => boolean
): ArtifactRowItem[] {
  const items: ArtifactRowItem[] = [];
  for (const section of sections) {
    for (const group of section.groups) {
      items.push(group.root);
      if (isGroupedView && isGroupExpanded(group.groupKey)) {
        items.push(...group.children);
      }
    }
  }
  return items;
}

function flattenDisplayGroups(
  groups: DisplayGroup[],
  isGroupExpanded: (key: string) => boolean
): ArtifactRowItem[] {
  const items: ArtifactRowItem[] = [];
  for (const group of groups) {
    items.push(group.root);
    if (isGroupExpanded(group.groupKey)) {
      items.push(...group.children);
    }
  }
  return items;
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
  applyProjectFilters,
  isFilterActive,
  onClearFilters,
  groupByStatus = false,
}: ArtifactsViewProps) {
  const { isExpanded: isGroupExpanded, toggleGroup } = useGroupExpansion(
    `table:expand:project-artifacts:${projectId}`
  );
  const { isExpanded: isStatusExpanded, toggleGroup: toggleStatusSection } =
    useGroupExpansion(`table:expand:project-status-sections:${projectId}`, {
      defaultExpanded: true,
    });
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
  const [moveEntities, setMoveEntities] = useState<
    { id: string; entityType: EntityType; projectId?: string | null }[]
  >([]);
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
  const canBulkMove =
    filterCategory === "documents" ||
    filterCategory === "features" ||
    filterCategory === "plans";

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

    // Apply project filters to root items — children are preserved regardless
    const filtered = applyProjectFilters
      ? ungrouped.filter((g) => applyProjectFilters([g.root]).length > 0)
      : ungrouped;

    if (!sortBy) {
      return filtered;
    }
    const config = ITEM_SORT_CONFIGS[sortBy];
    if (!config?.comparator) {
      return filtered;
    }
    const { comparator } = config;
    const dirMultiplier = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort(
      (a, b) => comparator(a.root, b.root) * dirMultiplier
    );
  }, [
    filteredArtifacts,
    filteredFeatures,
    sortBy,
    sortDir,
    treeData,
    applyProjectFilters,
  ]);

  // Build flat items for filtered views
  const flatItems: ArtifactRowItem[] = useMemo(() => {
    let items: ArtifactRowItem[] = [
      ...filteredArtifacts.map(
        (a): ArtifactRowItem => ({ kind: "artifact", data: a })
      ),
      ...filteredFeatures.map(
        (f): ArtifactRowItem => ({ kind: "feature", data: f })
      ),
    ];
    // Apply project filters (assignee, status, priority, date)
    if (applyProjectFilters) {
      items = applyProjectFilters(items);
    }
    if (sortBy) {
      const config = ITEM_SORT_CONFIGS[sortBy];
      if (config) {
        return sortTableData(items, sortBy, ITEM_SORT_CONFIGS, sortDir);
      }
    }
    return items;
  }, [
    filteredArtifacts,
    filteredFeatures,
    sortBy,
    sortDir,
    applyProjectFilters,
  ]);

  // Build status sections when groupByStatus is enabled
  const statusSections: StatusSection[] = useMemo(() => {
    if (!groupByStatus) {
      return [];
    }
    if (isGroupedView) {
      return groupDisplayGroupsByStatus(groups);
    }
    return groupFlatItemsByStatus(flatItems);
  }, [groupByStatus, isGroupedView, groups, flatItems]);

  const renderedItems = useMemo((): ArtifactRowItem[] => {
    if (groupByStatus) {
      return flattenStatusSections(
        statusSections,
        isGroupedView,
        isGroupExpanded
      );
    }
    if (!isGroupedView) {
      return flatItems;
    }
    return flattenDisplayGroups(groups, isGroupExpanded);
  }, [
    groupByStatus,
    statusSections,
    isGroupedView,
    flatItems,
    groups,
    isGroupExpanded,
  ]);

  // When a child entity is moved to a different project, it leaves its parent's
  // project tree (parentMap is built from the current project's tree). To keep
  // the "Parent" column populated after a cross-project move, we query
  // entity-links for any item not already in parentMap and build a fallback
  // that surfaces the parent's title and href in the new project's table.
  const parentFallbackItems = useMemo(
    () =>
      renderedItems
        .filter((item) => !parentMap.has(item.data.id))
        .map((item) => ({
          id: item.data.id,
          entityType:
            item.kind === "feature" ? EntityType.Feature : EntityType.Artifact,
        })),
    [renderedItems, parentMap]
  );

  const fallbackParentMap = useParentFallbackMap(parentFallbackItems);

  const combinedParentMap = useMemo(() => {
    const map = new Map(parentMap);
    for (const [childId, parentInfo] of fallbackParentMap) {
      if (!map.has(childId)) {
        map.set(childId, parentInfo);
      }
    }
    return map;
  }, [parentMap, fallbackParentMap]);

  const isSourceEmpty =
    filteredArtifacts.length === 0 && filteredFeatures.length === 0;
  const isPostFilterEmpty = renderedItems.length === 0;
  const shouldShowEmptyState =
    isSourceEmpty || (isFilterActive === true && isPostFilterEmpty);
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
    // Use the full, unfiltered tree data to find children so that active
    // view filters (e.g. "Documents only") do not hide children of a
    // different type and cause them to be left behind during a move.
    if (treeData) {
      const treeNode = treeData.nodes.find((n) => n.root.id === item.data.id);
      if (treeNode && treeNode.children.length > 0) {
        const rootEntityType =
          item.kind === "artifact" ? EntityType.Artifact : EntityType.Feature;
        const rootProjectId =
          item.kind === "artifact" || item.kind === "feature"
            ? item.data.projectId
            : undefined;
        setMoveEntities([
          {
            id: item.data.id,
            entityType: rootEntityType,
            projectId: rootProjectId,
          },
          ...treeNode.children.map((child) => ({
            id: child.id,
            entityType: child.entityType,
          })),
        ]);
        setMenuState(null);
        return;
      }
    }

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

  function handleRequestBulkMove() {
    const entitiesToMove: {
      id: string;
      entityType: EntityType;
      projectId?: string | null;
    }[] = [];

    for (const id of selectedIds) {
      const artifact = artifacts.find((a) => a.id === id);
      if (artifact) {
        entitiesToMove.push({
          id: artifact.id,
          entityType: EntityType.Artifact,
          projectId: artifact.projectId,
        });
        continue;
      }

      const feature = features.find((f) => f.id === id);
      if (feature) {
        entitiesToMove.push({
          id: feature.id,
          entityType: EntityType.Feature,
          projectId: feature.projectId,
        });
      }
    }

    if (entitiesToMove.length > 0) {
      setMoveEntities(entitiesToMove);
    }
  }

  // ---- Branches: render ExternalLinks instead of artifacts ----

  if (filterCategory === "branches") {
    return <BranchesList projectId={projectId} />;
  }

  // ---- Empty state ----

  if (shouldShowEmptyState) {
    return (
      <ArtifactsEmptyState
        hasAnyItems={hasAnyItems}
        isFilterActive={isFilterActive}
        onClearFilters={onClearFilters}
      />
    );
  }

  // ---- Table body rendering (extracted to avoid nested ternaries) ----

  function renderTableBody() {
    if (groupByStatus) {
      return statusSections.map((section) => {
        const sectionOpen = isStatusExpanded(section.status);
        return (
          <div key={section.status}>
            <StatusSectionHeader
              count={section.groups.length}
              isOpen={sectionOpen}
              label={section.label}
              onToggle={() => toggleStatusSection(section.status)}
              status={section.status}
            />
            {sectionOpen &&
              section.groups.map((group) =>
                isGroupedView ? (
                  <TreeGroupRows
                    combinedParentMap={combinedParentMap}
                    editHandlers={editHandlers}
                    group={group}
                    handleMoreMenu={handleMoreMenu}
                    handleSelectionChange={handleSelectionChange}
                    isGroupExpanded={isGroupExpanded}
                    key={group.groupKey}
                    selectedIds={selectedIds}
                    toggleGroup={toggleGroup}
                    visibleColumns={visibleColumns}
                  />
                ) : (
                  <ArtifactRow
                    editHandlers={editHandlers}
                    isSelected={selectedIds.has(group.root.data.id)}
                    item={group.root}
                    key={group.root.data.id}
                    onMoreMenu={handleMoreMenu}
                    onSelectionChange={handleSelectionChange}
                    parentHref={combinedParentMap.get(group.root.data.id)?.href}
                    parentTitle={
                      combinedParentMap.get(group.root.data.id)?.title
                    }
                    showCheckbox={showCheckbox}
                    visibleColumns={visibleColumns}
                  />
                )
              )}
          </div>
        );
      });
    }

    if (isGroupedView) {
      return groups.map((group) => (
        <TreeGroupRows
          combinedParentMap={combinedParentMap}
          editHandlers={editHandlers}
          group={group}
          handleMoreMenu={handleMoreMenu}
          handleSelectionChange={handleSelectionChange}
          isGroupExpanded={isGroupExpanded}
          key={group.groupKey}
          selectedIds={selectedIds}
          toggleGroup={toggleGroup}
          visibleColumns={visibleColumns}
        />
      ));
    }

    return flatItems.map((item) => (
      <ArtifactRow
        editHandlers={editHandlers}
        isSelected={selectedIds.has(item.data.id)}
        item={item}
        key={item.data.id}
        onMoreMenu={handleMoreMenu}
        onSelectionChange={handleSelectionChange}
        parentHref={combinedParentMap.get(item.data.id)?.href}
        parentTitle={combinedParentMap.get(item.data.id)?.title}
        showCheckbox={showCheckbox}
        visibleColumns={visibleColumns}
      />
    ));
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
        {renderTableBody()}

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
                {canBulkMove && (
                  <Button
                    className="h-8 text-xs"
                    onClick={handleRequestBulkMove}
                    size="sm"
                    variant="outline"
                  >
                    <Layers2Icon className="h-4 w-4" />
                    Move to Project
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
              <Layers2Icon className="h-4 w-4" />
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
      {moveEntities.length > 0 && (
        <MoveEntityDialog
          currentProjectId={projectId}
          entities={moveEntities}
          onOpenChange={(open) => {
            if (!open) {
              setMoveEntities([]);
            }
          }}
          onSuccess={() => {
            setSelectedIds(new Set());
            setMoveEntities([]);
          }}
          open={moveEntities.length > 0}
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

// ---- Tree group rows (shared between grouped and status-grouped views) ----

function TreeGroupRows({
  group,
  editHandlers,
  isGroupExpanded,
  toggleGroup,
  selectedIds,
  handleSelectionChange,
  handleMoreMenu,
  combinedParentMap,
  visibleColumns,
}: {
  group: DisplayGroup;
  editHandlers?: RowEditHandlers;
  isGroupExpanded: (key: string) => boolean;
  toggleGroup: (key: string) => void;
  selectedIds: Set<string>;
  handleSelectionChange: (id: string, checked: boolean) => void;
  handleMoreMenu: (item: ArtifactRowItem, anchor: HTMLElement) => void;
  combinedParentMap: Map<string, { title: string; href: string | null }>;
  visibleColumns: ArtifactColumn[];
}) {
  const { root, children } = group;
  const isOpen = isGroupExpanded(group.groupKey);
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
          hasChildren ? () => toggleGroup(group.groupKey) : undefined
        }
        parentHref={combinedParentMap.get(root.data.id)?.href}
        parentTitle={combinedParentMap.get(root.data.id)?.title}
        showCheckbox={false}
        visibleColumns={visibleColumns}
      />
      {isOpen &&
        children.map((child, childIndex) => (
          <ArtifactRow
            editHandlers={editHandlers}
            extendIndentedBottomBorderLeft={childIndex === children.length - 1}
            indented
            isSelected={selectedIds.has(child.data.id)}
            item={child}
            key={child.data.id}
            onMoreMenu={handleMoreMenu}
            onSelectionChange={handleSelectionChange}
            parentHref={combinedParentMap.get(child.data.id)?.href}
            parentTitle={combinedParentMap.get(child.data.id)?.title}
            showCheckbox={false}
            visibleColumns={visibleColumns}
          />
        ))}
    </div>
  );
}

// ---- Branches list (ExternalLinks with type=PULL_REQUEST) ----

function BranchesList({ projectId }: { projectId: string }) {
  const { data: links, isLoading } = useExternalLinks({
    projectId,
    type: "PULL_REQUEST",
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!links || links.length === 0) {
    return (
      <EmptyState
        description="No pull requests linked to this project yet."
        icon={GitPullRequestIcon}
        title="No branches"
      />
    );
  }

  return (
    <div className="flex flex-col">
      {links.map((link) => (
        <Link
          className="flex items-center gap-3 border-border border-b px-4 py-3 transition-colors hover:bg-accent/50"
          href={`/build/${link.id}`}
          key={link.id}
        >
          <GitPullRequestIcon className="h-4 w-4 shrink-0 text-emerald-500" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate font-medium text-foreground text-sm">
              {link.title}
            </span>
            <span className="truncate text-muted-foreground text-xs">
              {link.externalUrl}
            </span>
          </div>
          <ExternalLinkIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Link>
      ))}
    </div>
  );
}

function ArtifactsEmptyState({
  hasAnyItems,
  isFilterActive,
  onClearFilters,
}: {
  hasAnyItems: boolean;
  isFilterActive?: boolean;
  onClearFilters?: () => void;
}) {
  if (!hasAnyItems) {
    return (
      <EmptyState
        description="Create a PRD, feature, or plan to get started."
        icon={FileTextIcon}
        title="No artifacts yet"
      />
    );
  }
  if (isFilterActive) {
    return (
      <EmptyState
        action={
          onClearFilters ? (
            <Button onClick={onClearFilters} size="sm" variant="outline">
              Clear filters
            </Button>
          ) : undefined
        }
        description="Try adjusting your filters or search term."
        icon={FilterXIcon}
        title="No items match your filters"
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
