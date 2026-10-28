// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenericArtifact } from "../../fixtures";
import type {
  ArtifactHierarchySpec,
  ArtifactManualMoveDirection,
  ArtifactProjectMoveConfig,
} from "../artifact-hierarchy-view";
import { useArtifactHierarchyView } from "../artifact-hierarchy-view";
import {
  artifactIds,
  lastToast,
  listRow,
  renderControlledListController,
  renderListController,
} from "./support/list-controller-harness";

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: toastSuccess },
}));

const UNDO = "Undo";
const deepHierarchy: ArtifactHierarchySpec = { maxVisibleLevels: 4 };
const shallowHierarchy: ArtifactHierarchySpec = { maxVisibleLevels: 2 };

const projectMove: ArtifactProjectMoveConfig = {
  currentProject: { id: "home", label: "Home" },
  destinations: [{ id: "elsewhere", label: "Elsewhere" }],
};

function child(id: string, parentArtifactId: string): GenericArtifact {
  return listRow(id, { parentArtifactId });
}

function renderManual(artifacts: GenericArtifact[], hierarchy = deepHierarchy) {
  return renderControlledListController({
    artifacts,
    hierarchy,
    manualOrdering: true,
    onOpenArtifact: vi.fn(),
  });
}

function visibleOrder(
  result: ReturnType<typeof renderListController>["result"]
): readonly string[] {
  return artifactIds(result.current.hierarchyView.orderedArtifacts);
}

