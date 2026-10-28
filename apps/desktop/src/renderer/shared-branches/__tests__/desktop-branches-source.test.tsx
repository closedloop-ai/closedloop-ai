import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import {
  CollaboratorArtifactType,
  unavailableArtifactCollaboratorBatchResponse,
} from "@repo/api/src/types/artifact-collaborators";
import {
  type BranchListResponse,
  type BranchRow,
  BranchViewerScope,
  encodeBranchId,
} from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { BranchTraceCompletenessState } from "@repo/api/src/types/branch-trace";
import { LIST_QUERY_EXPRESSION_PARAM } from "@repo/api/src/types/list-query-expression";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import {
  useBranchesDataSource,
  useBranchesQueryContext,
} from "@repo/app/branches/data-source/provider";
import { useBranchTracePages } from "@repo/app/branches/hooks/use-branch-trace-pages";
import { useBranchesPageData } from "@repo/app/branches/hooks/use-branches";
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
import { z } from "zod";
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

function setupDesktopApi(
  initial: DesktopAuthState,
  stores: { localItems?: BranchRow[]; cloudList?: BranchListResponse } = {}
) {
  const listeners = new Set<(state: DesktopAuthState) => void>();
  const localItems = stores.localItems ?? [];
  const cloudList = stores.cloudList ?? canonicalBranchListResponseFixture;
  const localTrace = vi.fn(async () => ({
    items: [],
    sessions: [],
    qualifyingSessionCount: 0,
    completeness: { state: BranchTraceCompletenessState.Complete },
    aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
  }));
  const localPageData = vi.fn(async () => ({
    list: { items: localItems, total: localItems.length },
    analytics: {},
  }));
  const cloudApiFetch = vi.fn(async () => ({
    kind: "response" as const,
    status: 200,
    statusText: "OK",
    headers: [["content-type", "application/json"]] as [string, string][],
    bodyText: JSON.stringify({
      success: true,
      data: cloudList,
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
        trace: localTrace,
        pageData: localPageData,
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
    localPageData,
    localTrace,
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
  it("loads cursor trace pages through the authenticated cloud adapter", async () => {
    restoreOnline = forceOnline(true);
    const { cloudApiFetch, localTrace } = setupDesktopApi(AUTHENTICATED);
    cloudApiFetch.mockResolvedValue({
      kind: "response",
      status: 200,
      statusText: "OK",
      headers: [["content-type", "application/json"]],
      bodyText: JSON.stringify({
        success: true,
        data: {
          branchId: "branch-1",
          viewerScope: BranchViewerScope.Organization,
          items: [],
          overviewItems: [],
          hasMore: false,
          traceState: {
            sessions: [],
            qualifyingSessionCount: 0,
            completeness: { state: BranchTraceCompletenessState.Complete },
            aggregateCompleteness: {
              state: BranchTraceCompletenessState.Complete,
            },
          },
        },
      }),
    });
    const { result } = renderHook(
      () => {
        const source = useBranchesDataSource();
        return useBranchTracePages(
          source.scope === HTTP_SCOPE ? "branch-1" : ""
        );
      },
      { wrapper: appCoreWrapper() }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(cloudApiFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/branches/branch-1/trace?pageMode=cursor&limit=100",
      })
    );
    expect(localTrace).not.toHaveBeenCalled();
    expect(result.current.hasNextPage).toBe(false);
  });

  it("keeps the local IPC trace available without a page capability", async () => {
    const { cloudApiFetch, localTrace } = setupDesktopApi(SIGNED_OUT);
    const { result } = renderHook(() => useBranchTracePages("branch-1"), {
      wrapper: StandaloneWrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(localTrace).toHaveBeenCalledWith("branch-1");
    expect(cloudApiFetch).not.toHaveBeenCalled();
    expect(result.current.hasNextPage).toBe(false);
  });

  it("selects the cloud HTTP source when authenticated + online", async () => {
    restoreOnline = forceOnline(true);
    setupDesktopApi(AUTHENTICATED);

    const { result } = renderHook(() => useBranchesDataSource(), {
      wrapper: appCoreWrapper(),
    });

    await waitFor(() => expect(result.current.scope).toBe(HTTP_SCOPE));
  });

  it("routes Cloud Branch collaborator reads through the authenticated IPC transport", async () => {
    restoreOnline = forceOnline(true);
    const { cloudApiFetch } = setupDesktopApi(AUTHENTICATED);
    const branchId = "55555555-5555-4555-8555-555555555551";
    cloudApiFetch.mockResolvedValue({
      kind: "response",
      status: 200,
      statusText: "OK",
      headers: [["content-type", "application/json"]],
      bodyText: JSON.stringify({
        success: true,
        data: unavailableArtifactCollaboratorBatchResponse(
          CollaboratorArtifactType.Branch,
          [branchId]
        ),
      }),
    });
    const { result } = renderHook(() => useBranchesDataSource(), {
      wrapper: appCoreWrapper(),
    });
    await waitFor(() => expect(result.current.scope).toBe(HTTP_SCOPE));

    const response = await result.current.collaborators?.([branchId]);

    expect(response?.results[0]?.artifactId).toBe(branchId);
    expect(cloudApiFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: expect.stringContaining("/artifacts/collaborators?"),
      })
    );
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
  ])(
    "fails closed to local for incomplete identity $userId/$organizationId",
    async ({ userId, organizationId }) => {
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
    }
  );

  it("returns the connected canonical cloud projection unchanged", async () => {
    restoreOnline = forceOnline(true);
    setupDesktopApi(AUTHENTICATED);

    const { result } = renderHook(() => useBranchesPageData(), {
      wrapper: appCoreWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(JSON.stringify(result.current.data?.list)).toBe(
      JSON.stringify(canonicalBranchListResponseFixture)
    );
    expect(
      JSON.stringify(result.current.data?.list.items[0]?.canonicalProjection)
    ).toBe(
      JSON.stringify(
        canonicalBranchListResponseFixture.items[0]?.canonicalProjection
      )
    );
  });

  /**
   * ISS-6972 decision 3: Branches follows the one read-source rule, so offline
   * is Local here exactly as it already was on Sessions. This replaces the
   * deliberate divergence that kept serving cached CLOUD rows offline — that
   * bought offline branch reads at the price of one screen naming two stores,
   * which is the defect class `read-source-cross-surface-parity` exists for.
   */
  it("moves to this device's branches when the machine goes offline", async () => {
    restoreOnline = forceOnline(true);
    const { cloudApiFetch, localPageData } = setupDesktopApi(AUTHENTICATED);
    const { result } = renderHook(
      () => ({
        query: useBranchesPageData(),
        client: useBranchesQueryContext().queryClient,
      }),
      { wrapper: appCoreWrapper() }
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    // The split cloud read issues analytics only once the list has resolved, so
    // the connected call count is taken after both reads have settled.
    await waitFor(() =>
      expect(result.current.query.analyticsPending).toBe(false)
    );
    const connectedClient = result.current.client;
    const connectedFetchCount = cloudApiFetch.mock.calls.length;

    act(() => {
      onlineManager.setOnline(false);
      restoreOnline?.();
      restoreOnline = forceOnline(false);
      window.dispatchEvent(new Event("offline"));
    });

    // The local source answers, and the cloud is not asked again while there is
    // no network to ask over.
    await waitFor(() => expect(localPageData).toHaveBeenCalled());
    expect(cloudApiFetch).toHaveBeenCalledTimes(connectedFetchCount);
    // One Branch client across the transition: the cache namespace changes with
    // the source, the CLIENT does not, so mounted observers stay attached.
    expect(result.current.client).toBe(connectedClient);
  });

  // ISS-6972 decision 3: an uncached offline read is served by THIS DEVICE
  // rather than parked on an unreachable cloud. What survives from the paused
  // version is the half that still matters — the cloud is not called while there
  // is no network, and no cloud rows are invented for the new filter.
  it("serves an uncached authenticated offline read from this device", async () => {
    restoreOnline = forceOnline(true);
    const { cloudApiFetch, localPageData } = setupDesktopApi(AUTHENTICATED);
    const { result, rerender } = renderHook(
      ({ repo }: { repo: string }) => useBranchesPageData({ repo }),
      {
        initialProps: { repo: "closedloop-ai/closedloop-ai" },
        wrapper: appCoreWrapper(),
      }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.analyticsPending).toBe(false));
    const connectedFetchCount = cloudApiFetch.mock.calls.length;
    const connectedLocalCallCount = localPageData.mock.calls.length;

    act(() => {
      onlineManager.setOnline(false);
      restoreOnline?.();
      restoreOnline = forceOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    rerender({ repo: "closedloop-ai/other-repository" });

    await waitFor(() =>
      expect(localPageData.mock.calls.length).toBeGreaterThan(
        connectedLocalCallCount
      )
    );
    expect(cloudApiFetch).toHaveBeenCalledTimes(connectedFetchCount);
  });

  it("returns to the cloud source on reconnect", async () => {
    restoreOnline = forceOnline(true);
    const { cloudApiFetch, localPageData } = setupDesktopApi(AUTHENTICATED);
    const { result } = renderHook(
      () => ({
        query: useBranchesPageData(),
        source: useBranchesDataSource(),
        client: useBranchesQueryContext().queryClient,
      }),
      { wrapper: appCoreWrapper() }
    );
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    await waitFor(() =>
      expect(result.current.query.analyticsPending).toBe(false)
    );
    const identityClient = result.current.client;
    const connectedFetchCount = cloudApiFetch.mock.calls.length;

    act(() => {
      onlineManager.setOnline(false);
      restoreOnline?.();
      restoreOnline = forceOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    await waitFor(() => expect(localPageData).toHaveBeenCalled());
    expect(cloudApiFetch).toHaveBeenCalledTimes(connectedFetchCount);

    act(() => {
      onlineManager.setOnline(true);
      restoreOnline?.();
      restoreOnline = forceOnline(true);
      window.dispatchEvent(new Event("online"));
    });
    // Back on the canonical cloud rows — served from the cloud-scoped cache
    // entry the offline detour never touched, which is the point of keeping one
    // client and namespacing by source.
    await waitFor(() =>
      expect(JSON.stringify(result.current.query.data?.list)).toBe(
        JSON.stringify(canonicalBranchListResponseFixture)
      )
    );
    expect(result.current.client).toBe(identityClient);
  });

  it("clears mounted Branch data on direct authenticated identity change", async () => {
    restoreOnline = forceOnline(true);
    const { push } = setupDesktopApi(AUTHENTICATED);
    const { result } = renderHook(
      () => ({
        query: useBranchesPageData(),
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
    // size. user-2 leaves their own transient `desktop-local` entry beside their
    // cloud one on the way. Neither is user-1's, which is the whole claim.
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

    // ISS-6972: offline no longer parks this query on the cloud, so the claim
    // under test is the one that always mattered — the previous identity's rows
    // must not survive the switch, whatever store answers next.
    await waitFor(() =>
      expect(result.current.data?.list).not.toEqual(
        canonicalBranchListResponseFixture
      )
    );
  });

  it("never exposes the first identity across sign-out then sign-in", async () => {
    restoreOnline = forceOnline(true);
    const { push } = setupDesktopApi(AUTHENTICATED);
    const { result } = renderHook(
      () => ({
        query: useBranchesPageData(),
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
    // directly rather than a bare cache size. A second entry is expected on this
    // path: the freshly-signed-in reader reads its own machine's `desktop-local`
    // scope before the cloud one. Neither is user-1's.
    const scopes = result.current.branchClient
      .getQueryCache()
      .getAll()
      .map((query) => JSON.stringify(query.queryKey));
    expect(scopes.some((key) => key.includes("user-1"))).toBe(false);
    expect(scopes.some((key) => key.includes('desktop-cloud:[\\"user-2'))).toBe(
      true
    );
  });

  /**
   * ISS-9456: the two stores can disagree about one branch, and the rule is
   * selection, not reconciliation. Each case gives the INACTIVE store the
   * fresher answer, so a merge or a freshness tie-break would show up as the
   * wrong rows or as a call on the wrong log.
   */
  describe("when the local and cloud stores disagree about one branch", () => {
    it("serves the cloud rows in Cloud mode even when this device is newer", async () => {
      restoreOnline = forceOnline(true);
      const { localPageData } = setupDesktopApi(AUTHENTICATED, {
        localItems: [localRow({ sessionIds: [LOCAL_ONLY_SESSION_ID] })],
      });
      const { result, rerender } = renderHook(
        ({ repo }: { repo?: string }) => ({
          query: useBranchesPageData(repo ? { repo } : undefined),
          source: useBranchesDataSource(),
        }),
        { initialProps: {}, wrapper: appCoreWrapper() }
      );
      // Auth resolves asynchronously and the mode is Local until it does, so a
      // local read before this point is legitimate. Only reads after it count.
      await waitFor(() => expect(result.current.source.scope).toBe(HTTP_SCOPE));
      await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
      localPageData.mockClear();

      rerender({ repo: cloudRow.repoFullName });

      await waitFor(() =>
        expect(result.current.query.data?.list.items[0]?.artifactId).toBe(
          cloudRow.artifactId
        )
      );
      expect(result.current.query.data?.list.items[0]?.sessionIds).toEqual(
        cloudRow.sessionIds
      );
      expect(localPageData).not.toHaveBeenCalled();
    });

    it("serves this device's rows in Local mode even when the cloud is newer", async () => {
      restoreOnline = forceOnline(true);
      const { cloudApiFetch, localPageData } = setupDesktopApi(SIGNED_OUT, {
        localItems: [localRow({ sessionIds: [LOCAL_ONLY_SESSION_ID] })],
        cloudList: cloudNewerList(),
      });

      const { result } = renderHook(() => useBranchesPageData(), {
        wrapper: appCoreWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(localPageData).toHaveBeenCalled();
      const items = result.current.data?.list.items ?? [];
      expect(items.map((item) => item.sessionIds)).toEqual([
        [LOCAL_ONLY_SESSION_ID],
      ]);
      expect(items.some((item) => Object.hasOwn(item, "artifactId"))).toBe(
        false
      );
      expect(cloudApiFetch).not.toHaveBeenCalled();
    });

    it("keeps a local branch with no linked sessions unkeyed and asks the cloud nothing", async () => {
      restoreOnline = forceOnline(true);
      const { cloudApiFetch } = setupDesktopApi(SIGNED_OUT, {
        localItems: [localRow({ sessionIds: [] })],
        cloudList: cloudNewerList(),
      });

      const { result } = renderHook(() => useBranchesPageData(), {
        wrapper: appCoreWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const [item] = result.current.data?.list.items ?? [];
      expect(item?.sessionIds).toEqual([]);
      expect(item && Object.hasOwn(item, "artifactId")).toBe(false);
      // No bridge call at all, so no related-sessions request either: Local
      // mode has no artifact id to key one on.
      expect(cloudApiFetch).not.toHaveBeenCalled();
    });
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

const LOCAL_ONLY_SESSION_ID = "session-local-only";
/** Newer than the canonical cloud fixture's `observedAt` (2026-07-31). */
const NEWER_ACTIVITY_AT = "2026-08-31T12:00:00.000Z";
/** Newer again than the local row, so a freshness tie-break would pick cloud. */
const CLOUD_NEWER_ACTIVITY_AT = "2026-09-01T12:00:00.000Z";

const cloudRow = firstCloudRow();

function firstCloudRow(): BranchRow {
  const [row] = canonicalBranchListResponseFixture.items;
  if (!row) {
    throw new Error("canonicalBranchListResponseFixture has no row");
  }
  return row;
}

/**
 * The cloud store's answer for the same branch, strictly fresher than the local
 * row and carrying a session the local row does not, so Local mode showing any
 * of it is a merge or a tie-break, never selection.
 */
function cloudNewerList(): BranchListResponse {
  return {
    ...canonicalBranchListResponseFixture,
    items: [
      {
        ...cloudRow,
        lastActivityAt: CLOUD_NEWER_ACTIVITY_AT,
        sessionIds: [...cloudRow.sessionIds, "session-cloud-newer"],
      },
    ],
  };
}

/**
 * The cloud fixture's branch as the local SQLite producer reports it: same repo
 * and branch name, the encoded local id, no cloud artifact identity, and newer
 * activity than the cloud row.
 */
function localRow(overrides: Pick<BranchRow, "sessionIds">): BranchRow {
  const {
    artifactId: _artifactId,
    canonicalProjection: _canonicalProjection,
    ...shared
  } = cloudRow;
  return {
    ...shared,
    id: encodeBranchId({
      repoFullName: cloudRow.repoFullName,
      branchName: cloudRow.branchName,
    }),
    lastActivityAt: NEWER_ACTIVITY_AT,
    ...overrides,
  };
}

// PRD-721: an installed Desktop build can be newer than the deployed API, so
// its cloud Branches read keeps the legacy params rather than sending a
// `listQuery` an older route refuses.
const cloudRequestSchema = z.object({ path: z.string() });

describe("DesktopBranchesSource cloud list read", () => {
  it("sends the legacy filter params, not listQuery", async () => {
    restoreOnline = forceOnline(true);
    const { cloudApiFetch } = setupDesktopApi(AUTHENTICATED);
    const { result } = renderHook(() => useBranchesDataSource(), {
      wrapper: appCoreWrapper(),
    });
    await waitFor(() => expect(result.current.scope).toBe(HTTP_SCOPE));

    await result.current.list({
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      names: ["feature/a"],
      sortKey: BranchListSortKey.Name,
      sortDir: BranchListSortDirection.Asc,
    });

    const calls: readonly (readonly unknown[])[] = cloudApiFetch.mock.calls;
    const listPaths = calls
      .map(
        ([request]) => cloudRequestSchema.safeParse(request).data?.path ?? ""
      )
      .filter(
        (path) =>
          path.startsWith("/branches?") &&
          path.includes(`pageMode=${BranchListPageMode.Server}`)
      );
    expect(listPaths.length).toBeGreaterThan(0);
    for (const path of listPaths) {
      expect(path).toContain("names=feature%2Fa");
      expect(path).not.toContain(LIST_QUERY_EXPRESSION_PARAM);
    }
  });
});
