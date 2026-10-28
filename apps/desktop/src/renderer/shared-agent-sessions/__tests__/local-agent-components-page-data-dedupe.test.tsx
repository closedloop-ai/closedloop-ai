import {
  AgentComponentSortDir,
  AgentComponentSortKey,
} from "@repo/api/src/types/agent-component";
import type {
  AgentComponentPageDataRequest,
  AgentComponentPageDataResult,
} from "@repo/api/src/utils/agent-component-page-data";
import { DEFAULT_AGENT_COMPONENT_FILTERS } from "@repo/api/src/utils/agent-component-reduce";
import { AgentComponentsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { useAgentComponentsPageData } from "@repo/app/agents/hooks/use-agent-components-page-data";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../types/desktop-api";
import { createLocalAgentComponentsDataSource } from "../local-agent-components-data-source";

/**
 * ISS-11170 on the desktop LOCAL source. The IPC page-data read cannot be
 * cancelled, so the shared hook must not hand it a signal: navigating off the
 * Agents page mid-read and back has to join the read still running in the main
 * process rather than start a second one behind it.
 */

const REQUEST: AgentComponentPageDataRequest = {
  filters: DEFAULT_AGENT_COMPONENT_FILTERS,
  sortBy: AgentComponentSortKey.Name,
  sortDir: AgentComponentSortDir.Asc,
  page: 0,
  pageSize: 50,
  honestSource: false,
  dedupePluginRollups: false,
};

const INERT_ADAPTER: ApiAdapter = {
  resolveApiOrigin: () => "http://unused.test",
  fetch: () => Promise.reject(new TypeError("no network in this suite")),
};

describe("local agent-components page-data read (ISS-11170)", () => {
  it("joins the in-flight IPC read on remount instead of issuing a second one", async () => {
    const getAgentComponentsPageData = vi.fn(
      () => new Promise<AgentComponentPageDataResult>(() => undefined)
    );
    const db: Partial<DesktopApi["db"]> = { getAgentComponentsPageData };
    const source = createLocalAgentComponentsDataSource({
      db: db as DesktopApi["db"],
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
          <ApiAdapterProvider adapter={INERT_ADAPTER}>
            <AgentComponentsDataSourceProvider dataSource={source}>
              {children}
            </AgentComponentsDataSourceProvider>
          </ApiAdapterProvider>
        </AuthAdapterProvider>
      </QueryClientProvider>
    );

    const first = renderHook(() => useAgentComponentsPageData(REQUEST), {
      wrapper,
    });
    await waitFor(() =>
      expect(getAgentComponentsPageData).toHaveBeenCalledTimes(1)
    );
    first.unmount();

    const second = renderHook(() => useAgentComponentsPageData(REQUEST), {
      wrapper,
    });
    await waitFor(() => expect(second.result.current.isFetching).toBe(true));

    expect(getAgentComponentsPageData).toHaveBeenCalledTimes(1);
  });
});
