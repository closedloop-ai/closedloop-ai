import {
  AgentComponentGroupBy,
  AgentComponentSortDir,
  AgentComponentSortKey,
  AgentMetricMode,
} from "@repo/api/src/types/agent-component";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_TOGGLEABLE_COLUMNS,
  useAgentComponentsViewState,
} from "../use-agent-components-view-state";

afterEach(() => {
  localStorage.clear();
});

describe("useAgentComponentsViewState", () => {
  it("defaults to Name sort ascending, None group-by, KlocPerDollar metric", () => {
    const { result } = renderHook(() => useAgentComponentsViewState());
    expect(result.current.sortKey).toBe(AgentComponentSortKey.Name);
    expect(result.current.sortDir).toBe(AgentComponentSortDir.Asc);
    expect(result.current.groupBy).toBe(AgentComponentGroupBy.None);
    expect(result.current.metricMode).toBe(AgentMetricMode.KlocPerDollar);
  });

  it("all toggleable columns are visible by default", () => {
    const { result } = renderHook(() => useAgentComponentsViewState());
    for (const col of AGENT_COMPONENT_TOGGLEABLE_COLUMNS) {
      expect(result.current.visibleColumns.has(col.id)).toBe(true);
    }
  });

  it("toggles a column on/off", () => {
    const { result } = renderHook(() => useAgentComponentsViewState());
    expect(result.current.visibleColumns.has("type")).toBe(true);
    act(() => result.current.toggleColumn("type"));
    expect(result.current.visibleColumns.has("type")).toBe(false);
    act(() => result.current.toggleColumn("type"));
    expect(result.current.visibleColumns.has("type")).toBe(true);
  });

  it("sets sort key without changing direction when dir is omitted", () => {
    const { result } = renderHook(() => useAgentComponentsViewState());
    act(() => result.current.setSort(AgentComponentSortKey.Invocations));
    expect(result.current.sortKey).toBe(AgentComponentSortKey.Invocations);
    expect(result.current.sortDir).toBe(AgentComponentSortDir.Asc);
  });

  it("sets sort key and direction together", () => {
    const { result } = renderHook(() => useAgentComponentsViewState());
    act(() =>
      result.current.setSort(
        AgentComponentSortKey.Sessions,
        AgentComponentSortDir.Desc
      )
    );
    expect(result.current.sortKey).toBe(AgentComponentSortKey.Sessions);
    expect(result.current.sortDir).toBe(AgentComponentSortDir.Desc);
  });

  it("toggles sort direction between asc and desc", () => {
    const { result } = renderHook(() => useAgentComponentsViewState());
    expect(result.current.sortDir).toBe(AgentComponentSortDir.Asc);
    act(() => result.current.toggleSortDir());
    expect(result.current.sortDir).toBe(AgentComponentSortDir.Desc);
    act(() => result.current.toggleSortDir());
    expect(result.current.sortDir).toBe(AgentComponentSortDir.Asc);
  });

  it("updates groupBy", () => {
    const { result } = renderHook(() => useAgentComponentsViewState());
    act(() => result.current.setGroupBy(AgentComponentGroupBy.Type));
    expect(result.current.groupBy).toBe(AgentComponentGroupBy.Type);
  });

  it("updates metricMode", () => {
    const { result } = renderHook(() => useAgentComponentsViewState());
    act(() => result.current.setMetricMode(AgentMetricMode.DollarPerKloc));
    expect(result.current.metricMode).toBe(AgentMetricMode.DollarPerKloc);
  });

  it("persists and restores view state via localStorage persistKey", () => {
    const persistKey = "agents:web";
    const first = renderHook(() => useAgentComponentsViewState(persistKey));
    act(() => {
      first.result.current.setSort(
        AgentComponentSortKey.Owner,
        AgentComponentSortDir.Desc
      );
      first.result.current.setGroupBy(AgentComponentGroupBy.Owner);
      first.result.current.setMetricMode(AgentMetricMode.ValueIndex);
      first.result.current.toggleColumn("harness");
    });

    // A second hook instance reads from localStorage
    const second = renderHook(() => useAgentComponentsViewState(persistKey));
    expect(second.result.current.sortKey).toBe(AgentComponentSortKey.Owner);
    expect(second.result.current.sortDir).toBe(AgentComponentSortDir.Desc);
    expect(second.result.current.groupBy).toBe(AgentComponentGroupBy.Owner);
    expect(second.result.current.metricMode).toBe(AgentMetricMode.ValueIndex);
    expect(second.result.current.visibleColumns.has("harness")).toBe(false);
  });

  it("restores without a persistKey — no localStorage access", () => {
    // Without persistKey nothing should throw and defaults should be returned
    const { result } = renderHook(() => useAgentComponentsViewState());
    expect(result.current.sortKey).toBe(AgentComponentSortKey.Name);
    // No items should appear in storage
    expect(localStorage.length).toBe(0);
  });

  it("ignores unknown column ids in persisted hiddenColumns", () => {
    localStorage.setItem(
      "agents:saved-view:agents:test",
      JSON.stringify({
        sortKey: AgentComponentSortKey.Name,
        sortDir: AgentComponentSortDir.Asc,
        groupBy: AgentComponentGroupBy.None,
        metricMode: AgentMetricMode.KlocPerDollar,
        hiddenColumns: ["future-col", "type"],
      })
    );

    const { result } = renderHook(() =>
      useAgentComponentsViewState("agents:test")
    );
    // Known hidden column was applied
    expect(result.current.visibleColumns.has("type")).toBe(false);
    // Unknown column is not surfaced in visibleColumns (correct: it was simply ignored)
    expect([...result.current.visibleColumns]).not.toContain("future-col");
  });

  it("resetColumns restores a hidden column to visible", () => {
    const { result } = renderHook(() => useAgentComponentsViewState());
    const firstColumn = AGENT_COMPONENT_TOGGLEABLE_COLUMNS[0].id;

    expect(result.current.visibleColumns.has(firstColumn)).toBe(true);

    act(() => result.current.toggleColumn(firstColumn));
    expect(result.current.visibleColumns.has(firstColumn)).toBe(false);

    act(() => result.current.resetColumns());
    expect(result.current.visibleColumns.has(firstColumn)).toBe(true);
  });

  it("resetColumns restores ALL toggleable columns", () => {
    const { result } = renderHook(() => useAgentComponentsViewState());

    act(() => {
      for (const column of AGENT_COMPONENT_TOGGLEABLE_COLUMNS) {
        result.current.toggleColumn(column.id);
      }
    });
    for (const column of AGENT_COMPONENT_TOGGLEABLE_COLUMNS) {
      expect(result.current.visibleColumns.has(column.id)).toBe(false);
    }

    act(() => result.current.resetColumns());
    for (const column of AGENT_COMPONENT_TOGGLEABLE_COLUMNS) {
      expect(result.current.visibleColumns.has(column.id)).toBe(true);
    }
  });
});
