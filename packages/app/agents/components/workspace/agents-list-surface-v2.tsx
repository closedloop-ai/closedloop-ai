"use client";

import { cn } from "@repo/design-system/lib/utils";
import { CompleteSurfaceState } from "../../../shared/lib/complete-surface-contract";
import { useAgentsListSurfaceV2ViewModel } from "../../hooks/use-agents-list-surface-v2-view-model";
import { AgentsListSurfaceV2Metrics } from "./agents-list-surface-v2-metrics";
import { AgentsListSurfaceV2Pagination } from "./agents-list-surface-v2-pagination";
import type { AgentsListSurfaceV2Props } from "./agents-list-surface-v2-props";
import { AgentsListSurfaceV2Rows } from "./agents-list-surface-v2-rows";
import { AgentsListSurfaceV2States } from "./agents-list-surface-v2-states";
import { AgentsListSurfaceV2Toolbar } from "./agents-list-surface-v2-toolbar";

/**
 * The Agents inventory workspace, complete (ISS-9398, PRD-730
 * `wave-fs-1-shared-now`).
 *
 * Owns the type tabs, the filters, the metric strip, the table, the state
 * ladder, the pagination and the PLACEMENT of a host's management panel. A host
 * supplies only its route, its persistence key, and the local-runtime bridges it
 * actually has — the first two required, so neither can be dropped in silence.
 *
 * `AgentsGroupedList` reached both shells too, but left them three ways to
 * differ: a `pluginsFooter` node, an omittable `persistKey`, an omittable
 * `getComponentHref`. ISS-9216 names that class and ISS-9218 showed a capability
 * ledger cannot catch it.
 *
 * The Agent DETAIL surface is untouched and remains the canonical destination —
 * rows link into it through the host's `getComponentHref`, exactly as before.
 *
 * Closed by default on both shells behind ONE PostHog key
 * (`AGENT_OPS_COMPLETE_SURFACE_FEATURE_FLAG_KEY`), read once per shell at the
 * mount site. Neither this surface nor `AgentsGroupedList` knows that gate
 * exists.
 */
export function AgentsListSurfaceV2({
  getComponentHref,
  persistKey,
  pluginManagement,
}: AgentsListSurfaceV2Props) {
  const model = useAgentsListSurfaceV2ViewModel(persistKey);

  const metrics = (
    <div
      className={cn(
        "flex flex-col gap-4 px-4 pt-3 pb-4",
        model.metricsPinned && "shrink-0"
      )}
    >
      <AgentsListSurfaceV2Metrics model={model} />
    </div>
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid={AGENTS_LIST_SURFACE_V2_TEST_ID}
    >
      <AgentsListSurfaceV2Toolbar model={model} />

      {/* ISS-5530: the KPI strip summarizes the whole filtered population, so it
          is not part of the table's scroll plane — inside the `overflow-auto`
          wrapper, scrolling right to reach the trailing columns dragged the
          cards sideways out of view. */}
      {model.metricsPinned ? metrics : null}

      <div
        className="min-h-0 flex-1 overflow-auto"
        data-testid={AGENTS_LIST_SURFACE_V2_SCROLL_TEST_ID}
      >
        {model.metricsPinned ? null : metrics}

        {model.state === CompleteSurfaceState.Ready ? (
          <AgentsListSurfaceV2Rows
            getComponentHref={getComponentHref}
            model={model}
          />
        ) : (
          <AgentsListSurfaceV2States model={model} />
        )}

        <AgentsListSurfaceV2Pagination model={model} />

        {/* The surface decides WHERE a host's management bridge appears and
            WHETHER this tab is the one it belongs under; the host supplies only
            the body. A host without the bridge renders nothing here — never a
            disabled control that looks available. */}
        {model.pluginManagementSlotActive && pluginManagement ? (
          <div
            className="mt-2 border-t pt-2"
            data-testid={AGENTS_PLUGIN_MANAGEMENT_TEST_ID}
          >
            {pluginManagement.renderPanel()}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Marks the surface's root so a shell's E2E suite can prove which branch of its
 * flag actually rendered.
 *
 * Both halves of the gate need it: the ON case asserts the surface is present
 * and the OFF case asserts it is ABSENT, and an absence assertion written
 * against copy the two branches share would pass on either.
 */
export const AGENTS_LIST_SURFACE_V2_TEST_ID = "agents-list-surface-v2";

/**
 * Marks the region a host's plugin-management bridge occupies.
 *
 * The absence of a capability is what each shell's E2E has to prove, and the
 * bridge's own body is a host component whose copy neither shell's spec should
 * depend on. This names the region instead, so "desktop has it, web does not" is
 * one locator asserted in both directions.
 */
export const AGENTS_PLUGIN_MANAGEMENT_TEST_ID = "agents-plugin-management";

/**
 * Marks the region that scrolls the rows (ISS-9282).
 *
 * With the KPI strip pinned it is the one child of the surface's column that
 * can shrink to nothing, and a starved region still reports its rows `visible`.
 * So a narrow-viewport spec has to measure THIS element, not the rows in it.
 */
export const AGENTS_LIST_SURFACE_V2_SCROLL_TEST_ID =
  "agents-list-surface-v2-scroll";
