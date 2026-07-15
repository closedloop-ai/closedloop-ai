import {
  type AgentComponent,
  AgentComponentKind,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { useAgentComponentsFilterState } from "../use-agent-components-filter-state";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRow(
  id: string,
  kind: AgentComponentKind,
  owner: string | null = null,
  source = "repo-a",
  harness: Harness = Harness.Claude
): AgentComponent {
  return {
    id,
    name: `Component ${id}`,
    kind,
    sourceType: SourceType.Repo,
    source,
    harness,
    invocations: 5,
    sessions: 2,
    klocPerDollar: 1.0,
    trend: [],
    owner,
    collaborators: [],
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
        owners: [],
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
        owners: [],
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
        owners: [],
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
        owners: [],
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
        owners: [],
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
        owners: [],
        sources: ["repo-c"],
        harnesses: [],
        search: "",
      });
    });

    expect(result.current.filteredRows.map((r) => r.id)).toEqual(["f"]);
  });
});
