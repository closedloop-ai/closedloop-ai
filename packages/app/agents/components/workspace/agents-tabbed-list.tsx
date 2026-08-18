"use client";

/**
 * Agents workspace Separated/tabbed layout (T-3.5).
 *
 * Renders one tab per AgentComponentKind in KIND_ORDER. Each tab shows an
 * AgentsTable filtered to that kind only.
 *
 * Per-kind columns (FEA-4052): the metric and invocations columns are omitted
 * for configured-only kinds (Hook, Config) whose values are always null, and the
 * LOC/$ metric column alone is omitted for an observed-but-non-verifiable kind
 * (plugin/mcp) whose per-component LOC/$ can't be reliably attributed. Any tab
 * whose metric column is hidden defaults to name sort ascending rather than to a
 * hidden metric column.
 *
 * This component is selectable as a view-option from AgentsViewMenu (a layout
 * toggle, not a group-by dimension).
 *
 * Domain component: lives in this feature slice, NOT in @closedloop-ai/design-system.
 */

import {
  type AgentComponent,
  type AgentComponentKind,
  AgentComponentSortDir,
  AgentComponentSortKey,
  type AgentMetricMode,
  isLocPerDollarVerifiableKind,
} from "@repo/api/src/types/agent-component";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { useState } from "react";
import { sortAgentComponentRows } from "../../lib/agent-component-sort-group";
import { isObservedKind, KIND_ORDER, kindMeta } from "../../lib/component-meta";
import { AgentsTable } from "./agents-table";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Column ids to omit for configured-only kinds (Hook, Config).
 * These kinds have null locPerDollar and null invocations so those columns
 * carry no information and are removed from the per-kind view.
 */
const CONFIGURED_ONLY_HIDDEN_COLUMNS = new Set<string>([
  "metric",
  "invocations",
]);

/**
 * FEA-4052: the LOC/$ (efficiency) metric column, hidden on a tab whose kind
 * has no reliable per-component attribution ({@link isLocPerDollarVerifiableKind}). The
 * service already returns `locPerDollar: null` for those kinds, so the column
 * would render an all-"—" strip; hiding it (in lockstep with the summary card,
 * see `AgentsSummaryCards`) means the tab never shows a LOC/$ number it can't
 * back — no zeros, no misleading placeholders.
 */
const METRIC_COLUMN_ID = "metric";

// ---------------------------------------------------------------------------
// Per-kind state
// ---------------------------------------------------------------------------

type KindViewState = {
  sortKey: AgentComponentSortKey;
  sortDir: AgentComponentSortDir;
};

