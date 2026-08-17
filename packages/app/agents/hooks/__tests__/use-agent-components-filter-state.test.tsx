import {
  type AgentComponent,
  AgentComponentKind,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_AGENT_COMPONENT_FILTERS,
  filterAgentComponentRows,
  harnessMatchesFacet,
  useAgentComponentsFilterState,
} from "../use-agent-components-filter-state";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRow(
  id: string,
  kind: AgentComponentKind,
  // FEA-4098 (Slice 3): the single author (collaborator) for this fixture row;
  // null means "no authors" (empty people-set), replacing the old owner param.
  collaborator: string | null = null,
  source = "repo-a",
  harness: Harness = Harness.Claude
): AgentComponent {
  return {
    id,
    slug: id,
    name: `Component ${id}`,
    kind,
    sourceType: SourceType.Repo,
    source,
    harness,
    invocations: 5,
    sessions: 2,
    locPerDollar: 1.0,
    trend: [],
    collaborators: collaborator === null ? [] : [collaborator],
    computeTargetIds: [],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
  };
}

const ROWS: AgentComponent[] = [
  makeRow("a", AgentComponentKind.Subagent, "Alice", "repo-a", Harness.Claude),
  makeRow("b", AgentComponentKind.Subagent, "Alice", "repo-a", Harness.Claude),
  makeRow("c", AgentComponentKind.Command, "Sam", "repo-b", Harness.Codex),
  makeRow("d", AgentComponentKind.Command, "Sam", "repo-b", Harness.Codex),
  makeRow("e", AgentComponentKind.Skill, "Jordan", "repo-a", Harness.Both),
  makeRow("f", AgentComponentKind.Hook, null, "repo-c", Harness.Claude),
];

describe("useAgentComponentsFilterState", () => {
  test("paginates rows by given page size and reports visible range", () => {
    const { result } = renderHook(() => useAgentComponentsFilterState(ROWS, 4));

    expect(result.current.total).toBe(6);
    expect(result.current.totalPages).toBe(2);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(result.current.from).toBe(1);
    expect(result.current.to).toBe(4);
  });

  test("advances to next page", () => {
    const { result } = renderHook(() => useAgentComponentsFilterState(ROWS, 4));

    act(() => result.current.setPage(1));

    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["e", "f"]);
    expect(result.current.from).toBe(5);
    expect(result.current.to).toBe(6);
  });

  test("filtering by kind narrows rows and recomputes totals", () => {
    const { result } = renderHook(() =>
      useAgentComponentsFilterState(ROWS, 10)
    );

    act(() => {
      result.current.handleFiltersChange({
        kinds: [AgentComponentKind.Command],
        collaborators: [],
        sources: [],
        harnesses: [],
        search: "",
      });
    });

    expect(result.current.total).toBe(2);
    expect(result.current.filteredRows.map((r) => r.id)).toEqual(["c", "d"]);
  });

  test("changing filters resets back to the first page", () => {
    const { result } = renderHook(() => useAgentComponentsFilterState(ROWS, 4));

    act(() => result.current.setPage(1));
    expect(result.current.page).toBe(1);

    act(() => {
      result.current.handleFiltersChange({
        kinds: [AgentComponentKind.Skill],
        collaborators: [],
        sources: [],
        harnesses: [],
        search: "",
      });
    });

    expect(result.current.page).toBe(0);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["e"]);
  });

  test("clamps the page when the row set shrinks beneath current page", () => {
    const { result, rerender } = renderHook(
      ({ rows }) => useAgentComponentsFilterState(rows, 4),
      { initialProps: { rows: ROWS } }
    );

    act(() => result.current.setPage(1));
    expect(result.current.page).toBe(1);

    rerender({ rows: ROWS.slice(0, 2) });

    expect(result.current.totalPages).toBe(1);
    expect(result.current.page).toBe(0);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.current.from).toBe(1);
    expect(result.current.to).toBe(2);
  });

  test("does not resurrect a stale page index after the corpus shrinks then regrows", () => {
    const { result, rerender } = renderHook(
      ({ rows }) => useAgentComponentsFilterState(rows, 4),
      { initialProps: { rows: ROWS } }
    );

    act(() => result.current.setPage(1));
    expect(result.current.page).toBe(1);

    rerender({ rows: ROWS.slice(0, 2) });
    expect(result.current.page).toBe(0);

    rerender({ rows: ROWS });
    expect(result.current.page).toBe(0);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("keeps at least one page and a zeroed range when nothing matches", () => {
    const { result } = renderHook(() => useAgentComponentsFilterState(ROWS, 4));

    act(() => {
      result.current.handleFiltersChange({
        kinds: [],
        collaborators: [],
        sources: [],
        harnesses: [],
        search: "zzzzzz-no-match",
      });
    });

    expect(result.current.total).toBe(0);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.pagedRows).toEqual([]);
    expect(result.current.from).toBe(0);
    expect(result.current.to).toBe(0);
  });

  test("search filter is case-insensitive substring match on name", () => {
    const { result } = renderHook(() =>
      useAgentComponentsFilterState(ROWS, 10)
    );

    act(() => {
      result.current.handleFiltersChange({
        kinds: [],
        collaborators: [],
        sources: [],
        harnesses: [],
        search: "component a",
      });
    });

    expect(result.current.filteredRows.map((r) => r.id)).toEqual(["a"]);
  });

  test("harness filter narrows rows by harness", () => {
    const { result } = renderHook(() =>
      useAgentComponentsFilterState(ROWS, 10)
    );

    act(() => {
      result.current.handleFiltersChange({
        kinds: [],
        collaborators: [],
        sources: [],
        harnesses: [Harness.Both],
        search: "",
      });
    });

    expect(result.current.filteredRows.map((r) => r.id)).toEqual(["e"]);
  });

  test("source filter narrows rows by source", () => {
    const { result } = renderHook(() =>
      useAgentComponentsFilterState(ROWS, 10)
    );

    act(() => {
      result.current.handleFiltersChange({
        kinds: [],
        collaborators: [],
        sources: ["repo-c"],
        harnesses: [],
        search: "",
      });
    });

    expect(result.current.filteredRows.map((r) => r.id)).toEqual(["f"]);
  });

  // FEA-4098 (Slice 3): the collaborators (authors) facet — a row matches when
  // any of its authors is selected.
  test("collaborators filter narrows rows by author", () => {
    const multiAuthor = makeRow(
      "g",
      AgentComponentKind.Skill,
      "Alice",
      "repo-a",
      Harness.Claude
    );
    // Give one row two authors so the "some author matches" semantics is proven.
    multiAuthor.collaborators = ["Alice", "Sam"];
    const rows = [...ROWS, multiAuthor];
    const { result } = renderHook(() =>
      useAgentComponentsFilterState(rows, 10)
    );

    act(() => {
      result.current.handleFiltersChange({
        kinds: [],
        collaborators: ["Alice"],
        sources: [],
        harnesses: [],
        search: "",
      });
    });

    // Alice authored rows a, b, and the multi-author g (not c/d/e/f).
    expect(result.current.filteredRows.map((r) => r.id)).toEqual([
      "a",
      "b",
      "g",
    ]);
  });

  test("a whitespace-only search is treated as no search (FEA-4086)", () => {
    // A single space must NOT filter to zero rows: it is trimmed to "" so it is
    // the same "no search" the empty-state honesty helpers see. Otherwise a
    // space empties the list while the copy still claims a full inventory.
    const { result } = renderHook(() =>
      useAgentComponentsFilterState(ROWS, 10)
    );

    act(() => {
      result.current.handleFiltersChange({
        ...DEFAULT_AGENT_COMPONENT_FILTERS,
        search: "   ",
      });
    });

    expect(result.current.total).toBe(ROWS.length);
  });
});

