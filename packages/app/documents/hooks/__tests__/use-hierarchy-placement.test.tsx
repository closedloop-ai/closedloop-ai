// @vitest-environment jsdom

import type { DragEndEvent, DragMoveEvent } from "@dnd-kit/core";
import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import {
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { useHierarchyPlacement } from "@repo/app/documents/hooks/use-hierarchy-placement";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mutate, useFeatureFlagEnabledOptional } = vi.hoisted(() => ({
  mutate: vi.fn(),
  useFeatureFlagEnabledOptional: vi.fn(),
}));

vi.mock("@repo/app/projects/hooks/use-artifact-placement", () => ({
  useArtifactPlacement: () => ({ mutate }),
}));
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional,
}));

function row(id: string, children: DocumentRowItem[] = []): DocumentRowItem {
  return {
    kind: "document",
    data: { id },
    children,
  } as unknown as DocumentRowItem;
}

const CHILD_A = row("child-a");
const CHILD_B = row("child-b");
const CHILD_C = row("child-c");
const ROOT = row("root", [CHILD_A, CHILD_B, CHILD_C]);

describe("useHierarchyPlacement", () => {
  afterEach(() => {
    globalThis.document
      .querySelector("[data-sortable-subtree-id='child-b']")
      ?.remove();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    useFeatureFlagEnabledOptional.mockImplementation(
      (key: string) => key === MANUAL_ARTIFACT_ORDERING_FLAG_KEY
    );
  });

  it("AC-006 enables only the exact flag on an eligible project hierarchy", () => {
    const { result } = renderHook(() =>
      useHierarchyPlacement({
        projectId: "project-1",
        projectVersion: "project-version-1",
        currentOrderingEnabled: true,
        renderedItems: [ROOT, CHILD_A, CHILD_B, CHILD_C],
        selectedIds: new Set(),
        treeRoots: [ROOT],
      })
    );
    expect(useFeatureFlagEnabledOptional).toHaveBeenCalledWith(
      MANUAL_ARTIFACT_ORDERING_FLAG_KEY
    );
    expect(result.current.enabled).toBe(true);

    useFeatureFlagEnabledOptional.mockReturnValue(false);
    const disabled = renderHook(() =>
      useHierarchyPlacement({
        projectId: "project-1",
        projectVersion: "project-version-1",
        currentOrderingEnabled: true,
        renderedItems: [ROOT],
        selectedIds: new Set(),
        treeRoots: [ROOT],
      })
    );
    expect(disabled.result.current.enabled).toBe(false);
  });

  it("AC-010 sends selected rows in painted order through keyboard placement", () => {
    const { result } = renderHook(() =>
      useHierarchyPlacement({
        projectId: "project-1",
        projectVersion: "project-version-1",
        currentOrderingEnabled: true,
        renderedItems: [ROOT, CHILD_A, CHILD_B, CHILD_C],
        selectedIds: new Set(["child-a", "child-b"]),
        treeRoots: [ROOT],
      })
    );

    act(() => result.current.handleKeyboardPlacement("child-a", "down"));
    expect(mutate).toHaveBeenCalledWith(
      {
        sourceArtifactIds: ["child-a", "child-b"],
        destinationProjectId: "project-1",
        position: ProjectArtifactPlacementPosition.After,
        targetArtifactId: "child-c",
        expectedProjectVersions: { "project-1": "project-version-1" },
        source: ProjectArtifactPlacementSource.Keyboard,
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      })
    );

    const callbacks = mutate.mock.calls[0]?.[1] as {
      onSuccess: () => void;
      onError: () => void;
    };
    act(() => callbacks.onSuccess());
    expect(result.current.announcement).toBe("Moved");
    act(() => callbacks.onError());
    expect(result.current.announcement).toBe(
      "Failed to move items. Please try again."
    );
  });

  it("tracks pointer thirds within one hovered row and commits the same after placement", () => {
    const { result } = renderHook(() =>
      useHierarchyPlacement({
        projectId: "project-1",
        projectVersion: "project-version-1",
        currentOrderingEnabled: true,
        renderedItems: [ROOT, CHILD_A, CHILD_B, CHILD_C],
        selectedIds: new Set(),
        treeRoots: [ROOT],
      })
    );
    const eventAt = (y: number): DragMoveEvent =>
      ({
        active: {
          id: "child-a",
          rect: { current: { translated: { top: y, height: 1 } } },
        },
        over: { id: "child-b", rect: { top: 0, height: 90 } },
        activatorEvent: { type: "pointerdown", clientY: 0 },
        delta: { x: 0, y },
      }) as unknown as DragMoveEvent;

    act(() => result.current.handleDragMove(eventAt(10)));
    expect(result.current.preview?.position).toBe(
      ProjectArtifactPlacementPosition.Before
    );
    act(() => result.current.handleDragMove(eventAt(45)));
    expect(result.current.preview?.position).toBe(
      ProjectArtifactPlacementPosition.Inside
    );
    act(() => result.current.handleDragMove(eventAt(80)));
    expect(result.current.preview?.position).toBe(
      ProjectArtifactPlacementPosition.After
    );
    act(() => result.current.handleDragEnd(eventAt(80) as DragEndEvent));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetArtifactId: "child-b",
        position: ProjectArtifactPlacementPosition.After,
      }),
      expect.any(Object)
    );
  });

  it("uses the drop snapshot rather than a shifted DOM row for preview and commit", () => {
    const subtree = globalThis.document.createElement("div");
    subtree.dataset.sortableSubtreeId = "child-b";
    const rootRow = globalThis.document.createElement("div");
    rootRow.getBoundingClientRect = vi.fn(
      () => ({ top: 100, height: 60 }) as DOMRect
    );
    subtree.append(rootRow);
    globalThis.document.body.append(subtree);
    const { result } = renderHook(() =>
      useHierarchyPlacement({
        projectId: "project-1",
        projectVersion: "project-version-1",
        currentOrderingEnabled: true,
        renderedItems: [ROOT, CHILD_A, CHILD_B, CHILD_C],
        selectedIds: new Set(),
        treeRoots: [ROOT],
      })
    );
    const event = {
      active: { id: "child-a", rect: { current: { translated: null } } },
      over: { id: "child-b", rect: { top: 0, height: 120 } },
      activatorEvent: { type: "pointerdown", clientY: 0 },
      delta: { x: 0, y: 55 },
    } as unknown as DragMoveEvent;

    act(() => result.current.handleDragMove(event));
    expect(result.current.preview?.position).toBe(
      ProjectArtifactPlacementPosition.After
    );
    rootRow.getBoundingClientRect = vi.fn(
      () => ({ top: 200, height: 60 }) as DOMRect
    );
    act(() => result.current.handleDragEnd(event as DragEndEvent));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetArtifactId: "child-b",
        position: ProjectArtifactPlacementPosition.After,
      }),
      expect.any(Object)
    );
  });

  it("updates the indicator on each pointer event and commits the latest release band", () => {
    const { result } = renderHook(() =>
      useHierarchyPlacement({
        projectId: "project-1",
        projectVersion: "project-version-1",
        currentOrderingEnabled: true,
        renderedItems: [ROOT, CHILD_A, CHILD_B, CHILD_C],
        selectedIds: new Set(),
        treeRoots: [ROOT],
      })
    );
    const beforeEvent = {
      active: { id: "child-a", rect: { current: { translated: null } } },
      over: { id: "child-b", rect: { top: 0, height: 90 } },
      activatorEvent: { type: "pointerdown", clientY: 0 },
      delta: { x: 0, y: 10 },
    } as unknown as DragMoveEvent;
    const insideEvent = {
      active: { id: "child-a", rect: { current: { translated: null } } },
      over: { id: "child-b", rect: { top: 0, height: 90 } },
      activatorEvent: { type: "pointerdown", clientY: 0 },
      delta: { x: 0, y: 45 },
    } as unknown as DragMoveEvent;
    const releaseEvent = {
      active: { id: "child-a", rect: { current: { translated: null } } },
      over: { id: "child-b", rect: { top: 100, height: 30 } },
      activatorEvent: { type: "pointerdown", clientY: 0 },
      delta: { x: 0, y: 150 },
    } as unknown as DragEndEvent;

    act(() => result.current.handleDragOver(beforeEvent));
    expect(result.current.preview?.position).toBe(
      ProjectArtifactPlacementPosition.Before
    );
    act(() => result.current.handleDragMove(insideEvent));
    expect(result.current.preview?.position).toBe(
      ProjectArtifactPlacementPosition.Inside
    );
    act(() => result.current.handleDragEnd(releaseEvent));

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetArtifactId: "child-b",
        position: ProjectArtifactPlacementPosition.After,
      }),
      expect.any(Object)
    );
    expect(result.current.preview).toBeNull();
  });

  it("refreshes release placement when DragEnd outruns the preview render", () => {
    const { result } = renderHook(() =>
      useHierarchyPlacement({
        projectId: "project-1",
        projectVersion: "project-version-1",
        currentOrderingEnabled: true,
        renderedItems: [ROOT, CHILD_A, CHILD_B, CHILD_C],
        selectedIds: new Set(),
        treeRoots: [ROOT],
      })
    );
    const moveEvent = {
      active: { id: "child-a", rect: { current: { translated: null } } },
      over: { id: "child-b", rect: { top: 0, height: 90 } },
      activatorEvent: { type: "pointerdown", clientY: 0 },
      delta: { x: 0, y: 45 },
    } as unknown as DragMoveEvent;
    const releaseEvent = {
      active: { id: "child-a", rect: { current: { translated: null } } },
      over: { id: "child-b", rect: { top: 100, height: 30 } },
      activatorEvent: { type: "pointerdown", clientY: 0 },
      delta: { x: 0, y: 150 },
    } as unknown as DragEndEvent;

    act(() => {
      result.current.handleDragMove(moveEvent);
      result.current.handleDragEnd(releaseEvent);
    });

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetArtifactId: "child-b",
        position: ProjectArtifactPlacementPosition.After,
      }),
      expect.any(Object)
    );
  });

  it("uses the release target when the pointer leaves the previewed row", () => {
    const { result } = renderHook(() =>
      useHierarchyPlacement({
        projectId: "project-1",
        projectVersion: "project-version-1",
        currentOrderingEnabled: true,
        renderedItems: [ROOT, CHILD_A, CHILD_B, CHILD_C],
        selectedIds: new Set(),
        treeRoots: [ROOT],
      })
    );
    const previewEvent = {
      active: { id: "child-a", rect: { current: { translated: null } } },
      over: { id: "child-b", rect: { top: 0, height: 90 } },
      activatorEvent: { type: "pointerdown", clientY: 0 },
      delta: { x: 0, y: 45 },
    } as unknown as DragMoveEvent;
    const releaseEvent = {
      active: { id: "child-a", rect: { current: { translated: null } } },
      over: { id: "child-c", rect: { top: 0, height: 90 } },
      activatorEvent: { type: "pointerdown", clientY: 0 },
      delta: { x: 0, y: 10 },
    } as unknown as DragEndEvent;

    act(() => {
      result.current.handleDragMove(previewEvent);
      result.current.handleDragEnd(releaseEvent);
    });

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetArtifactId: "child-c",
        position: ProjectArtifactPlacementPosition.Before,
      }),
      expect.any(Object)
    );
  });

  it("rejects pointer drops onto a source descendant before requesting placement", () => {
    const { result } = renderHook(() =>
      useHierarchyPlacement({
        projectId: "project-1",
        projectVersion: "project-version-1",
        currentOrderingEnabled: true,
        renderedItems: [ROOT, CHILD_A, CHILD_B, CHILD_C],
        selectedIds: new Set(),
        treeRoots: [ROOT],
      })
    );
    const event = {
      active: { id: "root", rect: { current: { translated: null } } },
      over: { id: "child-a", rect: { top: 0, height: 90 } },
      activatorEvent: { type: "pointerdown", clientY: 0 },
      delta: { x: 0, y: 45 },
    } as unknown as DragMoveEvent;

    act(() => result.current.handleDragMove(event));
    expect(result.current.preview).toBeNull();
    act(() => result.current.handleDragEnd(event as DragEndEvent));
    expect(mutate).not.toHaveBeenCalled();
    expect(result.current.announcement).toBe("");
  });

  it("opens the destination after keyboard nesting so the moved handle stays reachable", () => {
    const onInsidePlaced = vi.fn();
    const { result } = renderHook(() =>
      useHierarchyPlacement({
        projectId: "project-1",
        projectVersion: "project-version-1",
        currentOrderingEnabled: true,
        renderedItems: [ROOT, CHILD_A, CHILD_B, CHILD_C],
        selectedIds: new Set(),
        treeRoots: [ROOT],
        onInsidePlaced,
      })
    );
    act(() => result.current.handleKeyboardPlacement("child-b", "in"));
    const [intent, callbacks] = mutate.mock.calls[0] ?? [];
    expect(intent).toEqual(
      expect.objectContaining({
        position: ProjectArtifactPlacementPosition.Inside,
        targetArtifactId: "child-a",
      })
    );
    act(() => callbacks?.onSuccess());
    expect(onInsidePlaced).toHaveBeenCalledWith("child-a");
  });

  it("excludes branch rows from placement sources, targets, and mixed selections", () => {
    const branch = {
      kind: "branch",
      data: { id: "branch" },
    } as unknown as DocumentRowItem;
    const session = {
      kind: "session",
      data: { id: "session" },
    } as unknown as DocumentRowItem;
    const { result } = renderHook(() =>
      useHierarchyPlacement({
        projectId: "project-1",
        projectVersion: "project-version-1",
        currentOrderingEnabled: true,
        renderedItems: [ROOT, CHILD_A, branch, session, CHILD_B],
        selectedIds: new Set(["child-a", "branch", "session"]),
        treeRoots: [ROOT, branch, session],
      })
    );
    const event = (activeId: string, targetId: string) =>
      ({
        active: { id: activeId, rect: { current: { translated: null } } },
        over: { id: targetId, rect: { top: 0, height: 90 } },
        activatorEvent: { type: "pointerdown", clientY: 0 },
        delta: { x: 0, y: 10 },
      }) as unknown as DragMoveEvent;

    expect(result.current.itemIds).toEqual(["root", "child-a", "child-b"]);
    expect(result.current.canDragRow(CHILD_A)).toBe(true);
    expect(result.current.canDragRow(branch)).toBe(false);
    expect(result.current.canDragRow(session)).toBe(false);
    expect(result.current.canDropOnRow(CHILD_A, branch, "before")).toBe(false);
    expect(result.current.canDropOnRow(branch, CHILD_B, "before")).toBe(false);
    expect(result.current.canDropOnRow(CHILD_A, session, "before")).toBe(false);
    expect(result.current.canDropOnRow(session, CHILD_B, "before")).toBe(false);
    act(() => result.current.handleDragMove(event("child-a", "branch")));
    expect(result.current.preview).toBeNull();
    act(() =>
      result.current.handleDragEnd(event("branch", "child-b") as DragEndEvent)
    );
    expect(mutate).not.toHaveBeenCalled();
    act(() =>
      result.current.handleDragEnd(event("child-a", "child-b") as DragEndEvent)
    );
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ sourceArtifactIds: ["child-a"] }),
      expect.any(Object)
    );
    act(() => result.current.handleKeyboardPlacement("branch", "down"));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("refuses inside preview and keyboard nesting beyond four visible levels", () => {
    const source = row("source");
    const target = row("target");
    const deepRoot = row("deep-root", [
      row("level-2", [row("level-3", [target, source])]),
    ]);
    const { result } = renderHook(() =>
      useHierarchyPlacement({
        projectId: "project-1",
        projectVersion: "project-version-1",
        currentOrderingEnabled: true,
        renderedItems: [deepRoot, target, source],
        selectedIds: new Set(),
        treeRoots: [deepRoot],
      })
    );
    const event = {
      active: { id: "source", rect: { current: { translated: null } } },
      over: { id: "target", rect: { top: 0, height: 90 } },
      activatorEvent: { type: "pointerdown", clientY: 0 },
      delta: { x: 0, y: 45 },
    } as unknown as DragMoveEvent;

    act(() => result.current.handleDragMove(event));
    expect(result.current.preview).toBeNull();
    act(() => result.current.handleDragEnd(event as DragEndEvent));
    act(() => result.current.handleKeyboardPlacement("source", "in"));
    expect(mutate).not.toHaveBeenCalled();
    expect(result.current.announcement).toBe("");
  });

  it("refuses a fifth-level grid preview and commit through the shared admission rule", () => {
    const source = row("source");
    const target = row("target");
    const deepRoot = row("deep-root", [
      row("level-2", [row("level-3", [target, source])]),
    ]);
    const { result } = renderHook(() =>
      useHierarchyPlacement({
        projectId: "project-1",
        projectVersion: "project-version-1",
        currentOrderingEnabled: true,
        renderedItems: [deepRoot, target, source],
        selectedIds: new Set(),
        treeRoots: [deepRoot],
      })
    );

    expect(result.current.canDropOnRow(source, target, "inside")).toBe(false);
    act(() => result.current.handleGridRowDrop(source, target, "inside"));
    expect(mutate).not.toHaveBeenCalled();
    expect(result.current.announcement).toBe("");
  });

  it("refuses a grid cycle in preview and commit", () => {
    const { result } = renderHook(() =>
      useHierarchyPlacement({
        projectId: "project-1",
        projectVersion: "project-version-1",
        currentOrderingEnabled: true,
        renderedItems: [ROOT, CHILD_A, CHILD_B, CHILD_C],
        selectedIds: new Set(),
        treeRoots: [ROOT],
      })
    );

    expect(result.current.canDropOnRow(ROOT, CHILD_A, "inside")).toBe(false);
    act(() => result.current.handleGridRowDrop(ROOT, CHILD_A, "inside"));
    expect(mutate).not.toHaveBeenCalled();
  });
});
