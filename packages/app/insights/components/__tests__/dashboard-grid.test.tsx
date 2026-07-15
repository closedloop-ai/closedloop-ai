import { BranchKpiState } from "@repo/api/src/types/branch";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DashboardPins } from "../../hooks/use-dashboard-pins";
import { DashboardGrid } from "../dashboard-grid";
import { getMetricValueRow } from "./metric-card-test-utils";

type GridItemLayout = { i: string; x: number; y: number; w: number; h: number };

const CONNECT_GITHUB_BUTTON_NAME = /connect github/i;
const medianPrSizeValuePattern = /^128\s*lines$/;
const klocMergedValuePattern = /^4.2\s*KLOC$/;

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

const emptyTimeSeries = { series: [], points: [] };
const deliverySectionsWithUnitKpis = {
  [InsightsSection.Delivery]: {
    kpis: [
      {
        key: "pr-size",
        label: "Median PR size",
        value: 128,
        format: KpiFormat.Number,
        sub: "Median changed lines per merged PR",
        deltaPct: null,
      },
      {
        key: "kloc",
        label: "KLOC merged",
        value: 4.2,
        format: KpiFormat.Number,
        sub: "Thousands of lines merged",
        deltaPct: null,
      },
    ],
    charts: {
      prTrend: emptyTimeSeries,
      prByRepo: [],
      meanTimeToMerge: [],
      prByState: [],
      branchLifespan: [],
      branchesWithoutPr: [],
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

  it("renders a connect affordance for gated GitHub tiles instead of zero data", () => {
    const onConnectGitHub = vi.fn();
    const pins = makePins({ tiles: ["kpi:merged"] });

    render(
      <DashboardGrid
        availableSections={[InsightsSection.Delivery]}
        getTileAvailability={() => ({ state: BranchKpiState.Gated })}
        onAddTiles={vi.fn()}
        onConnectGitHub={onConnectGitHub}
        onEditTile={vi.fn()}
        pins={pins}
        sections={{
          [InsightsSection.Delivery]: {
            kpis: [
              {
                key: "merged",
                label: "Merged PRs",
                value: 0,
                format: KpiFormat.Number,
                sub: "pull requests",
                deltaPct: null,
              },
            ],
            charts: {
              prTrend: emptyTimeSeries,
              prByRepo: [],
              meanTimeToMerge: [],
              prByState: [],
              branchLifespan: [],
              branchesWithoutPr: [],
            },
          },
        }}
      />
    );

    expect(
      screen.getByText("Connect GitHub to light up this metric.")
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: CONNECT_GITHUB_BUTTON_NAME })
    );
    expect(onConnectGitHub).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders unavailable GitHub tiles without falling back to zero data", () => {
    const pins = makePins({ tiles: ["kpi:merged"] });

    render(
      <DashboardGrid
        availableSections={[InsightsSection.Delivery]}
        getTileAvailability={() => ({ state: BranchKpiState.Unavailable })}
        onAddTiles={vi.fn()}
        onEditTile={vi.fn()}
        pins={pins}
        sections={{
          [InsightsSection.Delivery]: {
            kpis: [
              {
                key: "merged",
                label: "Merged PRs",
                value: 0,
                format: KpiFormat.Number,
                sub: "pull requests",
                deltaPct: null,
              },
            ],
            charts: {
              prTrend: emptyTimeSeries,
              prByRepo: [],
              meanTimeToMerge: [],
              prByState: [],
              branchLifespan: [],
              branchesWithoutPr: [],
            },
          },
        }}
      />
    );

    expect(
      screen.getByText(
        "This GitHub metric is unavailable for the selected scope."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders unit labels for pinned delivery KPI tiles", () => {
    const pins = makePins({ tiles: ["kpi:pr-size", "kpi:kloc"] });

    render(
      <DashboardGrid
        availableSections={[InsightsSection.Delivery]}
        onAddTiles={vi.fn()}
        onEditTile={vi.fn()}
        pins={pins}
        sections={deliverySectionsWithUnitKpis}
      />
    );

    expect(getMetricValueRow("Median PR size")).toHaveTextContent(
      medianPrSizeValuePattern
    );
    expect(
      within(getMetricValueRow("Median PR size")).getByText("lines")
    ).toBeInTheDocument();
    expect(getMetricValueRow("KLOC merged")).toHaveTextContent(
      klocMergedValuePattern
    );
    expect(
      within(getMetricValueRow("KLOC merged")).getByText("KLOC")
    ).toBeInTheDocument();
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
