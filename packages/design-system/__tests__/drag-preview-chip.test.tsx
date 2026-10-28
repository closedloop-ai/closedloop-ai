import { DragPreviewChip } from "@closedloop-ai/design-system/components/ui/drag-preview-chip";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const visibleLists: HTMLElement[] = [];

afterEach(() => {
  for (const list of visibleLists) {
    list.remove();
  }
  visibleLists.length = 0;
  vi.unstubAllGlobals();
});

describe("DragPreviewChip", () => {
  it("shrink-wraps the grip and title while respecting list and viewport bounds", () => {
    vi.stubGlobal("innerWidth", 1440);
    const list = globalThis.document.createElement("div");
    const row = globalThis.document.createElement("div");
    Object.defineProperty(list, "clientWidth", { value: 600 });
    Object.defineProperty(row, "clientWidth", { value: 1800 });
    list.append(row);
    globalThis.document.body.append(list);
    visibleLists.push(list);

    const { rerender } = render(
      <DragPreviewChip label="Test PRD" sourceElement={row} x={80} y={240} />
    );
    const chip = screen.getByTestId("drag-preview-chip");
    expect(chip).toHaveStyle({
      maxWidth: "min(var(--container-sm), 600px)",
      top: "240px",
      width: "max-content",
    });
    expect(chip).toHaveClass("translate-y-3");

    rerender(
      <DragPreviewChip label="Test PRD" sourceElement={row} x={1300} y={240} />
    );
    expect(chip).toHaveStyle({
      maxWidth: "min(var(--container-sm), 140px)",
      width: "max-content",
    });
  });

  it.each([
    ["before", 180, 180],
    ["after", 325, 325],
    ["inside", 290, 320],
  ] as const)(
    "clears the %s indicator without changing before/after pointer geometry",
    (placement, y, expectedTop) => {
      const list = globalThis.document.createElement("div");
      const row = globalThis.document.createElement("div");
      const target = globalThis.document.createElement("div");
      target.getBoundingClientRect = () => ({ bottom: 320 }) as DOMRect;
      list.append(row, target);
      globalThis.document.body.append(list);
      visibleLists.push(list);

      render(
        <DragPreviewChip
          dropTarget={{ element: target, placement }}
          label="Test PRD"
          sourceElement={row}
          x={80}
          y={y}
        />
      );
      expect(screen.getByTestId("drag-preview-chip")).toHaveStyle({
        top: `${expectedTop}px`,
      });
      expect(screen.getByTestId("drag-preview-chip")).toHaveClass(
        "translate-y-3"
      );
    }
  );
});
