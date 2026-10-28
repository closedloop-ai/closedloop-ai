/**
 * ISS-11170 — a settled search term that is superseded must not leave its
 * `/agent-components/page-data` read running.
 *
 * Nothing between the hook and the `ApiTransportFetch` port is a double: no
 * source is injected, so the Agents view builds the default HTTP source over
 * the real `useApiClient`, exactly as `apps/app` does. The transport records the
 * init it was handed and never answers, so a read is "outstanding" until its
 * signal aborts.
 *
 * What this pins is the CLIENT half. `apps/api` is not asked to stop — see the
 * ISS-11170 ticket thread for why the server half is "ignored", not "cancelled".
 */

import {
  AgentComponentSortDir,
  AgentComponentSortKey,
} from "@repo/api/src/types/agent-component";
import type { AgentComponentPageDataRequest } from "@repo/api/src/utils/agent-component-page-data";
import { DEFAULT_AGENT_COMPONENT_FILTERS } from "@repo/api/src/utils/agent-component-reduce";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiAdapter } from "../../../shared/api/api-adapter";
import { ApiAdapterProvider } from "../../../shared/api/provider";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { useAgentComponentsPageData } from "../use-agent-components-page-data";
import {
  AGENT_INVENTORY_SEARCH_SETTLE_MS,
  useAgentsInventoryView,
} from "../use-agents-inventory-view";

const PAGE_DATA_PATH = "/agent-components/page-data";

/** One keystroke at a time, each held long enough to settle into its own read. */
const TYPED_PREFIXES = ["o", "or", "orc"];

type RecordedRequest = {
  pathname: string;
  search: string | null;
  signal: AbortSignal | null | undefined;
};

/** Never answers; rejects the way a real `fetch` does once its signal fires. */
function createHangingTransport(
  recorded: RecordedRequest[]
): ApiAdapter["fetch"] {
  return (input, init) => {
    const url = new URL(String(input));
    const signal = init?.signal;
    recorded.push({
      pathname: url.pathname,
      search: url.searchParams.get("search"),
      signal,
    });
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
}

function pageDataRequests(recorded: RecordedRequest[]): RecordedRequest[] {
  return recorded.filter((request) => request.pathname === PAGE_DATA_PATH);
}

describe("the Agents search aborts the page-data read it supersedes (ISS-11170)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves exactly one page-data request outstanding after each settled keystroke", async () => {
    const recorded: RecordedRequest[] = [];
    const adapter: ApiAdapter = {
      resolveApiOrigin: () => "http://agents.test",
      fetch: createHangingTransport(recorded),
    };
    const { result } = renderHook(
      () =>
        useAgentsInventoryView({
          supportsDateWindow: false,
          isViewReady: true,
          sortKey: AgentComponentSortKey.Name,
          sortDir: AgentComponentSortDir.Asc,
          pageSize: 50,
          initialFilters: DEFAULT_AGENT_COMPONENT_FILTERS,
          honestSourceEnabled: false,
          dedupePluginRollups: false,
          boundedPageDataEnabled: true,
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <AppCoreStoryProviders>
            <ApiAdapterProvider adapter={adapter}>
              {children}
            </ApiAdapterProvider>
          </AppCoreStoryProviders>
        ),
      }
    );

    await waitFor(() => expect(pageDataRequests(recorded)).toHaveLength(1));
    const first = pageDataRequests(recorded)[0];
    // Live before it is superseded, so "aborted" below is something that changed.
    expect(first?.signal?.aborted).toBe(false);

    for (const prefix of TYPED_PREFIXES) {
      act(() => {
        result.current.handleFiltersChange({
          ...result.current.filters,
          search: prefix,
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AGENT_INVENTORY_SEARCH_SETTLE_MS * 2);
      });
      await waitFor(() =>
        expect(pageDataRequests(recorded).at(-1)?.search).toBe(prefix)
      );
    }

    const requests = pageDataRequests(recorded);
    expect(requests.map((request) => request.search)).toEqual([
      "",
      ...TYPED_PREFIXES,
    ]);
    await waitFor(() => expect(first?.signal?.aborted).toBe(true));
    const outstanding = requests.filter((request) => !request.signal?.aborted);
    expect(outstanding.map((request) => request.search)).toEqual(["orc"]);
  });

  it("keeps the in-flight read across a remount when the transport cannot cancel (desktop cloud)", async () => {
    const recorded: RecordedRequest[] = [];
    // `createDesktopCloudApiAdapter`'s declaration: the IPC bridge drops the signal.
    const adapter: ApiAdapter = {
      resolveApiOrigin: () => "http://agents.test",
      fetch: createHangingTransport(recorded),
      honorsAbortSignal: false,
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
          <ApiAdapterProvider adapter={adapter}>{children}</ApiAdapterProvider>
        </AuthAdapterProvider>
      </QueryClientProvider>
    );
    const request: AgentComponentPageDataRequest = {
      filters: DEFAULT_AGENT_COMPONENT_FILTERS,
      sortBy: AgentComponentSortKey.Name,
      sortDir: AgentComponentSortDir.Asc,
      page: 0,
      pageSize: 50,
      honestSource: false,
      dedupePluginRollups: false,
    };

    const first = renderHook(() => useAgentComponentsPageData(request), {
      wrapper,
    });
    await waitFor(() => expect(pageDataRequests(recorded)).toHaveLength(1));
    first.unmount();

    const second = renderHook(() => useAgentComponentsPageData(request), {
      wrapper,
    });
    await waitFor(() => expect(second.result.current.isFetching).toBe(true));

    // The remount joined the read already running rather than paying for a
    // second full org read behind one the bridge cannot stop.
    expect(pageDataRequests(recorded)).toHaveLength(1);
    expect(pageDataRequests(recorded)[0]?.signal?.aborted).toBe(false);
  });
});
