import { BranchKpiState } from "@repo/api/src/types/branch";
import type {
  AgentsInsightsResponse,
  TimeSeries,
} from "@repo/api/src/types/insights";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import { TOTAL_ESTIMATED_COST_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DashboardTileSettings } from "../../hooks/use-dashboard-pins";
import { SECTION_META } from "../../lib/section-meta";
import { MetricPicker } from "../metric-picker";
import type { InsightsSectionData } from "../tile-content";

vi.mock("@repo/design-system/components/ui/time-series-area-chart", () => ({
  TimeSeriesAreaChart: ({ comparisonLabel }: { comparisonLabel?: string }) => (
    <div data-testid="preview-area-chart">
      {`comparison:${comparisonLabel ?? "none"}`}
    </div>
  ),
}));
vi.mock("@repo/design-system/components/ui/category-bar-chart", () => ({
  CategoryBarChart: () => <div data-testid="preview-bar-chart" />,
}));
vi.mock("@repo/design-system/components/ui/donut-chart", () => ({
  DonutChart: () => <div data-testid="preview-donut-chart" />,
}));

const AGENTS_TITLE = SECTION_META[InsightsSection.Agents].title;
const RENDERED_AS_RE = /rendered as/;
const CONNECT_GITHUB_RE = /connect (?:to )?github/i;
const STATUS_PIE_SUMMARY_RE = /rendered as pie grouped by status\.$/;
const HEATMAP_SUMMARY_RE = /rendered as heatmap grouped by date\.$/;
const TABLE_SUMMARY_RE = /rendered as table grouped by reviewer\.$/;
const EMPTY_SURFACE_COPY = "No metrics are available for this surface.";

type PickerProps = ComponentProps<typeof MetricPicker>;

