import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import {
  useBranchesDataSource,
  useBranchesQueryContext,
} from "@repo/app/branches/data-source/provider";
import {
  branchesKeys,
  useBranchesPageData,
  useBranchList,
} from "@repo/app/branches/hooks/use-branches";
import { canonicalBranchListResponseFixture } from "@repo/app/branches/test-fixtures/canonical-branch-projection";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  keepPreviousData,
  onlineManager,
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { DesktopAppCoreProvider } from "../../shared-agent-sessions/desktop-app-core-provider";
import type { DesktopAuthState } from "../../types/desktop-api";
import { DesktopBranchesSource } from "../desktop-branches-source";

const LOCAL_SCOPE = "local";
const HTTP_SCOPE = "http";
const OVERRIDE_SCOPE = "override";

const SIGNED_OUT: DesktopAuthState = {
  status: DesktopAuthStatus.SignedOut,
  userId: null,
  organizationId: null,
};
const AUTHENTICATED: DesktopAuthState = {
  status: DesktopAuthStatus.Authenticated,
  userId: "user-1",
  organizationId: "org-1",
};

const inertApiAdapter: ApiAdapter = {
  resolveApiOrigin: () => "http://test.local",
  fetch: () => Promise.reject(new Error("no remote REST API in tests")),
};

