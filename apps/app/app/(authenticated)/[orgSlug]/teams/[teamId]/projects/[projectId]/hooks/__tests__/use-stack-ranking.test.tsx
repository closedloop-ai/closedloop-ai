import type { DragEndEvent } from "@dnd-kit/core";
import { MovePosition } from "@repo/api/src/types/project-artifact-move";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import type { DisplayGroup } from "@repo/app/documents/components/table/document-tree";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import {
  RankInteractionMode,
  SortKey,
} from "@repo/app/documents/components/table/sort-keys";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mutate = vi.fn();

vi.mock("@repo/app/projects/hooks/use-project-tree", () => ({
  useMoveArtifact: () => ({ mutate }),
}));

import { useStackRanking } from "../use-stack-ranking";

// Minimal row/group fixtures — only `kind` and `data.id` are read by the hook.
function row(id: string, kind: DocumentRowItem["kind"] = "document") {
  return { kind, data: { id } } as DocumentRowItem;
}

function group(rootId: string): DisplayGroup {
  return { root: row(rootId), children: [] } as unknown as DisplayGroup;
}

function fakeDragEvent(activeId: string, overId: string): DragEndEvent {
  return {
    active: { id: activeId },
    over: { id: overId },
  } as unknown as DragEndEvent;
}

const ROOTS = [group("root-1"), group("root-2"), group("root-3")];

type Overrides = Partial<Parameters<typeof useStackRanking>[0]>;

function setup(overrides: Overrides = {}) {
  return renderHook(() =>
    useStackRanking({
      isStackRankEnabled: true,
      projectId: "proj-1",
      filterCategory: "all" as FilterCategory,
      sortBy: SortKey.StackRank,
      groupBy: GroupByMode.None,
      isGroupedView: true,
      groups: ROOTS,
      flatItems: [],
      renderedItems: [],
      ...overrides,
    })
  );
}

describe("useStackRanking (PLN-755)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("is off the rank surface when the flag is disabled", () => {
    const { result } = setup({ isStackRankEnabled: false });
    expect(result.current.rankInteractionMode).toBeUndefined();
    expect(result.current.isDndEnabled).toBe(false);
    expect(result.current.rankItemIds).toEqual([]);
    expect(result.current.isRankableMenuItem(row("root-1"))).toBe(false);
  });

  it("is off the rank surface outside the all/tree view", () => {
    const { result } = setup({
      filterCategory: "plans" as FilterCategory,
      isGroupedView: false,
    });
    expect(result.current.rankInteractionMode).toBeUndefined();
    expect(result.current.isDndEnabled).toBe(false);
  });

  it("is off the rank surface in multi-project mode (no projectId)", () => {
    const { result } = setup({ projectId: undefined });
    expect(result.current.isDndEnabled).toBe(false);
  });

  it("enables drag in the all view with stack-rank sort, ungrouped", () => {
    const { result } = setup();
    expect(result.current.rankInteractionMode).toBe(
      RankInteractionMode.Enabled
    );
    expect(result.current.isDndEnabled).toBe(true);
    expect(result.current.rankItemIds).toEqual(["root-1", "root-2", "root-3"]);
  });

  it("disables (but still reserves the slot) when grouping is active", () => {
    const { result } = setup({ groupBy: GroupByMode.Status });
    expect(result.current.rankInteractionMode).toBe(
      RankInteractionMode.DisabledGrouped
    );
    expect(result.current.isDndEnabled).toBe(false);
    expect(result.current.rankItemIds).toEqual([]);
  });

  it("hides the affordance when a column sort is active", () => {
    const { result } = setup({ sortBy: SortKey.Title });
    expect(result.current.rankInteractionMode).toBe(RankInteractionMode.Hidden);
    expect(result.current.isDndEnabled).toBe(false);
  });

  it("offers the menu for any artifact root, never for children or projects", () => {
    const { result } = setup();
    expect(result.current.isRankableMenuItem(row("root-1"))).toBe(true);
    // Non-root child id (not in the rank id set).
    expect(result.current.isRankableMenuItem(row("child-9"))).toBe(false);
    // Stack rank is type-agnostic: any artifact kind that is a root is
    // rankable (FEA-1763 Phase 2) — only project rows are excluded.
    expect(result.current.isRankableMenuItem(row("root-1", "branch"))).toBe(
      true
    );
    expect(result.current.isRankableMenuItem(row("root-1", "session"))).toBe(
      true
    );
    expect(result.current.isRankableMenuItem(row("root-1", "project"))).toBe(
      false
    );
  });

  it("moveToTop / moveToBottom dispatch the move when enabled", () => {
    const { result } = setup();
    result.current.moveToTop(row("root-2"));
    expect(mutate).toHaveBeenCalledWith({
      artifactId: "root-2",
      position: MovePosition.Top,
    });

    result.current.moveToBottom(row("root-2"));
    expect(mutate).toHaveBeenCalledWith({
      artifactId: "root-2",
      position: MovePosition.Bottom,
    });
  });

  it("move actions and drag are no-ops when disabled", () => {
    const { result } = setup({ sortBy: SortKey.Title });
    result.current.moveToTop(row("root-1"));
    result.current.moveToBottom(row("root-1"));
    result.current.handleDragEnd(fakeDragEvent("root-1", "root-2"));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("handleDragEnd resolves the drag and dispatches the move", () => {
    const { result } = setup({
      renderedItems: [row("a"), row("b"), row("c")],
    });
    // Drag a (index 0) onto c (index 2) → place a after c.
    result.current.handleDragEnd(fakeDragEvent("a", "c"));
    expect(mutate).toHaveBeenCalledWith({
      artifactId: "a",
      position: MovePosition.After,
      referenceArtifactId: "c",
    });
  });
});
