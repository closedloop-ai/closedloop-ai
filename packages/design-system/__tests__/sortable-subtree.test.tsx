import { DragPreviewChip } from "@closedloop-ai/design-system/components/ui/drag-preview-chip";
import { SortableSubtree } from "@closedloop-ai/design-system/components/ui/sortable-subtree";
import { DndContext } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

const ROOT_ID = "11111111-1111-7111-8111-111111111111";

function wrap(children: ReactNode) {
  return (
    <DndContext>
      <SortableContext items={[ROOT_ID]} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

describe("SortableSubtree (PLN-755)", () => {
  it("renders the shared preview as a grip and truncated title only", () => {
    const { container } = render(
      <DragPreviewChip
        label="Test PRD"
        sourceElement={globalThis.document.createElement("div")}
        x={12}
        y={24}
      />
    );
    const chip = container.querySelector("[data-drag-preview-chip]");
    expect(chip).toHaveTextContent("Test PRD");
    expect(chip?.querySelector("svg")).not.toBeNull();
    expect(chip?.querySelectorAll("[data-drag-preview-title]")).toHaveLength(1);
  });
  it("renders the drag handle into the root via renderRoot", () => {
    render(
      wrap(
        <SortableSubtree
          handleLabel="Reorder row"
          id={ROOT_ID}
          renderRoot={({ buttonProps }) => (
            <div data-testid="root-row">
              <button {...buttonProps} />
            </div>
          )}
        />
      )
    );

    const root = screen.getByTestId("root-row");
    const handle = root.querySelector("button");
    expect(handle).not.toBeNull();
    expect(handle?.getAttribute("aria-label")).toBe("Reorder row");
  });

  it("exposes a pointer-only root binding beside the accessible handle", () => {
    render(
      wrap(
        <SortableSubtree
          handleLabel="Reorder row"
          id={ROOT_ID}
          renderRoot={({ buttonProps, pointerTargetProps }) => (
            <div
              data-has-pointer-target={Boolean(
                pointerTargetProps.onPointerDown
              )}
              data-testid="root-row"
              {...pointerTargetProps}
            >
              <button {...buttonProps} />
            </div>
          )}
        />
      )
    );

    expect(screen.getByTestId("root-row")).toHaveAttribute(
      "data-has-pointer-target",
      "true"
    );
  });

  it("renders children alongside the root inside the same sortable node", () => {
    render(
      wrap(
        <SortableSubtree
          handleLabel="Reorder row"
          id={ROOT_ID}
          renderRoot={() => <div data-testid="root-row">root</div>}
        >
          <div data-testid="child-row">child</div>
        </SortableSubtree>
      )
    );

    // Both root and child live under the single sortable wrapper.
    const root = screen.getByTestId("root-row");
    const child = screen.getByTestId("child-row");
    expect(root.closest("[data-sortable-subtree-id]")).toBe(
      child.closest("[data-sortable-subtree-id]")
    );
  });

  it.each([
    ["before", "top-0", "bg-primary"],
    ["after", "bottom-0", "bg-primary"],
    ["inside", "ring-2", "ring-primary"],
  ] as const)(
    "AC-003 renders the generic %s placement preview without domain wiring",
    (dropPosition, expectedClass, expectedAccent) => {
      const { container } = render(
        wrap(
          <SortableSubtree
            dropPosition={dropPosition}
            handleLabel="Reorder row"
            id={ROOT_ID}
            renderRoot={() => <div>root</div>}
          />
        )
      );

      const wrapper = container.querySelector(
        `[data-drop-position="${dropPosition}"]`
      );
      expect(wrapper).not.toBeNull();
      if (dropPosition === "inside") {
        expect(wrapper).toHaveClass(expectedClass, expectedAccent);
      } else {
        expect(
          wrapper?.querySelector(`[data-drop-line="${dropPosition}"]`)
        ).toHaveClass(
          "absolute",
          "inset-x-0",
          "h-px",
          expectedClass,
          expectedAccent
        );
      }
      if (dropPosition === "inside") {
        expect(
          wrapper?.querySelector("[aria-hidden='true'].absolute")
        ).toHaveClass("z-10", "ring-primary");
      }
    }
  );
});