/** A no-op source with a distinct scope, to prove `override` wins over mode. */
const overrideSource = {
  scope: OVERRIDE_SCOPE,
} as unknown as BranchesDataSource;

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function setupDesktopApi(initial: DesktopAuthState) {
  const listeners = new Set<(state: DesktopAuthState) => void>();
  const localList = vi.fn(async () => ({ items: [], total: 0 }));
  const cloudApiFetch = vi.fn(async () => ({
    kind: "response" as const,
    status: 200,
    statusText: "OK",
    headers: [["content-type", "application/json"]] as [string, string][],
    bodyText: JSON.stringify({
      success: true,
      data: canonicalBranchListResponseFixture,
    }),
  }));
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDesktopAuthState: vi.fn(() => Promise.resolve(initial)),
      onDesktopAuthStateChanged: vi.fn(
        (listener: (state: DesktopAuthState) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }
      ),
      cloudApiFetch,
      agentSessionsApi: {
        analytics: vi.fn(async () => ({
          byAgentType: [],
          byProject: [],
          byRepository: [],
          byTool: [],
          viewerScope: AgentSessionViewerScope.Self,
        })),
        detail: vi.fn(async () => null),
        list: vi.fn(async () => ({
          items: [],
          total: 0,
          viewerScope: AgentSessionViewerScope.Self,
        })),
        usage: vi.fn(async () => null),
      },
      branchesApi: {
        list: localList,
        detail: vi.fn(async () => null),
        analytics: vi.fn(async () => ({})),
        usage: vi.fn(async () => ({})),
      },
      db: {
        listAgentComponents: vi.fn(async () => ({ items: [], total: 0 })),
        getAgentComponentDetail: vi.fn(async () => null),
      },
    },
  });
  return {
    cloudApiFetch,
    localList,
    push(state: DesktopAuthState) {
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

function forceOnline(value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
  return () => {
    if (original) {
      Object.defineProperty(window.navigator, "onLine", original);
    } else {
      Reflect.deleteProperty(window.navigator, "onLine");
    }
  };
}

let restoreOnline: (() => void) | null = null;

afterEach(() => {
  onlineManager.setOnline(true);
  restoreOnline?.();
  restoreOnline = null;
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

/** Wrap the probe in `DesktopBranchesSource` under the real app-core stack. */
function appCoreWrapper(override?: BranchesDataSource) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <DesktopAppCoreProvider>
        <DesktopBranchesSource override={override}>
          {children}
        </DesktopBranchesSource>
      </DesktopAppCoreProvider>
    );
  };
}

/** Minimal stack with no app-core mode provider — the default-Local fallback. */
function StandaloneWrapper({ children }: { children: ReactNode }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  return (
    <QueryClientProvider client={queryClient}>
      <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
        <ApiAdapterProvider adapter={inertApiAdapter}>
          <FeatureFlagAdapterProvider
            adapter={createStaticFeatureFlagAdapter()}
          >
            <DesktopBranchesSource>{children}</DesktopBranchesSource>
          </FeatureFlagAdapterProvider>
        </ApiAdapterProvider>
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
}

describe("DesktopBranchesSource", () => {
  it("selects the cloud HTTP source when authenticated + online", async () => {
    restoreOnline = forceOnline(true);
    setupDesktopApi(AUTHENTICATED);

    const { result } = renderHook(() => useBranchesDataSource(), {
      wrapper: appCoreWrapper(),
    });

    await waitFor(() => expect(result.current.scope).toBe(HTTP_SCOPE));
  });

  it("selects the local source when signed out", async () => {
    restoreOnline = forceOnline(true);
    setupDesktopApi(SIGNED_OUT);

    const { result } = renderHook(() => useBranchesDataSource(), {
      wrapper: appCoreWrapper(),
    });

    // Mode starts Local (auth loading) and stays Local once signed out resolves.
    await waitFor(() => expect(result.current.scope).toBe(LOCAL_SCOPE));
    expect(result.current.scope).toBe(LOCAL_SCOPE);
  });

  it.each([
    { userId: "user-1", organizationId: null },
    { userId: undefined, organizationId: "org-1" },
    { userId: "user-1", organizationId: undefined },
  ])("fails closed to local for incomplete identity $userId/$organizationId", async ({
    userId,
    organizationId,
  }) => {
    restoreOnline = forceOnline(true);
    setupDesktopApi({
      status: DesktopAuthStatus.Authenticated,
      userId,
      organizationId,
    } as DesktopAuthState);

    const { result } = renderHook(() => useBranchesDataSource(), {
      wrapper: appCoreWrapper(),
    });

    await waitFor(() => expect(result.current.scope).toBe(LOCAL_SCOPE));
  });

  it("returns the connected canonical cloud projection unchanged", async () => {
    restoreOnline = forceOnline(true);
    setupDesktopApi(AUTHENTICATED);

    const { result } = renderHook(() => useBranchList(), {
      wrapper: appCoreWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(JSON.stringify(result.current.data)).toBe(
      JSON.stringify(canonicalBranchListResponseFixture)
    );
    expect(
      JSON.stringify(result.current.data?.items[0]?.canonicalProjection)
    ).toBe(
      JSON.stringify(
        canonicalBranchListResponseFixture.items[0]?.canonicalProjection
      )
    );
  });

  it("retains cached canonical cloud data without a local fallback while offline", async () => {
    restoreOnline = forceOnline(true);
    const { cloudApiFetch, localList } = setupDesktopApi(AUTHENTICATED);
    const { result } = renderHook(
      () => ({
        query: useBranchList(),
        client: useBranchesQueryContext().queryClient,
      }),
      { wrapper: appCoreWrapper() }
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    const connectedClient = result.current.client;
    const connectedFetchCount = cloudApiFetch.mock.calls.length;
    const connectedLocalCallCount = localList.mock.calls.length;

    act(() => {
      onlineManager.setOnline(false);
      restoreOnline?.();
      restoreOnline = forceOnline(false);
      window.dispatchEvent(new Event("offline"));
    });

    await waitFor(() =>
      expect(JSON.stringify(result.current.query.data)).toBe(
        JSON.stringify(canonicalBranchListResponseFixture)
      )
    );
    expect(result.current.client).toBe(connectedClient);
    expect(cloudApiFetch).toHaveBeenCalledTimes(connectedFetchCount);
    expect(localList).toHaveBeenCalledTimes(connectedLocalCallCount);
  });

  it("keeps an uncached authenticated offline read pending and paused", async () => {
    restoreOnline = forceOnline(true);
    const { cloudApiFetch, localList } = setupDesktopApi(AUTHENTICATED);
    const { result, rerender } = renderHook(
      ({ repo }: { repo: string }) => useBranchList({ repo }),
      {
        initialProps: { repo: "closedloop-ai/symphony-alpha" },
        wrapper: appCoreWrapper(),
      }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const connectedFetchCount = cloudApiFetch.mock.calls.length;
    const connectedLocalCallCount = localList.mock.calls.length;

    act(() => {
      onlineManager.setOnline(false);
      restoreOnline?.();
      restoreOnline = forceOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    rerender({ repo: "closedloop-ai/other-repository" });

    await waitFor(() => expect(result.current.fetchStatus).toBe("paused"));
    expect(result.current.status).toBe("pending");
    expect(result.current.data).toBeUndefined();
    expect(cloudApiFetch).toHaveBeenCalledTimes(connectedFetchCount);
    expect(localList).toHaveBeenCalledTimes(connectedLocalCallCount);
  });

  it("refetches one stale canonical query through cloud only on reconnect", async () => {
    restoreOnline = forceOnline(true);
    const { cloudApiFetch, localList } = setupDesktopApi(AUTHENTICATED);
    const { result } = renderHook(
      () => ({
        query: useBranchList(),
        source: useBranchesDataSource(),
        client: useBranchesQueryContext().queryClient,
      }),
      { wrapper: appCoreWrapper() }
    );
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    const identityClient = result.current.client;
    const connectedFetchCount = cloudApiFetch.mock.calls.length;
    const connectedLocalCount = localList.mock.calls.length;

    act(() => {
      onlineManager.setOnline(false);
      restoreOnline?.();
      restoreOnline = forceOnline(false);
      window.dispatchEvent(new Event("offline"));
      identityClient.invalidateQueries({
        queryKey: branchesKeys.lists(),
        refetchType: "none",
      });
    });
    expect(JSON.stringify(result.current.query.data)).toBe(
      JSON.stringify(canonicalBranchListResponseFixture)
    );
    expect(result.current.query.isStale).toBe(true);
    expect(cloudApiFetch).toHaveBeenCalledTimes(connectedFetchCount);
    expect(localList).toHaveBeenCalledTimes(connectedLocalCount);
    expect(result.current.client).toBe(identityClient);

    act(() => {
      onlineManager.setOnline(true);
      restoreOnline?.();
      restoreOnline = forceOnline(true);
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() =>
      expect(cloudApiFetch).toHaveBeenCalledTimes(connectedFetchCount + 1)
    );
    expect(result.current.query.isSuccess).toBe(true);
    expect(result.current.source.scope).toBe(HTTP_SCOPE);
    expect(localList).toHaveBeenCalledTimes(connectedLocalCount);
    expect(result.current.client).toBe(identityClient);
  });

  it("clears mounted Branch data on direct authenticated identity change", async () => {
    restoreOnline = forceOnline(true);
    const { push } = setupDesktopApi(AUTHENTICATED);
    const { result } = renderHook(
      () => ({
        query: useBranchList(),
        source: useBranchesDataSource(),
        client: useBranchesQueryContext().queryClient,
      }),
      { wrapper: appCoreWrapper() }
    );
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    const branchClient = result.current.client;

    act(() =>
      push({
        status: DesktopAuthStatus.Authenticated,
        userId: "user-2",
        organizationId: "org-2",
      })
    );
    expect(result.current.query.data).toBeUndefined();
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.client).toBe(branchClient);
    expect(result.current.source.scope).toBe(HTTP_SCOPE);
    // The invariant is that the FIRST identity is unreachable, not a bare cache
    // size. ISS-5714 (review thread) re-arms the cutover gate for user-2 instead
    // of letting them inherit user-1's latch, and this suite's preload has no
    // readiness channel, so user-2 passes through the compatibility fail-open —
    // leaving their own transient `desktop-local` entry beside their cloud one
    // on the way. Neither is user-1's, which is the whole claim.
    const scopes = branchClient
      .getQueryCache()
      .getAll()
      .map((query) => JSON.stringify(query.queryKey));
    expect(scopes.some((key) => key.includes("user-1"))).toBe(false);
    expect(scopes.some((key) => key.includes('desktop-cloud:[\\"user-2'))).toBe(
      true
    );
  });

  it("does not expose the previous identity through page-data placeholders while offline", async () => {
    restoreOnline = forceOnline(true);
    const { push } = setupDesktopApi(AUTHENTICATED);
    const pageDataSource = {
      scope: OVERRIDE_SCOPE,
      pageData: vi.fn(async () => ({
        list: canonicalBranchListResponseFixture,
        analytics: {},
      })),
    } as unknown as BranchesDataSource;
    const { result } = renderHook(
      () => useBranchesPageData({}, { placeholderData: keepPreviousData }),
      { wrapper: appCoreWrapper(pageDataSource) }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.list).toEqual(
      canonicalBranchListResponseFixture
    );

    act(() => {
      onlineManager.setOnline(false);
      restoreOnline?.();
      restoreOnline = forceOnline(false);
      window.dispatchEvent(new Event("offline"));
      push({
        status: DesktopAuthStatus.Authenticated,
        userId: "user-2",
        organizationId: "org-2",
      });
    });

    await waitFor(() => expect(result.current.fetchStatus).toBe("paused"));
    expect(result.current.status).toBe("pending");
    expect(result.current.data).toBeUndefined();
  });

  it("never exposes the first identity across sign-out then sign-in", async () => {
    restoreOnline = forceOnline(true);
    const { push } = setupDesktopApi(AUTHENTICATED);
    const { result } = renderHook(
      () => ({
        query: useBranchList(),
        source: useBranchesDataSource(),
        branchClient: useBranchesQueryContext().queryClient,
        appClient: useQueryClient(),
      }),
      { wrapper: appCoreWrapper() }
    );
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    const branchClient = result.current.branchClient;
    expect(branchClient).not.toBe(result.current.appClient);

    act(() => push(SIGNED_OUT));
    await waitFor(() => expect(result.current.source.scope).toBe(LOCAL_SCOPE));
    expect(result.current.query.data).toBeUndefined();
    expect(result.current.branchClient).toBe(branchClient);

    act(() =>
      push({
        status: DesktopAuthStatus.Authenticated,
        userId: "user-2",
        organizationId: "org-2",
      })
    );
    expect(result.current.query.data).toBeUndefined();
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.branchClient).toBe(branchClient);
    // The invariant is that the FIRST identity is unreachable, so assert that
    // directly rather than a bare cache size. ISS-5714 added a second, expected
    // entry on this path: signing in no longer moves Branches to the cloud until
    // the upload backlog has drained, so the freshly-signed-in reader reads its
    // own machine's `desktop-local` scope first and the cloud scope after the
    // cutover. Neither is user-1's.
    const scopes = result.current.branchClient
      .getQueryCache()
      .getAll()
      .map((query) => JSON.stringify(query.queryKey));
    expect(scopes.some((key) => key.includes("user-1"))).toBe(false);
    expect(scopes.some((key) => key.includes('desktop-cloud:[\\"user-2'))).toBe(
      true
    );
  });

  it("honors an override regardless of mode (test seam)", () => {
    restoreOnline = forceOnline(true);
    setupDesktopApi(AUTHENTICATED);

    const { result } = renderHook(() => useBranchesDataSource(), {
      wrapper: appCoreWrapper(overrideSource),
    });

    // Even authenticated + online (which would otherwise pick "http"), the
    // injected source wins — synchronously, since override bypasses the mode.
    expect(result.current.scope).toBe(OVERRIDE_SCOPE);
  });

  it("defaults to the local source with no app-core mode provider", () => {
    setupDesktopApi(SIGNED_OUT);

    const { result } = renderHook(() => useBranchesDataSource(), {
      wrapper: StandaloneWrapper,
    });

    expect(result.current.scope).toBe(LOCAL_SCOPE);
  });
});
