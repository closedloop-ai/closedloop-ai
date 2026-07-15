import { BranchKpiState } from "@repo/api/src/types/branch";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { getMetricValueRow } from "../../__tests__/metric-card-test-utils";
import type { InsightsSectionData } from "../../tile-content";
import { DashboardRowContent } from "../dashboard-rows";
import { DASHBOARD_ROWS } from "../dashboard-tiles";

const emptySeries = { series: [], points: [] };
const statsRow = DASHBOARD_ROWS.find((row) => row.tour === "stats");
const prsRow = DASHBOARD_ROWS.find((row) => row.tour === "prs");
const distributionRow = DASHBOARD_ROWS.find(
  (row) => row.tour === "distribution"
);
const medianPrSizeValuePattern = /^128\s*lines$/;
const klocMergedValuePattern = /^4.2\s*KLOC$/;
const missingPrSizeValuePattern = /^—$/;

describe("DashboardRowContent", () => {
  it("uses source-owned KPI labels in the stats row", () => {
    renderStatsRow();

    expect(screen.getByText("Captured PRs")).toBeInTheDocument();
  });

  it("renders KPI unit labels in their scoped value rows", () => {
    renderStatsRow();

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

  it("moves KPI descriptions behind accessible info controls", async () => {
    const user = userEvent.setup();
    renderStatsRow();

    expect(
      screen.queryByText("PRs found in local sessions")
    ).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "About Captured PRs" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const contentId = trigger.getAttribute("aria-controls");
    const dialog = await screen.findByRole("dialog", {
      name: "About Captured PRs",
    });
    expect(contentId).toBeTruthy();
    expect(dialog).toHaveAttribute("id", contentId);
    expect(dialog).toHaveTextContent("PRs found in local sessions");

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("dialog", { name: "About Captured PRs" })
    ).not.toBeInTheDocument();

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("dialog", { name: "About Captured PRs" })
    ).toHaveTextContent("PRs found in local sessions");

    await user.keyboard("{Escape}");

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("dialog", { name: "About Captured PRs" })
    ).not.toBeInTheDocument();
  });

  it("opens KPI descriptions on hover and closes them on outside interaction", async () => {
    const user = userEvent.setup();
    renderStatsRow();

    const trigger = screen.getByRole("button", {
      name: "About Median PR size",
    });

    await user.hover(trigger);

    expect(
      await screen.findByRole("dialog", { name: "About Median PR size" })
    ).toHaveTextContent("Median changed lines per merged PR");

    await user.unhover(trigger);

    expect(
      screen.queryByRole("dialog", { name: "About Median PR size" })
    ).not.toBeInTheDocument();

    await user.click(trigger);
    expect(
      await screen.findByRole("dialog", { name: "About Median PR size" })
    ).toBeInTheDocument();

    await user.unhover(trigger);

    expect(
      await screen.findByRole("dialog", { name: "About Median PR size" })
    ).toBeInTheDocument();

    await user.click(document.body);

    expect(
      screen.queryByRole("dialog", { name: "About Median PR size" })
    ).not.toBeInTheDocument();
  });

  it("keeps focus-opened KPI descriptions available through pointer movement", async () => {
    const user = userEvent.setup();
    renderStatsRow();

    const trigger = screen.getByRole("button", { name: "About Captured PRs" });

    await user.tab();

    expect(trigger).toHaveFocus();
    expect(
      await screen.findByRole("dialog", { name: "About Captured PRs" })
    ).toHaveTextContent("PRs found in local sessions");

    await user.hover(trigger);
    await user.unhover(trigger);

    expect(
      await screen.findByRole("dialog", { name: "About Captured PRs" })
    ).toBeInTheDocument();

    await user.tab();

    expect(
      screen.queryByRole("dialog", { name: "About Captured PRs" })
    ).not.toBeInTheDocument();
  });

  it("opens KPI descriptions from a touch pointer", async () => {
    renderStatsRow();

    const trigger = screen.getByRole("button", { name: "About KLOC merged" });

    fireEvent.pointerDown(trigger, { pointerType: "touch" });

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("dialog", { name: "About KLOC merged" })
    ).toHaveTextContent("Thousands of lines merged");
  });

  it("omits KPI unit labels when the metric is missing", () => {
    const delivery = sections[InsightsSection.Delivery];
    if (!delivery) {
      throw new Error("delivery section fixture is missing");
    }

    renderStatsRow({
      sections: {
        ...sections,
        [InsightsSection.Delivery]: {
          ...delivery,
          kpis: delivery.kpis.filter((kpi) => kpi.key !== "pr-size"),
        },
      },
    });

    const valueRow = getMetricValueRow("Median PR size");
    expect(valueRow).toHaveTextContent(missingPrSizeValuePattern);
    expect(within(valueRow).queryByText("lines")).not.toBeInTheDocument();
  });

  it("renders availability overrides for gated stats-row tiles", () => {
    renderStatsRow({
      getTileAvailability: (tile) => ({
        state:
          tile.id === "kpi:merged"
            ? BranchKpiState.Gated
            : BranchKpiState.Available,
      }),
    });

    expect(
      screen.getByText("Connect GitHub to light up this metric.")
    ).toBeInTheDocument();
  });

  it("uses the narrow-safe five-card grid for stats row KPI cards", () => {
    const { container } = renderStatsRow();
    const grid = container.firstElementChild;

    expect(grid).toHaveClass("grid-cols-1", "lg:grid-cols-3", "xl:grid-cols-5");
    expect(grid).not.toHaveClass("grid-cols-2");
    expect(grid?.querySelectorAll('[data-slot="card"]')).toHaveLength(5);
  });

  it("renders the PR throughput row as a single full-width chart", () => {
    if (!prsRow) {
      throw new Error("prs row fixture is missing");
    }

    const { container } = renderDashboardRow(prsRow);
    const grid = container.firstElementChild;

    expect(prsRow.tileIds).toEqual(["chart:prTrend"]);
    expect(grid).toHaveClass("grid", "gap-3");
    expect(grid).not.toHaveClass("lg:grid-cols-3");
    expect(grid).not.toHaveClass("lg:grid-cols-2");
    expect(grid?.children).toHaveLength(1);
    expect(grid?.firstElementChild).not.toHaveClass("lg:col-span-2");
  });

  it("renders model spend and PR repository breakdown as an even distribution row", () => {
    if (!distributionRow) {
      throw new Error("distribution row fixture is missing");
    }

    const { container } = renderDashboardRow(distributionRow);
    const grid = container.firstElementChild;

    expect(distributionRow.tileIds).toEqual([
      "chart:modelBreakdown",
      "chart:prByRepo",
    ]);
    expect(grid).toHaveClass("grid", "gap-3", "lg:grid-cols-2");
    expect(grid?.children).toHaveLength(2);
    expect(grid?.firstElementChild).not.toHaveClass("lg:col-span-2");
  });
});

