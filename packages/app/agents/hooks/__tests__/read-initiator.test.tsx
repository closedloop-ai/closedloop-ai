import type {
  AgentSessionListResponse,
  AgentSessionsPageData,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { ReadInitiator } from "@repo/api/src/types/read-initiator";
import type {
  AgentSessionsDataSource,
  AgentSessionsReadOptions,
} from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import {
  focusManager,
  type QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refetchAsUser } from "../read-initiator";
import {
  useAgentSessionDetail,
  useAgentSessionsPageData,
} from "../use-agent-sessions";

/**
 * ISS-12039 (Perrin Upcott ruling, 2026-10-05): a read is USER-initiated on its
 * key's first fetch or on an explicit refresh, and BACKGROUND on any refetch of
 * a key that already settled — a poll, a window-focus refetch, a live-bridge
 * invalidation. Each case reads the initiator the data source was handed.
 */

const PAGE_DATA = {
  list: { items: [], total: 0, viewerScope: "self" },
  usage: {} as AgentSessionUsageSummary,
} as unknown as AgentSessionsPageData;

afterEach(() => {
  focusManager.setFocused(undefined);
});

function createSource(): AgentSessionsDataSource {
  return {
    scope: "source",
    list: vi.fn().mockResolvedValue({} as AgentSessionListResponse),
    detail: vi.fn().mockResolvedValue({ id: "s-1" }),
    usage: vi.fn().mockResolvedValue({} as AgentSessionUsageSummary),
    analytics: vi.fn(),
    pageData: vi.fn().mockResolvedValue(PAGE_DATA),
  };
}

const API_ADAPTER: ApiAdapter = {
  resolveApiOrigin: () => "http://sessions.test",
  fetch: () => Promise.reject(new Error("no HTTP in this suite")),
};

function wrapperFor(client: QueryClient, source: AgentSessionsDataSource) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
        <ApiAdapterProvider adapter={API_ADAPTER}>
          <AgentSessionsDataSourceProvider dataSource={source}>
            {children}
          </AgentSessionsDataSourceProvider>
        </ApiAdapterProvider>
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
}

/** The initiator handed to each pageData read, in call order. */
function pageDataInitiators(source: AgentSessionsDataSource) {
  return vi
    .mocked(source.pageData)
    .mock.calls.map(
      ([, options]) => (options as AgentSessionsReadOptions).readInitiator
    );
}

function renderPageData(source: AgentSessionsDataSource, limit = 25) {
  const client = createTestQueryClient();
  return renderHook(
    ({ filters }) => {
      const query = useAgentSessionsPageData(filters, {
        refetchOnWindowFocus: "always",
      });
      return { query };
    },
    {
      initialProps: { filters: { limit } },
      wrapper: wrapperFor(client, source),
    }
  );
}

describe("read initiator (ISS-12039)", () => {
  it("marks a key's first fetch user-initiated", async () => {
    const source = createSource();
    renderPageData(source);

    await waitFor(() => expect(source.pageData).toHaveBeenCalledTimes(1));
    expect(pageDataInitiators(source)).toEqual([ReadInitiator.User]);
  });

  it("marks a poll of a key that already has data as background", async () => {
    const source = createSource();
    const { result } = renderPageData(source);
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    // What a refetchInterval tick does: refetch the same, settled key.
    await act(() => result.current.query.refetch());

    expect(pageDataInitiators(source)).toEqual([
      ReadInitiator.User,
      ReadInitiator.Background,
    ]);
  });

  it("marks a window-focus refetch as background", async () => {
    const source = createSource();
    const { result } = renderPageData(source);
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(source.pageData).toHaveBeenCalledTimes(2));

    expect(pageDataInitiators(source)).toEqual([
      ReadInitiator.User,
      ReadInitiator.Background,
    ]);
  });

  it("marks a filter change as user-initiated", async () => {
    const source = createSource();
    const { result, rerender } = renderPageData(source);
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    rerender({ filters: { limit: 50 } });
    await waitFor(() => expect(source.pageData).toHaveBeenCalledTimes(2));

    expect(pageDataInitiators(source)).toEqual([
      ReadInitiator.User,
      ReadInitiator.User,
    ]);
  });

  it("marks an explicit refresh user-initiated, once", async () => {
    const source = createSource();
    const { result } = renderPageData(source);
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    await act(() => refetchAsUser(result.current.query.refetch));
    await act(() => result.current.query.refetch());

    expect(pageDataInitiators(source)).toEqual([
      ReadInitiator.User,
      ReadInitiator.User,
      ReadInitiator.Background,
    ]);
  });

  it("marks a refetch after a failed first fetch as background", async () => {
    const source = createSource();
    vi.mocked(source.pageData).mockRejectedValueOnce(new Error("boom"));
    const { result } = renderPageData(source);
    await waitFor(() => expect(result.current.query.isError).toBe(true));

    await act(() => result.current.query.refetch());

    expect(pageDataInitiators(source)).toEqual([
      ReadInitiator.User,
      ReadInitiator.Background,
    ]);
  });

  it("hands the detail read its initiator", async () => {
    const source = createSource();
    renderHook(() => useAgentSessionDetail("s-1"), {
      wrapper: wrapperFor(createTestQueryClient(), source),
    });

    await waitFor(() =>
      expect(source.detail).toHaveBeenCalledWith("s-1", {
        readInitiator: ReadInitiator.User,
      })
    );
  });
});
