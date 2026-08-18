import {
  type AgentComponent,
  AgentComponentKind,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { ComponentScope } from "@repo/api/src/types/component-scope";
import { describe, expect, it } from "vitest";
import {
  type AgentComponentFilters,
  DEFAULT_AGENT_COMPONENT_FILTERS,
  filterAgentComponentRows,
} from "../../../hooks/use-agent-components-filter-state";
import { agentComponentFilterFacetGroups } from "../agent-component-filter-adapter";

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

const ALL_ROWS: AgentComponent[] = [
  makeRow({ id: "1", harness: Harness.Claude }),
  makeRow({ id: "2", harness: Harness.Codex }),
  makeRow({ id: "3", harness: Harness.Both }),
  makeRow({ id: "4", harness: Harness.Claude }),
];

function harnessOptions(
  filteredRows: AgentComponent[],
  filters: AgentComponentFilters
) {
  const groups = agentComponentFilterFacetGroups(
    filteredRows,
    ALL_ROWS,
    filters,
    () => {
      // onChange is not exercised by these count assertions.
    },
    // ISS-5009 Source-provenance honesty off — these cases are about the harness
    // facet, and the flag must not change them.
    false
  );
  const harness = groups.find((g) => g.id === "harness");
  return harness?.options ?? [];
}

describe("agentComponentFilterFacetGroups — harness self-exclusion (wongk, FEA-4336)", () => {
  it("keeps the other harness's count non-zero when one harness is checked", () => {
    // Claude is checked → the adapter narrows `rows` to the Claude facet, which
    // drops the Codex-only row 2. If the harness options counted off that
    // narrowed set, Codex would read 0. They must instead count off the
    // harness-cleared corpus so Codex previews its true union add.
    const filters: AgentComponentFilters = {
      ...DEFAULT_AGENT_COMPONENT_FILTERS,
      harnesses: [Harness.Claude],
    };
    // Rows the Claude facet surfaces: 1, 4 (Claude) + 3 (Both).
    const claudeFacet: Harness[] = [Harness.Claude, Harness.Both];
    const claudeFilteredRows = ALL_ROWS.filter((r) =>
      claudeFacet.includes(r.harness)
    );

    const options = harnessOptions(claudeFilteredRows, filters);

    const claude = options.find((o) => o.id === Harness.Claude);
    const codex = options.find((o) => o.id === Harness.Codex);

    // Off the harness-cleared corpus: Claude = rows 1, 3, 4 → 3; Codex = rows
    // 2, 3 → 2. Crucially Codex is NOT zeroed by the active Claude filter.
    expect(claude?.count).toBe(3);
    expect(codex?.count).toBe(2);
    // Combined Both is never a selectable option (FEA-4336).
    expect(options.some((o) => o.id === Harness.Both)).toBe(false);
  });

  it("uses the fully-filtered rows for harness counts when no harness is selected", () => {
    // No harness filter → counts reflect the current (here: full) narrowing.
    const options = harnessOptions(ALL_ROWS, DEFAULT_AGENT_COMPONENT_FILTERS);

    const claude = options.find((o) => o.id === Harness.Claude);
    const codex = options.find((o) => o.id === Harness.Codex);

    // Claude = rows 1, 3, 4 → 3; Codex = rows 2, 3 → 2.
    expect(claude?.count).toBe(3);
    expect(codex?.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ISS-5009 — the Source facet is gated as ONE unit
// ---------------------------------------------------------------------------

/** A user-scoped row whose legacy `source` is its own identity-key echo. */
const SCOPE_USER_ECHO = "skill::python";
const SCOPE_USER_HONEST = ComponentScope.User;

/** A row with no provenance at all — its legacy `source` is its own pack echo. */
const NO_PROVENANCE_ECHO = "code";

const HONEST_ROWS: AgentComponent[] = [
  makeRow({
    id: "honest-1",
    slug: "skill::python",
    name: "Python Expert Skill",
    source: SCOPE_USER_ECHO,
    honestSource: {
      hasProvenance: true,
      source: SCOPE_USER_HONEST,
      sourceType: SourceType.Local,
    },
  }),
  makeRow({
    id: "honest-2",
    slug: "plugin::code",
    name: NO_PROVENANCE_ECHO,
    sourceType: SourceType.Pack,
    source: NO_PROVENANCE_ECHO,
    honestSource: {
      hasProvenance: false,
      source: null,
      sourceType: SourceType.Local,
    },
  }),
];

function sourceOptionIds(honestSourceEnabled: boolean): string[] {
  const groups = agentComponentFilterFacetGroups(
    HONEST_ROWS,
    HONEST_ROWS,
    DEFAULT_AGENT_COMPONENT_FILTERS,
    () => {
      // onChange is not exercised by these option assertions.
    },
    honestSourceEnabled
  );
  return (groups.find((g) => g.id === "source")?.options ?? []).map((option) =>
    String(option.id)
  );
}

describe("agentComponentFilterFacetGroups — Source facet honesty (ISS-5009)", () => {
  it("offers the honest value and drops the identity-key echoes when enabled", () => {
    const ids = sourceOptionIds(true);

    expect(ids).toContain(SCOPE_USER_HONEST);
    // The echoes are gone from the menu entirely: a provenance-less row leaves
    // the facet rather than contributing its own identifier as a "source".
    expect(ids).not.toContain(SCOPE_USER_ECHO);
    expect(ids).not.toContain(NO_PROVENANCE_ECHO);
  });

  it("keeps the rows the honest option covers VISIBLE through the membership predicate", () => {
    // The load-bearing case. Gating only the option universe would leave the
    // menu offering "user" with a positive count while
    // `filterAgentComponentRows` still compared it against the legacy echo —
    // selecting it would return ZERO rows and empty the catalog, strictly worse
    // than the echo being fixed. Assert the rows SURVIVE, not merely that the
    // echo left the menu.
    const filtered = filterAgentComponentRows(
      HONEST_ROWS,
      { ...DEFAULT_AGENT_COMPONENT_FILTERS, sources: [SCOPE_USER_HONEST] },
      true
    );

    expect(filtered.map((row) => row.id)).toEqual(["honest-1"]);
  });

  it("counts the honest option over exactly the rows it selects", () => {
    const groups = agentComponentFilterFacetGroups(
      HONEST_ROWS,
      HONEST_ROWS,
      DEFAULT_AGENT_COMPONENT_FILTERS,
      () => {
        // onChange is not exercised here.
      },
      true
    );
    const option = groups
      .find((g) => g.id === "source")
      ?.options.find((o) => o.id === SCOPE_USER_HONEST);

    // A count that does not match the membership predicate's result is the
    // same lie in a different place.
    expect(option?.count).toBe(
      filterAgentComponentRows(
        HONEST_ROWS,
        { ...DEFAULT_AGENT_COMPONENT_FILTERS, sources: [SCOPE_USER_HONEST] },
        true
      ).length
    );
  });

  it("offers and matches the legacy echoes when disabled", () => {
    // The dark-launch no-op: both echoes are still selectable options, and
    // selecting one still surfaces its row exactly as it does today.
    const ids = sourceOptionIds(false);
    expect(ids).toEqual([NO_PROVENANCE_ECHO, SCOPE_USER_ECHO].sort());
    expect(ids).not.toContain(SCOPE_USER_HONEST);

    const filtered = filterAgentComponentRows(HONEST_ROWS, {
      ...DEFAULT_AGENT_COMPONENT_FILTERS,
      sources: [SCOPE_USER_ECHO],
    });
    expect(filtered.map((row) => row.id)).toEqual(["honest-1"]);
  });
});
