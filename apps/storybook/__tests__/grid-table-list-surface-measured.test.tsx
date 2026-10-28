/**
 * The Measured* stories on the Grid Table List Surface skip their layout
 * assertions when `getBoundingClientRect` reports no width, which it always
 * does in jsdom. These cases give the host a layout: every element measures as
 * wide as its nearest ancestor with an inline pixel width, and a resizable
 * ResizeObserver stub reports that same width. Then the stories' own `play`
 * assertions run in full, and a hand-driven flow crosses the breakpoint in
 * both directions through each mode's click handler.
 */
import { CARD_FALLBACK_BREAKPOINT } from "@repo/design-system/lib/column-order";
import { composeStory } from "@storybook/react";
import { render, screen } from "@testing-library/react";
import { userEvent } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ResizableContainerWidthStub,
  stubResizableContainerWidthPx,
} from "../../../packages/typescript-config/vitest-container-width-stub";
import listSurfaceMeta, {
  MeasuredCompact as measuredCompactStory,
  MeasuredExpanded as measuredExpandedStory,
  MeasuredFocusHandoff as measuredFocusHandoffStory,
} from "../stories/composites-v2/v2-grid-table-list-surface.stories";
import frozenListSurfaceMeta, {
  MeasuredCompact as frozenMeasuredCompactStory,
  MeasuredFocusHandoff as frozenMeasuredFocusHandoffStory,
} from "../stories/grid-table-list-surface.stories";

const HOST_TEST_ID = "grid-table-measured-width-host";
const ROW_NAME = "Alpha";
const CASE_TIMEOUT_MS = 20_000;

let resizeStub: ResizableContainerWidthStub | null = null;

function inlineWidthPx(element: Element): number {
  let node: Element | null = element;
  while (node) {
    if (node instanceof HTMLElement) {
      const width = Number.parseFloat(node.style.width);
      if (Number.isFinite(width)) {
        return width;
      }
    }
    node = node.parentElement;
  }
  return 0;
}

function hostWidthPx(): number {
  return inlineWidthPx(screen.getByTestId(HOST_TEST_ID));
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(0, 0, inlineWidthPx(this), 600);
    }
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  resizeStub?.restore();
  resizeStub = null;
});

describe("Grid Table List Surface measured stories with layout", () => {
  it(
    "keeps the frozen v1 compact card and toolbar contract",
    async () => {
      resizeStub = stubResizableContainerWidthPx(CARD_FALLBACK_BREAKPOINT - 1);
      const Story = composeStory(
        frozenMeasuredCompactStory,
        frozenListSurfaceMeta
      );
      await Story.run();
      expect(screen.getByRole("button", { name: "View" })).toBeVisible();
      expect(screen.getByText("Ada Lovelace")).toBeVisible();
      expect(screen.queryByRole("grid")).toBeNull();
    },
    CASE_TIMEOUT_MS
  );

  it(
    "keeps the frozen v1 focus handoff when cards become the grid",
    async () => {
      resizeStub = stubResizableContainerWidthPx(CARD_FALLBACK_BREAKPOINT - 1);
      const bridge = new MutationObserver(() =>
        resizeStub?.setWidth(hostWidthPx())
      );
      bridge.observe(document.body, {
        attributeFilter: ["style"],
        attributes: true,
        subtree: true,
      });
      try {
        const Story = composeStory(
          frozenMeasuredFocusHandoffStory,
          frozenListSurfaceMeta
        );
        await Story.run();
      } finally {
        bridge.disconnect();
      }
      expect(screen.getByRole("region", { name: "Rows" })).toHaveFocus();
    },
    CASE_TIMEOUT_MS
  );

  it(
    "MeasuredCompact renders the Name-only narrow list below the breakpoint",
    async () => {
      resizeStub = stubResizableContainerWidthPx(CARD_FALLBACK_BREAKPOINT - 1);
      const Story = composeStory(measuredCompactStory, listSurfaceMeta);
      await Story.run();
      expect(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "1");
      expect(screen.getByRole("columnheader")).toHaveTextContent("Name");
      expect(screen.queryByText("Ada Lovelace")).toBeNull();
    },
    CASE_TIMEOUT_MS
  );

  it(
    "MeasuredExpanded renders the grid at the breakpoint",
    async () => {
      resizeStub = stubResizableContainerWidthPx(CARD_FALLBACK_BREAKPOINT);
      const Story = composeStory(measuredExpandedStory, listSurfaceMeta);
      await Story.run();
      expect(screen.getByRole("grid")).toBeInTheDocument();
    },
    CASE_TIMEOUT_MS
  );

  it(
    "MeasuredFocusHandoff keeps focus on the row action across the breakpoint",
    async () => {
      resizeStub = stubResizableContainerWidthPx(CARD_FALLBACK_BREAKPOINT - 1);
      // A real ResizeObserver fires when the host's width changes; this bridges
      // the host's inline style to the stub the same way.
      const bridge = new MutationObserver(() =>
        resizeStub?.setWidth(hostWidthPx())
      );
      bridge.observe(document.body, {
        attributeFilter: ["style"],
        attributes: true,
        subtree: true,
      });
      try {
        const Story = composeStory(measuredFocusHandoffStory, listSurfaceMeta);
        await Story.run();
      } finally {
        bridge.disconnect();
      }
      expect(screen.getByRole("button", { name: ROW_NAME })).toHaveFocus();
    },
    CASE_TIMEOUT_MS
  );

  it(
    "a narrow-row click expands the surface, and a lead click compacts it again",
    async () => {
      resizeStub = stubResizableContainerWidthPx(CARD_FALLBACK_BREAKPOINT - 1);
      const Story = composeStory(
        { ...measuredFocusHandoffStory, play: undefined },
        listSurfaceMeta
      );
      render(<Story />);
      expect(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "1");

      // The current surface keeps the viewport fixed while its fixture toggles
      // the same compact/expanded projection owned by the responsive host.
      await userEvent.click(screen.getByRole("button", { name: ROW_NAME }));
      expect(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "2");

      await userEvent.click(screen.getByRole("button", { name: ROW_NAME }));
      expect(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "1");
    },
    CASE_TIMEOUT_MS
  );
});
