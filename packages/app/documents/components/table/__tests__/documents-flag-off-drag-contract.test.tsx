// @vitest-environment jsdom

import { documentTreeRoots } from "@repo/app/documents/lib/documents-grid-groups";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import {
  makeArtifact,
  makePlanArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pointerDown: vi.fn(),
  useSortable: vi.fn(),
}));

vi.mock("@dnd-kit/sortable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dnd-kit/sortable")>()),
  useSortable: mocks.useSortable,
}));

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

import { DocumentsPlacementBody } from "../documents-placement-body";
import {
  DocumentsUngroupedTreeBody,
  REORDER_ROW_LABEL,
} from "../documents-ungrouped-tree-body";
import { RankInteractionMode } from "../sort-keys";

const ROOT_ID = "root-1";

describe("flag-off Documents tree drag contract", () => {
  beforeEach(() => {
    mocks.pointerDown.mockClear();
    mocks.useSortable.mockImplementation(({ id }: { id: string }) => ({
      attributes: {},
      isDragging: id === ROOT_ID,
      listeners: { onPointerDown: mocks.pointerDown },
      setActivatorNodeRef: vi.fn(),
      setNodeRef: vi.fn(),
      transform: { scaleX: 1, scaleY: 1, x: 80, y: 60 },
      transition: undefined,
    }));
  });

  it("keeps row and title presses off the activator while the dragged subtree remains visible", () => {
    const { container } = renderFlagOffTree();
    const title = screen.getByRole("link", { name: "Root One" });
    const row = title.closest("div.group\\/row");
    const handle = screen.getAllByRole("button", {
      name: REORDER_ROW_LABEL,
    })[0];
    const subtree = container.querySelector<HTMLElement>(
      `[data-sortable-subtree-id="${ROOT_ID}"]`
    );

    if (!(row && handle)) {
      throw new Error("Expected the document row and drag handle");
    }
    fireEvent.pointerDown(row);
    fireEvent.pointerDown(title);
    expect(mocks.pointerDown).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle);
    expect(mocks.pointerDown).toHaveBeenCalledOnce();
    expect(subtree).toHaveStyle({
      opacity: "0.4",
      position: "relative",
      zIndex: "1",
    });
  });

  it("leaves horizontal movement free and paints the dragged subtree above following rows", () => {
    const { container } = renderFlagOffTree();
    const subtree = container.querySelector<HTMLElement>(
      `[data-sortable-subtree-id="${ROOT_ID}"]`
    );

    expect(subtree).toHaveStyle({
      transform: "translate3d(80px, 60px, 0)",
      opacity: "0.4",
      zIndex: "1",
    });
    expect(subtree).not.toHaveClass("bg-background");
    expect(container.querySelector("[data-drag-preview-chip]")).toBeNull();
  });
});

function renderFlagOffTree() {
  const root = {
    kind: "document" as const,
    data: makeArtifact({ id: ROOT_ID, slug: "PRD-1", title: "Root One" }),
  };
  const child = {
    kind: "document" as const,
    data: makePlanArtifact({
      id: "child-1",
      slug: "PLN-1",
      title: "Child One",
    }),
  };
  const following = {
    kind: "document" as const,
    data: makeArtifact({ id: "root-2", slug: "PRD-2", title: "Root Two" }),
  };
  const items = documentTreeRoots([
    { groupKey: ROOT_ID, root, children: [child] },
    { groupKey: "root-2", root: following, children: [] },
  ]);
  return render(
    <DocumentsPlacementBody
      enabled
      itemIds={[ROOT_ID, "root-2"]}
      manualPlacementEnabled={false}
      onDragEnd={vi.fn()}
    >
      <DocumentsUngroupedTreeBody
        isExpanded={() => true}
        items={items}
        parentMap={new Map()}
        rankInteractionMode={RankInteractionMode.Enabled}
        toggleRow={vi.fn()}
        visibleColumns={[DocumentColumn.Type]}
      />
    </DocumentsPlacementBody>
  );
}
