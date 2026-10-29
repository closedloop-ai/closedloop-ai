// @vitest-environment jsdom

import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { Link } from "@repo/navigation/link";
import { act, fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

let onDragStart: ((event: DragStartEvent) => void) | undefined;
let onDragEnd: ((event: DragEndEvent) => void) | undefined;

vi.mock("@repo/app/shared/components/dnd-provider", () => ({
  DndProvider: ({
    children,
    onDragStart: start,
    onDragEnd: end,
  }: {
    children: ReactNode;
    onDragStart: (event: DragStartEvent) => void;
    onDragEnd: (event: DragEndEvent) => void;
  }) => {
    onDragStart = start;
    onDragEnd = end;
    return <>{children}</>;
  },
}));

import { DocumentsPlacementBody } from "../documents-placement-body";

describe("DocumentsPlacementBody pointer settlement", () => {
  afterEach(() => vi.useRealTimers());

  it("prevents the delayed native post-drag click without blocking a new click", () => {
    const click = vi.fn();
    render(
      <DocumentsPlacementBody
        enabled
        itemIds={["root"]}
        manualPlacementEnabled
        onDragEnd={vi.fn()}
      >
        <Link href="/documents/test" onClick={click}>
          Open Test PRD
        </Link>
      </DocumentsPlacementBody>
    );
    const link = screen.getByRole("link", { name: "Open Test PRD" });
    vi.useFakeTimers();

    act(() => {
      onDragStart?.({
        activatorEvent: { type: "pointerdown" },
      } as DragStartEvent);
      onDragEnd?.({
        active: { id: "root" },
        activatorEvent: { type: "pointerdown" },
      } as DragEndEvent);
    });
    act(() => vi.runOnlyPendingTimers());
    const postDragClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    link.dispatchEvent(postDragClick);
    expect(postDragClick.defaultPrevented).toBe(true);
    expect(click).not.toHaveBeenCalled();

    fireEvent.pointerDown(link);
    fireEvent.click(link);
    expect(click).toHaveBeenCalledOnce();
  });
});
