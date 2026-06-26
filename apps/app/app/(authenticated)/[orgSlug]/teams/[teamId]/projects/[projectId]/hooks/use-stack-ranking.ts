"use client";

import type { DragEndEvent } from "@dnd-kit/core";
import { MovePosition } from "@repo/api/src/types/project-artifact-move";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import type { DisplayGroup } from "@repo/app/documents/components/table/document-tree";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import { resolveDragMove } from "@repo/app/documents/components/table/rank-drag-helpers";
import {
  getRankInteractionMode,
  RankInteractionMode,
  type SortKey,
} from "@repo/app/documents/components/table/sort-keys";
import type { GroupByMode } from "@repo/app/documents/lib/group-by";
import { useMoveArtifact } from "@repo/app/projects/hooks/use-project-tree";

type UseStackRankingInput = {
  /**
   * Whether the `stack-rank-project-page` flag is on. Computed by the caller
   * because the same value also drives the page's default sort column, which
   * is resolved before this hook runs.
   */
  isStackRankEnabled: boolean;
  projectId: string | undefined;
  filterCategory: FilterCategory;
  sortBy: SortKey | null;
  groupBy: GroupByMode;
  /** True when the current view is the "all" tree projection. */
  isGroupedView: boolean;
  /** Root groups backing the "all" view — the rank-order source. */
  groups: DisplayGroup[];
  /** Flat row list backing the category views. */
  flatItems: DocumentRowItem[];
  /** Final ordered row list, used to resolve drag before/after slots. */
  renderedItems: DocumentRowItem[];
};

type UseStackRankingResult = {
  /** Row-level rank-interaction state, or undefined off the rank surface. */
  rankInteractionMode: RankInteractionMode | undefined;
  /** True when drag-reorder and the Move-to-top/bottom actions are live. */
  isDndEnabled: boolean;
  /** Ordered root ids the `SortableContext` should track. */
  rankItemIds: string[];
  /** Whether a row should be offered the Move-to-top/bottom menu items. */
  isRankableMenuItem: (item: DocumentRowItem) => boolean;
  moveToTop: (item: DocumentRowItem) => void;
  moveToBottom: (item: DocumentRowItem) => void;
  handleDragEnd: (event: DragEndEvent) => void;
};

/**
 * PLN-755 (PRD-421): all stack-rank interaction state and actions for the
 * project page, extracted from `DocumentsView` so the component stays an
 * orchestrator. Derives the rank-interaction mode from `(sortBy, groupBy)`,
 * owns the `useMoveArtifact` mutation, and exposes the drag / Move-to-top /
 * Move-to-bottom handlers plus the predicates the render path needs.
 *
 * Restricted to the "all" (tree) view. Stack rank is a whole-project,
 * root-only ordering, and only the tree projection renders off the
 * `projectTreeKeys` cache that `useMoveArtifact` splices. The flat category
 * views (documents/features/plans) render off the `documents` prop
 * (`documentKeys.list`, untouched by the move) and include non-root children,
 * so a drag there would persist server-side but never reorder visually — the
 * row would snap back. Keep the affordance where it is coherent and correctly
 * reflected.
 */
export function useStackRanking(
  input: UseStackRankingInput
): UseStackRankingResult {
  const {
    isStackRankEnabled,
    projectId,
    filterCategory,
    sortBy,
    groupBy,
    isGroupedView,
    groups,
    flatItems,
    renderedItems,
  } = input;

  const isRankSurface =
    isStackRankEnabled && !!projectId && filterCategory === "all";
  const rankInteractionMode: RankInteractionMode | undefined = isRankSurface
    ? getRankInteractionMode(sortBy, groupBy)
    : undefined;
  const isDndEnabled =
    isRankSurface && rankInteractionMode === RankInteractionMode.Enabled;

  // `useMoveArtifact` only POSTs in single-project mode; when `projectId` is
  // absent `isDndEnabled` is false, so the handlers short-circuit before the
  // mutation ever fires against the placeholder id.
  const moveArtifactMutation = useMoveArtifact(projectId ?? "");

  const rankItemIds = resolveRankItemIds({
    isDndEnabled,
    isGroupedView,
    groups,
    flatItems,
  });
  const rankableRootIds = new Set(rankItemIds);

  function moveToTop(item: DocumentRowItem) {
    if (!isDndEnabled) {
      return;
    }
    moveArtifactMutation.mutate({
      artifactId: item.data.id,
      position: MovePosition.Top,
    });
  }

  function moveToBottom(item: DocumentRowItem) {
    if (!isDndEnabled) {
      return;
    }
    moveArtifactMutation.mutate({
      artifactId: item.data.id,
      position: MovePosition.Bottom,
    });
  }

  // dnd-kit reports `active` (dragged row) and `over` (row underneath);
  // `resolveDragMove` translates that into a before/after slot relative to
  // `over` using the current ordered id list. Server is source of truth on
  // settle; the optimistic splice handles the immediate reorder.
  function handleDragEnd(event: DragEndEvent) {
    if (!isDndEnabled) {
      return;
    }
    const move = resolveDragMove(event, renderedItems);
    if (!move) {
      return;
    }
    moveArtifactMutation.mutate(move);
  }

  return {
    rankInteractionMode,
    isDndEnabled,
    rankItemIds,
    isRankableMenuItem: (item) => isRankableMenuItem(item, rankableRootIds),
    moveToTop,
    moveToBottom,
    handleDragEnd,
  };
}

/**
 * Resolve the ordered list of ROOT artifact ids the `SortableContext` should
 * track. Empty when DnD is disabled, the grouped-tree projection (`groups`)
 * for the "all" view, or the flat filtered list otherwise.
 */
function resolveRankItemIds(input: {
  isDndEnabled: boolean;
  isGroupedView: boolean;
  groups: DisplayGroup[];
  flatItems: DocumentRowItem[];
}): string[] {
  if (!input.isDndEnabled) {
    return [];
  }
  if (input.isGroupedView) {
    return input.groups.map((g) => g.root.data.id);
  }
  return input.flatItems.map((i) => i.data.id);
}

function isRankableMenuItem(
  item: DocumentRowItem,
  rankableRootIds: ReadonlySet<string>
): boolean {
  // Stack rank is a type-agnostic root ordering (`sortOrder` lives on the
  // artifact row), so every artifact kind that can be a tree root — document,
  // branch, session — gets the Move-to-top/bottom actions; this matches the
  // drag handle, which `SortableTreeGroup` already renders on every root.
  if (item.kind === "project") {
    return false;
  }
  // Only root artifacts participate in stack rank; nested children share the
  // same kinds but must not be offered Move-to-top / Move-to-bottom.
  return rankableRootIds.has(item.data.id);
}
