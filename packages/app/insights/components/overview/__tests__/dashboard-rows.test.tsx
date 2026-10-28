import { BranchKpiState } from "@repo/api/src/types/branch";
import type { KpiStat } from "@repo/api/src/types/insights";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import { TOTAL_ESTIMATED_COST_COPY } from "@repo/api/src/types/total-estimated-cost-copy";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  getMetricValueRow,
  tabTo,
} from "../../__tests__/metric-card-test-utils";
import type { InsightsSectionData } from "../../tile-content";
import { DashboardRowContent } from "../dashboard-rows";
import { DASHBOARD_ROWS } from "../dashboard-tiles";

// The two Sessions-specific phrases that must never reach the Dashboard tooltip:
// this surface has no session filter and renders no caption beneath the number
// (whitlockk review on #4905). Matched as patterns as well as by whole string so a
// reworded Sessions copy that keeps either idea still fails here.
const SESSIONS_FILTERED_COPY_PATTERN = /filtered sessions/i;
const SESSIONS_CAPTION_GLOSS_PATTERN = /caption beneath/i;
// Whole strings AND the two ideas, so a reworded Sessions copy that keeps either
// still fails rather than sliding onto the Dashboard unnoticed.
const SESSIONS_COPY_FORBIDDEN_ON_DASHBOARD = [
  SESSIONS_FILTERED_COPY_PATTERN,
  SESSIONS_CAPTION_GLOSS_PATTERN,
];
const emptySeries = { series: [], points: [] };
const statsRow = DASHBOARD_ROWS.find((row) => row.tour === "stats");
const prsRow = DASHBOARD_ROWS.find((row) => row.tour === "prs");
const distributionRow = DASHBOARD_ROWS.find(
  (row) => row.tour === "distribution"
);
const medianPrSizeValuePattern = /^128\s*lines$/;
const PR_SIZE_UNIT_LABEL = "lines";
const klocMergedValuePattern = /^4.2\s*KLOC$/;
const missingPrSizeValuePattern = /^—$/;
const emptyDashCostValuePattern = /^—$/;
const dollarSignPattern = /\$/;

