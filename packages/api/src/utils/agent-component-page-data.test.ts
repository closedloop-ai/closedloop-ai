import { describe, expect, it } from "vitest";
import {
  type AgentComponent,
  AgentComponentKind,
  AgentComponentSortDir,
  AgentComponentSortKey,
  Harness,
  SourceType,
} from "../types/agent-component.js";
import {
  type AgentComponentPageDataQuery,
  deserializeSummaryAggregate,
  hasCompletePriorWindow,
  isUsableUsageBound,
  reduceAgentComponentPageData,
  serializeSummaryAggregate,
} from "./agent-component-page-data.js";
import { DEFAULT_AGENT_COMPONENT_FILTERS } from "./agent-component-reduce.js";
import {
  PluginRollupCoverage,
  type SummaryAggregate,
} from "./agent-component-summary-aggregate.js";

describe("reduceAgentComponentPageData", () => {
  const current = [
    row("c", Harness.Claude, 1),
    row("a", Harness.Codex, 2),
    row("b", Harness.Claude, 4),
  ];

  it("sorts, pages, and clamps an out-of-range page to the last page", () => {
    const result = reduceAgentComponentPageData(
      { current, universe: current },
      query({ page: 99, pageSize: 2 })
    );
    expect(result.filteredTotal).toBe(3);
    expect(result.totalPages).toBe(2);
    expect(result.page).toBe(1);
    expect(result.items.map((r) => r.id)).toEqual(["c"]);
    expect(result.current.invocations).toBe(7);
    expect(result).not.toHaveProperty("previous");
  });

  it("floors a negative page and a zero page size", () => {
    const result = reduceAgentComponentPageData(
      { current, universe: current },
      query({ page: -3, pageSize: 0 })
    );
    expect(result.page).toBe(0);
    expect(result.totalPages).toBe(3);
    expect(result.items.map((r) => r.id)).toEqual(["a"]);
  });

  it("counts harness facets over the harness-cleared rows while summarizing the filtered rows", () => {
    const result = reduceAgentComponentPageData(
      { current, universe: current, previous: [row("z", Harness.Codex, 9)] },
      query({
        filters: {
          ...DEFAULT_AGENT_COMPONENT_FILTERS,
          harnesses: [Harness.Claude],
        },
      })
    );
    expect(result.items.map((r) => r.id)).toEqual(["b", "c"]);
    expect(result.facets.harnesses.map((o) => o.count)).toEqual([2, 1, 0]);
    expect(result.current.invocations).toBe(5);
    // The previous window is filtered by the same harness selection.
    expect(result.previous?.invocations).toBe(0);
    expect(result.previous?.components).toBe(0);
  });
});

describe("serializeSummaryAggregate / deserializeSummaryAggregate", () => {
  const aggregate: SummaryAggregate = {
    components: 2,
    invocations: 5,
    locPerDollar: 3.5,
    locPerDollarSampleSize: 1,
    collaborators: 1,
    hasVerifiableLocPerDollar: true,
    invocationsExact: false,
    invocationsPluginCoverage: new Map([["p", PluginRollupCoverage.Unknown]]),
  };

  it("serializes the coverage map to entries and mirrors LOC/$ into the legacy field", () => {
    const serialized = serializeSummaryAggregate(aggregate);
    expect(serialized.invocationsPluginCoverage).toEqual([
      ["p", PluginRollupCoverage.Unknown],
    ]);
    expect(serialized.avgLocPerDollar).toBe(3.5);
  });

  it("round-trips and drops the legacy field", () => {
    const restored = deserializeSummaryAggregate(
      serializeSummaryAggregate(aggregate)
    );
    expect(restored).toEqual(aggregate);
    expect(restored).not.toHaveProperty("avgLocPerDollar");
  });
});

describe("isUsableUsageBound", () => {
  it("accepts a parseable date and rejects garbage", () => {
    expect(isUsableUsageBound("2026-01-01T00:00:00Z")).toBe(true);
    expect(isUsableUsageBound("not a date")).toBe(false);
  });
});

describe("hasCompletePriorWindow", () => {
  it("requires both or neither prior bound", () => {
    expect(hasCompletePriorWindow({})).toBe(true);
    expect(hasCompletePriorWindow({ prevStart: "a", prevEnd: "b" })).toBe(true);
    expect(hasCompletePriorWindow({ prevStart: "a" })).toBe(false);
    expect(hasCompletePriorWindow({ prevEnd: "b" })).toBe(false);
  });
});

function query(
  overrides: Partial<AgentComponentPageDataQuery> = {}
): AgentComponentPageDataQuery {
  return {
    filters: DEFAULT_AGENT_COMPONENT_FILTERS,
    sortBy: AgentComponentSortKey.Name,
    sortDir: AgentComponentSortDir.Asc,
    page: 0,
    pageSize: 50,
    honestSource: false,
    dedupePluginRollups: false,
    ...overrides,
  };
}

function row(
  id: string,
  harness: Harness,
  invocations: number
): AgentComponent {
  return {
    id,
    slug: `skill::${id}`,
    name: id,
    kind: AgentComponentKind.Skill,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness,
    invocations,
    sessions: 0,
    trend: [],
    collaborators: [],
    computeTargetIds: [],
    locPerDollar: null,
    firstSeenAt: "",
    lastSeenAt: "",
  };
}
