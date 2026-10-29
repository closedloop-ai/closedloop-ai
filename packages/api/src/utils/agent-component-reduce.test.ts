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
  type AgentComponentFilters,
  countFacetValues,
  DEFAULT_AGENT_COMPONENT_FILTERS,
  filterAgentComponentRows,
  harnessMatchesFacet,
  kindPlural,
  normalizedSearch,
  sortAgentComponentRows,
  sourceFacetValue,
} from "./agent-component-reduce.js";

describe("kindPlural", () => {
  it.each([
    [AgentComponentKind.Subagent, "Agents"],
    [AgentComponentKind.Command, "Commands"],
    [AgentComponentKind.Skill, "Skills"],
    [AgentComponentKind.Workflow, "Workflows"],
    [AgentComponentKind.Plugin, "Plugins"],
    [AgentComponentKind.Mcp, "MCPs"],
    [AgentComponentKind.Tool, "Tools"],
    [AgentComponentKind.Orchestration, "Orchestration"],
    [AgentComponentKind.Hook, "Hooks"],
    [AgentComponentKind.Config, "Memory & config"],
  ])("maps known kind %s to %s", (kind, label) => {
    expect(kindPlural(kind)).toBe(label);
  });

  it("labelizes and pluralizes an unknown kind", () => {
    expect(kindPlural("custom_thing")).toBe("Custom Things");
  });
});

describe("normalizedSearch", () => {
  it("trims the search string", () => {
    expect(normalizedSearch(filters({ search: "  abc \t" }))).toBe("abc");
  });
});

describe("harnessMatchesFacet", () => {
  it("matches a row whose harness is selected", () => {
    expect(harnessMatchesFacet(Harness.Codex, [Harness.Codex])).toBe(true);
    expect(harnessMatchesFacet(Harness.Both, [Harness.Both])).toBe(true);
  });

  it("matches a Both row under any individual harness", () => {
    expect(harnessMatchesFacet(Harness.Both, [Harness.Opencode])).toBe(true);
  });

  it("does not match a Both row with no individual selection", () => {
    expect(harnessMatchesFacet(Harness.Both, [])).toBe(false);
  });

  it("does not match a single-harness row outside the selection", () => {
    expect(harnessMatchesFacet(Harness.Claude, [Harness.Codex])).toBe(false);
    expect(harnessMatchesFacet(Harness.Claude, [Harness.Both])).toBe(false);
  });
});