describe("DashboardRowContent", () => {
  it("uses the catalog's titles in the stats row, not the source's labels (ISS-12638)", () => {
    renderStatsRow();

    expect(screen.getByText("Merged PRs")).toBeInTheDocument();
    // The fixture's producer calls this tile "Captured PRs"; paired with the
    // presence assertion above so the absence cannot pass on an empty row.
    expect(screen.queryByText("Captured PRs")).not.toBeInTheDocument();
  });

  it("renders KPI unit labels in their scoped value rows", () => {
    renderStatsRow();

    expect(getMetricValueRow("Median PR size")).toHaveTextContent(
      medianPrSizeValuePattern
    );
    expect(
      within(getMetricValueRow("Median PR size")).getByText(PR_SIZE_UNIT_LABEL)
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

    const trigger = screen.getByRole("button", { name: "About Merged PRs" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const contentId = trigger.getAttribute("aria-controls");
    const dialog = await screen.findByRole("dialog", {
      name: "About Merged PRs",
    });
    expect(contentId).toBeTruthy();
    expect(dialog).toHaveAttribute("id", contentId);
    expect(dialog).toHaveTextContent("PRs found in local sessions");

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("dialog", { name: "About Merged PRs" })
    ).not.toBeInTheDocument();

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("dialog", { name: "About Merged PRs" })
    ).toHaveTextContent("PRs found in local sessions");

    await user.keyboard("{Escape}");

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("dialog", { name: "About Merged PRs" })
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

    // FEA-3818: the Cost card (shared CostMetricCard) always renders its info
    // control, so it is the first tabbable KPI info button in the stats row.
    // ISS-4995 put the "No comparison" delta chip in the tab order too, so it is
    // no longer the first stop overall — walk to it rather than pinning a count.
    const trigger = screen.getByRole("button", {
      name: `About ${TOTAL_ESTIMATED_COST_COPY.label}`,
    });

    await tabTo(user, trigger);

    expect(trigger).toHaveFocus();
    // ISS-9971 took this ONE tile off the backend `sub` its four rowmates still
    // render: the dollar figure the Dashboard and the Sessions strip both
    // headline gets the one canonical explanation, so the two screens cannot
    // describe it differently.
    expect(
      await screen.findByRole("dialog", {
        name: `About ${TOTAL_ESTIMATED_COST_COPY.label}`,
      })
    ).toHaveTextContent(TOTAL_ESTIMATED_COST_COPY.info.what);

    await user.hover(trigger);
    await user.unhover(trigger);

    expect(
      await screen.findByRole("dialog", {
        name: `About ${TOTAL_ESTIMATED_COST_COPY.label}`,
      })
    ).toBeInTheDocument();

    await user.tab();

    expect(
      screen.queryByRole("dialog", {
        name: `About ${TOTAL_ESTIMATED_COST_COPY.label}`,
      })
    ).not.toBeInTheDocument();
  });

  it("opens KPI descriptions from a touch pointer", async () => {
    renderStatsRow();

    const trigger = screen.getByRole("button", { name: "About KLOC merged" });

    // A real tap fires pointerdown then a click; together they open it once.
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("dialog", { name: "About KLOC merged" })
    ).toHaveTextContent("Thousands of lines merged");
  });

  // ISS-9971 / ISS-10636: this tile no longer consults the producer's `sub` at
  // all — it resolves the one canonical dollar copy, the same words the Sessions
  // card renders, so the two screens cannot spell one figure two ways. The two
  // degenerate producer shapes stay as counterfactuals: a tile that reverted to
  // reading `sub`, or to a per-surface fallback, would redden here.
  //
  // Both are type-legal: `sub` is a required `string` on the wire contract, so
  // the reachable falsy case is a BLANK one from a version-skewed or incomplete
  // producer, not `undefined`. The KPI going missing entirely is the other.
  it("states the canonical dollar copy when the backend sends a blank `sub`", async () => {
    const dialog = await openDashboardCostInfoDialog((kpis) =>
      kpis.map((kpi) => (kpi.key === "cost" ? { ...kpi, sub: "" } : kpi))
    );

    expect(dialog).toHaveTextContent(TOTAL_ESTIMATED_COST_COPY.info.what);
    for (const sessionsCopy of SESSIONS_COPY_FORBIDDEN_ON_DASHBOARD) {
      expect(dialog).not.toHaveTextContent(sessionsCopy);
    }
  });

  it("states the canonical dollar copy when the Cost KPI is missing entirely", async () => {
    const dialog = await openDashboardCostInfoDialog((kpis) =>
      kpis.filter((kpi) => kpi.key !== "cost")
    );

    expect(dialog).toHaveTextContent(TOTAL_ESTIMATED_COST_COPY.info.what);
    for (const sessionsCopy of SESSIONS_COPY_FORBIDDEN_ON_DASHBOARD) {
      expect(dialog).not.toHaveTextContent(sessionsCopy);
    }
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
    expect(
      within(valueRow).queryByText(PR_SIZE_UNIT_LABEL)
    ).not.toBeInTheDocument();
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

    // The gated stats-row tile renders the `card` placement's inline ask.
    // `renderStatsRow` hands the row a live connect target, so the CTA label is
    // what proves the override reached the tile. Read from the copy map's card
    // entry (ISS-11476) rather than spelled here, so a reworded ask cannot leave
    // this case asserting a string the product no longer says.
    expect(
      screen.getByRole("button", {
        name:
          GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].cardCtaLabel ??
          GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].ctaLabel,
      })
    ).toBeInTheDocument();
  });

  it("uses the narrow-safe five-card grid for stats row KPI cards", () => {
    const { container } = renderStatsRow();
    // The stats row now always carries its staleness disclosure above the grid
    // (ISS-10414 review thread), so the grid is no longer the root element.
    // Same expectation, located by its own class rather than by position.
    const grid = container.querySelector(".grid");

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

  it("renders the Cost KPI via the shared CostMetricCard: whole-dollar value + the canonical dollar copy", async () => {
    const user = userEvent.setup();
    renderStatsRow();

    // Whole-dollar headline (formatCurrencyWhole), same as the Sessions card.
    const costCard = screen
      .getByText(TOTAL_ESTIMATED_COST_COPY.label)
      .closest('[data-slot="card"]');
    expect(costCard).toBeTruthy();
    expect(
      costCard!.querySelector('[data-slot="card-title"]')!.textContent
    ).toContain("$9,061");

    // ISS-9971: the canonical dollar copy, not the backend `kpi.sub` the four
    // rowmates render — the one explanation of the one figure.
    await user.click(
      screen.getByRole("button", {
        name: `About ${TOTAL_ESTIMATED_COST_COPY.label}`,
      })
    );
    expect(
      await screen.findByRole("dialog", {
        name: `About ${TOTAL_ESTIMATED_COST_COPY.label}`,
      })
    ).toHaveTextContent(TOTAL_ESTIMATED_COST_COPY.info.what);
  });

  it("renders the honest-empty '—' for the Cost KPI when its value is unavailable (FEA-3818)", () => {
    const delivery = sections[InsightsSection.Delivery];
    if (!delivery) {
      throw new Error("delivery section fixture is missing");
    }
    renderStatsRow({
      sections: {
        ...sections,
        [InsightsSection.Delivery]: {
          ...delivery,
          kpis: delivery.kpis.map((kpi) =>
            kpi.key === "cost" ? { ...kpi, value: null } : kpi
          ),
        },
      },
    });

    const valueRow = getMetricValueRow(TOTAL_ESTIMATED_COST_COPY.label);
    expect(valueRow).toHaveTextContent(emptyDashCostValuePattern);
    expect(within(valueRow).queryByText(dollarSignPattern)).toBeNull();
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
      gates={{ agentCollaborationNetwork: true }}
      getTileAvailability={getTileAvailability}
      githubConnect={{
        action: GitHubConnectAction.Connect,
        onConnect: vi.fn(),
      }}
      heatmap={undefined}
      modelSeries={undefined}
      row={statsRow}
      sections={renderSections}
    />
  );
}

/**
 * Drives the Dashboard Cost card's fallback-`info` path and asserts it renders
 * THIS surface's copy (whitlockk review on #4905).
 *
 * The reachable gap: `OverviewCostKpiCard` passes `info={undefined}` when the
 * Cost KPI or its `sub` is falsy, and `CostMetricCard`'s `info` DEFAULT is the
 * Sessions copy. Sessions itself always passes `info` explicitly (from
 * `resolveCostCardPresentation`), so this is the ONLY production path that
 * reaches that default — and before the fix it rendered a Dashboard tooltip
 * about "filtered sessions" plus a caption this surface never draws.
 *
 * `mutateKpis` picks which falsy branch to drive. Both callers stay type-legal:
 * `sub` is a REQUIRED `string` on the wire contract, so the reachable blank case
 * is `""` from a version-skewed or incomplete producer, never `undefined`.
 *
 * Returns the opened info dialog so each caller asserts in its own test body —
 * `expect` inside this helper would be a misplaced assertion.
 */
async function openDashboardCostInfoDialog(
  mutateKpis: (kpis: KpiStat[]) => KpiStat[]
) {
  const user = userEvent.setup();
  const delivery = sections[InsightsSection.Delivery];
  if (!delivery) {
    throw new Error("delivery section fixture is missing");
  }

  renderStatsRow({
    sections: {
      ...sections,
      [InsightsSection.Delivery]: {
        ...delivery,
        kpis: mutateKpis(delivery.kpis),
      },
    },
  });

  const trigger = screen.getByRole("button", {
    name: `About ${TOTAL_ESTIMATED_COST_COPY.label}`,
  });
  await user.click(trigger);
  return await screen.findByRole("dialog", {
    name: `About ${TOTAL_ESTIMATED_COST_COPY.label}`,
  });
}

function renderDashboardRow(row: NonNullable<typeof statsRow>) {
  // The PR-by-repository tile now reads the `emergent` flag for its segment
  // drilldown (FEA-2993); mount a static adapter (flag off = prior rendering) so
  // the feature-flag hook resolves in this unit test.
  return render(
    <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
      <DashboardRowContent
        autonomySeries={undefined}
        gates={{ agentCollaborationNetwork: true }}
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
        // FEA-3818: the Cost KPI is always emitted by the insights service, so
        // the dashboard cost card (now the shared CostMetricCard) always renders
        // its info control — mirror that here so tab-order/label assertions match
        // production.
        key: "cost",
        label: "Cost",
        value: 9061,
        format: KpiFormat.Currency,
        sub: "estimated cost in range, including subscription-covered usage",
        deltaPct: null,
      },
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

const agentPipelineRow = DASHBOARD_ROWS.find(
  (row) => row.tour === "agent-pipeline"
);
const sampleAgentPipeline = {
  nodes: [
    {
      subagentType: "planner",
      total: 12,
      completed: 11,
      errors: 1,
      sessions: 8,
      successRate: 92,
      avgDuration: 120,
      trend: [],
    },
    {
      subagentType: "reviewer",
      total: 9,
      completed: 9,
      errors: 0,
      sessions: 7,
      successRate: 100,
      avgDuration: 90,
      trend: [],
    },
  ],
  edges: [{ source: "planner", target: "reviewer", weight: 5 }],
};

function renderAgentPipelineRow(props: {
  agentPipeline?: typeof sampleAgentPipeline;
  // ISS-5061 re-gate: defaults to the gate OPEN so the FEA-3537 rendering tests
  // below keep testing rendering. The gate itself is covered explicitly.
  agentCollaborationNetwork?: boolean;
}) {
  if (!agentPipelineRow) {
    throw new Error("agent-pipeline row fixture is missing");
  }
  return render(
    <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
      <DashboardRowContent
        agentPipeline={props.agentPipeline}
        autonomySeries={undefined}
        gates={{
          agentCollaborationNetwork: props.agentCollaborationNetwork ?? true,
        }}
        heatmap={undefined}
        modelSeries={undefined}
        row={agentPipelineRow}
        sections={sections}
      />
    </FeatureFlagAdapterProvider>
  );
}

describe("DashboardRowContent — agent-pipeline row (FEA-3537)", () => {
  it("shows an empty state when there is no data", () => {
    renderAgentPipelineRow({});

    expect(
      screen.getByText("No agent collaboration data for this period yet.")
    ).toBeInTheDocument();
    // FEA-4016: the empty branch still draws the "Agent Collaboration Network"
    // header. The card is flagged `contentHasOwnTitle`, so without a header here
    // the collapsed grid card would be anonymous and the expanded modal would
    // have no visible title at all. The header must hold on BOTH branches.
    expect(
      screen.getByRole("heading", { name: "Agent Collaboration Network" })
    ).toBeInTheDocument();
  });

  it("renders the agent collaboration graph when there is data", () => {
    renderAgentPipelineRow({ agentPipeline: sampleAgentPipeline });

    expect(screen.getByText("Agent Collaboration Network")).toBeInTheDocument();
    expect(
      screen.queryByText("No agent collaboration data for this period yet.")
    ).not.toBeInTheDocument();
  });

  // ISS-5061 re-gate (reverses ISS-5280 for this one flag). The render boundary
  // is the second half of the gate: `dashboardRowsFor` drops the row from the
  // order, and this stops a caller that maps `DASHBOARD_ROWS` directly from
  // drawing the card anyway. Driven WITH data present, so the absence can only
  // come from the gate and never from the empty branch.
  it("renders NOTHING when the gate is closed, even with data", () => {
    const { container } = renderAgentPipelineRow({
      agentCollaborationNetwork: false,
      agentPipeline: sampleAgentPipeline,
    });

    expect(container).toBeEmptyDOMElement();
    // Specifically NOT the graph's own empty state: that would claim there is
    // no data when the feature is merely off.
    expect(
      screen.queryByText("No agent collaboration data for this period yet.")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Agent Collaboration Network" })
    ).not.toBeInTheDocument();
  });

  it("renders the row when the gate is open", () => {
    renderAgentPipelineRow({
      agentCollaborationNetwork: true,
      agentPipeline: sampleAgentPipeline,
    });

    expect(
      screen.getByRole("heading", { name: "Agent Collaboration Network" })
    ).toBeInTheDocument();
  });
});

const frustrationRow = DASHBOARD_ROWS.find((row) => row.tour === "frustration");
const sampleFrustrationSeries = {
  series: [{ key: "frustration", label: "Frustration" }],
  points: [
    { date: "2026-06-08", values: { frustration: 100 } },
    { date: "2026-06-09", values: { frustration: 25 } },
  ],
};

function renderFrustrationRow(props: {
  frustrationSeries?: typeof sampleFrustrationSeries;
}) {
  if (!frustrationRow) {
    throw new Error("frustration row fixture is missing");
  }
  // The frustration chart is the shared @repo/app component consumed by BOTH the
  // web shell and the desktop renderer, so this row render proves the same
  // surface renders on both (web+desktop parity, FEA-4022).
  return render(
    <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
      <DashboardRowContent
        autonomySeries={undefined}
        frustrationSeries={props.frustrationSeries}
        gates={{ agentCollaborationNetwork: true }}
        heatmap={undefined}
        modelSeries={undefined}
        row={frustrationRow}
        sections={sections}
      />
    </FeatureFlagAdapterProvider>
  );
}

describe("DashboardRowContent — frustration row (FEA-4022)", () => {
  it("is a registered dashboard row", () => {
    expect(frustrationRow).toBeDefined();
  });

  it("renders the Frustration Over Time card when the series is present", () => {
    renderFrustrationRow({ frustrationSeries: sampleFrustrationSeries });

    expect(screen.getByText("Frustration Over Time")).toBeInTheDocument();
  });

  it("still renders the titled card (with a loading skeleton) when the series is absent", () => {
    const { container } = renderFrustrationRow({
      frustrationSeries: undefined,
    });

    expect(screen.getByText("Frustration Over Time")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  });

  it("does not render a skeleton when the frustration series is present", () => {
    const { container } = renderFrustrationRow({
      frustrationSeries: sampleFrustrationSeries,
    });

    expect(screen.getByText("Frustration Over Time")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });
});
