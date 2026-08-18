import { InsightsSection } from "@repo/api/src/types/insights";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { type TileDescriptor, TileKind } from "../../lib/tile-catalog";
import { InsightsTile } from "../insights-tile";
import type { InsightsSectionData } from "../tile-content";

// Isolate the tile shell + expand affordance from real chart plumbing: the
// chart body is stubbed with a stateful marker so we can assert single-instance
// state continuity across expand/collapse (FEA-3751 reuses ExpandableWidget's
// FEA-3700 portal machinery).
let chartMountCount = 0;
vi.mock("../tile-content", async () => {
  const actual =
    await vi.importActual<typeof import("../tile-content")>("../tile-content");
  return {
    ...actual,
    InsightsChartContent: () => {
      const [value, setValue] = useState("initial");
      const mounted = useRef(false);
      if (!mounted.current) {
        mounted.current = true;
        chartMountCount += 1;
      }
      useEffect(() => {
        // no-op durable effect
      }, []);
      return (
        <div data-testid="chart-body">
          <span data-testid="chart-state">{value}</span>
          <button onClick={() => setValue("changed")} type="button">
            Change chart state
          </button>
        </div>
      );
    },
  };
});

const CHART_TILE: TileDescriptor = {
  id: "chart:prTrend",
  section: InsightsSection.Delivery,
  title: "PR Trend",
  kind: TileKind.TimeSeries,
  dataKey: "prTrend",
  metricKey: "merged",
  metricLabel: "Merged",
  grid: { w: 6, h: 4 },
};

const EMPTY_SECTIONS = {} as InsightsSectionData;
const EXPAND_BUTTON_NAME = "Expand PR Trend";
const CLOSE_BUTTON_NAME_REGEX = /close/i;

function renderTile(node: ReactNode) {
  return render(node);
}

describe("InsightsTile chart-tile expand affordance (FEA-3751)", () => {
  it("renders a discoverable, aria-labeled expand control on each chart tile", () => {
    renderTile(
      <InsightsTile
        pinned={false}
        sections={EMPTY_SECTIONS}
        tile={CHART_TILE}
      />
    );

    const trigger = screen.getByRole("button", { name: EXPAND_BUTTON_NAME });
    expect(trigger).toBeInTheDocument();
    // Native <button>, keyboard-focusable.
    expect(trigger).not.toHaveAttribute("tabindex", "-1");
    // Carries the drag-cancel class so it never starts a react-grid-layout drag.
    expect(trigger).toHaveClass("insights-widget-control");
  });

  it("opens a full-screen modal dialog with the same chart content on activation", async () => {
    const user = userEvent.setup();
    renderTile(
      <InsightsTile
        pinned={false}
        sections={EMPTY_SECTIONS}
        tile={CHART_TILE}
      />
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: EXPAND_BUTTON_NAME }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // Dialog has an accessible name for the focus-trap.
    expect(dialog).toHaveAccessibleName("PR Trend");
    // Same chart body, now inside the modal.
    expect(within(dialog).getByTestId("chart-body")).toBeInTheDocument();
    // The relocated card's own hover-revealed control cluster (info/pin/edit)
    // reveals on `group-hover` / `group-focus-within`; those Tailwind variants
    // only work under a `.group` ancestor. The modal must therefore provide one
    // (the dialog mount point), or the tile's controls would be stuck hidden
    // while expanded.
    expect(within(dialog).getByTestId("chart-body").closest(".group")).not.toBe(
      null
    );
  });

  it("dismisses the modal via the close button and via Escape", async () => {
    const user = userEvent.setup();
    renderTile(
      <InsightsTile
        pinned={false}
        sections={EMPTY_SECTIONS}
        tile={CHART_TILE}
      />
    );

    await user.click(screen.getByRole("button", { name: EXPAND_BUTTON_NAME }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: CLOSE_BUTTON_NAME_REGEX })
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // ...and via Escape.
    await user.click(screen.getByRole("button", { name: EXPAND_BUTTON_NAME }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("suppresses the grid-only drag handle and resize controls inside the expand modal", async () => {
    const user = userEvent.setup();
    renderTile(
      <InsightsTile
        onEditTile={vi.fn()}
        onResizeWidth={vi.fn()}
        onTogglePin={vi.fn()}
        pinned
        sections={EMPTY_SECTIONS}
        showDragHandle
        showResizeControls
        tile={CHART_TILE}
      />
    );

    // Collapsed: the grid affordances are present in the tile's control cluster.
    expect(document.querySelector(".insights-drag-handle")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Full" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1/2" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: EXPAND_BUTTON_NAME }));
    const dialog = screen.getByRole("dialog");

    // Inside the modal there is no grid to drag within and no column width to
    // set, so those affordances must be gone — a lit-but-inert control reads as
    // broken. Since the tile is a single relocated instance, they must be absent
    // from the whole document, not just re-hidden.
    expect(document.querySelector(".insights-drag-handle")).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Full" })
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "1/2" })
    ).not.toBeInTheDocument();
    // Edit / info / remove stay reachable in the modal.
    expect(
      within(dialog).getByRole("button", { name: "Edit widget" })
    ).toBeInTheDocument();
  });

  it("closes the modal when the tile is removed (unpinned) while expanded", async () => {
    const user = userEvent.setup();
    const onTogglePin = vi.fn();
    renderTile(
      <InsightsTile
        onTogglePin={onTogglePin}
        pinned
        sections={EMPTY_SECTIONS}
        tile={CHART_TILE}
      />
    );

    await user.click(screen.getByRole("button", { name: EXPAND_BUTTON_NAME }));
    const dialog = screen.getByRole("dialog");

    // Removing the tile takes it off the dashboard; the modal must not linger
    // over a widget that no longer exists behind it.
    await user.click(
      within(dialog).getByRole("button", { name: "Remove widget" })
    );
    expect(onTogglePin).toHaveBeenCalledWith(CHART_TILE.id);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps a single chart instance and preserves its state across expand → collapse", async () => {
    const user = userEvent.setup();
    chartMountCount = 0;
    renderTile(
      <InsightsTile
        pinned={false}
        sections={EMPTY_SECTIONS}
        tile={CHART_TILE}
      />
    );

    // Mounted exactly once at initial load (single-instance portal).
    expect(chartMountCount).toBe(1);

    // Change control state in the collapsed tile.
    await user.click(
      screen.getByRole("button", { name: "Change chart state" })
    );
    expect(screen.getByTestId("chart-state")).toHaveTextContent("changed");

    // Expand: same instance relocates into the dialog, state carries over, no
    // remount, and the chart body lives in exactly one place.
    await user.click(screen.getByRole("button", { name: EXPAND_BUTTON_NAME }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("chart-state")).toHaveTextContent(
      "changed"
    );
    expect(chartMountCount).toBe(1);
    expect(screen.getAllByTestId("chart-body")).toHaveLength(1);

    // Collapse: state survives the round-trip, still one instance.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("chart-state")).toHaveTextContent("changed");
    expect(chartMountCount).toBe(1);
  });
});
