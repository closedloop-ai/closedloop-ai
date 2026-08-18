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
import { AGENT_COMPONENT_NO_AUTHORS_LABEL } from "../agent-component-authors";
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
    slug: overrides.slug ?? "subagent::uuid-default",
    name: "Default Component",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: 10,
    sessions: 3,
    locPerDollar: 2.5,
    trend: [],
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

  it("sorts by Metric (locPerDollar) descending — highest efficiency first", () => {
    const rows = [
      makeRow({ id: "1", locPerDollar: 1.0 }),
      makeRow({ id: "2", locPerDollar: 5.5 }),
      makeRow({ id: "3", locPerDollar: null }),
    ];

    const sorted = sortAgentComponentRows(
      rows,
      AgentComponentSortKey.Metric,
      AgentComponentSortDir.Desc
    );

    expect(sorted.map((r) => r.locPerDollar)).toEqual([5.5, 1.0, null]);
  });

  // FEA-4098 (Slice 3): Owner was removed and Collaborators (an authors
  // people-set) is intentionally unsortable, so there is no owner/collaborator
  // sort case to test here — grouping/filtering by collaborators is covered
  // below.

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

    // All 10 kinds should appear as groups (including empty ones)
    expect(groups.length).toBe(10);

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

    // The 10 known-kind groups plus one trailing group for "widget". (FEA-3048:
    // "tool" is a known kind in KIND_ORDER, so it is NOT a trailing group;
    // FEA-2642 adds "orchestration" as the 10th known kind.)
    expect(groups.length).toBe(11);
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

    // Only the 10 KIND_ORDER groups — no trailing fallback group for tool.
    expect(groups.length).toBe(10);
    const toolGroup = groups.find((g) => g.label === "Tools");
    expect(toolGroup).toBeDefined();
    expect(toolGroup?.items.map((i) => i.id)).toEqual(["2"]);
    // It sits in its KIND_ORDER position (between MCPs and Hooks), NOT last.
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
    expect(labels).toContain("MCPs");
    expect(labels).toContain("Hooks");
    expect(labels).toContain("Memory & config");
  });

  it("Collaborators — one group per distinct author (multi-author rows appear under each), sorted alphabetically, none → 'No authors' at end", () => {
    const rows = [
      makeRow({ id: "1", collaborators: ["Zara"] }),
      // A multi-author row lands in BOTH Alice's and Zara's groups.
      makeRow({ id: "2", collaborators: ["Alice", "Zara"] }),
      makeRow({ id: "3", collaborators: [] }),
      makeRow({ id: "4", collaborators: ["Alice"] }),
    ];

    const groups = groupAgentComponentRows(
      rows,
      AgentComponentGroupBy.Collaborators
    );

    expect(groups.map((g) => g.label)).toEqual([
      "Alice",
      "Zara",
      AGENT_COMPONENT_NO_AUTHORS_LABEL,
    ]);
    // Alice authored rows 2 and 4 (discoverer order within a row is preserved).
    expect(groups[0].items.map((r) => r.id)).toEqual(["2", "4"]);
    // Zara authored rows 1 and 2 — row 2 appears in both groups.
    expect(groups[1].items.map((r) => r.id)).toEqual(["1", "2"]);
    expect(groups[2].items.map((r) => r.id)).toEqual(["3"]);
  });

  it("Collaborators — no 'No authors' group when every row has an author", () => {
    const rows = [
      makeRow({ id: "1", collaborators: ["Alice"] }),
      makeRow({ id: "2", collaborators: ["Bob"] }),
    ];

    const groups = groupAgentComponentRows(
      rows,
      AgentComponentGroupBy.Collaborators
    );

    const noAuthors = groups.find(
      (g) => g.label === AGENT_COMPONENT_NO_AUTHORS_LABEL
    );
    expect(noAuthors).toBeUndefined();
  });

  it("Harness — one group per harness in canonical order", () => {
    const rows = [
      makeRow({ id: "1", harness: Harness.Codex }),
      makeRow({ id: "2", harness: Harness.Claude }),
      makeRow({ id: "3", harness: Harness.Both }),
      // ISS-4386: an OpenCode component is grouped into its own harness group.
      makeRow({ id: "4", harness: Harness.Opencode }),
    ];

    const groups = groupAgentComponentRows(rows, AgentComponentGroupBy.Harness);

    // `Both` renders as "Multiple harnesses" (T3/T9), not "Claude + Codex" —
    // it now collapses Claude+OpenCode too, so naming Codex would lie.
    expect(groups.map((g) => g.label)).toEqual([
      "Multiple harnesses",
      "Claude",
      "Codex",
      "OpenCode",
    ]);
    expect(
      groups
        .find((g) => g.label === "Multiple harnesses")
        ?.items.map((r) => r.id)
    ).toEqual(["3"]);
    expect(
      groups.find((g) => g.label === "Claude")?.items.map((r) => r.id)
    ).toEqual(["2"]);
    expect(
      groups.find((g) => g.label === "Codex")?.items.map((r) => r.id)
    ).toEqual(["1"]);
    expect(
      groups.find((g) => g.label === "OpenCode")?.items.map((r) => r.id)
    ).toEqual(["4"]);
  });

  it("Harness — empty harness groups are dropped (T11)", () => {
    // Only a Claude row exists → Codex/OpenCode/Multiple buckets are empty and
    // must NOT render as headers (mostly-chrome empty buckets, T11).
    const rows = [makeRow({ id: "1", harness: Harness.Claude })];
    const groups = groupAgentComponentRows(rows, AgentComponentGroupBy.Harness);
    expect(groups.map((g) => g.label)).toEqual(["Claude"]);
    expect(groups.find((g) => g.label === "Codex")).toBeUndefined();
    expect(groups.find((g) => g.label === "OpenCode")).toBeUndefined();
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
      collaborators: ["Alice"],
      source: "repo-a",
      harness: Harness.Claude,
    }),
    makeRow({
      id: "2",
      kind: AgentComponentKind.Command,
      collaborators: ["Bob"],
      source: "repo-b",
      harness: Harness.Codex,
    }),
    makeRow({
      id: "3",
      kind: AgentComponentKind.Skill,
      // FEA-4098: a multi-author row — Alice AND Carol — so a per-author count
      // increments once for each distinct author on the row.
      collaborators: ["Alice", "Carol"],
      source: "repo-a",
      harness: Harness.Both,
    }),
    makeRow({
      id: "4",
      kind: AgentComponentKind.Hook,
      collaborators: [],
      source: "repo-c",
      harness: Harness.Claude,
    }),
  ];

  const EMPTY_FILTERS = {
    kinds: [] as AgentComponentKind[],
    collaborators: [],
    sources: [],
    harnesses: [] as Harness[],
    search: "",
  };

  it("counts collaborators from the already-filtered rows (active narrowing)", () => {
    // Only rows 1 and 3 (Subagent/Skill) survive the type-tab filter — Alice
    // authored both, Carol authored only row 3, Bob authored neither.
    const filteredRows = ALL_ROWS.filter(
      (r) =>
        r.kind === AgentComponentKind.Subagent ||
        r.kind === AgentComponentKind.Skill
    );

    const facets = countFacetValues(filteredRows, ALL_ROWS, EMPTY_FILTERS);

    const aliceOpt = facets.collaborators.find((o) => o.id === "Alice");
    const carolOpt = facets.collaborators.find((o) => o.id === "Carol");
    const bobOpt = facets.collaborators.find((o) => o.id === "Bob");

    // Alice authored both filtered rows (1 and 3).
    expect(aliceOpt?.count).toBe(2);
    // Carol authored only the multi-author skill (row 3).
    expect(carolOpt?.count).toBe(1);
    // Bob authored none of the filtered rows, but is still present (from allRows).
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

  it("harness filter options offer only the individual harnesses, not the combined Both (FEA-4336)", () => {
    const facets = countFacetValues([], ALL_ROWS, EMPTY_FILTERS);

    const harnessIds = facets.harnesses.map((h) => h.id);
    // The individual harnesses are selectable...
    expect(harnessIds).toContain(Harness.Claude);
    expect(harnessIds).toContain(Harness.Codex);
    // OpenCode is a first-class individual harness option (ISS-4386).
    expect(harnessIds).toContain(Harness.Opencode);
    // ...but the synthetic combined "Multiple harnesses" (Harness.Both) row is
    // NOT offered as a filter option — checking the individual boxes is the union.
    expect(harnessIds).not.toContain(Harness.Both);
    // No option carries the combined label either.
    expect(facets.harnesses.map((h) => h.label)).not.toContain(
      "Multiple harnesses"
    );
  });

  it("rows with no authors contribute no collaborator option", () => {
    const facets = countFacetValues(ALL_ROWS, ALL_ROWS, EMPTY_FILTERS);

    // Row 4 has an empty authors set, so it adds no option and no null/empty id.
    const hasEmpty = facets.collaborators.some(
      (o) => o.id === null || o.id === "null" || o.id === ""
    );
    expect(hasEmpty).toBe(false);
    // The three distinct real authors across the corpus are present.
    expect(facets.collaborators.map((o) => o.id).sort()).toEqual([
      "Alice",
      "Bob",
      "Carol",
    ]);
  });

  it("collaborator/source counts reflect the already-filtered rows — not the full corpus", () => {
    // Narrow to only rows with harness=Claude (rows 1 and 4). With no explicit
    // `harnessCountRows`, the harness options also count off this narrowed set,
    // matching the pre-FEA-4336 passthrough contract for the non-harness dims.
    const filteredRows = ALL_ROWS.filter((r) => r.harness === Harness.Claude);

    const facets = countFacetValues(filteredRows, ALL_ROWS, EMPTY_FILTERS);

    const claudeCount = facets.harnesses.find(
      (h) => h.id === Harness.Claude
    )?.count;
    const codexCount = facets.harnesses.find(
      (h) => h.id === Harness.Codex
    )?.count;

    // Default (no harnessCountRows) → harness counts fall back to `rows`.
    expect(claudeCount).toBe(2); // rows 1 and 4
    expect(codexCount).toBe(0);
    // The combined `Both` value is no longer offered as a filter option (FEA-4336).
    expect(facets.harnesses.some((h) => h.id === Harness.Both)).toBe(false);
  });

  it("harness options count off harnessCountRows so an active harness filter does not zero-out the other harness (wongk, FEA-4336)", () => {
    // Simulate the real adapter with Claude checked: `rows` has dropped every
    // Codex-only component (only rows 1, 3, 4 survive the Claude facet — see
    // harnessMatchesFacet), but `harnessCountRows` is the harness-CLEARED corpus
    // (all four rows). The Codex option must still preview its true union count
    // instead of reading 0.
    const claudeFacet: Harness[] = [Harness.Claude, Harness.Both];
    const claudeFilteredRows = ALL_ROWS.filter((r) =>
      // rows 1, 4 = Claude; row 3 = Both (member of the Claude facet)
      claudeFacet.includes(r.harness)
    );

    const facets = countFacetValues(
      claudeFilteredRows,
      ALL_ROWS,
      { ...EMPTY_FILTERS, harnesses: [Harness.Claude] },
      // harness-cleared basis = full corpus (no other facet active here)
      ALL_ROWS
    );

    const claudeCount = facets.harnesses.find(
      (h) => h.id === Harness.Claude
    )?.count;
    const codexCount = facets.harnesses.find(
      (h) => h.id === Harness.Codex
    )?.count;

    // Off the harness-cleared corpus: Claude covers rows 1, 4 and the Both row 3
    // → 3; Codex covers row 2 and the Both row 3 → 2. Codex is NOT zeroed even
    // though checking Claude already removed the Codex-only row 2 from `rows`.
    expect(claudeCount).toBe(3);
    expect(codexCount).toBe(2);
    expect(facets.harnesses.some((h) => h.id === Harness.Both)).toBe(false);
  });

  it("counts a Both row under EVERY individual harness facet (FEA-4086 / ISS-4386)", () => {
    // The Both row (id 3) is used across more than one harness, so it is a member
    // of EVERY individual harness facet — Claude, Codex, AND OpenCode — matching
    // the membership predicate used to filter the rows. Counting it only under a
    // combined value (or only Claude+Codex) would show the individual options as
    // covering fewer rows than they actually do, and would drop it from the
    // OpenCode facet entirely (T2/T10). After FEA-4336 the combined `Both` value
    // is no longer a selectable option, but the Both row still folds into every
    // individual count so the union stays honest.
    const facets = countFacetValues(ALL_ROWS, ALL_ROWS, EMPTY_FILTERS);

    const claudeCount = facets.harnesses.find(
      (h) => h.id === Harness.Claude
    )?.count;
    const codexCount = facets.harnesses.find(
      (h) => h.id === Harness.Codex
    )?.count;
    const openCodeCount = facets.harnesses.find(
      (h) => h.id === Harness.Opencode
    )?.count;

    // Rows: 1=Claude, 2=Codex, 3=Both, 4=Claude.
    // Claude facet covers 1, 4, and the Both row 3 → 3.
    expect(claudeCount).toBe(3);
    // Codex facet covers 2 and the Both row 3 → 2.
    expect(codexCount).toBe(2);
    // OpenCode facet covers the Both row 3 → 1 (no OpenCode-only row here), so
    // the multi-harness component is NOT dropped from the OpenCode filter.
    expect(openCodeCount).toBe(1);
    // The combined `Both` value is not offered as a filter option (FEA-4336).
    expect(facets.harnesses.some((h) => h.id === Harness.Both)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-18.1(a) — Plugin kind in countFacetValues and KIND_ORDER
// ---------------------------------------------------------------------------

describe("Plugin kind — countFacetValues T-18.1(a)", () => {
  const EMPTY_FILTERS = {
    kinds: [] as AgentComponentKind[],
    collaborators: [],
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
      collaborators: ["DevOps"],
    });
    const otherRow = makeRow({
      id: "c1",
      kind: AgentComponentKind.Command,
      source: "repo-x",
      harness: Harness.Codex,
      collaborators: ["Alice"],
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

  it("counts plugin-kind rows in collaborators facet", () => {
    const pluginRow = makeRow({
      id: "p2",
      kind: AgentComponentKind.Plugin,
      source: "gstack",
      harness: Harness.Both,
      collaborators: ["Platform"],
    });
    const allRows = [pluginRow];

    const facets = countFacetValues([pluginRow], allRows, EMPTY_FILTERS);

    const platformCollaborator = facets.collaborators.find(
      (o) => o.id === "Platform"
    );
    expect(platformCollaborator?.count).toBe(1);
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
    const mcpIndex = labels.indexOf("MCPs");

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

    // Alphabetic by plural label: "MCPs" < "Plugins" < "Skills"
    expect(sorted.map((r) => r.id)).toEqual(["mcp-s", "plugin-s", "skill-s"]);
  });
});
