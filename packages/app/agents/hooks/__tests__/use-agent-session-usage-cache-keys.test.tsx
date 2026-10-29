import type {
  AgentSessionAnalytics,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import {
  keepPreviousData,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, type Mock, vi } from "vitest";
import type {
  AgentSessionsDataSource,
  AgentSessionUsageQueryFilters,
} from "../../data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "../../data-source/provider";
import { useAgentSessionUsage } from "../use-agent-sessions";

/**
 * ISS-9897 — the summary read's cache key covers the WHOLE request shape, and a
 * key it has never settled serves nothing.
 *
 * The retired snapshot lifecycle shipped because every test it had asked about
 * ONE selection. A single-key test cannot fail on the defect this closes: it is
 * the SECOND selection that has a previous key's figures available to borrow, so
 * the table below changes exactly one dimension at a time off a shared baseline
 * and asserts the previous key's payload never reaches the caller.
 *
 * Both arms of the caller contract are covered, because the page mounts this
 * read with `keepPreviousData`: without it a miss reports `undefined`, and with
 * it the held payload is flagged `isPlaceholderData` so the render can skeleton
 * rather than paint it. `apps/app/…/sessions/__tests__/summary-scope-change-loading.test.tsx`
 * is where the page's own render is held to that flag.
 */

const BASELINE: AgentSessionUsageQueryFilters = {
  autonomyTiers: ["high"],
  costBuckets: ["low"],
  endDate: "2026-08-30T00:00:00.000Z",
  harnesses: ["claude"],
  limit: 25,
  models: ["opus"],
  offset: 0,
  projectIds: ["project-a"],
  repositories: ["repo-a"],
  search: "deploy",
  startDate: "2026-08-01T00:00:00.000Z",
  statuses: ["active"],
  userIds: ["user-a"],
  viewerScope: AgentSessionViewerScope.Organization,
};

/**
 * One dimension of the request shape each, off {@link BASELINE}. Written out by
 * hand rather than derived from the filters type: a dimension the key stops
 * carrying must fail HERE rather than quietly agree with whatever the key
 * currently folds in.
 */
const SINGLE_DIMENSION_CHANGES: readonly (readonly [
  string,
  Partial<AgentSessionUsageQueryFilters>,
])[] = [
  ["the date window's start", { startDate: "2026-07-01T00:00:00.000Z" }],
  ["the date window's end", { endDate: "2026-08-31T00:00:00.000Z" }],
  ["a status facet", { statuses: ["inactive"] }],
  ["an owner facet", { userIds: ["user-b"] }],
  ["a repository facet", { repositories: ["repo-b"] }],
  ["a harness facet", { harnesses: ["codex"] }],
  ["a model facet", { models: ["sonnet"] }],
  ["an autonomy facet", { autonomyTiers: ["guided"] }],
  ["a cost facet", { costBuckets: ["high"] }],
  ["a project facet", { projectIds: ["project-b"] }],
  ["the search term", { search: "revert" }],
  ["the page size", { limit: 100 }],
  ["the page offset", { offset: 25 }],
  ["the viewer scope", { viewerScope: AgentSessionViewerScope.Self }],
];

describe("the Sessions summary read's cache key (ISS-9897)", () => {
  it.each(SINGLE_DIMENSION_CHANGES)(
    "serves nothing from the previous key when %s changes",
    async (_dimension, change) => {
      const source = createSource();

      const { rerender, result } = renderHook(
        ({ filters }: { filters: AgentSessionUsageQueryFilters }) =>
          useAgentSessionUsage(filters),
        {
          initialProps: { filters: BASELINE },
          wrapper: createCacheKeyWrapper(source),
        }
      );

      await waitFor(() => expect(result.current.data).toBeDefined());
      expect(source.usage).toHaveBeenCalledTimes(1);

      rerender({ filters: { ...BASELINE, ...change } });

      // The new key has settled nothing, so the caller is handed the pending
      // state — never the figures the previous selection produced.
      expect(result.current.data).toBeUndefined();
      expect(result.current.isPending).toBe(true);
      await waitFor(() => expect(source.usage).toHaveBeenCalledTimes(2));
    }
  );

  it("flags the held payload as another key's when the caller keeps previous data", async () => {
    const source = createSource();

    const { rerender, result } = renderHook(
      ({ filters }: { filters: AgentSessionUsageQueryFilters }) =>
        useAgentSessionUsage(filters, { placeholderData: keepPreviousData }),
      {
        initialProps: { filters: BASELINE },
        wrapper: createCacheKeyWrapper(source),
      }
    );

    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));

    rerender({
      filters: { ...BASELINE, startDate: "2026-07-01T00:00:00.000Z" },
    });

    // The payload in hand is the PREVIOUS key's — the render must skeleton on
    // this flag rather than paint it under the new selection.
    expect(result.current.isPlaceholderData).toBe(true);
  });

  it("serves an exact-key hit from cache, with no wait and no new key", async () => {
    const source = createSource();
    const widened = { ...BASELINE, startDate: "2026-07-01T00:00:00.000Z" };

    const { rerender, result } = renderHook(
      ({ filters }: { filters: AgentSessionUsageQueryFilters }) =>
        useAgentSessionUsage(filters),
      {
        initialProps: { filters: BASELINE },
        wrapper: createCacheKeyWrapper(source),
      }
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    rerender({ filters: widened });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const keysRead = new Set(
      readFilters(source).map((filters) => JSON.stringify(filters))
    );
    expect(keysRead.size).toBe(2);

    // Back to a selection this page load already settled — 30d → 60d → 30d. The
    // reader waits for nothing: the figures are on the same render, settled, and
    // not flagged as another key's.
    rerender({ filters: { ...BASELINE } });

    expect(result.current.data).toEqual(USAGE_FIXTURE);
    expect(result.current.isPending).toBe(false);
    expect(result.current.isPlaceholderData).toBe(false);
    // No THIRD key is opened. A background revalidation of this same key can
    // follow — that is the read's `staleTime` policy, and it is invisible to the
    // reader — but a key already settled must never be read as a new question.
    expect(
      new Set(readFilters(source).map((filters) => JSON.stringify(filters)))
        .size
    ).toBe(2);
  });

  it("keeps one source's figures out of another source's key", async () => {
    const httpSource = createSource();
    const localSource = { ...createSource(), scope: "desktop-local" };

    const { result } = renderHook(() => useAgentSessionUsage(BASELINE), {
      wrapper: createCacheKeyWrapper(httpSource),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    // Same filters, different source: local and cloud produce different numbers
    // for an identical question, so neither may satisfy the other's key.
    const local = renderHook(() => useAgentSessionUsage(BASELINE), {
      wrapper: createCacheKeyWrapper(localSource),
    });
    expect(local.result.current.data).toBeUndefined();
    expect(local.result.current.isPending).toBe(true);
  });
});

const LIST_FIXTURE: AgentSessionListResponse = {
  items: [],
  total: 0,
  viewerScope: AgentSessionViewerScope.Organization,
};

const USAGE_FIXTURE: AgentSessionUsageSummary = {
  apiEstimatedCost: 0,
  byHarness: [],
  byModel: [],
  byRepository: [],
  byUser: [],
  earliestSessionAt: null,
  lastSyncTargets: [],
  latestSessionAt: null,
  subscriptionEstimatedCost: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  totalEstimatedCost: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalSessions: 565,
  viewerScope: AgentSessionViewerScope.Organization,
};

const ANALYTICS_FIXTURE: AgentSessionAnalytics = {
  byAgentType: [],
  byProject: [],
  byRepository: [],
  byTool: [],
  viewerScope: AgentSessionViewerScope.Organization,
};

function createSource(): AgentSessionsDataSource {
  return {
    scope: "http",
    list: vi.fn().mockResolvedValue(LIST_FIXTURE),
    detail: vi.fn().mockRejectedValue(new Error("detail unused")),
    usage: vi.fn().mockResolvedValue(USAGE_FIXTURE),
    pageData: vi
      .fn()
      .mockResolvedValue({ list: LIST_FIXTURE, usage: USAGE_FIXTURE }),
    analytics: vi.fn().mockResolvedValue(ANALYTICS_FIXTURE),
  };
}

function createCacheKeyWrapper(source: AgentSessionsDataSource) {
  // One client per rendered hook, NOT one per render: `rerender` re-invokes
  // `Wrapper`, so constructing it inside the body would discard the cache on
  // every filter transition and leave the placeholder-data and 30d → 60d → 30d
  // cases unable to observe the previous key at all.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppCoreStoryProviders>
        <QueryClientProvider client={client}>
          <AgentSessionsDataSourceProvider dataSource={source}>
            {children}
          </AgentSessionsDataSourceProvider>
        </QueryClientProvider>
      </AppCoreStoryProviders>
    );
  };
}

/** The filter sets this source was actually asked for, in call order. */
function readFilters(
  source: AgentSessionsDataSource
): AgentSessionUsageQueryFilters[] {
  return (source.usage as Mock).mock.calls.map(
    (call) => call[0] as AgentSessionUsageQueryFilters
  );
}
