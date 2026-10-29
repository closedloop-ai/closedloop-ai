import { describe, expect, it, vi } from "vitest";
import {
  type AgentComponent,
  AgentComponentKind,
  Harness,
  SourceType,
} from "../types/agent-component.js";
import {
  computeSummaryAggregate,
  computeSummaryAggregatePair,
  invocationsDerivation,
  isInvocationsComparable,
  PluginRollupCoverage,
  type SummaryAggregate,
  sumDedupedInvocations,
} from "./agent-component-summary-aggregate.js";

describe("sumDedupedInvocations", () => {
  it("sums non-plugin rows, treating null invocations as 0", () => {
    const result = sumDedupedInvocations([
      row({ slug: "a", invocations: 4 }),
      row({ slug: "b", invocations: null }),
      row({ slug: "c", kind: AgentComponentKind.Hook, invocations: 3 }),
    ]);
    expect(result.invocations).toBe(7);
    expect(result.exact).toBe(true);
    expect([...result.pluginCoverage]).toEqual([]);
  });

  it("excludes a plugin whose pack is represented by an in-view child", () => {
    const result = sumDedupedInvocations([
      row({ slug: "child", invocations: 2, packIds: ["pack-1"] }),
      plugin("plug", 10, ["other", "pack-1"]),
    ]);
    expect(result.invocations).toBe(2);
    expect(result.exact).toBe(true);
    expect(result.pluginCoverage.get("plug")).toBe(
      PluginRollupCoverage.Represented
    );
  });

  it("counts a plugin whose packs no in-view child represents", () => {
    const result = sumDedupedInvocations([
      row({ slug: "child", invocations: 2, packIds: ["pack-1"] }),
      // A non-child kind's packIds do not represent anything.
      row({
        slug: "hook",
        kind: AgentComponentKind.Hook,
        invocations: 1,
        packIds: ["pack-2"],
      }),
      plugin("plug", 10, ["pack-2"]),
    ]);
    expect(result.invocations).toBe(13);
    expect(result.exact).toBe(true);
    expect(result.pluginCoverage.get("plug")).toBe(
      PluginRollupCoverage.Independent
    );
  });

  it("marks a plugin without packIds Unknown when a child contributes invocations", () => {
    const result = sumDedupedInvocations([
      row({ slug: "child", invocations: 1 }),
      plugin("plug", 10, undefined),
    ]);
    expect(result.invocations).toBe(1);
    expect(result.exact).toBe(false);
    expect(result.pluginCoverage.get("plug")).toBe(
      PluginRollupCoverage.Unknown
    );
  });

  it("keeps the total exact when an Unknown plugin has a zero or null rollup", () => {
    const result = sumDedupedInvocations([
      row({ slug: "child", invocations: 1 }),
      plugin("zero", 0, undefined),
      plugin("none", null, undefined),
    ]);
    expect(result.invocations).toBe(1);
    expect(result.exact).toBe(true);
    expect(result.pluginCoverage.get("zero")).toBe(
      PluginRollupCoverage.Unknown
    );
    expect(result.pluginCoverage.get("none")).toBe(
      PluginRollupCoverage.Unknown
    );
  });

  it("counts a plugin without packIds as Independent when no child contributes", () => {
    const result = sumDedupedInvocations([
      row({ slug: "idle-child", invocations: 0 }),
      row({ slug: "null-child", invocations: null }),
      row({ slug: "hook", kind: AgentComponentKind.Hook, invocations: 5 }),
      plugin("plug", 10, undefined),
    ]);
    expect(result.invocations).toBe(15);
    expect(result.exact).toBe(true);
    expect(result.pluginCoverage.get("plug")).toBe(
      PluginRollupCoverage.Independent
    );
  });
});

describe("computeSummaryAggregate", () => {
  const population = [
    row({
      slug: "sub",
      kind: AgentComponentKind.Subagent,
      invocations: 3,
      collaborators: ["amy", "bob"],
      packIds: ["p"],
    }),
    row({ slug: "skill", invocations: 2, collaborators: ["bob"] }),
    plugin("plug", 5, ["p"]),
  ];

  it("defaults to the flat sum with null LOC/$ and an empty coverage map", () => {
    expect(computeSummaryAggregate(population)).toEqual({
      components: 3,
      invocations: 10,
      locPerDollar: null,
      locPerDollarSampleSize: 0,
      collaborators: 2,
      hasVerifiableLocPerDollar: true,
      invocationsExact: true,
      invocationsPluginCoverage: new Map(),
    });
  });

  it("dedupes plugin rollups and uses the supplied LOC/$ fold", () => {
    const fold = vi.fn(() => ({ locPerDollar: 12.5, sampleSize: 4 }));
    const result = computeSummaryAggregate(population, true, fold);
    expect(fold).toHaveBeenCalledWith(population);
    expect(result.invocations).toBe(5);
    expect(result.locPerDollar).toBe(12.5);
    expect(result.locPerDollarSampleSize).toBe(4);
    expect(result.invocationsPluginCoverage.get("plug")).toBe(
      PluginRollupCoverage.Represented
    );
  });

  it("reports no verifiable LOC/$ when no subagent is present", () => {
    expect(
      computeSummaryAggregate([row({ slug: "skill" })])
        .hasVerifiableLocPerDollar
    ).toBe(false);
  });
});

