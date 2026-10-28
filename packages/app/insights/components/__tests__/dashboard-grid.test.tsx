import { BranchKpiState } from "@repo/api/src/types/branch";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { GitHubConnectAction } from "../../../github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "../../../github/lib/github-connect-copy";
import type {
  DashboardPins,
  GridPosition,
} from "../../hooks/use-dashboard-pins";
import { gridLayoutSchema } from "../../lib/dashboard-schema";
import { DashboardGrid } from "../dashboard-grid";
import { getMetricValueRow } from "./metric-card-test-utils";

type GridItemLayout = { i: string; x: number; y: number; w: number; h: number };

const CONNECT_GITHUB_BUTTON_NAME = /connect (?:to )?github/i;
const medianPrSizeValuePattern = /^128\s*lines$/;
const klocMergedValuePattern = /^4.2\s*KLOC$/;

type MockGridProps = {
  children?: ReactNode;
  className?: string;
  dragConfig?: { handle?: string; cancel?: string; bounded?: boolean };
  layouts?: Record<string, GridItemLayout[]>;
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
        data-draggable-cancel={props.dragConfig?.cancel}
        data-draggable-handle={props.dragConfig?.handle}
        data-testid="responsive-grid"
      >
        {props.children}
      </div>
    );
  }

  return {
    Responsive,
    // v2 replaces WidthProvider with a hook; return a measured, mounted state
    // so the grid renders synchronously in tests.
    useContainerWidth: () => ({
      width: 1200,
      mounted: true,
      containerRef: { current: null },
      measureWidth: () => {
        // no-op in tests
      },
    }),
    verticalCompactor: () => [],
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
        githubConnect={{
          action: GitHubConnectAction.Connect,
          onConnect: onConnectGitHub,
        }}
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

    // ISS-7866: a gated TILE renders the CTA alone — the explanation sentence
    // this used to assert is deliberately gone from the `card` variant, which is
    // what `InsightsTile` mounts. The honesty half of the case is unchanged and
    // still asserted: a live control, and no fabricated `0` under it.
    expect(
      screen.queryByText(
        GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].gatedMetricExplanation
      )
    ).not.toBeInTheDocument();
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

  it("renders a tile whose stored position was corrupt at its authored height on lg and md", () => {
    // ISS-8738: the schema drops the h:0 entry, so buildLayout falls back to
    // the tile's authored grid on every breakpoint — not only the sm path,
    // which already floored h at 1.
    const pins = makePins({
      layout: gridLayoutSchema.parse({
        "kpi:sessions": { x: 0, y: 0, w: 12, h: 0 },
      }),
    });
    expect(pins.layout).toEqual({});

    render(
      <DashboardGrid
        availableSections={[InsightsSection.Utilization]}
        onAddTiles={vi.fn()}
        onEditTile={vi.fn()}
        pins={pins}
        sections={utilizationSections}
      />
    );

    for (const breakpoint of ["lg", "md"] as const) {
      const items = captured.props?.layouts?.[breakpoint] ?? [];
      expect(items.map((item) => item.i)).toEqual(["kpi:sessions"]);
      for (const item of items) {
        expect(item.h).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("never folds back a position the stored-layout guard would drop", () => {
    // marisolashgrove (#6698): `setLayout` writes straight through, so the ingress
    // guard is only worth what the write path feeds it. Fold the grid's OWN
    // emitted lg layout back — starting from a store whose only entry was
    // corrupt — and require the result to survive a re-read unchanged. A
    // producer that ever emits a sub-1 or fractional height reds this instead
    // of costing the user their saved position on the next load.
    let persisted: Record<string, GridPosition> | undefined;
    const pins = makePins({
      layout: gridLayoutSchema.parse({
        "kpi:sessions": { x: 0, y: 0, w: 12, h: 0 },
      }),
      setLayout: (next) => {
        persisted = next;
      },
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

    const lgItems = captured.props?.layouts?.lg ?? [];
    expect(lgItems.length).toBeGreaterThan(0);

    act(() => captured.props?.onLayoutChange?.(lgItems, { lg: lgItems }));

    expect(persisted).toBeDefined();
    expect(gridLayoutSchema.parse(persisted)).toEqual(persisted);
    for (const position of Object.values(persisted ?? {})) {
      expect(position.h).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps the saved position of a still-pinned tile the grid did not render", () => {
    // whitlockk (#4282): the grid lays out only VISIBLE tiles, so a tile that is
    // still pinned but hidden this pass — behind a feature flag, or belonging to
    // a section this shell cannot populate — contributes nothing to the layout
    // react-grid-layout hands back. Persisting that layout wholesale deleted the
    // hidden tile's saved position, silently moving it when it came back.
    const setLayout = vi.fn();
    const pins = makePins({
      tiles: ["kpi:sessions", "chart:prTrend"],
      layout: {
        "kpi:sessions": { x: 0, y: 0, w: 6, h: 2 },
        "chart:prTrend": { x: 6, y: 0, w: 6, h: 4 },
      },
      setLayout,
    });

    render(
      // Delivery is NOT available here, so "chart:prTrend" stays pinned but is
      // never rendered.
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
        [{ i: "kpi:sessions", x: 3, y: 1, w: 6, h: 2 }],
        { lg: [{ i: "kpi:sessions", x: 3, y: 1, w: 6, h: 2 }] }
      )
    );

    expect(setLayout).toHaveBeenCalledWith({
      "kpi:sessions": { x: 3, y: 1, w: 6, h: 2 },
      "chart:prTrend": { x: 6, y: 0, w: 6, h: 4 },
    });
  });

  it("drops the saved position of a tile that is no longer pinned", () => {
    // The other half of the merge: unpinning IS when a saved position should be
    // forgotten, so the map cannot grow without bound as tiles come and go.
    const setLayout = vi.fn();
    const pins = makePins({
      tiles: ["kpi:sessions"],
      layout: {
        "kpi:sessions": { x: 0, y: 0, w: 6, h: 2 },
        "chart:prTrend": { x: 6, y: 0, w: 6, h: 4 },
      },
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

    act(() =>
      captured.props?.onLayoutChange?.(
        [{ i: "kpi:sessions", x: 3, y: 1, w: 6, h: 2 }],
        { lg: [{ i: "kpi:sessions", x: 3, y: 1, w: 6, h: 2 }] }
      )
    );

    expect(setLayout).toHaveBeenCalledWith({
      "kpi:sessions": { x: 3, y: 1, w: 6, h: 2 },
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

/**
 * ISS-9749. The gate is spent on the tile LIST, before `buildLayout` and before
 * the children map, because a `KpiMetricTile` that returns null still leaves the
 * grid a keyed, sized, draggable cell — a resizable hole where a card used to be
 * (whitlockk review on #6914).
 */
describe("DashboardGrid under metric-card-hide-unavailable", () => {
  it("builds no grid cell and no layout track for a retired tile", () => {
    const { container } = renderGatedGrid({
      hide: true,
      klocValue: null,
    });

    expect(container.querySelector('[data-tile-id="kpi:kloc"]')).toBeNull();
    expect(
      container.querySelector('[data-tile-id="kpi:pr-size"]')
    ).not.toBeNull();
    expect(captured.props?.layouts?.lg?.map((item) => item.i)).toEqual([
      "kpi:pr-size",
    ]);
  });

  it("keeps that same tile with the gate off", () => {
    const { container } = renderGatedGrid({ hide: false, klocValue: null });

    expect(container.querySelector('[data-tile-id="kpi:kloc"]')).not.toBeNull();
  });

  /**
   * ISS-9730 acceptance 3, which the grid spends through the same shared policy:
   * a dashboard whose every pinned tile is absent keeps its tiles rather than
   * collapsing to a bare canvas.
   */
  it("keeps every cell when every pinned tile would be retired", () => {
    const { container } = renderGatedGrid({
      hide: true,
      klocValue: null,
      prSizeValue: null,
    });

    expect(container.querySelector('[data-tile-id="kpi:kloc"]')).not.toBeNull();
    expect(
      container.querySelector('[data-tile-id="kpi:pr-size"]')
    ).not.toBeNull();
  });

  /**
   * Sections resolve independently, so a tile whose section has not arrived yet
   * reads as an absent KPI. Retiring it there makes the tile vanish and pop back
   * when its query lands; only a section that actually loaded can retire a tile.
   */
  it("keeps a tile whose section has not loaded while retiring a loaded absent one", () => {
    const { container } = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY],
        })}
      >
        <DashboardGrid
          availableSections={[
            InsightsSection.Delivery,
            InsightsSection.Utilization,
          ]}
          onAddTiles={vi.fn()}
          onEditTile={vi.fn()}
          pins={makePins({
            tiles: ["kpi:pr-size", "kpi:kloc", "kpi:sessions"],
          })}
          sections={{
            [InsightsSection.Delivery]: {
              ...deliverySectionsWithUnitKpis[InsightsSection.Delivery],
              kpis: [
                {
                  ...deliverySectionsWithUnitKpis[InsightsSection.Delivery]
                    .kpis[0],
                  value: 128,
                },
                {
                  ...deliverySectionsWithUnitKpis[InsightsSection.Delivery]
                    .kpis[1],
                  value: null,
                },
              ],
            },
          }}
        />
      </FeatureFlagAdapterProvider>
    );

    expect(container.querySelector('[data-tile-id="kpi:kloc"]')).toBeNull();
    expect(
      container.querySelector('[data-tile-id="kpi:sessions"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-tile-id="kpi:pr-size"]')
    ).not.toBeNull();
  });
});

function renderGatedGrid({
  hide,
  klocValue,
  prSizeValue = 128,
}: {
  hide: boolean;
  klocValue: number | null;
  prSizeValue?: number | null;
}) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: hide
          ? [METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      <DashboardGrid
        availableSections={[InsightsSection.Delivery]}
        onAddTiles={vi.fn()}
        onEditTile={vi.fn()}
        pins={makePins({ tiles: ["kpi:pr-size", "kpi:kloc"] })}
        sections={{
          [InsightsSection.Delivery]: {
            ...deliverySectionsWithUnitKpis[InsightsSection.Delivery],
            kpis: [
              {
                ...deliverySectionsWithUnitKpis[InsightsSection.Delivery]
                  .kpis[0],
                value: prSizeValue,
              },
              {
                ...deliverySectionsWithUnitKpis[InsightsSection.Delivery]
                  .kpis[1],
                value: klocValue,
              },
            ],
          },
        }}
      />
    </FeatureFlagAdapterProvider>
  );
}
