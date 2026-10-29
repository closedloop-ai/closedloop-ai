import type { AgentSessionListResponse } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import {
  DateRange,
  DEFAULT_DATE_RANGE,
} from "@repo/app/shared/lib/format-utils";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionsDataSource } from "../../data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "../../data-source/provider";
import { agentSessionKeys } from "../agent-session-keys";
import { useSessionsOutsideWindow } from "../use-sessions-outside-window";

/**
 * ISS-11913 — the unwindowed probe behind the Sessions date-range empty state.
 *
 * Two contracts: it is only ever asked of a list the window alone has emptied
 * (a populated or facet-filtered list never pays for it), and its answer is the
 * all-time population, not the window's.
 */

const WINDOW_ONLY = {
  customWindowActive: false,
  dateRange: DEFAULT_DATE_RANGE,
  isListSettledEmpty: true,
  otherFiltersActive: false,
};

describe("useSessionsOutsideWindow (ISS-11913)", () => {
  it.each([
    ["the list has not settled empty", { isListSettledEmpty: false }],
    ["a facet is also narrowing", { otherFiltersActive: true }],
    ["an explicit from/to window is set", { customWindowActive: true }],
    ["the range is already all time", { dateRange: DateRange.AllTime }],
  ])("asks nothing, and holds nothing, when %s", async (_case, change) => {
    const source = createSource(3);
    const { result } = renderHook(
      () => useSessionsOutsideWindow({ ...WINDOW_ONLY, ...change }),
      { wrapper: withProbeSource(source) }
    );

    // Positive control on the same source: the window-only shape DOES ask, so
    // the zero call count above is the gate, not a source that never answers.
    const control = renderHook(() => useSessionsOutsideWindow(WINDOW_ONLY), {
      wrapper: withProbeSource(source),
    });
    await waitFor(() =>
      expect(control.result.current.hasSessionsOutsideWindow).toBe(true)
    );

    expect(result.current).toEqual({
      hasSessionsOutsideWindow: undefined,
      isPending: false,
    });
    expect(source.list).toHaveBeenCalledTimes(1);
  });

  it("reads the whole population as a count, with no window", async () => {
    const source = createSource(3);
    const { result } = renderHook(() => useSessionsOutsideWindow(WINDOW_ONLY), {
      wrapper: withProbeSource(source),
    });

    await waitFor(() =>
      expect(result.current).toEqual({
        hasSessionsOutsideWindow: true,
        isPending: false,
      })
    );
    expect(source.list).toHaveBeenCalledWith({ countOnly: true, limit: 1 });
  });

  it("answers false when no session exists at all", async () => {
    const source = createSource(0);
    const { result } = renderHook(() => useSessionsOutsideWindow(WINDOW_ONLY), {
      wrapper: withProbeSource(source),
    });

    await waitFor(() =>
      expect(result.current).toEqual({
        hasSessionsOutsideWindow: false,
        isPending: false,
      })
    );
  });

  it("holds pending while the probe is in flight", async () => {
    const source = createSource(3);
    vi.mocked(source.list).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useSessionsOutsideWindow(WINDOW_ONLY), {
      wrapper: withProbeSource(source),
    });

    await waitFor(() => expect(source.list).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual({
      hasSessionsOutsideWindow: undefined,
      isPending: true,
    });
  });

  it("keeps its last answer when a later refetch fails", async () => {
    const source = createSource(3);
    const client = createTestQueryClient();
    // A second observer of the probe's own cache entry, read in the SAME render
    // as the hook, so the assertion below runs on the frame that saw the error.
    const { result } = renderHook(
      () => ({
        probe: useSessionsOutsideWindow(WINDOW_ONLY),
        status: useQuery({
          enabled: false,
          queryFn: () => Promise.reject(new Error("observer only")),
          queryKey: agentSessionKeys.list(source.scope, {
            countOnly: true,
            limit: 1,
          }),
        }).status,
      }),
      { wrapper: withProbeSource(source, client) }
    );
    await waitFor(() =>
      expect(result.current.probe.hasSessionsOutsideWindow).toBe(true)
    );

    vi.mocked(source.list).mockRejectedValue(new Error("refetch failed"));
    await act(() => client.refetchQueries().catch(() => undefined));
    await waitFor(() => expect(result.current.status).toBe("error"));

    expect(result.current.probe).toEqual({
      hasSessionsOutsideWindow: true,
      isPending: false,
    });
  });

  it("answers nothing, and stops holding, when the probe fails", async () => {
    const source = createSource(3);
    vi.mocked(source.list).mockRejectedValue(new Error("probe failed"));
    const { result } = renderHook(() => useSessionsOutsideWindow(WINDOW_ONLY), {
      wrapper: withProbeSource(source),
    });

    await waitFor(() => expect(source.list).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.hasSessionsOutsideWindow).toBeUndefined();
  });
});

function createSource(total: number): AgentSessionsDataSource {
  const list: AgentSessionListResponse = {
    items: [],
    total,
    viewerScope: AgentSessionViewerScope.Organization,
  };
  return {
    scope: "http",
    list: vi.fn().mockResolvedValue(list),
    detail: vi.fn().mockRejectedValue(new Error("detail unused")),
    usage: vi.fn().mockRejectedValue(new Error("usage unused")),
    pageData: vi.fn().mockRejectedValue(new Error("pageData unused")),
    analytics: vi.fn().mockRejectedValue(new Error("analytics unused")),
  };
}

function withProbeSource(
  source: AgentSessionsDataSource,
  client = createTestQueryClient()
) {
  const QueryWrapper = createWrapperWithClient(client);
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppCoreStoryProviders>
        <QueryWrapper>
          <AgentSessionsDataSourceProvider dataSource={source}>
            {children}
          </AgentSessionsDataSourceProvider>
        </QueryWrapper>
      </AppCoreStoryProviders>
    );
  };
}