describe("computeSummaryAggregatePair", () => {
  it("returns undefined previous when no previous population exists", () => {
    const pair = computeSummaryAggregatePair(
      [row({ slug: "a" })],
      undefined,
      false
    );
    expect(pair.current.components).toBe(1);
    expect(pair.previous).toBeUndefined();
  });

  it("routes each fold to its own window", () => {
    const pair = computeSummaryAggregatePair(
      [row({ slug: "a", invocations: 1 })],
      [row({ slug: "b", invocations: 2 }), row({ slug: "c", invocations: 3 })],
      false,
      {
        current: () => ({ locPerDollar: 1, sampleSize: 1 }),
        previous: () => ({ locPerDollar: 2, sampleSize: 2 }),
      }
    );
    expect(pair.current.invocations).toBe(1);
    expect(pair.current.locPerDollar).toBe(1);
    expect(pair.previous?.invocations).toBe(5);
    expect(pair.previous?.components).toBe(2);
    expect(pair.previous?.locPerDollar).toBe(2);
    expect(pair.previous?.locPerDollarSampleSize).toBe(2);
  });
});

describe("invocationsDerivation", () => {
  it("dedupes plugin rollups only when asked", () => {
    const rows = [
      row({ slug: "c", invocations: 1, packIds: ["p"] }),
      plugin("plug", 9, ["p"]),
    ];
    expect(invocationsDerivation(true).reduce(rows).invocations).toBe(1);
    const flat = invocationsDerivation(false).reduce(rows);
    expect(flat.invocations).toBe(10);
    expect(flat.exact).toBe(true);
    expect(flat.pluginCoverage.size).toBe(0);
  });

  it("explains the deduped exact, deduped inexact, and flat derivations differently", () => {
    const dedupedExact = invocationsDerivation(true).explain(true);
    const dedupedInexact = invocationsDerivation(true).explain(false);
    const flat = invocationsDerivation(false).explain(false);
    expect(dedupedExact.detail).toBe("across components in view");
    expect(dedupedInexact.detail).toBe("some calls may be missing");
    expect(flat.detail).toBe("across components in view");
    expect(dedupedExact.what).toBe(
      "Total tool calls attributed to these components."
    );
    expect(dedupedInexact.what).toBe(dedupedExact.what);
    expect(flat.what).toBe(dedupedExact.what);
    expect(new Set([dedupedExact.how, dedupedInexact.how, flat.how]).size).toBe(
      3
    );
  });
});

describe("isInvocationsComparable", () => {
  it("is comparable with no previous window", () => {
    expect(isInvocationsComparable(aggregate(), undefined)).toBe(true);
  });

  it("is not comparable when either side is inexact", () => {
    expect(
      isInvocationsComparable(
        aggregate({ invocationsExact: false }),
        aggregate()
      )
    ).toBe(false);
    expect(
      isInvocationsComparable(
        aggregate(),
        aggregate({ invocationsExact: false })
      )
    ).toBe(false);
  });

  it("is not comparable when a shared plugin's coverage changed", () => {
    expect(
      isInvocationsComparable(
        aggregate({ coverage: [["p", PluginRollupCoverage.Represented]] }),
        aggregate({ coverage: [["p", PluginRollupCoverage.Independent]] })
      )
    ).toBe(false);
  });

  it("is comparable when coverage matches or the plugin is absent before", () => {
    expect(
      isInvocationsComparable(
        aggregate({
          coverage: [
            ["p", PluginRollupCoverage.Represented],
            ["new", PluginRollupCoverage.Independent],
          ],
        }),
        aggregate({ coverage: [["p", PluginRollupCoverage.Represented]] })
      )
    ).toBe(true);
  });
});

function aggregate(
  options: {
    invocationsExact?: boolean;
    coverage?: [string, PluginRollupCoverage][];
  } = {}
): SummaryAggregate {
  return {
    components: 0,
    invocations: 0,
    locPerDollar: null,
    locPerDollarSampleSize: 0,
    collaborators: 0,
    hasVerifiableLocPerDollar: false,
    invocationsExact: options.invocationsExact ?? true,
    invocationsPluginCoverage: new Map(options.coverage ?? []),
  };
}

function plugin(
  slug: string,
  invocations: number | null,
  packIds: string[] | undefined
): AgentComponent {
  return row({
    slug,
    kind: AgentComponentKind.Plugin,
    invocations,
    ...(packIds ? { packIds } : {}),
  });
}

function row(overrides: Partial<AgentComponent> = {}): AgentComponent {
  const slug = overrides.slug ?? "slug";
  return {
    id: slug,
    slug,
    name: slug,
    kind: AgentComponentKind.Skill,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness: Harness.Claude,
    invocations: 0,
    sessions: 0,
    trend: [],
    collaborators: [],
    computeTargetIds: [],
    locPerDollar: null,
    firstSeenAt: "",
    lastSeenAt: "",
    ...overrides,
  };
}
