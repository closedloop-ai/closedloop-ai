/**
 * ISS-9842: what the two capped donut tiles hand `DonutChart` once their
 * buckets carry a population, and what they hand it when they do not.
 *
 * `DonutChart` is mocked to capture its props — the component's own behavior is
 * pinned in `@repo/design-system`'s residual-wedge suite. What is under test
 * here is the WIRING: the population is read off the buckets, the omitted count
 * is derived from it, and the tile's own noun names the residual. The two
 * payload shapes are paired against the SAME tile descriptor on purpose: the
 * desktop in Cloud mode (signed in and online) receives the cloud producer's
 * shape, which does not cap and carries no population, so the residual is a
 * Local-mode-only render and a reader must not assume otherwise.
 */

import { SpendOutcome } from "@closedloop-ai/loops-api/insights";
import type { CategoryBucket } from "@repo/api/src/types/insights";
import { InsightsSection } from "@repo/api/src/types/insights";
import type { CategoryDatum } from "@repo/design-system/components/ui/category-bar-chart";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTile, type TileDescriptor } from "../../lib/tile-catalog";
import { InsightsChartContent } from "../tile-content";

type DonutProps = {
  data: CategoryDatum[];
  total?: number;
  omittedCount?: number;
  otherSeriesLabel?: string;
};

const captured = vi.hoisted(() => ({
  donut: undefined as DonutProps | undefined,
  bar: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@repo/design-system/components/ui/donut-chart", () => ({
  DonutChart: (props: DonutProps) => {
    captured.donut = props;
    return <div data-testid="mock-donut-chart" />;
  },
}));

vi.mock("@repo/design-system/components/ui/category-bar-chart", () => ({
  CategoryBarChart: (props: Record<string, unknown>) => {
    captured.bar = props;
    return <div data-testid="mock-category-bar-chart" />;
  },
}));

const toolDonut = getTile("chart:toolUsage:donut") as TileDescriptor;
const toolBar = getTile("chart:toolUsage") as TileDescriptor;
const eventsDonut = getTile("chart:eventsByType") as TileDescriptor;
const spendDonut = getTile("chart:spendByOutcome:donut") as TileDescriptor;

const POPULATION = { total: 100, categories: 9 };

/** The desktop Local-mode producer's shape: a capped prefix carrying the population. */
const LOCAL_TOOLS: CategoryBucket[] = [
  { key: "Bash", label: "Bash", value: 30, population: POPULATION },
  { key: "Read", label: "Read", value: 20, population: POPULATION },
  { key: "Edit", label: "Edit", value: 12, population: POPULATION },
  { key: "Grep", label: "Grep", value: 8, population: POPULATION },
];

/**
 * The cloud producer's shape (`fetchToolUsageBuckets`): every category, no
 * population — what a signed-in desktop in Cloud mode and the web app receive.
 */
const CLOUD_TOOLS: CategoryBucket[] = LOCAL_TOOLS.map(
  ({ key, label, value }) => ({ key, label, value })
);

const LOCAL_EVENTS: CategoryBucket[] = [
  {
    key: "PreToolUse",
    label: "Pre tool use",
    value: 40,
    population: { total: 90, categories: 6 },
  },
  {
    key: "Stop",
    label: "Stop",
    value: 30,
    population: { total: 90, categories: 6 },
  },
];

const SPENT: CategoryBucket[] = [
  { key: SpendOutcome.Clean, label: "Ended clean", value: 6 },
  { key: SpendOutcome.Errored, label: "Ended with error", value: 3 },
  { key: SpendOutcome.Running, label: "Still running", value: 1 },
  { key: SpendOutcome.Unknown, label: "Not recorded", value: 0 },
];

const EMPTY_SERIES = { series: [], points: [] };

function renderAgentsTile(
  tile: TileDescriptor,
  charts: { toolUsage?: CategoryBucket[]; spendByOutcome?: CategoryBucket[] }
) {
  return render(
    <InsightsChartContent
      sections={{
        [InsightsSection.Agents]: {
          kpis: [],
          charts: {
            modelUsageOverTime: EMPTY_SERIES,
            modelBreakdown: [],
            ...charts,
          },
        },
      }}
      tile={tile}
    />
  );
}

function renderUtilizationTile(
  tile: TileDescriptor,
  eventsByType: CategoryBucket[]
) {
  return render(
    <InsightsChartContent
      sections={{
        [InsightsSection.Utilization]: {
          kpis: [],
          charts: {
            eventActivity: EMPTY_SERIES,
            reviewQueue: [],
            eventsByType,
          },
        },
      }}
      tile={tile}
    />
  );
}

afterEach(() => {
  captured.donut = undefined;
  captured.bar = undefined;
});

describe("capped donut tiles forward the population (ISS-9842)", () => {
  it("Local-mode tool usage: population total, omitted count, and the tile's noun", () => {
    renderAgentsTile(toolDonut, { toolUsage: LOCAL_TOOLS });

    expect(captured.donut).toMatchObject({
      total: 100,
      omittedCount: 5,
      otherSeriesLabel: "Other tools",
    });
    expect(captured.donut?.data).toBe(LOCAL_TOOLS);
  });

  it("Cloud-mode tool usage on the SAME tile: no population, so no residual props", () => {
    renderAgentsTile(toolDonut, { toolUsage: CLOUD_TOOLS });

    expect(captured.donut?.total).toBeUndefined();
    expect(captured.donut?.omittedCount).toBeUndefined();
    expect(captured.donut?.otherSeriesLabel).toBe("Other tools");
  });

  it("Local-mode events by type names its residual after event types", () => {
    renderUtilizationTile(eventsDonut, LOCAL_EVENTS);

    expect(captured.donut).toMatchObject({
      total: 90,
      omittedCount: 4,
      otherSeriesLabel: "Other event types",
    });
  });

  it("the bar tile of the same metric receives none of the residual props", () => {
    renderAgentsTile(toolBar, { toolUsage: LOCAL_TOOLS });

    expect(captured.donut).toBeUndefined();
    expect(captured.bar).toBeDefined();
    expect(captured.bar).not.toHaveProperty("total");
    expect(captured.bar).not.toHaveProperty("omittedCount");
    expect(captured.bar).not.toHaveProperty("otherSeriesLabel");
  });

  it("the spend-by-outcome donut is untouched: its producer never carries a population", () => {
    renderAgentsTile(spendDonut, { spendByOutcome: SPENT });

    expect(captured.donut?.total).toBeUndefined();
    expect(captured.donut?.omittedCount).toBeUndefined();
  });

  it("drops an inconsistent population instead of forwarding it", () => {
    // Every category present, yet the total claims more than the slices hold.
    const inconsistent = LOCAL_TOOLS.map((bucket) => ({
      ...bucket,
      population: { total: 71, categories: 4 },
    }));
    renderAgentsTile(toolDonut, { toolUsage: inconsistent });

    expect(captured.donut?.total).toBeUndefined();
    expect(captured.donut?.omittedCount).toBeUndefined();
  });
});