export function defaultKindState(kind: AgentComponentKind): KindViewState {
  // FEA-4052: only kinds with a reliable, VISIBLE LOC/$ column default to
  // metric-descending (highest efficiency first). A kind whose metric column is
  // hidden (configured-only OR a non-verifiable observed kind like plugin/mcp)
  // would otherwise default-sort by a column the user can't see, so it falls
  // back to name sort ascending.
  if (isLocPerDollarVerifiableKind(kind)) {
    return {
      sortKey: AgentComponentSortKey.Metric,
      sortDir: AgentComponentSortDir.Desc,
    };
  }
  return {
    sortKey: AgentComponentSortKey.Name,
    sortDir: AgentComponentSortDir.Asc,
  };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type AgentsTabbedListProps = {
  /** Full inventory row set — this component filters per tab. */
  items: AgentComponent[];
  /**
   * Set of column ids that should be visible. When provided, additional
   * per-kind column omissions (metric/invocations for Hook/Config) are layered
   * on top. When absent, only the per-kind omissions apply.
   */
  visibleColumns?: Set<string>;
  /**
   * When provided, clicking a row's name cell navigates to the returned href.
   */
  getComponentHref?: (item: AgentComponent) => string;
  /** Which efficiency metric the Metric column displays. */
  metricMode: AgentMetricMode;
};

// ---------------------------------------------------------------------------
// AgentsTabbedList
// ---------------------------------------------------------------------------

/**
 * Separated/tabbed layout for the Agents workspace inventory.
 *
 * One Tabs.Tab per AgentComponentKind in KIND_ORDER. Each tab renders an
 * AgentsTable filtered to that kind only, with sort state managed independently
 * per tab (configured-only kinds default to name sort rather than metric sort).
 */
export function AgentsTabbedList({
  items,
  visibleColumns,
  getComponentHref,
  metricMode,
}: AgentsTabbedListProps): React.ReactNode {
  const [activeTab, setActiveTab] = useState<AgentComponentKind>(KIND_ORDER[0]);

  // Per-kind sort state — each tab gets independent sort controls.
  const [kindStates, setKindStates] = useState<
    Record<AgentComponentKind, KindViewState>
  >(
    () =>
      Object.fromEntries(
        KIND_ORDER.map((kind) => [kind, defaultKindState(kind)])
      ) as Record<AgentComponentKind, KindViewState>
  );

  const handleSort = (
    kind: AgentComponentKind,
    col: string,
    dir: AgentComponentSortDir
  ) => {
    setKindStates((prev) => ({
      ...prev,
      [kind]: { sortKey: col as AgentComponentSortKey, sortDir: dir },
    }));
  };

  return (
    <Tabs
      className="flex min-h-0 flex-1 flex-col"
      onValueChange={(value) => setActiveTab(value as AgentComponentKind)}
      value={activeTab}
    >
      {/* Tab bar */}
      <div className="shrink-0 border-b px-4">
        <TabsList className="h-auto rounded-none border-0 bg-transparent p-0">
          {KIND_ORDER.map((kind) => {
            const meta = kindMeta(kind);
            const Icon = meta.icon;
            const kindItems = items.filter((item) => item.kind === kind);
            return (
              <TabsTrigger
                className="rounded-none border-b-2 border-b-transparent px-4 py-2 text-xs data-[state=active]:border-b-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                key={kind}
                value={kind}
              >
                <Icon className="size-3.5" />
                {meta.plural}
                {kindItems.length > 0 ? (
                  <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
                    {kindItems.length}
                  </span>
                ) : null}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>

      {/* Tab content — one panel per kind */}
      {KIND_ORDER.map((kind) => {
        const state = kindStates[kind];
        const kindItems = items.filter((item) => item.kind === kind);
        const sortedItems = sortAgentComponentRows(
          kindItems,
          state.sortKey,
          state.sortDir
        );

        // For configured-only kinds, omit metric and invocations columns.
        const configuredOnly = !isObservedKind(kind);
        // FEA-4052: an observed kind whose LOC/$ is NOT reliably attributable
        // (plugin/mcp) still hides the metric column — it renders all "—"
        // otherwise (the service nulls it), and the summary card is hidden in
        // lockstep so a tab never shows a card while hiding the column.
        const hideMetricOnly = !(
          configuredOnly || isLocPerDollarVerifiableKind(kind)
        );
        let effectiveVisible: Set<string> | undefined;
        if (configuredOnly) {
          // Start from the caller-supplied visible set (or all columns) and
          // remove the configured-only-irrelevant column ids.
          const base = visibleColumns ? new Set(visibleColumns) : null;
          if (base === null) {
            // No caller-supplied set — build one that omits only the
            // configured-only columns. Pass undefined if all data columns
            // are visible minus the two we hide.
            effectiveVisible = buildConfiguredOnlyColumns();
          } else {
            for (const id of CONFIGURED_ONLY_HIDDEN_COLUMNS) {
              base.delete(id);
            }
            effectiveVisible = base;
          }
        } else if (hideMetricOnly) {
          effectiveVisible = buildLocPerDollarHiddenColumns(visibleColumns);
        } else {
          effectiveVisible = visibleColumns;
        }

        return (
          <TabsContent
            className="mt-0 min-h-0 flex-1 overflow-auto"
            key={kind}
            value={kind}
          >
            {sortedItems.length === 0 ? (
              <p className="px-4 py-12 text-center text-muted-foreground text-sm">
                No {kindMeta(kind).plural.toLowerCase()} found.
              </p>
            ) : (
              <AgentsTable
                getComponentHref={getComponentHref}
                items={sortedItems}
                metricMode={metricMode}
                onSort={(col, dir) => handleSort(kind, col, dir)}
                sortBy={state.sortKey}
                sortDir={state.sortDir}
                visibleColumns={effectiveVisible}
              />
            )}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the default visible column set for configured-only kinds (Hook, Config):
 * all columns except metric and invocations (which are always null for these
 * kinds).
 *
 * The AgentsTable COLUMN_SPECS ids are: type, metric, owner, collaborators,
 * source, harness, invocations, sessions, actions.
 */
function buildConfiguredOnlyColumns(): Set<string> {
  return new Set([
    "type",
    "owner",
    "collaborators",
    "source",
    "harness",
    "sessions",
    "actions",
  ]);
}

/**
 * FEA-4052: the visible column set for an observed kind whose LOC/$ is not
 * reliably attributable (plugin/mcp) — every column the caller allowed EXCEPT
 * the metric column. Unlike configured-only kinds this keeps `invocations`
 * (those kinds do carry real invocation data); only the unbacked LOC/$ column
 * is dropped. When the caller supplies no set, all columns except the metric are
 * shown; otherwise the metric is removed from the caller's set.
 */
function buildLocPerDollarHiddenColumns(
  visibleColumns: Set<string> | undefined
): Set<string> {
  const base = visibleColumns
    ? new Set(visibleColumns)
    : new Set([
        "type",
        "owner",
        "collaborators",
        "source",
        "harness",
        "invocations",
        "sessions",
        "actions",
      ]);
  base.delete(METRIC_COLUMN_ID);
  return base;
}
