import {
  type AgentComponent,
  AgentComponentGroupBy,
  AgentComponentKind,
  AgentMetricMode,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import {
  type AgentSessionUsageSummary,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import {
  LOC_PER_DOLLAR_LABEL,
  LOC_PER_DOLLAR_MERGED_LABEL,
} from "@repo/api/src/utils/loc-per-dollar";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { SessionsSummaryCards } from "../sessions/sessions-summary-cards";
import { AgentsTable } from "../workspace/agents-table";
import { AgentsViewMenu } from "../workspace/agents-view-menu";

/**
 * ISS-4866 — the LOC/$ DISPLAY polish: the retired metric-mode picker, the
 * column's one fixed precision, and the merged-scope Sessions card label.
 *
 * ISS-5366 retired `agents-loc-per-dollar-display` to its enabled state, so
 * these are the unconditional renderings and the flag-off cases are gone. Each
 * case that asserts an ABSENCE is paired with a positive assertion against the
 * same surface, so a component that failed to render cannot satisfy it.
 */

// A genuinely small but non-zero efficiency — ISS-4667's motivating value. The
// column must not floor it to a fabricated "0.00".
const SUB_THRESHOLD_LOC_PER_DOLLAR = 0.0088;
const WHOLE_LOC_PER_DOLLAR = 12;
const METRIC_MODE_VALUE_INDEX_LABEL = "Value Index";
// The `TableViewMenu` trigger, whose default label is "View".
const VIEW_MENU_TRIGGER_NAME = /view/i;

function makeComponent(
  id: string,
  locPerDollar: number | null
): AgentComponent {
  return {
    id,
    slug: `mcp::${id}`,
    name: `Component ${id}`,
    kind: AgentComponentKind.Mcp,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: 10,
    sessions: 3,
    locPerDollar,
    trend: [],
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2020-01-01T00:00:00.000Z",
    lastSeenAt: "2020-06-01T00:00:00.000Z",
  };
}

function renderMetricColumn(items: AgentComponent[]) {
  return render(
    <AppCoreStoryProviders enabledFlags={[]}>
      <AgentsTable
        items={items}
        metricMode={AgentMetricMode.LocPerDollar}
        onSort={vi.fn()}
        sortBy="metric"
        sortDir="desc"
      />
    </AppCoreStoryProviders>
  );
}

function renderViewMenu() {
  return render(
    <AppCoreStoryProviders enabledFlags={[]}>
      <AgentsViewMenu
        groupBy={AgentComponentGroupBy.None}
        onGroupByChange={vi.fn()}
        onReset={vi.fn()}
        onToggleColumn={vi.fn()}
        visibleColumns={new Set<string>()}
      />
    </AppCoreStoryProviders>
  );
}

function mergedUsageFixture(): AgentSessionUsageSummary {
  return {
    viewerScope: AgentSessionViewerScope.Organization,
    totalSessions: 12,
    earliestSessionAt: null,
    latestSessionAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 42,
    subscriptionEstimatedCost: 0,
    apiEstimatedCost: 42,
    byUser: [],
    byModel: [],
    byHarness: [],
    byRepository: [],
    lastSyncTargets: [],
    mergedPrCount: 7,
    mergedLocPerDollar: 3.5,
  };
}

function renderSummaryCards() {
  return render(
    <AppCoreStoryProviders enabledFlags={[]}>
      <SessionsSummaryCards isLoading={false} usage={mergedUsageFixture()} />
    </AppCoreStoryProviders>
  );
}

describe("Agents Metric column precision (ISS-4866 item 2)", () => {
  it("renders one fixed precision across the column", () => {
    renderMetricColumn([
      makeComponent("uuid-whole", WHOLE_LOC_PER_DOLLAR),
      makeComponent("uuid-small", SUB_THRESHOLD_LOC_PER_DOLLAR),
    ]);

    // The reported defect was a column stacking `12` beside `0.0088`.
    expect(screen.getByText("12.00")).toBeInTheDocument();
    expect(screen.getByText("< 0.01")).toBeInTheDocument();
  });

  it("never floors a real sub-threshold value to a fabricated 0.00", () => {
    renderMetricColumn([
      makeComponent("uuid-small", SUB_THRESHOLD_LOC_PER_DOLLAR),
    ]);

    // Positive control: the row rendered the honest sub-threshold marker, so the
    // absence assertion below is about the value and not about an empty table.
    expect(screen.getByText("< 0.01")).toBeInTheDocument();
    expect(screen.queryByText("0.00")).not.toBeInTheDocument();
  });

  it("never renders the ADAPTIVE per-value precision the column replaced", () => {
    // The retired rendering, asserted directly: `12` beside `0.0088` was the
    // reported defect — two shapes with no shared decimal position. A regression
    // to it fails here rather than silently reappearing now that no flag-off
    // case pins it.
    renderMetricColumn([
      makeComponent("uuid-whole", WHOLE_LOC_PER_DOLLAR),
      makeComponent("uuid-small", SUB_THRESHOLD_LOC_PER_DOLLAR),
    ]);

    expect(screen.queryByText("12", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("0.0088")).not.toBeInTheDocument();
  });

  it("still separates an unavailable metric from every real value", () => {
    renderMetricColumn([makeComponent("uuid-none", null)]);

    // Loading/unavailable vs a true zero stays a distinct state: `—`, never a
    // number the row cannot support.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("0.00")).not.toBeInTheDocument();
  });
});

describe("Agents metric-mode picker (ISS-4866 item 1)", () => {
  it("drops the picker whose second option renders the identical value", () => {
    renderViewMenu();

    // Positive control: the view menu itself rendered, so "no combobox" is a
    // statement about the retired picker rather than about an empty subtree.
    expect(
      screen.getByRole("button", { name: VIEW_MENU_TRIGGER_NAME })
    ).toBeInTheDocument();
    expect(
      screen.queryByText(METRIC_MODE_VALUE_INDEX_LABEL)
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("Sessions merged LOC/$ card scope label (ISS-4866 item 3)", () => {
  it("names the population the merged card actually computes", () => {
    renderSummaryCards();

    expect(screen.getByText(LOC_PER_DOLLAR_MERGED_LABEL)).toBeInTheDocument();
    // Built FROM the shared unit constant, so the unit itself cannot drift.
    expect(LOC_PER_DOLLAR_MERGED_LABEL.startsWith(LOC_PER_DOLLAR_LABEL)).toBe(
      true
    );
  });

  it("never renders the bare unit label the merged scope replaced", () => {
    // The retired rendering. `LOC_PER_DOLLAR_LABEL` is a strict prefix of the
    // merged label, so this is asserted with `exact` — otherwise the merged
    // label would satisfy it and the case would prove nothing.
    renderSummaryCards();

    expect(
      screen.queryByText(LOC_PER_DOLLAR_LABEL, { exact: true })
    ).not.toBeInTheDocument();
  });
});
