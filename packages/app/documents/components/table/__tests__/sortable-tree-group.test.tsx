import { DndContext } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { SortableTreeGroup } from "../sortable-tree-group";

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

describe("SortableTreeGroup (PLN-755)", () => {
  it("renders the drag handle into the root via renderRoot", () => {
    render(
      wrap(
        <SortableTreeGroup
          id={ROOT_ID}
          renderRoot={(dragHandle) => (
            <div data-testid="root-row">{dragHandle}</div>
          )}
        />
      )
    );

    const root = screen.getByTestId("root-row");
    const handle = root.querySelector("button");
    expect(handle).not.toBeNull();
    expect(handle?.getAttribute("aria-label")).toBe("Reorder row");
  });

  it("renders children alongside the root inside the same sortable node", () => {
    render(
      wrap(
        <SortableTreeGroup
          id={ROOT_ID}
          renderRoot={() => <div data-testid="root-row">root</div>}
        >
          <div data-testid="child-row">child</div>
        </SortableTreeGroup>
      )
    );

    // Both root and child live under the single sortable wrapper, so a drag
    // transform applied to the wrapper moves them together.
    const root = screen.getByTestId("root-row");
    const child = screen.getByTestId("child-row");
    expect(root.parentElement).toBe(child.parentElement);
  });
});
