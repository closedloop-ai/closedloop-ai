// @vitest-environment jsdom

import {
  SortableSubtree,
  sortableSubtreeAnnouncements,
} from "@closedloop-ai/design-system/components/ui/sortable-subtree";
import type { Active } from "@dnd-kit/core";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useSortable: vi.fn() }));

vi.mock("@dnd-kit/sortable", () => ({ useSortable: mocks.useSortable }));

describe("SortableSubtree transform", () => {
  beforeEach(() => {
    mocks.useSortable.mockReturnValue({
      attributes: {},
      isDragging: true,
      listeners: {},
      setActivatorNodeRef: vi.fn(),
      setNodeRef: vi.fn(),
      transform: { scaleX: 1, scaleY: 1, x: 240, y: 18 },
      transition: undefined,
    });
  });

  it("keeps the default transform free on both axes", () => {
    const { container } = renderSubtree(false);

    expect(container.firstElementChild).toHaveStyle({
      transform: "translate3d(240px, 18px, 0)",
    });
  });

  it("contains horizontal preview movement for an opted-in vertical list", () => {
    const { container } = renderSubtree(true);

    expect(container.firstElementChild).toHaveStyle({
      transform: "translate3d(0px, 18px, 0)",
    });
  });

  it("keeps the legacy dragged subtree translucent and above following rows", () => {
    const { container } = renderSubtree(false);
    const ghost = container.firstElementChild;

    expect(ghost).toHaveAttribute("data-dragging", "true");
    expect(ghost).toHaveStyle({
      opacity: "0.4",
      position: "relative",
      zIndex: "1",
    });
    expect(ghost).not.toHaveClass("bg-background");
  });

  it("keeps an opted-in source subtree stationary and highlighted", () => {
    const { container } = render(
      <SortableSubtree
        handleLabel="Reorder row"
        id="root"
        preserveSourcePosition
        renderRoot={() => <div>Root</div>}
        restrictToVerticalAxis
      />
    );
    const source = container.firstElementChild;

    expect(source).toHaveAttribute("data-dragging", "true");
    expect(source).toHaveClass("bg-accent/40");
    expect(source).not.toHaveStyle({ transform: "translate3d(0px, 18px, 0)" });
  });

  it("does not translate a descendant again while its subtree is dragged", () => {
    mocks.useSortable.mockImplementation(({ id }: { id: string }) => ({
      attributes: {},
      isDragging: id === "root",
      listeners: {},
      setActivatorNodeRef: vi.fn(),
      setNodeRef: vi.fn(),
      transform: { scaleX: 1, scaleY: 1, x: 0, y: 18 },
      transition: undefined,
    }));
    const { container } = render(
      <SortableSubtree
        handleLabel="Reorder row"
        id="root"
        renderRoot={() => <div>Parent</div>}
      >
        <SortableSubtree
          handleLabel="Reorder child"
          id="child"
          renderRoot={() => <div>Child</div>}
        />
      </SortableSubtree>
    );
    expect(
      container.querySelector("[data-sortable-subtree-id='root']")
    ).toHaveStyle({
      transform: "translate3d(0px, 18px, 0)",
    });
    expect(
      container.querySelector("[data-sortable-subtree-id='child']")
    ).not.toHaveStyle({
      transform: "translate3d(0px, 18px, 0)",
    });
  });

  it("does not fall back to an internal id when a human label is absent", () => {
    const active = {
      data: { current: undefined },
      id: "internal-row-id",
    } as Active;

    expect(
      sortableSubtreeAnnouncements.onDragStart?.({ active })
    ).toBeUndefined();
  });
});

function renderSubtree(restrictToVerticalAxis: boolean) {
  return render(
    <SortableSubtree
      handleLabel="Reorder row"
      id="root"
      renderRoot={({ buttonProps }) => <button {...buttonProps} />}
      restrictToVerticalAxis={restrictToVerticalAxis}
    />
  );
}