describe("filterAgentComponentRows — harness membership (FEA-4086)", () => {
  test("a Claude+Codex (Both) row surfaces under a single Claude harness facet", () => {
    // The Both row `e` ran across Claude and Codex, so it is a member of the
    // Claude facet. A naive `includes(row.harness)` would drop it ("both" !==
    // "claude") and the empty state would wrongly read "No plugins installed
    // for Claude."
    const filtered = filterAgentComponentRows(ROWS, {
      ...DEFAULT_AGENT_COMPONENT_FILTERS,
      harnesses: [Harness.Claude],
    });
    // Rows a, b (Claude) plus e (Both) — f is a Claude Hook, so it matches too.
    expect(filtered.map((r) => r.id).sort()).toEqual(["a", "b", "e", "f"]);
  });

  test("a Both row also surfaces under a single Codex harness facet", () => {
    const filtered = filterAgentComponentRows(ROWS, {
      ...DEFAULT_AGENT_COMPONENT_FILTERS,
      harnesses: [Harness.Codex],
    });
    // Rows c, d (Codex) plus e (Both).
    expect(filtered.map((r) => r.id).sort()).toEqual(["c", "d", "e"]);
  });

  test("checking both individual harnesses yields the union, including the combined Both row (FEA-4336)", () => {
    // FEA-4336 removes the synthetic combined "Claude + Codex" filter option, so
    // the way to see everything is to check both individual boxes. That union
    // must cover every row — including the combined-harness row `e` — so removing
    // the combined option never orphans a Both row.
    const filtered = filterAgentComponentRows(ROWS, {
      ...DEFAULT_AGENT_COMPONENT_FILTERS,
      harnesses: [Harness.Claude, Harness.Codex],
    });
    // Every row surfaces: a/b/f (Claude), c/d (Codex), and e (Both).
    expect(filtered.map((r) => r.id).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });

  test("harnessMatchesFacet: Both matches ANY individual harness; singles match only themselves", () => {
    expect(harnessMatchesFacet(Harness.Both, [Harness.Claude])).toBe(true);
    expect(harnessMatchesFacet(Harness.Both, [Harness.Codex])).toBe(true);
    // ISS-4386: a multi-harness (`Both`) row is a member of the OpenCode facet
    // too — a Claude+OpenCode component must not drop out of the OpenCode filter
    // (T2/T10).
    expect(harnessMatchesFacet(Harness.Both, [Harness.Opencode])).toBe(true);
    expect(harnessMatchesFacet(Harness.Both, [Harness.Both])).toBe(true);
    expect(harnessMatchesFacet(Harness.Claude, [Harness.Claude])).toBe(true);
    expect(harnessMatchesFacet(Harness.Claude, [Harness.Codex])).toBe(false);
    // A single-harness row is NOT a member of the Both facet.
    expect(harnessMatchesFacet(Harness.Claude, [Harness.Both])).toBe(false);
    // An OpenCode-only row matches only OpenCode.
    expect(harnessMatchesFacet(Harness.Opencode, [Harness.Opencode])).toBe(
      true
    );
    expect(harnessMatchesFacet(Harness.Opencode, [Harness.Claude])).toBe(false);
  });
});
