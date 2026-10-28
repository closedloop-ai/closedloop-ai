/**
 * ISS-6888 — the facet UNIVERSE half, which no delta assertion can catch.
 *
 * The Owner/Source filter options are supposed to be drawn from the UNWINDOWED
 * inventory, so an owner whose components were idle in the selected window stays
 * listed as a zero-count option. Narrow the universe to the window instead and
 * the option disappears — which removes the one narrowing that would bring those
 * rows back, silently, with nothing on screen to say so. A missing delta chip is
 * visible; a missing filter option is not.
 *
 * These cases pin the REQUEST, not the rendered menu. The unwindowed read is a
 * second request the hook either issues or does not, and asserting on it is what
 * makes the pair falsifiable: the rendered menu is confounded by React Query's
 * cache, because the surface opens on the all-time window, which populates the
 * unwindowed key before any narrowing and lets a DISABLED query keep serving it.
 *
 * Every case therefore starts from a BOUNDED `startDate` on a fresh cache, where
 * no all-time entry exists and an unwindowed read can only come from the hook
 * deciding to make one.
 */

import type { AgentComponentQueryFilters } from "@repo/api/src/types/agent-component";
import {
  AgentComponentSortDir,
  AgentComponentSortKey,
} from "@repo/api/src/types/agent-component";
import { DEFAULT_AGENT_COMPONENT_FILTERS } from "@repo/api/src/utils/agent-component-reduce";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../data-source/provider";
import { useAgentsInventoryView } from "../use-agents-inventory-view";

const CURRENT_WINDOW_START = "2026-05-01T00:00:00.000Z";

/** A source that records the window bounds of every list read it is asked for. */
function recordingSource(
  windows: AgentComponentQueryFilters[],
  honorsDateWindow: boolean
): AgentComponentsDataSource {
  return {
    scope: "agent-components:test",
    honorsDateWindow,
    list: (filters) => {
      windows.push(filters);
      return Promise.resolve({ items: [], total: 0, hasMore: false });
    },
    detail: () => Promise.reject(new Error("not used")),
  };
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

function renderView(dataSource: AgentComponentsDataSource, supports: boolean) {
  return renderHook(
    () =>
      useAgentsInventoryView({
        startDate: CURRENT_WINDOW_START,
        supportsDateWindow: supports,
        isViewReady: true,
        sortKey: AgentComponentSortKey.Name,
        sortDir: AgentComponentSortDir.Asc,
        pageSize: 50,
        initialFilters: DEFAULT_AGENT_COMPONENT_FILTERS,
        honestSourceEnabled: false,
        dedupePluginRollups: false,
        boundedPageDataEnabled: false,
      }),
    { wrapper: wrapperFor(dataSource) }
  );
}

/** The reads that carried NO lower bound — i.e. asked for the whole inventory. */
function unwindowedReads(
  windows: AgentComponentQueryFilters[]
): AgentComponentQueryFilters[] {
  return windows.filter((filters) => filters.startDate === undefined);
}

describe("useAgentsInventoryView facet universe (ISS-6888)", () => {
  it("reads the UNWINDOWED inventory for the facet options on a window-capable source", async () => {
    const windows: AgentComponentQueryFilters[] = [];
    const view = renderView(recordingSource(windows, true), true);

    await waitFor(() => expect(view.result.current.isLoading).toBe(false));
    await waitFor(() => expect(unwindowedReads(windows).length).toBe(1));

    // The windowed read still happens — the universe is an ADDITIONAL read, not
    // a replacement, so the rows on screen stay scoped to the selected window.
    expect(
      windows.some((filters) => filters.startDate === CURRENT_WINDOW_START)
    ).toBe(true);
  });

  it("does NOT issue that read on a source that ignores the window", async () => {
    // The negative sibling, on the same locator (`unwindowedReads`) in the
    // opposite state. Suppressing it is correct rather than a lesser outcome: a
    // source that ignores the bounds answers the unwindowed read with the
    // windowed rows, so the extra request buys an identical population — the
    // "universe" would be the window wearing a different name.
    const windows: AgentComponentQueryFilters[] = [];
    const view = renderView(recordingSource(windows, false), false);

    await waitFor(() => expect(view.result.current.isLoading).toBe(false));
    // The windowed read proves the hook ran to completion, so the absence below
    // is a real absence and not a hook that never issued anything.
    await waitFor(() =>
      expect(
        windows.some((filters) => filters.startDate === CURRENT_WINDOW_START)
      ).toBe(true)
    );
    expect(unwindowedReads(windows)).toEqual([]);
  });
});
