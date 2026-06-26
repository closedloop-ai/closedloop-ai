import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DashboardPins } from "../../hooks/use-dashboard-pins";
import { DashboardGrid } from "../dashboard-grid";

type GridItemLayout = { i: string; x: number; y: number; w: number; h: number };

type MockGridProps = {
  children?: ReactNode;
  className?: string;
  draggableCancel?: string;
  draggableHandle?: string;
  onLayoutChange?: (
    current: GridItemLayout[],
    allLayouts: Record<string, GridItemLayout[]>
  ) => void;
};

// Capture the props the grid is rendered with so tests can drive the
// onLayoutChange callback the real react-grid-layout would fire.
const captured = vi.hoisted(() => ({ props: null as MockGridProps | null }));

vi.mock("react-grid-layout", () => {
  function Responsive(props: MockGridProps) {
    captured.props = props;
    return (
      <div
        className={props.className}
        data-draggable-cancel={props.draggableCancel}
        data-draggable-handle={props.draggableHandle}
        data-testid="responsive-grid"
      >
        {props.children}
      </div>
    );
  }

  return {
    Responsive,
    WidthProvider: (Component: ComponentType<MockGridProps>) => Component,
  };
});

const utilizationSections = {
  [InsightsSection.Utilization]: {
    kpis: [
      {
        key: "sessions",
        label: "Sessions",
        value: 42,
        format: KpiFormat.Number,
        sub: "agent sessions run",
        deltaPct: null,
      },
    ],
    charts: {
      eventActivity: { series: [], points: [] },
      reviewQueue: [],
    },
  },
};

function makePins(overrides: Partial<DashboardPins> = {}): DashboardPins {
  return {
    tiles: ["kpi:sessions"],
    layout: {},
    settings: {},
    isPinned: () => true,
    getTileSettings: () => ({}),
    pinTile: vi.fn(),
    replaceTile: vi.fn(),
    unpinTile: vi.fn(),
    togglePin: vi.fn(),
    setTileSettings: vi.fn(),
    setLayout: vi.fn(),
    resetToDefault: vi.fn(),
    ...overrides,
  };
}

describe("DashboardGrid", () => {
  it("marks controls as drag-cancel targets", () => {
    const pins = makePins();

    render(
      <DashboardGrid
        availableSections={[InsightsSection.Utilization]}
        onAddTiles={vi.fn()}
        onEditTile={vi.fn()}
        pins={pins}
        sections={utilizationSections}
      />
    );

    const grid = screen.getByTestId("responsive-grid");
    expect(grid).toHaveClass("insights-dashboard-grid");
    expect(grid).toHaveAttribute(
      "data-draggable-cancel",
      ".insights-widget-control"
    );
    expect(grid).toHaveAttribute(
      "data-draggable-handle",
      ".insights-drag-handle"
    );
    expect(screen.getByLabelText("Edit widget")).toHaveClass(
      "insights-widget-control"
    );
    expect(screen.getByLabelText("Metric details")).toHaveClass(
      "insights-widget-control"
    );
    expect(screen.getByLabelText("Remove widget")).toHaveClass(
      "insights-widget-control"
    );
    expect(
      screen.getByRole("button", { name: "1/2" }).parentElement
    ).toHaveClass("insights-widget-control");
  });

  it("keeps width controls clickable", () => {
    const setLayout = vi.fn();
    const pins = makePins({ setLayout });

    render(
      <DashboardGrid
        availableSections={[InsightsSection.Utilization]}
        onAddTiles={vi.fn()}
        onEditTile={vi.fn()}
        pins={pins}
        sections={utilizationSections}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "1/2" }));

    expect(setLayout).toHaveBeenCalledWith({
      "kpi:sessions": { x: 0, y: 0, w: 6, h: 2 },
    });
  });

  it("persists the lg layout when it changes", () => {
    const setLayout = vi.fn();
    const pins = makePins({ setLayout });

    render(
      <DashboardGrid
        availableSections={[InsightsSection.Utilization]}
        onAddTiles={vi.fn()}
        onEditTile={vi.fn()}
        pins={pins}
        sections={utilizationSections}
      />
    );

    act(() =>
      captured.props?.onLayoutChange?.(
        [{ i: "kpi:sessions", x: 0, y: 0, w: 6, h: 2 }],
        { lg: [{ i: "kpi:sessions", x: 0, y: 0, w: 6, h: 2 }] }
      )
    );

    expect(setLayout).toHaveBeenCalledWith({
      "kpi:sessions": { x: 0, y: 0, w: 6, h: 2 },
    });
  });

  it("ignores collapsed-view edits that leave the lg layout unchanged", () => {
    const setLayout = vi.fn();
    const pins = makePins({
      layout: { "kpi:sessions": { x: 0, y: 0, w: 6, h: 2 } },
      setLayout,
    });

    render(
      <DashboardGrid
        availableSections={[InsightsSection.Utilization]}
        onAddTiles={vi.fn()}
        onEditTile={vi.fn()}
        pins={pins}
        sections={utilizationSections}
      />
    );

    // An edit made in the sm view updates only allLayouts.sm; allLayouts.lg is
    // unchanged, so nothing is persisted — this is what stops the single-column
    // corruption, and it holds regardless of the active breakpoint.
    act(() =>
      captured.props?.onLayoutChange?.(
        [{ i: "kpi:sessions", x: 0, y: 0, w: 1, h: 2 }],
        {
          lg: [{ i: "kpi:sessions", x: 0, y: 0, w: 6, h: 2 }],
          sm: [{ i: "kpi:sessions", x: 0, y: 0, w: 1, h: 2 }],
        }
      )
    );

    expect(setLayout).not.toHaveBeenCalled();
  });
});
