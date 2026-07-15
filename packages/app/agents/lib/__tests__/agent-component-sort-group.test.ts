import {
  type AgentComponent,
  AgentComponentGroupBy,
  AgentComponentKind,
  AgentComponentSortDir,
  AgentComponentSortKey,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import {
  countFacetValues,
  groupAgentComponentRows,
  sortAgentComponentRows,
} from "../agent-component-sort-group";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<AgentComponent> = {}): AgentComponent {
  return {
    id: "uuid-default",
    name: "Default Component",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: 10,
    sessions: 3,
    klocPerDollar: 2.5,
    trend: [],
    owner: "alice",
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sortAgentComponentRows — T-10.6
// ---------------------------------------------------------------------------

describe("sortAgentComponentRows", () => {
  it("sorts by Name ascending (default locale order)", () => {
    const rows = [
      makeRow({ id: "1", name: "Zeta" }),
      makeRow({ id: "2", name: "Alpha" }),
      makeRow({ id: "3", name: "Gamma" }),
    ];

    const sorted = sortAgentComponentRows(
      rows,
      AgentComponentSortKey.Name,
      AgentComponentSortDir.Asc
    );

    expect(sorted.map((r) => r.name)).toEqual(["Alpha", "Gamma", "Zeta"]);
  });

  it("sorts by Name descending", () => {
    const rows = [
      makeRow({ id: "1", name: "Alpha" }),
      makeRow({ id: "2", name: "Zeta" }),
      makeRow({ id: "3", name: "Gamma" }),
    ];

    const sorted = sortAgentComponentRows(
      rows,
      AgentComponentSortKey.Name,
      AgentComponentSortDir.Desc
    );

    expect(sorted.map((r) => r.name)).toEqual(["Zeta", "Gamma", "Alpha"]);
  });

  it("sorts by Invocations ascending — null values sort last", () => {
    const rows = [
      makeRow({ id: "1", invocations: null }),
      makeRow({ id: "2", invocations: 100 }),
      makeRow({ id: "3", invocations: 5 }),
    ];

    const sorted = sortAgentComponentRows(
      rows,
      AgentComponentSortKey.Invocations,
      AgentComponentSortDir.Asc
    );

    // null → treated as -Infinity; ascending puts -Infinity first, then 5, then 100
    expect(sorted.map((r) => r.invocations)).toEqual([null, 5, 100]);
  });

  it("sorts by Invocations descending — highest first, null last", () => {
    const rows = [
      makeRow({ id: "1", invocations: null }),
      makeRow({ id: "2", invocations: 100 }),
      makeRow({ id: "3", invocations: 5 }),
    ];

    const sorted = sortAgentComponentRows(
      rows,
      AgentComponentSortKey.Invocations,
      AgentComponentSortDir.Desc
    );

    // null (-Infinity) descending is last
    expect(sorted.map((r) => r.invocations)).toEqual([100, 5, null]);
  });

  it("sorts by Sessions ascending", () => {
    const rows = [
      makeRow({ id: "1", sessions: 50 }),
      makeRow({ id: "2", sessions: 2 }),
      makeRow({ id: "3", sessions: 20 }),
    ];

    const sorted = sortAgentComponentRows(
      rows,
      AgentComponentSortKey.Sessions,
      AgentComponentSortDir.Asc
    );

    expect(sorted.map((r) => r.sessions)).toEqual([2, 20, 50]);
  });

  it("sorts by Metric (klocPerDollar) descending — highest efficiency first", () => {
    const rows = [
      makeRow({ id: "1", klocPerDollar: 1.0 }),
      makeRow({ id: "2", klocPerDollar: 5.5 }),
      makeRow({ id: "3", klocPerDollar: null }),
    ];

    const sorted = sortAgentComponentRows(
      rows,
      AgentComponentSortKey.Metric,
      AgentComponentSortDir.Desc
    );

    expect(sorted.map((r) => r.klocPerDollar)).toEqual([5.5, 1.0, null]);
  });

  it("sorts by Owner ascending — null owners sort last", () => {
    const rows = [
      makeRow({ id: "1", owner: "Zara" }),
      makeRow({ id: "2", owner: null }),
      makeRow({ id: "3", owner: "Alice" }),
    ];

    const sorted = sortAgentComponentRows(
      rows,
      AgentComponentSortKey.Owner,
      AgentComponentSortDir.Asc
    );

    expect(sorted.map((r) => r.owner)).toEqual(["Alice", "Zara", null]);
  });

  it("sorts by Source ascending", () => {
    const rows = [
      makeRow({ id: "1", source: "repo-c" }),
      makeRow({ id: "2", source: "repo-a" }),
      makeRow({ id: "3", source: "repo-b" }),
    ];

    const sorted = sortAgentComponentRows(
      rows,
      AgentComponentSortKey.Source,
      AgentComponentSortDir.Asc
    );

    expect(sorted.map((r) => r.source)).toEqual(["repo-a", "repo-b", "repo-c"]);
  });

  it("sorts by Harness ascending", () => {
    const rows = [
      makeRow({ id: "1", harness: Harness.Codex }),
      makeRow({ id: "2", harness: Harness.Both }),
      makeRow({ id: "3", harness: Harness.Claude }),
    ];

    const sorted = sortAgentComponentRows(
      rows,
      AgentComponentSortKey.Harness,
      AgentComponentSortDir.Asc
    );

    // Alphabetic: "both" < "claude" < "codex"
    expect(sorted.map((r) => r.harness)).toEqual([
      Harness.Both,
      Harness.Claude,
      Harness.Codex,
    ]);
  });

  it("sorts by Type ascending (alphabetic plural label order)", () => {
    const rows = [
      makeRow({ id: "1", kind: AgentComponentKind.Skill }),
      makeRow({ id: "2", kind: AgentComponentKind.Subagent }),
      makeRow({ id: "3", kind: AgentComponentKind.Command }),
    ];

    const sorted = sortAgentComponentRows(
      rows,
      AgentComponentSortKey.Type,
      AgentComponentSortDir.Asc
    );

    // Plural labels: "Agents" < "Commands" < "Skills"
    expect(sorted.map((r) => r.kind)).toEqual([
      AgentComponentKind.Subagent,
      AgentComponentKind.Command,
      AgentComponentKind.Skill,
    ]);
  });

  it('sorts by Type without crashing on an unmapped kind (e.g. "widget")', () => {
    // Regression: a synced kind not in AgentComponentKind made the Type sort key
    // `undefined` and `localeCompare` threw, taking down the whole Agents page.
    // kindPlural() now labelizes the fallback ("Widgets"). (FEA-3048: "tool" is
    // now a MAPPED kind, so a still-unmapped placeholder exercises this path.)
    const rows = [
      makeRow({ id: "1", kind: AgentComponentKind.Subagent }),
      makeRow({ id: "2", kind: "widget" as AgentComponentKind }),
      makeRow({ id: "3", kind: AgentComponentKind.Command }),
    ];

    let sorted: AgentComponent[] = [];
    expect(() => {
      sorted = sortAgentComponentRows(
        rows,
        AgentComponentSortKey.Type,
        AgentComponentSortDir.Asc
      );
    }).not.toThrow();

    // Labels: "Agents" < "Commands" < "Widgets" — unmapped kind sorts by its
    // labelized plural rather than crashing.
    expect(sorted.map((r) => r.kind)).toEqual([
      AgentComponentKind.Subagent,
      AgentComponentKind.Command,
      "widget",
    ]);
  });

  it("is non-destructive — original array is unchanged", () => {
    const rows = [
      makeRow({ id: "1", name: "Zeta" }),
      makeRow({ id: "2", name: "Alpha" }),
    ];
    const original = [...rows];

    sortAgentComponentRows(
      rows,
      AgentComponentSortKey.Name,
      AgentComponentSortDir.Asc
    );

    expect(rows.map((r) => r.id)).toEqual(original.map((r) => r.id));
  });
});

// ---------------------------------------------------------------------------
// groupAgentComponentRows — T-10.6
// ---------------------------------------------------------------------------

describe("groupAgentComponentRows", () => {
  it("None — returns a single group with empty label", () => {
    const rows = [
      makeRow({ id: "1", kind: AgentComponentKind.Subagent }),
      makeRow({ id: "2", kind: AgentComponentKind.Command }),
    ];

    const groups = groupAgentComponentRows(rows, AgentComponentGroupBy.None);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("");
    expect(groups[0].items).toHaveLength(2);
  });

  it("Type — one group per kind in KIND_ORDER using plural labels", () => {
    const rows = [
      makeRow({ id: "1", kind: AgentComponentKind.Skill }),
      makeRow({ id: "2", kind: AgentComponentKind.Subagent }),
      makeRow({ id: "3", kind: AgentComponentKind.Command }),
    ];

    const groups = groupAgentComponentRows(rows, AgentComponentGroupBy.Type);

    // All 9 kinds should appear as groups (including empty ones)
    expect(groups.length).toBe(9);

    const agentsGroup = groups.find((g) => g.label === "Agents");
    expect(agentsGroup).toBeDefined();
    expect(agentsGroup?.items.map((i) => i.id)).toEqual(["2"]);

    const commandsGroup = groups.find((g) => g.label === "Commands");
    expect(commandsGroup?.items.map((i) => i.id)).toEqual(["3"]);

    const skillsGroup = groups.find((g) => g.label === "Skills");
    expect(skillsGroup?.items.map((i) => i.id)).toEqual(["1"]);
  });

  it("Type — groups with zero items are included", () => {
    const rows = [makeRow({ id: "1", kind: AgentComponentKind.Skill })];
    const groups = groupAgentComponentRows(rows, AgentComponentGroupBy.Type);

    const pluginsGroup = groups.find((g) => g.label === "Plugins");
    expect(pluginsGroup).toBeDefined();
    expect(pluginsGroup?.items).toHaveLength(0);
  });

  it('Type — an unmapped kind (e.g. "widget") gets its own trailing group, not dropped', () => {
    const rows = [
      makeRow({ id: "1", kind: AgentComponentKind.Skill }),
      makeRow({ id: "2", kind: "widget" as AgentComponentKind }),
    ];

    const groups = groupAgentComponentRows(rows, AgentComponentGroupBy.Type);

    // The 9 known-kind groups plus one trailing group for "widget". (FEA-3048:
    // "tool" is now a known kind in KIND_ORDER, so it is NOT a trailing group.)
    expect(groups.length).toBe(10);
    const widgetGroup = groups.find((g) => g.label === "Widgets");
    expect(widgetGroup).toBeDefined();
    expect(widgetGroup?.items.map((i) => i.id)).toEqual(["2"]);
    // Known-kind group ordering is preserved ahead of the fallback group.
    expect(groups.at(-1)?.label).toBe("Widgets");
  });

  it('Type — "tool" is a first-class KIND_ORDER group, not a trailing fallback (FEA-3048)', () => {
    const rows = [
      makeRow({ id: "1", kind: AgentComponentKind.Skill }),
      makeRow({ id: "2", kind: AgentComponentKind.Tool }),
    ];

    const groups = groupAgentComponentRows(rows, AgentComponentGroupBy.Type);

    // Only the 9 KIND_ORDER groups — no trailing fallback group for tool.
    expect(groups.length).toBe(9);
    const toolGroup = groups.find((g) => g.label === "Tools");
    expect(toolGroup).toBeDefined();
    expect(toolGroup?.items.map((i) => i.id)).toEqual(["2"]);
    // It sits in its KIND_ORDER position (between MCP tools and Hooks), NOT last.
    expect(groups.at(-1)?.label).not.toBe("Tools");
  });

  it("Type — labels match KIND_META plural values", () => {
    const rows: AgentComponent[] = [];
    const groups = groupAgentComponentRows(rows, AgentComponentGroupBy.Type);

    const labels = groups.map((g) => g.label);
    expect(labels).toContain("Agents");
    expect(labels).toContain("Commands");
    expect(labels).toContain("Skills");
    expect(labels).toContain("Workflows");
    expect(labels).toContain("Plugins");
    expect(labels).toContain("MCP tools");
    expect(labels).toContain("Hooks");
    expect(labels).toContain("Memory & config");
  });

  it("Owner — one group per distinct owner, sorted alphabetically, null → 'Unattributed' at end", () => {
    const rows = [
      makeRow({ id: "1", owner: "Zara" }),
      makeRow({ id: "2", owner: "Alice" }),
      makeRow({ id: "3", owner: null }),
      makeRow({ id: "4", owner: "Alice" }),
    ];

    const groups = groupAgentComponentRows(rows, AgentComponentGroupBy.Owner);

    expect(groups.map((g) => g.label)).toEqual([
      "Alice",
      "Zara",
      "Unattributed",
    ]);
    expect(groups[0].items.map((r) => r.id)).toEqual(["2", "4"]);
    expect(groups[1].items.map((r) => r.id)).toEqual(["1"]);
    expect(groups[2].items.map((r) => r.id)).toEqual(["3"]);
  });

  it("Owner — no 'Unattributed' group when all rows have owners", () => {
    const rows = [
      makeRow({ id: "1", owner: "Alice" }),
      makeRow({ id: "2", owner: "Bob" }),
    ];

    const groups = groupAgentComponentRows(rows, AgentComponentGroupBy.Owner);

    const unattributed = groups.find((g) => g.label === "Unattributed");
    expect(unattributed).toBeUndefined();
  });

  it("Harness — one group per harness in canonical order", () => {
    const rows = [
      makeRow({ id: "1", harness: Harness.Codex }),
      makeRow({ id: "2", harness: Harness.Claude }),
      makeRow({ id: "3", harness: Harness.Both }),
    ];

    const groups = groupAgentComponentRows(rows, AgentComponentGroupBy.Harness);

    expect(groups.map((g) => g.label)).toEqual([
      "Claude + Codex",
      "Claude",
      "Codex",
    ]);
    expect(
      groups.find((g) => g.label === "Claude + Codex")?.items.map((r) => r.id)
    ).toEqual(["3"]);
    expect(
      groups.find((g) => g.label === "Claude")?.items.map((r) => r.id)
    ).toEqual(["2"]);
    expect(
      groups.find((g) => g.label === "Codex")?.items.map((r) => r.id)
    ).toEqual(["1"]);
  });

  it("Harness — all three harness groups present even if some are empty", () => {
    const rows = [makeRow({ id: "1", harness: Harness.Claude })];
    const groups = groupAgentComponentRows(rows, AgentComponentGroupBy.Harness);
    expect(groups).toHaveLength(3);
    const codexGroup = groups.find((g) => g.label === "Codex");
    expect(codexGroup?.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// countFacetValues — T-10.6
// ---------------------------------------------------------------------------

describe("countFacetValues", () => {
  const ALL_ROWS: AgentComponent[] = [
    makeRow({
      id: "1",
      kind: AgentComponentKind.Subagent,
      owner: "Alice",
      source: "repo-a",
      harness: Harness.Claude,
    }),
    makeRow({
      id: "2",
      kind: AgentComponentKind.Command,
      owner: "Bob",
      source: "repo-b",
      harness: Harness.Codex,
    }),
    makeRow({
      id: "3",
      kind: AgentComponentKind.Skill,
      owner: "Alice",
      source: "repo-a",
      harness: Harness.Both,
    }),
    makeRow({
      id: "4",
      kind: AgentComponentKind.Hook,
      owner: null,
      source: "repo-c",
      harness: Harness.Claude,
    }),
  ];

  const EMPTY_FILTERS = {
    kinds: [] as AgentComponentKind[],
    owners: [],
    sources: [],
    harnesses: [] as Harness[],
    search: "",
  };

  it("counts owners from the already-filtered rows (active narrowing)", () => {
    // Only rows 1 and 3 (both Alice, repo-a, Subagent/Skill) survive the type-tab filter
    const filteredRows = ALL_ROWS.filter(
      (r) =>
        r.kind === AgentComponentKind.Subagent ||
        r.kind === AgentComponentKind.Skill
    );

    const facets = countFacetValues(filteredRows, ALL_ROWS, EMPTY_FILTERS);

    const aliceOpt = facets.owners.find((o) => o.id === "Alice");
    const bobOpt = facets.owners.find((o) => o.id === "Bob");

    // Alice has count 2 in the filtered rows
    expect(aliceOpt?.count).toBe(2);
    // Bob has count 0 (not in filtered rows), but still present (from allRows)
    expect(bobOpt?.count).toBe(0);
  });

  it("includes zero-count options from allRows so filter menu doesn't hide them", () => {
    // Narrow to only Command rows
    const filteredRows = ALL_ROWS.filter(
      (r) => r.kind === AgentComponentKind.Command
    );

    const facets = countFacetValues(filteredRows, ALL_ROWS, EMPTY_FILTERS);

    // All sources that appear in allRows must be present even with count 0
    const allSourceIds = facets.sources.map((s) => s.id);
    expect(allSourceIds).toContain("repo-a");
    expect(allSourceIds).toContain("repo-b");
    expect(allSourceIds).toContain("repo-c");

    const repoACount = facets.sources.find((s) => s.id === "repo-a")?.count;
    // repo-a is not in the filtered rows (only Command has repo-b)
    expect(repoACount).toBe(0);
  });

  it("harness options always include all three values", () => {
    const facets = countFacetValues([], ALL_ROWS, EMPTY_FILTERS);

    const harnessIds = facets.harnesses.map((h) => h.id);
    expect(harnessIds).toContain(Harness.Claude);
    expect(harnessIds).toContain(Harness.Codex);
    expect(harnessIds).toContain(Harness.Both);
  });

  it("null owners are excluded from owner options (no null entry)", () => {
    const facets = countFacetValues(ALL_ROWS, ALL_ROWS, EMPTY_FILTERS);

    const hasNull = facets.owners.some((o) => o.id === null || o.id === "null");
    expect(hasNull).toBe(false);
  });

  it("counts reflect the already-filtered rows — not the full corpus", () => {
    // Narrow to only rows with harness=Claude (rows 1 and 4)
    const filteredRows = ALL_ROWS.filter((r) => r.harness === Harness.Claude);

    const facets = countFacetValues(filteredRows, ALL_ROWS, EMPTY_FILTERS);

    const claudeCount = facets.harnesses.find(
      (h) => h.id === Harness.Claude
    )?.count;
    const codexCount = facets.harnesses.find(
      (h) => h.id === Harness.Codex
    )?.count;
    const bothCount = facets.harnesses.find(
      (h) => h.id === Harness.Both
    )?.count;

    expect(claudeCount).toBe(2); // rows 1 and 4
    expect(codexCount).toBe(0);
    expect(bothCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T-18.1(a) — Plugin kind in countFacetValues and KIND_ORDER
// ---------------------------------------------------------------------------

describe("Plugin kind — countFacetValues T-18.1(a)", () => {
  const EMPTY_FILTERS = {
    kinds: [] as AgentComponentKind[],
    owners: [],
    sources: [],
    harnesses: [] as Harness[],
    search: "",
  };

  it("counts plugin-kind rows in source facet", () => {
    const pluginRow = makeRow({
      id: "p1",
      kind: AgentComponentKind.Plugin,
      source: "rtk-pack",
      harness: Harness.Claude,
      owner: "DevOps",
    });
    const otherRow = makeRow({
      id: "c1",
      kind: AgentComponentKind.Command,
      source: "repo-x",
      harness: Harness.Codex,
      owner: "Alice",
    });
    const allRows = [pluginRow, otherRow];

    // When only the plugin row survives active narrowing:
    const facets = countFacetValues([pluginRow], allRows, EMPTY_FILTERS);

    const pluginSource = facets.sources.find((s) => s.id === "rtk-pack");
    expect(pluginSource).toBeDefined();
    expect(pluginSource?.count).toBe(1);

    // repo-x is in allRows but not in filteredRows → count 0
    const otherSource = facets.sources.find((s) => s.id === "repo-x");
    expect(otherSource?.count).toBe(0);
  });

  it("counts plugin-kind rows in owner facet", () => {
    const pluginRow = makeRow({
      id: "p2",
      kind: AgentComponentKind.Plugin,
      source: "gstack",
      harness: Harness.Both,
      owner: "Platform",
    });
    const allRows = [pluginRow];

    const facets = countFacetValues([pluginRow], allRows, EMPTY_FILTERS);

    const platformOwner = facets.owners.find((o) => o.id === "Platform");
    expect(platformOwner?.count).toBe(1);
  });
});

describe("Plugin kind — KIND_ORDER (T-18.1(a))", () => {
  it("groupAgentComponentRows Type dimension includes Plugin in KIND_ORDER", () => {
    const pluginRow = makeRow({
      id: "plugin-1",
      kind: AgentComponentKind.Plugin,
    });

    const groups = groupAgentComponentRows(
      [pluginRow],
      AgentComponentGroupBy.Type
    );

    // Plugin group should exist and contain our row
    const pluginsGroup = groups.find((g) => g.label === "Plugins");
    expect(pluginsGroup).toBeDefined();
    expect(pluginsGroup?.items).toHaveLength(1);
    expect(pluginsGroup?.items[0].id).toBe("plugin-1");
  });

  it("groupAgentComponentRows Type dimension places Plugin before Mcp in KIND_ORDER", () => {
    const mcpRow = makeRow({ id: "mcp-1", kind: AgentComponentKind.Mcp });
    const pluginRow = makeRow({
      id: "plugin-2",
      kind: AgentComponentKind.Plugin,
    });

    const groups = groupAgentComponentRows(
      [mcpRow, pluginRow],
      AgentComponentGroupBy.Type
    );

    const labels = groups.map((g) => g.label);
    const pluginIndex = labels.indexOf("Plugins");
    const mcpIndex = labels.indexOf("MCP tools");

    // Plugin must appear before MCP in canonical KIND_ORDER
    expect(pluginIndex).toBeGreaterThanOrEqual(0);
    expect(mcpIndex).toBeGreaterThanOrEqual(0);
    expect(pluginIndex).toBeLessThan(mcpIndex);
  });

  it("sortAgentComponentRows Type — Plugin rows sort correctly among other kinds", () => {
    const rows = [
      makeRow({ id: "mcp-s", kind: AgentComponentKind.Mcp }),
      makeRow({ id: "plugin-s", kind: AgentComponentKind.Plugin }),
      makeRow({ id: "skill-s", kind: AgentComponentKind.Skill }),
    ];

    const sorted = sortAgentComponentRows(
      rows,
      AgentComponentSortKey.Type,
      AgentComponentSortDir.Asc
    );

    // Alphabetic by plural label: "MCP tools" < "Plugins" < "Skills"
    expect(sorted.map((r) => r.id)).toEqual(["mcp-s", "plugin-s", "skill-s"]);
  });
});
