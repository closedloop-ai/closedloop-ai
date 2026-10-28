"use client";

import type { AgentComponent } from "@repo/api/src/types/agent-component";
import type { AgentsListSurfaceV2ViewModel } from "../../hooks/use-agents-list-surface-v2-view-model";
import { AgentsTable } from "./agents-table";

/**
 * `AgentsListSurfaceV2`'s populated body (ISS-9398).
 *
 * Renders the current page — grouped into sections or flat, as the view model
 * already decided — through the shared `AgentsTable`. Rows link via the host's
 * `getComponentHref`, which is the one genuinely per-shell value in this whole
 * surface (`HostBoundarySeam.Routing`).
 */
export function AgentsListSurfaceV2Rows({
  getComponentHref,
  model,
}: {
  getComponentHref: (item: AgentComponent) => string;
  model: AgentsListSurfaceV2ViewModel;
}) {
  return (
    <AgentsTable
      columnOrder={model.columnOrder}
      getComponentHref={getComponentHref}
      groups={model.tableGroups}
      items={model.flatItems}
      metricMode={model.metricMode}
      onColumnOrderChange={model.onColumnOrderChange}
      onSort={model.onSort}
      sortBy={model.sortKey}
      sortDir={model.sortDir}
      visibleColumns={model.visibleColumns}
    />
  );
}