describe("MetricPicker add mode", () => {
  it("opens on the first available metric and pins it with no settings on save", () => {
    const props = renderPicker();

    expect(
      screen.getByRole("heading", { name: "Add metric" })
    ).toBeInTheDocument();
    expect(summaryText()).toBe(
      `${AGENTS_TITLE} Input + output tokens, rendered as card.`
    );
    expect(
      screen.getByRole("combobox", { name: "Group by" })
    ).toHaveTextContent("None");
    expect(
      screen.queryByRole("button", { name: "Remove" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(props.onPinTile).toHaveBeenCalledWith("kpi:tokens", {});
    expect(props.onReplaceTile).not.toHaveBeenCalled();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("offers Remove for an already-pinned selection and unpins that tile", () => {
    const props = renderPicker({
      isPinned: vi.fn((id: string) => id === "kpi:tokens"),
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(props.onUnpinTile).toHaveBeenCalledWith("kpi:tokens");
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("reports an empty surface and disables Save when no section is available", () => {
    renderPicker({ availableSections: [], comparisonAvailable: true });

    expect(screen.getByText(EMPTY_SURFACE_COPY)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Metric" })).toHaveTextContent(
      "Select metric"
    );
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByText("Preview")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove" })
    ).not.toBeInTheDocument();
  });

  it("closes without saving from Cancel", () => {
    const props = renderPicker();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.onPinTile).not.toHaveBeenCalled();
  });
});

describe("MetricPicker selection", () => {
  it("resets group and visualization to the new metric's first valid tile", () => {
    const props = renderPicker();

    pick("Metric", `${AGENTS_TITLE} - ${TOTAL_ESTIMATED_COST_LABEL}`);
    expect(summaryText()).toBe(
      `${AGENTS_TITLE} ${TOTAL_ESTIMATED_COST_LABEL}, rendered as line grouped by model.`
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onPinTile).toHaveBeenLastCalledWith(
      "chart:modelUsageOverTime",
      {}
    );

    pick("Visualization", "Pie");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onPinTile).toHaveBeenLastCalledWith(
      "chart:modelBreakdown:donut",
      {}
    );

    pick("Group by", "Date");
    expect(summaryText()).toBe(
      `${AGENTS_TITLE} ${TOTAL_ESTIMATED_COST_LABEL}, rendered as bar grouped by date.`
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onPinTile).toHaveBeenLastCalledWith(
      "chart:modelUsageOverTime:bar",
      {}
    );
  });

  it("hides Group by for a metric whose only tile is ungrouped", () => {
    renderPicker({ editingTileId: "kpi:input-tokens" });

    expect(summaryText()).toBe(
      `${AGENTS_TITLE} Input tokens, rendered as card.`
    );
    expect(
      screen.queryByRole("combobox", { name: "Group by" })
    ).not.toBeInTheDocument();
  });

  it("shows Group by with the grouping of a grouped tile", () => {
    renderPicker({ editingTileId: "chart:tokenDistribution" });

    expect(
      screen.getByRole("combobox", { name: "Group by" })
    ).toHaveTextContent("Token type");
    expect(summaryText()).toBe(
      `${AGENTS_TITLE} Input + output tokens, rendered as pie grouped by token type.`
    );
  });

  it("offers the Session outcome grouping only while the spend-outcome flag is on", () => {
    const { unmount } = renderPicker(
      { editingTileId: "chart:modelUsageOverTime" },
      [INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY]
    );
    openCombobox("Group by");
    expect(
      screen.getByRole("option", { name: "Session outcome" })
    ).toBeInTheDocument();
    unmount();

    renderPicker({ editingTileId: "chart:modelUsageOverTime" });
    openCombobox("Group by");
    expect(screen.getByRole("option", { name: "Model" })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Session outcome" })
    ).not.toBeInTheDocument();
  });

  // ISS-10636 retired the gate that used to pick between the two spellings, so
  // the picker names the cost series canonically for every reader.
  it("labels the cost metric with the total-estimated-cost phrase", () => {
    renderPicker();
    openCombobox("Metric");
    expect(
      screen.getByRole("option", {
        name: `${AGENTS_TITLE} - ${TOTAL_ESTIMATED_COST_LABEL}`,
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: `${AGENTS_TITLE} - Cost` })
    ).not.toBeInTheDocument();
  });

  it("lists each grouping once even when several tiles share it", () => {
    renderPicker({ editingTileId: "chart:modelUsageOverTime" });

    openCombobox("Group by");

    expect(screen.getAllByRole("option", { name: "Model" })).toHaveLength(1);
    expect(screen.getAllByRole("option", { name: "Date" })).toHaveLength(1);
  });

  it("picks the tile matching both the grouping and the visualization", () => {
    const props = renderPicker({ editingTileId: "chart:agentsByStatus" });

    expect(summaryText()).toMatch(STATUS_PIE_SUMMARY_RE);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(props.onReplaceTile).toHaveBeenCalledWith(
      "chart:agentsByStatus",
      "chart:agentsByStatus",
      {}
    );
  });

  it.each([
    ["chart:eventVolume:heatmap", HEATMAP_SUMMARY_RE],
    ["chart:reviewerLoad", TABLE_SUMMARY_RE],
  ])("names the %s visualization in the summary", (tileId, summary) => {
    renderPicker({
      availableSections: [InsightsSection.Utilization],
      editingTileId: tileId,
    });

    expect(summaryText()).toMatch(summary);
  });

  it("recovers a valid metric when sections change while the dialog is closed", () => {
    const props = buildProps({ open: false });
    const { rerender } = render(wrap(props));

    rerender(
      wrap({
        ...props,
        availableSections: [InsightsSection.Delivery],
      })
    );
    rerender(
      wrap({
        ...props,
        availableSections: [InsightsSection.Delivery],
        open: true,
      })
    );

    expect(summaryText()).toBe(
      `${SECTION_META[InsightsSection.Delivery].title} Pull requests, rendered as card.`
    );
  });

  it("re-seeds the selection from the edited tile when the dialog opens", () => {
    const props = buildProps({
      open: false,
      editingTileId: "chart:tokenDistribution:bar",
    });
    const { rerender } = render(wrap(props));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rerender(wrap({ ...props, open: true }));

    expect(summaryText()).toBe(
      `${AGENTS_TITLE} Input + output tokens, rendered as bar grouped by token type.`
    );
  });
});

describe("MetricPicker edit mode", () => {
  it("replaces the edited tile with the current selection and removes it", () => {
    const props = renderPicker({ editingTileId: "chart:tokenDistribution" });

    expect(
      screen.getByRole("heading", { name: "Edit widget" })
    ).toBeInTheDocument();

    pick("Visualization", "Bar");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onReplaceTile).toHaveBeenCalledWith(
      "chart:tokenDistribution",
      "chart:tokenDistribution:bar",
      {}
    );
    expect(props.onPinTile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(props.onUnpinTile).toHaveBeenCalledWith("chart:tokenDistribution");
  });

  it("falls back to the first available tile when the edited tile's section is unavailable", () => {
    const props = renderPicker({ editingTileId: "chart:prTrend" });

    expect(
      screen.getByRole("heading", { name: "Edit widget" })
    ).toBeInTheDocument();
    expect(summaryText()).toBe(
      `${AGENTS_TITLE} Input + output tokens, rendered as card.`
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onReplaceTile).toHaveBeenCalledWith(
      "chart:prTrend",
      "kpi:tokens",
      {}
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(props.onUnpinTile).toHaveBeenCalledWith("chart:prTrend");
  });
});

describe("MetricPicker comparison overlay", () => {
  it("seeds the overlay from saved settings, feeds the preview, and saves the toggled value", () => {
    const props = renderPicker({
      comparisonAvailable: true,
      comparisonLabel: "Organization",
      comparisonSections: agentsSections(),
      editingTileId: "chart:modelUsageOverTime",
      getTileSettings: vi.fn(
        (): DashboardTileSettings => ({ comparisonOverlay: true })
      ),
    });

    const overlay = screen.getByRole("switch", {
      name: "Overlay Organization trendline",
    });
    expect(overlay).toBeChecked();
    expect(screen.getByTestId("preview-area-chart")).toHaveTextContent(
      "comparison:Organization"
    );

    fireEvent.click(overlay);
    expect(overlay).not.toBeChecked();
    expect(screen.getByTestId("preview-area-chart")).toHaveTextContent(
      "comparison:none"
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onReplaceTile).toHaveBeenLastCalledWith(
      "chart:modelUsageOverTime",
      "chart:modelUsageOverTime",
      { comparisonOverlay: false }
    );

    fireEvent.click(overlay);
    pick("Visualization", "Pie");
    expect(
      screen.queryByRole("switch", { name: "Overlay Organization trendline" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onReplaceTile).toHaveBeenLastCalledWith(
      "chart:modelUsageOverTime",
      "chart:modelBreakdown:donut",
      {}
    );
  });

  it("offers no overlay and saves no overlay setting when comparison is unavailable", () => {
    const props = renderPicker({
      comparisonAvailable: false,
      comparisonLabel: "Organization",
      editingTileId: "chart:modelUsageOverTime",
      getTileSettings: vi.fn(
        (): DashboardTileSettings => ({ comparisonOverlay: true })
      ),
    });

    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-area-chart")).toHaveTextContent(
      "comparison:none"
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onReplaceTile).toHaveBeenCalledWith(
      "chart:modelUsageOverTime",
      "chart:modelUsageOverTime",
      {}
    );
  });
});

describe("MetricPicker comparison overlay defaults", () => {
  it("starts the overlay off for a time-series tile with no saved overlay", () => {
    renderPicker({
      comparisonAvailable: true,
      comparisonLabel: "Organization",
      editingTileId: "chart:modelUsageOverTime",
    });

    expect(
      screen.getByRole("switch", { name: "Overlay Organization trendline" })
    ).not.toBeChecked();
  });
});

describe("MetricPicker preview", () => {
  it("renders the preview through the caller's availability resolver", () => {
    const getTileAvailability = vi.fn(() => ({
      state: BranchKpiState.Gated,
    }));
    renderPicker({
      editingTileId: "chart:modelUsageOverTime",
      getTileAvailability,
      githubConnect: {
        action: GitHubConnectAction.Connect,
        onConnect: vi.fn(),
      },
    });

    expect(
      screen.getByRole("button", { name: CONNECT_GITHUB_RE })
    ).toBeInTheDocument();
    expect(screen.queryByTestId("preview-area-chart")).not.toBeInTheDocument();
    expect(getTileAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ id: "chart:modelUsageOverTime" })
    );
  });
});

function buildProps(overrides: Partial<PickerProps> = {}): PickerProps {
  return {
    open: true,
    onOpenChange: vi.fn(),
    isPinned: vi.fn(() => false),
    onPinTile: vi.fn(),
    onReplaceTile: vi.fn(),
    onUnpinTile: vi.fn(),
    getTileSettings: vi.fn((): DashboardTileSettings => ({})),
    availableSections: [InsightsSection.Agents],
    sections: agentsSections(),
    comparisonAvailable: false,
    ...overrides,
  };
}

function wrap(props: PickerProps, enabledFlags: string[] = []) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <MetricPicker {...props} />
    </FeatureFlagAdapterProvider>
  );
}

function renderPicker(
  overrides: Partial<PickerProps> = {},
  enabledFlags: string[] = []
) {
  const props = buildProps(overrides);
  const result = render(wrap(props, enabledFlags));
  return Object.assign(props, { unmount: result.unmount });
}

function summaryText(): string | null {
  return screen.getByText(RENDERED_AS_RE).textContent;
}

function openCombobox(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name }));
}

function pick(comboboxName: string, optionName: string) {
  openCombobox(comboboxName);
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

function agentsSections(): InsightsSectionData {
  const modelUsageOverTime: TimeSeries = {
    series: [{ key: "opus", label: "Claude Opus" }],
    points: [{ date: "2026-01-01", values: { opus: 4 } }],
  };
  const agents: AgentsInsightsResponse = {
    kpis: [
      {
        key: "tokens",
        label: "Input + output tokens",
        value: 10,
        format: KpiFormat.Number,
        sub: "tokens",
        deltaPct: null,
      },
    ],
    charts: {
      modelUsageOverTime,
      modelBreakdown: [{ key: "opus", label: "Claude Opus", value: 4 }],
      tokenDistribution: [{ key: "input", label: "Input", value: 3 }],
    },
  };
  return { [InsightsSection.Agents]: agents };
}