describe("filterAgentComponentRows", () => {
  const rows = [
    row({
      id: "a",
      name: "Alpha Reviewer",
      kind: AgentComponentKind.Subagent,
      collaborators: ["ann"],
      source: "repo-a",
      harness: Harness.Claude,
    }),
    row({
      id: "b",
      name: "beta",
      kind: AgentComponentKind.Skill,
      collaborators: ["bob", "cat"],
      source: "repo-b",
      harness: Harness.Codex,
    }),
    row({
      id: "c",
      name: "gamma",
      kind: AgentComponentKind.Skill,
      collaborators: [],
      source: "repo-a",
      harness: Harness.Both,
    }),
  ];

  it("returns every row under default filters", () => {
    expect(ids(filterAgentComponentRows(rows, filters()))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("narrows by kind", () => {
    expect(
      ids(
        filterAgentComponentRows(
          rows,
          filters({ kinds: [AgentComponentKind.Skill] })
        )
      )
    ).toEqual(["b", "c"]);
  });

  it("narrows by any matching collaborator", () => {
    expect(
      ids(filterAgentComponentRows(rows, filters({ collaborators: ["cat"] })))
    ).toEqual(["b"]);
  });

  it("narrows by legacy source", () => {
    expect(
      ids(filterAgentComponentRows(rows, filters({ sources: ["repo-a"] })))
    ).toEqual(["a", "c"]);
  });

  it("narrows by harness, keeping Both rows under an individual harness", () => {
    expect(
      ids(
        filterAgentComponentRows(rows, filters({ harnesses: [Harness.Codex] }))
      )
    ).toEqual(["b", "c"]);
  });

  it("matches search case-insensitively as a trimmed substring", () => {
    expect(
      ids(filterAgentComponentRows(rows, filters({ search: " REVIEW " })))
    ).toEqual(["a"]);
  });

  it("treats a whitespace-only search as no search", () => {
    expect(
      ids(filterAgentComponentRows(rows, filters({ search: "   " })))
    ).toHaveLength(3);
  });

  it("uses the honest source projection when enabled, excluding provenance-less rows", () => {
    const honestRows = [
      row({
        id: "p",
        source: "echo-key",
        honestSource: {
          hasProvenance: true,
          source: "user",
          sourceType: SourceType.Local,
        },
      }),
      row({
        id: "q",
        source: "user",
        honestSource: {
          hasProvenance: false,
          source: null,
          sourceType: SourceType.Local,
        },
      }),
    ];
    const selected = filters({ sources: ["user"] });
    expect(ids(filterAgentComponentRows(honestRows, selected, true))).toEqual([
      "p",
    ]);
    expect(ids(filterAgentComponentRows(honestRows, selected))).toEqual(["q"]);
  });
});

describe("sortAgentComponentRows", () => {
  const rows = [
    row({
      id: "1",
      name: "bravo",
      kind: AgentComponentKind.Skill,
      source: "zeta",
      harness: Harness.Codex,
      locPerDollar: 5,
      invocations: 10,
      sessions: null,
    }),
    row({
      id: "2",
      name: "alpha",
      kind: AgentComponentKind.Subagent,
      source: "eta",
      harness: Harness.Claude,
      locPerDollar: null,
      invocations: null,
      sessions: 3,
    }),
    row({
      id: "3",
      name: "charlie",
      kind: AgentComponentKind.Command,
      source: "alpha",
      harness: Harness.Opencode,
      locPerDollar: 2,
      invocations: 1,
      sessions: 7,
    }),
  ];

  it.each([
    [AgentComponentSortKey.Name, ["2", "1", "3"]],
    // Agents < Commands < Skills (plural labels, not raw kinds).
    [AgentComponentSortKey.Type, ["2", "3", "1"]],
    [AgentComponentSortKey.Source, ["3", "2", "1"]],
    [AgentComponentSortKey.Harness, ["2", "1", "3"]],
    // null sorts as -Infinity.
    [AgentComponentSortKey.Metric, ["2", "3", "1"]],
    [AgentComponentSortKey.Invocations, ["2", "3", "1"]],
    [AgentComponentSortKey.Sessions, ["1", "2", "3"]],
  ])("sorts by %s ascending and reverses descending", (key, expected) => {
    expect(
      ids(sortAgentComponentRows(rows, key, AgentComponentSortDir.Asc))
    ).toEqual(expected);
    expect(
      ids(sortAgentComponentRows(rows, key, AgentComponentSortDir.Desc))
    ).toEqual([...expected].reverse());
  });

  it("sorts an unknown kind by its labelized plural without crashing", () => {
    const mixed = [
      row({ id: "x", kind: "zzz_kind" as AgentComponentKind }),
      row({ id: "y", kind: "aaa" as AgentComponentKind }),
    ];
    expect(
      ids(
        sortAgentComponentRows(
          mixed,
          AgentComponentSortKey.Type,
          AgentComponentSortDir.Asc
        )
      )
    ).toEqual(["y", "x"]);
  });

  it("does not mutate the input array", () => {
    const input = [...rows];
    sortAgentComponentRows(
      input,
      AgentComponentSortKey.Name,
      AgentComponentSortDir.Asc
    );
    expect(ids(input)).toEqual(["1", "2", "3"]);
  });
});

describe("countFacetValues", () => {
  it("counts collaborators once per row, sorts options, and keeps zero-count universe values", () => {
    const rows = [
      row({ id: "a", collaborators: ["zed", "amy", "amy"], source: "s2" }),
      row({ id: "b", collaborators: ["amy"], source: "s2" }),
    ];
    const all = [
      ...rows,
      row({ id: "c", collaborators: ["mo"], source: "s1" }),
    ];
    const result = countFacetValues(rows, all, filters());
    expect(result.collaborators).toEqual([
      { id: "amy", label: "amy", count: 2 },
      { id: "mo", label: "mo", count: 0 },
      { id: "zed", label: "zed", count: 1 },
    ]);
    expect(result.sources).toEqual([
      { id: "s1", label: "s1", count: 0 },
      { id: "s2", label: "s2", count: 2 },
    ]);
  });

  it("offers only individual harnesses and folds Both rows into every one", () => {
    const rows = [
      row({ id: "a", harness: Harness.Claude }),
      row({ id: "b", harness: Harness.Both }),
    ];
    expect(countFacetValues(rows, rows, filters()).harnesses).toEqual([
      { id: Harness.Claude, label: "Claude", count: 2 },
      { id: Harness.Codex, label: "Codex", count: 1 },
      { id: Harness.Opencode, label: "OpenCode", count: 1 },
    ]);
  });

  it("counts harnesses from harnessCountRows when supplied", () => {
    const rows = [row({ id: "a", harness: Harness.Claude })];
    const harnessRows = [
      row({ id: "a", harness: Harness.Claude }),
      row({ id: "b", harness: Harness.Codex }),
    ];
    const result = countFacetValues(rows, harnessRows, filters(), harnessRows);
    expect(result.harnesses.map((o) => o.count)).toEqual([1, 1, 0]);
  });

  it("drops provenance-less rows from the Source universe and counts under the honest flag", () => {
    const rows = [
      row({
        id: "a",
        source: "echo",
        honestSource: {
          hasProvenance: false,
          source: null,
          sourceType: SourceType.Local,
        },
      }),
      row({
        id: "b",
        source: "legacy",
        honestSource: {
          hasProvenance: true,
          source: "pack-x",
          sourceType: SourceType.Pack,
        },
      }),
    ];
    expect(countFacetValues(rows, rows, filters(), rows, true).sources).toEqual(
      [{ id: "pack-x", label: "pack-x", count: 1 }]
    );
    expect(countFacetValues(rows, rows, filters()).sources).toEqual([
      { id: "echo", label: "echo", count: 1 },
      { id: "legacy", label: "legacy", count: 1 },
    ]);
  });
});

describe("sourceFacetValue", () => {
  const withProvenance = row({
    source: "legacy",
    honestSource: {
      hasProvenance: true,
      source: "real",
      sourceType: SourceType.Repo,
    },
  });
  const withoutProvenance = row({
    source: "legacy",
    honestSource: {
      hasProvenance: false,
      source: null,
      sourceType: SourceType.Local,
    },
  });

  it("returns the honest source when enabled and provenance exists", () => {
    expect(sourceFacetValue(withProvenance, true)).toBe("real");
  });

  it("returns null when enabled and there is no provenance", () => {
    expect(sourceFacetValue(withoutProvenance, true)).toBeNull();
  });

  it("returns the legacy source when disabled or honestSource is absent", () => {
    expect(sourceFacetValue(withProvenance, false)).toBe("legacy");
    expect(sourceFacetValue(row({ source: "legacy" }), true)).toBe("legacy");
  });
});

function filters(
  overrides: Partial<AgentComponentFilters> = {}
): AgentComponentFilters {
  return { ...DEFAULT_AGENT_COMPONENT_FILTERS, ...overrides };
}

function ids(rows: AgentComponent[]): string[] {
  return rows.map((r) => r.id);
}

function row(overrides: Partial<AgentComponent> = {}): AgentComponent {
  const id = overrides.id ?? "id";
  return {
    id,
    slug: `skill::${id}`,
    name: id,
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
