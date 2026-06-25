import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { useDocumentsViewState } from "@repo/app/documents/hooks/use-documents-view-state";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";

function makeItem(id: string): DocumentRowItem {
  return { kind: "document", data: makeArtifact({ id }) };
}

const ANCHOR = {} as HTMLElement;

describe("useDocumentsViewState", () => {
  test("selection: change, replace, prune, clear", () => {
    const { result } = renderHook(() => useDocumentsViewState());

    act(() => {
      result.current.actions.changeSelection("a", true);
      result.current.actions.changeSelection("b", true);
    });
    expect(result.current.state.selectedIds).toEqual(new Set(["a", "b"]));

    act(() => {
      result.current.actions.pruneSelection(new Set(["a"]));
    });
    expect(result.current.state.selectedIds).toEqual(new Set(["a"]));

    act(() => {
      result.current.actions.replaceSelection(new Set(["x", "y"]));
    });
    expect(result.current.state.selectedIds).toEqual(new Set(["x", "y"]));

    act(() => {
      result.current.actions.clearSelection();
    });
    expect(result.current.state.selectedIds.size).toBe(0);
  });

  test("pruning to the same set keeps the state reference stable (no render loop)", () => {
    const { result } = renderHook(() => useDocumentsViewState());

    act(() => {
      result.current.actions.changeSelection("a", true);
    });
    const before = result.current.state;

    act(() => {
      result.current.actions.pruneSelection(new Set(["a", "b"]));
    });
    expect(result.current.state).toBe(before);
  });

  test("requestDelete opens the dialog with the target and closes the menu", () => {
    const { result } = renderHook(() => useDocumentsViewState());
    const item = makeItem("doc-1");

    act(() => {
      result.current.actions.openMenu(item, ANCHOR);
    });
    expect(result.current.state.menuState?.item).toBe(item);

    act(() => {
      result.current.actions.requestDelete(item);
    });
    expect(result.current.state.deleteDialogOpen).toBe(true);
    expect(result.current.state.deleteTarget).toBe(item);
    expect(result.current.state.menuState).toBeNull();
  });

  test("single delete success closes the dialog and removes the row from selection", () => {
    const { result } = renderHook(() => useDocumentsViewState());
    const item = makeItem("doc-1");

    act(() => {
      result.current.actions.changeSelection("doc-1", true);
      result.current.actions.changeSelection("doc-2", true);
      result.current.actions.requestDelete(item);
      result.current.actions.markDeleteSucceeded("doc-1");
    });

    expect(result.current.state.deleteDialogOpen).toBe(false);
    expect(result.current.state.deleteTarget).toBeNull();
    expect(result.current.state.selectedIds).toEqual(new Set(["doc-2"]));
  });

  test("bulk delete snapshots the selection and success clears everything", () => {
    const { result } = renderHook(() => useDocumentsViewState());

    act(() => {
      result.current.actions.changeSelection("a", true);
      result.current.actions.changeSelection("b", true);
      result.current.actions.requestBulkDelete();
    });
    expect(result.current.state.pendingBulkIds).toEqual(new Set(["a", "b"]));
    expect(result.current.state.deleteDialogOpen).toBe(true);

    act(() => {
      result.current.actions.markBulkDeleteSucceeded();
    });
    expect(result.current.state.pendingBulkIds.size).toBe(0);
    expect(result.current.state.selectedIds.size).toBe(0);
    expect(result.current.state.deleteDialogOpen).toBe(false);
  });

  test("single and bulk delete modes are mutually exclusive in state", () => {
    const { result } = renderHook(() => useDocumentsViewState());
    const item = makeItem("doc-1");

    act(() => {
      result.current.actions.requestDelete(item);
    });
    expect(result.current.state.deleteTarget).toBe(item);
    expect(result.current.state.pendingBulkIds.size).toBe(0);

    // Switching to bulk clears the single target.
    act(() => {
      result.current.actions.changeSelection("a", true);
      result.current.actions.requestBulkDelete();
    });
    expect(result.current.state.deleteTarget).toBeNull();
    expect(result.current.state.pendingBulkIds).toEqual(new Set(["a"]));

    // Switching back to single clears the bulk markers.
    act(() => {
      result.current.actions.requestDelete(item);
    });
    expect(result.current.state.pendingBulkIds.size).toBe(0);
    expect(result.current.state.deleteTarget).toBe(item);
  });

  test("a cancelled bulk delete does not bleed into a later single-row delete", () => {
    const { result } = renderHook(() => useDocumentsViewState());
    const item = makeItem("doc-9");

    act(() => {
      result.current.actions.changeSelection("a", true);
      result.current.actions.changeSelection("b", true);
      result.current.actions.requestBulkDelete();
    });
    expect(result.current.state.pendingBulkIds.size).toBe(2);

    // User cancels the bulk dialog: both delete markers reset.
    act(() => {
      result.current.actions.setDeleteDialogOpen(false);
    });
    expect(result.current.state.pendingBulkIds.size).toBe(0);
    expect(result.current.state.deleteTarget).toBeNull();

    // A subsequent single-row delete takes the single path, not bulk.
    act(() => {
      result.current.actions.requestDelete(item);
    });
    expect(result.current.state.pendingBulkIds.size).toBe(0);
    expect(result.current.state.deleteTarget).toBe(item);
  });

  test("clearMergeError removes a prior error so a retry shows no stale banner", () => {
    const { result } = renderHook(() => useDocumentsViewState());

    act(() => {
      result.current.actions.markMergeFailed("boom");
    });
    expect(result.current.state.mergeError).toBe("boom");

    act(() => {
      result.current.actions.clearMergeError();
    });
    expect(result.current.state.mergeError).toBeNull();
  });

  test("requestMove routes single vs bulk resolutions and closes the menu", () => {
    const { result } = renderHook(() => useDocumentsViewState());

    act(() => {
      result.current.actions.openMenu(makeItem("doc-1"), ANCHOR);
      result.current.actions.requestMove({
        kind: "single",
        entity: { id: "doc-1", projectId: "proj-1" },
      });
    });
    expect(result.current.state.moveEntity).toEqual({
      id: "doc-1",
      projectId: "proj-1",
    });
    expect(result.current.state.menuState).toBeNull();

    act(() => {
      result.current.actions.closeMoveDialog();
      result.current.actions.requestMove({
        kind: "bulk",
        entities: [{ id: "doc-1" }, { id: "fea-1" }],
      });
    });
    expect(result.current.state.moveEntity).toBeNull();
    expect(result.current.state.moveEntities).toHaveLength(2);

    act(() => {
      result.current.actions.markBulkMoveSucceeded();
    });
    expect(result.current.state.moveEntities).toHaveLength(0);
  });

  test("merge dialog lifecycle: open clears prior error; failure records it; success clears selection", () => {
    const { result } = renderHook(() => useDocumentsViewState());

    act(() => {
      result.current.actions.changeSelection("a", true);
      result.current.actions.markMergeFailed("boom");
      result.current.actions.openMergeDialog();
    });
    expect(result.current.state.mergeDialogOpen).toBe(true);
    expect(result.current.state.mergeError).toBeNull();

    act(() => {
      result.current.actions.markMergeFailed("merge failed");
    });
    expect(result.current.state.mergeError).toBe("merge failed");

    act(() => {
      result.current.actions.markMergeSucceeded();
    });
    expect(result.current.state.mergeDialogOpen).toBe(false);
    expect(result.current.state.selectedIds.size).toBe(0);
  });
});
