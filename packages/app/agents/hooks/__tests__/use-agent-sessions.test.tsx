import {
  type AgentSessionAnalytics,
  type AgentSessionListResponse,
  type AgentSessionUsageSummary,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import type { AgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { useQueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  agentSessionKeys,
  useAgentSessionAnalytics,
  useAgentSessions,
  useAgentSessionsPageData,
  useAgentSessionUsage,
} from "../use-agent-sessions";

const TEAM_A = "019f0fcb-8336-7c4d-9f64-528fb9520c32";
const TEAM_B = "019f0fcb-8336-7c4d-9f64-528fb9520c33";

describe("agent-session team-scope hooks", () => {
  it("disables explicit team usage queries until teamId exists", () => {
    const source = createSource();

    renderHook(
      () =>
        useAgentSessionUsage({
          viewerScope: AgentSessionViewerScope.Team,
        }),
      { wrapper: createWrapper(source) }
    );

    expect(source.usage).not.toHaveBeenCalled();
  });

  it("passes teamId through analytics queries and isolates cache keys", async () => {
    const source = createSource();

    const { rerender, result } = renderHook(
      ({ teamId }) => ({
        queryClient: useQueryClient(),
        analytics: useAgentSessionAnalytics({
          teamId,
          viewerScope: AgentSessionViewerScope.Team,
        }),
      }),
      {
        initialProps: { teamId: TEAM_A },
        wrapper: createWrapper(source),
      }
    );

    await waitFor(() =>
      expect(source.analytics).toHaveBeenCalledWith({
        teamId: TEAM_A,
        viewerScope: AgentSessionViewerScope.Team,
      })
    );

    rerender({ teamId: TEAM_B });

    await waitFor(() =>
      expect(source.analytics).toHaveBeenCalledWith({
        teamId: TEAM_B,
        viewerScope: AgentSessionViewerScope.Team,
      })
    );

    expect(
      result.current.queryClient.getQueryData(
        agentSessionKeys.analytics("source", {
          teamId: TEAM_A,
          viewerScope: AgentSessionViewerScope.Team,
        })
      )
    ).toEqual({
      byAgentType: [],
      byProject: [],
      byRepository: [],
      byTool: [],
      viewerScope: AgentSessionViewerScope.Team,
    });
    expect(
      result.current.queryClient.getQueryData(
        agentSessionKeys.analytics("source", {
          teamId: TEAM_B,
          viewerScope: AgentSessionViewerScope.Team,
        })
      )
    ).toEqual({
      byAgentType: [],
      byProject: [],
      byRepository: [],
      byTool: [],
      viewerScope: AgentSessionViewerScope.Team,
    });
  });
});

const LIST_FIXTURE: AgentSessionListResponse = {
  items: [],
  total: 0,
  viewerScope: AgentSessionViewerScope.Team,
};

const USAGE_FIXTURE: AgentSessionUsageSummary = {
  apiEstimatedCost: 0,
  byHarness: [],
  byModel: [],
  byRepository: [],
  byUser: [],
  earliestSessionAt: null,
  latestSessionAt: null,
  lastSyncTargets: [],
  subscriptionEstimatedCost: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  totalEstimatedCost: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalSessions: 0,
  viewerScope: AgentSessionViewerScope.Team,
};

// FEA-4157: the Sessions table + its prop-driven summary cards read through ONE
// combined `useAgentSessionsPageData` query instead of a separate list read and
// usage read of the same rows (mirroring `useBranchesPageData`).
describe("useAgentSessionsPageData (FEA-4157 combined read)", () => {
  it("serves list + usage from ONE pageData read, not separate list/usage reads", async () => {
    const source = createSource();

    const { result } = renderHook(
      () => useAgentSessionsPageData({ limit: 25 }),
      {
        wrapper: createWrapper(source),
      }
    );

    await waitFor(() => expect(result.current.data).toBeDefined());

    // ONE combined read backs both surfaces...
    expect(source.pageData).toHaveBeenCalledTimes(1);
    expect(source.pageData).toHaveBeenCalledWith({ limit: 25 });
    expect(result.current.data).toEqual({
      list: LIST_FIXTURE,
      usage: USAGE_FIXTURE,
    });
    // ...instead of the standalone list + usage reads it replaces.
    expect(source.list).not.toHaveBeenCalled();
    expect(source.usage).not.toHaveBeenCalled();
  });

  it("caches under a stable scope+filters key and reuses last-good on a filter change", async () => {
    const source = createSource();

    const { rerender, result } = renderHook(
      ({ filters }) => ({
        queryClient: useQueryClient(),
        pageData: useAgentSessionsPageData(filters, {
          placeholderData: (previous) => previous,
        }),
      }),
      {
        initialProps: { filters: { limit: 25, offset: 0 } },
        wrapper: createWrapper(source),
      }
    );

    await waitFor(() => expect(result.current.pageData.data).toBeDefined());
    expect(
      result.current.queryClient.getQueryData(
        agentSessionKeys.pageData("source", { limit: 25, offset: 0 })
      )
    ).toEqual({ list: LIST_FIXTURE, usage: USAGE_FIXTURE });

    // A page change swaps the filters/key; placeholderData keeps the prior
    // result on screen (no undefined flash) while the next page loads.
    rerender({ filters: { limit: 25, offset: 25 } });
    expect(result.current.pageData.data).toEqual({
      list: LIST_FIXTURE,
      usage: USAGE_FIXTURE,
    });

    await waitFor(() =>
      expect(source.pageData).toHaveBeenCalledWith({ limit: 25, offset: 25 })
    );
    // Each distinct filter set is its own cache entry; the prior one is retained.
    expect(
      result.current.queryClient.getQueryData(
        agentSessionKeys.pageData("source", { limit: 25, offset: 0 })
      )
    ).toEqual({ list: LIST_FIXTURE, usage: USAGE_FIXTURE });
  });
});

// FEA-4177: the web Sessions page reads the list and the summary as INDEPENDENT
// queries — the list keyed by the full (paginated) filters, the summary keyed by
// the summary-only filters — so a page/sort change never re-fetches the summary,
// and an equal-scope summary read shares the facet-option read's cache entry.
describe("FEA-4177 Sessions list/summary read decoupling", () => {
  it("does not re-fetch the summary usage when only the list page changes", async () => {
    const source = createSource();

    const { rerender, result } = renderHook(
      ({ offset }) => ({
        list: useAgentSessions({ startDate: "d1", limit: 25, offset }),
        // The summary scope is page-independent (no offset/limit), so its key is
        // stable across paging.
        usage: useAgentSessionUsage({ startDate: "d1" }),
      }),
      {
        initialProps: { offset: 0 },
        wrapper: createWrapper(source),
      }
    );

    await waitFor(() => expect(result.current.usage.data).toBeDefined());
    expect(source.usage).toHaveBeenCalledTimes(1);

    // Page forward: the list re-fetches under its new key...
    rerender({ offset: 25 });
    await waitFor(() =>
      expect(source.list).toHaveBeenCalledWith({
        startDate: "d1",
        limit: 25,
        offset: 25,
      })
    );
    // ...but the summary read stays cached — still exactly one usage fetch.
    expect(source.usage).toHaveBeenCalledTimes(1);
  });

  it("issues ONE usage request when the facet-option and summary scopes are equal", async () => {
    const source = createSource();

    const { result } = renderHook(
      () => ({
        // Facet-option read (facet-unfiltered) and the normalized no-facet
        // summary read resolve to the SAME filters object, so they must share one
        // cache entry rather than issue a duplicate no-facet aggregate.
        facetOption: useAgentSessionUsage({ startDate: "d1" }),
        summary: useAgentSessionUsage({ startDate: "d1" }),
      }),
      { wrapper: createWrapper(source) }
    );

    await waitFor(() => expect(result.current.summary.data).toBeDefined());
    expect(source.usage).toHaveBeenCalledTimes(1);
  });

  it("keeps the list query independent of a summary read failure", async () => {
    const source = createSource();
    (source.usage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("usage failed")
    );

    const { result } = renderHook(
      () => ({
        list: useAgentSessions({ startDate: "d1", limit: 25, offset: 0 }),
        usage: useAgentSessionUsage({ startDate: "d1" }),
      }),
      { wrapper: createWrapper(source) }
    );

    // The summary errors, but the list still resolves — a summary failure never
    // blanks the table.
    await waitFor(() => expect(result.current.usage.isError).toBe(true));
    await waitFor(() => expect(result.current.list.data).toEqual(LIST_FIXTURE));
    expect(result.current.list.isError).toBe(false);
  });
});

function createSource(): AgentSessionsDataSource {
  return {
    scope: "source",
    list: vi.fn().mockResolvedValue(LIST_FIXTURE),
    detail: vi.fn().mockRejectedValue(new Error("detail unused")),
    usage: vi.fn().mockResolvedValue(USAGE_FIXTURE),
    // FEA-4157: the combined list + usage read the table + summary cards share.
    pageData: vi
      .fn()
      .mockResolvedValue({ list: LIST_FIXTURE, usage: USAGE_FIXTURE }),
    analytics: vi.fn().mockResolvedValue({
      byAgentType: [],
      byProject: [],
      byRepository: [],
      byTool: [],
      viewerScope: AgentSessionViewerScope.Team,
    } satisfies AgentSessionAnalytics),
  };
}

function createWrapper(source: AgentSessionsDataSource) {
  return ({ children }: { children: ReactNode }) => (
    <AppCoreStoryProviders>
      <AgentSessionsDataSourceProvider dataSource={source}>
        {children}
      </AgentSessionsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}
