/**
 * ISS-6141 / ISS-4655 — the Agents page must not read page-data twice per load.
 *
 * `sortKey`/`sortDir` are in the bounded read's query key, and the persisted
 * view restores in a post-mount effect. Un-gated, the surface therefore issues
 * one read against the DEFAULT sort and, once the saved view lands, a second
 * against the restored one. Each of those reads costs up to three full org
 * population builds at the producer, so the wasted half is not a wasted request
 * — it is a wasted inventory rebuild.
 *
 * `usePersistedTableViewState` publishes `isViewReady` for exactly this, and
 * Sessions and Branches both gate on it. These cases pin the read COUNT and the
 * sort each read carried, so they fail for the reason that matters: drop the
 * gate in `use-agents-inventory-view.ts` and the restore case goes red with two
 * reads, the first under the default sort.
 */

import {
  AgentComponentSortDir,
  AgentComponentSortKey,
} from "@repo/api/src/types/agent-component";
import type {
  AgentComponentPageDataRequest,
  AgentComponentPageDataResult,
} from "@repo/api/src/utils/agent-component-page-data";
import { DEFAULT_AGENT_COMPONENT_FILTERS } from "@repo/api/src/utils/agent-component-reduce";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../data-source/provider";
import { useAgentsInventoryView } from "../use-agents-inventory-view";

function makeResult(): AgentComponentPageDataResult {
  return {
    // One real row and a multi-page total, so "the gate zeroed the data" is
    // observable in the hook's OUTPUT rather than only in its loading flag.
    items: [PREVIOUS_VISIT_ROW],
    filteredTotal: 3,
    totalPages: 3,
    page: 0,
    facets: { collaborators: [], sources: [], harnesses: [] },
    current: {
      components: 0,
      invocations: 0,
      locPerDollar: null,
      locPerDollarSampleSize: 0,
      collaborators: 0,
      hasVerifiableLocPerDollar: false,
      invocationsExact: true,
      invocationsPluginCoverage: [],
    },
  };
}

/**
 * A source that records the sort of every bounded read it is asked for — the
 * sort and not just the count, so a failure says WHICH reads were issued: a
 * pre-restore read under the default sort is a different bug from a duplicate.
 */
function recordingSource(sorts: AgentComponentSortKey[]) {
  const dataSource: AgentComponentsDataSource = {
    scope: "agent-components:test",
    honorsDateWindow: false,
    list: () => Promise.resolve({ items: [], total: 0 }),
    detail: () => Promise.reject(new Error("not used")),
    pageData: (request: AgentComponentPageDataRequest) => {
      sorts.push(request.sortBy);
      return Promise.resolve(makeResult());
    },
  };
  return dataSource;
}

function wrapperFor(dataSource: AgentComponentsDataSource) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppCoreStoryProviders>
        <AgentComponentsDataSourceProvider dataSource={dataSource}>
          {children}
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );
  };
}

function renderGatedView(
  dataSource: AgentComponentsDataSource,
  initial: { isViewReady: boolean; sortKey: AgentComponentSortKey }
) {
  return renderHook(
    (props: { isViewReady: boolean; sortKey: AgentComponentSortKey }) =>
      useAgentsInventoryView({
        supportsDateWindow: false,
        isViewReady: props.isViewReady,
        sortKey: props.sortKey,
        sortDir: AgentComponentSortDir.Asc,
        pageSize: 50,
        initialFilters: DEFAULT_AGENT_COMPONENT_FILTERS,
        honestSourceEnabled: false,
        dedupePluginRollups: false,
        boundedPageDataEnabled: true,
      }),
    { initialProps: initial, wrapper: wrapperFor(dataSource) }
  );
}

/** The row a previous visit left in the cache under the default-sort key. */
const PREVIOUS_VISIT_ROW = {
  id: "component-1",
  name: "orchestrator",
  kind: "agent",
} as unknown as AgentComponentPageDataResult["items"][number];

describe("useAgentsInventoryView restore gate (ISS-6141)", () => {
  it("issues NO bounded read while the persisted view is still restoring", async () => {
    const sorts: AgentComponentSortKey[] = [];
    const view = renderGatedView(recordingSource(sorts), {
      isViewReady: false,
      sortKey: AgentComponentSortKey.Name,
    });

    // The gate holds the read closed, so the surface reports loading rather
    // than an empty inventory it never asked for.
    await waitFor(() => expect(view.result.current.isLoading).toBe(true));
    expect(sorts).toEqual([]);
  });

  it("issues exactly ONE bounded read, under the RESTORED sort, once the view settles", async () => {
    const sorts: AgentComponentSortKey[] = [];
    const view = renderGatedView(recordingSource(sorts), {
      isViewReady: false,
      sortKey: AgentComponentSortKey.Name,
    });

    // The restore lands: the saved sort replaces the default in the same commit
    // that opens the gate, which is the whole point of gating on it.
    view.rerender({
      isViewReady: true,
      sortKey: AgentComponentSortKey.Invocations,
    });

    await waitFor(() => expect(view.result.current.isLoading).toBe(false));
    expect(sorts).toEqual([AgentComponentSortKey.Invocations]);
  });

  it("zeroes a cached pre-restore page instead of serving it while the gate is closed", async () => {
    const sorts: AgentComponentSortKey[] = [];
    // ONE mount, so the rerender below keeps the same QueryClient and the
    // default-sort key stays populated — the warm cache a revisit really has.
    // Two separate `renderHook` calls would each build a fresh empty cache and
    // this case would pass with the data-zeroing removed.
    const view = renderGatedView(recordingSource(sorts), {
      isViewReady: true,
      sortKey: AgentComponentSortKey.Name,
    });
    await waitFor(() => expect(view.result.current.isLoading).toBe(false));
    expect(view.result.current.pageRows).toHaveLength(1);
    expect(view.result.current.totalPages).toBe(3);

    // The gate closes again on the SAME key. `enabled: false` stops the fetch
    // but leaves the observer attached to that populated key, so without
    // `gateRestoredRead` the hook would keep handing back the row above.
    view.rerender({
      isViewReady: false,
      sortKey: AgentComponentSortKey.Name,
    });

    expect(view.result.current.pageRows).toEqual([]);
    expect(view.result.current.totalPages).toBe(1);
    expect(view.result.current.isLoading).toBe(true);
    // Still exactly one read: closing the gate must not issue another.
    expect(sorts).toEqual([AgentComponentSortKey.Name]);
  });
});