function renderStatsRow({
  getTileAvailability,
  sections: renderSections = sections,
}: {
  getTileAvailability?: Parameters<
    typeof DashboardRowContent
  >[0]["getTileAvailability"];
  sections?: InsightsSectionData;
} = {}) {
  if (!statsRow) {
    throw new Error("stats row fixture is missing");
  }
  return render(
    <DashboardRowContent
      autonomySeries={undefined}
      getTileAvailability={getTileAvailability}
      heatmap={undefined}
      modelSeries={undefined}
      onConnectGitHub={vi.fn()}
      row={statsRow}
      sections={renderSections}
    />
  );
}

function renderDashboardRow(row: NonNullable<typeof statsRow>) {
  // The PR-by-repository tile now reads the `emergent` flag for its segment
  // drilldown (FEA-2993); mount a static adapter (flag off = prior rendering) so
  // the feature-flag hook resolves in this unit test.
  return render(
    <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
      <DashboardRowContent
        autonomySeries={undefined}
        getTileAvailability={undefined}
        heatmap={undefined}
        modelSeries={undefined}
        row={row}
        sections={sections}
      />
    </FeatureFlagAdapterProvider>
  );
}

const sections: InsightsSectionData = {
  [InsightsSection.Delivery]: {
    kpis: [
      {
        key: "merged",
        label: "Captured PRs",
        value: 12,
        format: KpiFormat.Number,
        sub: "PRs found in local sessions",
        deltaPct: null,
      },
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
      prTrend: emptySeries,
      prByRepo: [],
      meanTimeToMerge: [],
      prByState: [],
      branchLifespan: [],
      branchesWithoutPr: [],
    },
  },
  [InsightsSection.Utilization]: {
    kpis: [],
    charts: {
      eventActivity: emptySeries,
      reviewQueue: [],
    },
  },
  [InsightsSection.Agents]: {
    kpis: [],
    charts: {
      modelUsageOverTime: emptySeries,
      modelBreakdown: [],
    },
  },
};