async function moveArtifact(
  result: ReturnType<typeof renderManual>["result"],
  artifactId: string,
  direction: ArtifactManualMoveDirection
) {
  await act(async () => {
    result.current.moveArtifactManually(artifactId, direction);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("list controller manual ordering", () => {
  it("opens parents after the first populated load and preserves explicit collapse", () => {
    const { result, rerender } = renderHook(
      ({ artifacts }: { artifacts: GenericArtifact[] }) =>
        useArtifactHierarchyView({
          artifacts,
          compareArtifacts: (left, right) => left.id.localeCompare(right.id),
          filteredArtifacts: artifacts,
          filtersActive: false,
          hierarchy: { maxVisibleLevels: 4 },
          sortActive: false,
        }),
      { initialProps: { artifacts: [] as GenericArtifact[] } }
    );
    expect(result.current.rows).toHaveLength(0);

    const artifacts = [listRow("p"), child("c", "p")];
    rerender({ artifacts });
    expect(result.current.isExpanded("p")).toBe(true);
    expect(artifactIds(result.current.orderedArtifacts)).toEqual(["p", "c"]);

    act(() => result.current.toggleExpanded("p"));
    rerender({ artifacts });
    expect(result.current.isExpanded("p")).toBe(false);
    expect(artifactIds(result.current.orderedArtifacts)).toEqual(["p"]);
  });

  it("is active only while manual ordering is on and no sort is applied", () => {
    const off = renderListController({
      artifacts: [listRow("p")],
      hierarchy: deepHierarchy,
      onOpenArtifact: vi.fn(),
    }).result;
    expect(off.current.manualOrderingActive).toBe(false);

    const { result } = renderManual([listRow("p")]);
    expect(result.current.manualOrderingActive).toBe(true);

    act(() => result.current.setSortActive(true));
    expect(result.current.manualOrderingActive).toBe(false);
  });

  it("does nothing when the row has no neighbour in that direction", async () => {
    const { result } = renderManual([listRow("p"), listRow("q")]);

    await moveArtifact(result, "p", "up");
    await moveArtifact(result, "q", "down");
    await moveArtifact(result, "p", "out");
    await moveArtifact(result, "missing", "down");

    expect(visibleOrder(result)).toEqual(["p", "q"]);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("reorders siblings silently and keeps a moved parent's children with it", async () => {
    const { result } = renderManual([
      listRow("p"),
      child("c", "p"),
      listRow("q"),
    ]);
    expect(visibleOrder(result)).toEqual(["p", "c", "q"]);

    await moveArtifact(result, "p", "down");

    expect(visibleOrder(result)).toEqual(["q", "p", "c"]);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("announces a re-parent and restores the tree through Undo", async () => {
    const { result } = renderManual([listRow("p"), listRow("q")]);

    await moveArtifact(result, "q", "in");

    expect(
      result.current.artifacts.find((artifact) => artifact.id === "q")
        ?.parentArtifactId
    ).toBe("p");
    expect(result.current.hierarchyView.isExpanded("p")).toBe(true);
    expect(lastToast(toastSuccess)).toMatchObject({
      actionLabel: UNDO,
      message: "Moved",
    });

    await act(async () => {
      lastToast(toastSuccess).undo?.();
      await Promise.resolve();
    });
    expect(
      result.current.artifacts.find((artifact) => artifact.id === "q")
        ?.parentArtifactId
    ).toBeNull();
    expect(visibleOrder(result)).toEqual(["p", "q"]);
  });

  it("opens the new parent when a row moves into it while another parent is open", async () => {
    const { result } = renderManual([
      listRow("x"),
      child("xc", "x"),
      listRow("p"),
      listRow("q"),
    ]);

    await moveArtifact(result, "q", "in");

    expect(result.current.hierarchyView.isExpanded("p")).toBe(true);
    expect(visibleOrder(result)).toEqual(["x", "xc", "p", "q"]);
  });

  it("leaves a collapsed sibling collapsed when a row moves past it", async () => {
    const { result } = renderManual([
      listRow("x"),
      child("xc", "x"),
      listRow("a"),
      listRow("b"),
      child("bc", "b"),
    ]);
    act(() => result.current.hierarchyView.toggleExpanded("b"));
    expect(visibleOrder(result)).toEqual(["x", "xc", "a", "b"]);

    await moveArtifact(result, "a", "down");

    expect(result.current.hierarchyView.isExpanded("b")).toBe(false);
    expect(visibleOrder(result)).toEqual(["x", "xc", "b", "a"]);
  });

  it("preserves an explicit all-collapsed choice after a reorder", async () => {
    const { result } = renderManual([
      listRow("x"),
      child("xc", "x"),
      listRow("a"),
      listRow("b"),
      child("bc", "b"),
    ]);
    act(() => result.current.hierarchyView.toggleExpanded("x"));
    act(() => result.current.hierarchyView.toggleExpanded("b"));
    expect(result.current.hierarchyView.isExpanded("x")).toBe(false);
    expect(result.current.hierarchyView.isExpanded("b")).toBe(false);
    expect(visibleOrder(result)).toEqual(["x", "a", "b"]);

    await moveArtifact(result, "a", "down");

    expect(visibleOrder(result)).toEqual(["x", "b", "a"]);
    expect(result.current.hierarchyView.isExpanded("x")).toBe(false);
    expect(result.current.hierarchyView.isExpanded("b")).toBe(false);
  });

  it("moves a child out beside its parent", async () => {
    const { result } = renderManual([listRow("p"), child("c", "p")]);

    await moveArtifact(result, "c", "out");

    expect(visibleOrder(result)).toEqual(["p", "c"]);
    expect(
      result.current.artifacts.find((artifact) => artifact.id === "c")
        ?.parentArtifactId
    ).toBeNull();
    expect(lastToast(toastSuccess).message).toBe("Moved");
  });

  it("counts the descendants that travel with a re-parented row", async () => {
    const one = renderManual([
      listRow("q"),
      listRow("p"),
      child("c", "p"),
    ]).result;
    await moveArtifact(one, "p", "in");
    expect(lastToast(toastSuccess).message).toBe("Moved with 1 descendant");

    const two = renderManual([
      listRow("q"),
      listRow("p"),
      child("c1", "p"),
      child("c2", "p"),
    ]).result;
    await moveArtifact(two, "p", "in");
    expect(lastToast(toastSuccess).message).toBe("Moved with 2 descendants");
  });

  it("refuses a move that would nest past the visible depth without telling the host", async () => {
    const onArtifactsChange = vi.fn();
    const { result } = renderListController({
      artifacts: [listRow("q"), listRow("p"), child("c", "p")],
      hierarchy: shallowHierarchy,
      manualOrdering: true,
      onArtifactsChange,
      onOpenArtifact: vi.fn(),
    });

    act(() => result.current.moveArtifactManually("p", "in"));
    await Promise.resolve();

    expect(onArtifactsChange).not.toHaveBeenCalled();

    expect(
      result.current.artifacts.find((artifact) => artifact.id === "p")
        ?.parentArtifactId
    ).toBeNull();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("list controller project moves", () => {
  function renderProject(artifacts: GenericArtifact[], configured = true) {
    return renderListController({
      artifacts,
      hierarchy: deepHierarchy,
      onOpenArtifact: vi.fn(),
      projectMove: configured ? projectMove : undefined,
    });
  }

  it("does nothing without a project move config or a selection", () => {
    const unconfigured = renderProject([listRow("q")], false).result;
    act(() => unconfigured.current.setSelectedArtifactIds(new Set(["q"])));
    act(() => unconfigured.current.moveSelectionToProject("Elsewhere"));
    expect(artifactIds(unconfigured.current.artifacts)).toEqual(["q"]);

    const unselected = renderProject([listRow("q")]).result;
    act(() => unselected.current.moveSelectionToProject("Elsewhere"));
    expect(artifactIds(unselected.current.artifacts)).toEqual(["q"]);

    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("removes the moved rows, clears the selection, and restores them through Undo", () => {
    const { result } = renderProject([listRow("p"), listRow("q")]);
    act(() => result.current.setSelectedArtifactIds(new Set(["q"])));

    act(() => result.current.moveSelectionToProject("Elsewhere"));

    expect(artifactIds(result.current.artifacts)).toEqual(["p"]);
    expect(result.current.selectedArtifactIds.size).toBe(0);
    expect(lastToast(toastSuccess)).toMatchObject({
      actionLabel: UNDO,
      description: "",
      message: "Moved 1 to Elsewhere",
    });

    act(() => lastToast(toastSuccess).undo?.());
    expect(artifactIds(result.current.artifacts)).toEqual(["p", "q"]);
  });

  it("describes promoted children and carried descendants", () => {
    const carried = renderProject([listRow("p"), child("c", "p")]).result;
    act(() => carried.current.setSelectedArtifactIds(new Set(["p"])));
    act(() => carried.current.moveSelectionToProject("Elsewhere"));
    expect(lastToast(toastSuccess)).toMatchObject({
      description: "1 descendant carried",
      message: "Moved 2 to Elsewhere",
    });

    const both = renderProject([
      listRow("p"),
      child("c1", "p"),
      child("c2", "p"),
      listRow("q"),
      child("d", "q"),
    ]).result;
    act(() => both.current.setSelectedArtifactIds(new Set(["p", "d"])));
    act(() => both.current.moveSelectionToProject("Elsewhere"));
    expect(lastToast(toastSuccess)).toMatchObject({
      description: "1 promoted to root · 2 descendants carried",
      message: "Moved 4 to Elsewhere",
    });
    expect(artifactIds(both.current.artifacts)).toEqual(["q"]);
  });
});
