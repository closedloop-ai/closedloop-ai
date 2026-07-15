import { BranchKpiState } from "@repo/api/src/types/branch";
import {
  GitHubDataConnectionSource,
  GitHubInstallationStatus,
  type GitHubIntegrationStatus,
  GitHubOAuthRequiredReason,
} from "@repo/api/src/types/github";
import {
  InsightsGitHubProvenanceState,
  InsightsScope,
  InsightsSection,
  InsightsTileAvailabilityState,
} from "@repo/api/src/types/insights";
import { useInsightsDataSource } from "@repo/app/insights/data/insights-data-source";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopInsightsProvider } from "../desktop-insights-provider";

const { useDesktopAuthMock } = vi.hoisted(() => ({
  useDesktopAuthMock: vi.fn(),
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

describe("DesktopInsightsProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useDesktopAuthMock.mockReset();
    if (originalDesktopApi) {
      Object.defineProperty(window, "desktopApi", originalDesktopApi);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
  });

  it("offers org scope from API-key capability but keeps org GitHub tiles gated without payload proof", async () => {
    installDesktopApi();
    useDesktopAuthMock.mockReturnValue(authState());

    renderWithProvider(<ProviderProbe />);

    expect(await screen.findByText("scopes:me,org")).toBeTruthy();
    expect(screen.getByText(`org:${BranchKpiState.Gated}`)).toBeTruthy();
    expect(screen.getByText(`local:${BranchKpiState.Gated}`)).toBeTruthy();
  });

  it("marks local GitHub tiles available when the desktop data connection is connected", async () => {
    installDesktopApi({
      githubIntegrationStatus: {
        connected: false,
        githubDataConnection: {
          connected: true,
          oauthRequiredReasons: [],
          sources: [GitHubDataConnectionSource.UserOAuth],
        },
      },
    });
    useDesktopAuthMock.mockReturnValue(authState());

    renderWithProvider(<ProviderProbe />);

    expect(
      await screen.findByText(`local:${BranchKpiState.Available}`)
    ).toBeTruthy();
  });

  it("falls back to legacy connected status when the data-connection field is omitted", async () => {
    installDesktopApi({
      githubIntegrationStatus: legacyConnectedGitHubStatus(),
    });
    useDesktopAuthMock.mockReturnValue(authState());

    renderWithProvider(<ProviderProbe />);

    expect(
      await screen.findByText(`local:${BranchKpiState.Available}`)
    ).toBeTruthy();
  });

  it("keeps local GitHub tiles gated while the initial desktop status is pending", () => {
    installDesktopApi({
      getGitHubIntegrationStatus: vi.fn(
        () => new Promise<GitHubIntegrationStatus | null>(() => {})
      ),
    });
    useDesktopAuthMock.mockReturnValue(authState());

    renderWithProvider(<ProviderProbe />);

    expect(screen.getByText(`local:${BranchKpiState.Gated}`)).toBeTruthy();
  });

  it("loads org scope independently when initial GitHub status fails", async () => {
    installDesktopApi({
      getGitHubIntegrationStatus: vi.fn(() =>
        Promise.reject(new Error("GitHub status unavailable"))
      ),
    });
    useDesktopAuthMock.mockReturnValue(authState());

    renderWithProvider(<ProviderProbe />);

    expect(await screen.findByText("scopes:me,org")).toBeTruthy();
    expect(screen.getByText(`local:${BranchKpiState.Gated}`)).toBeTruthy();
  });

  it("refreshes local GitHub tile gating after browser connect focus without remounting", async () => {
    let githubIntegrationStatus: GitHubIntegrationStatus | null = null;
    const getGitHubIntegrationStatus = vi.fn(
      async () => githubIntegrationStatus
    );
    const openGitHubConnect = vi.fn(async () => ({ ok: true }));
    installDesktopApi({ getGitHubIntegrationStatus, openGitHubConnect });
    useDesktopAuthMock.mockReturnValue(authState());

    renderWithProvider(<ProviderProbe />);

    expect(
      await screen.findByText(`local:${BranchKpiState.Gated}`)
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "connect" }));

    await waitFor(() => expect(openGitHubConnect).toHaveBeenCalledTimes(1));

    githubIntegrationStatus = legacyConnectedGitHubStatus();
    globalThis.dispatchEvent(new Event("focus"));

    expect(
      await screen.findByText(`local:${BranchKpiState.Available}`)
    ).toBeTruthy();
  });

  it("preserves the last known connected state when a focus refresh cannot load status", async () => {
    let githubIntegrationStatus: GitHubIntegrationStatus | null =
      legacyConnectedGitHubStatus();
    const getGitHubIntegrationStatus = vi.fn(
      async () => githubIntegrationStatus
    );
    installDesktopApi({ getGitHubIntegrationStatus });
    useDesktopAuthMock.mockReturnValue(authState());

    renderWithProvider(<ProviderProbe />);

    expect(
      await screen.findByText(`local:${BranchKpiState.Available}`)
    ).toBeTruthy();

    const callsBeforeFocus = getGitHubIntegrationStatus.mock.calls.length;
    githubIntegrationStatus = null;
    globalThis.dispatchEvent(new Event("focus"));

    await waitFor(() =>
      expect(getGitHubIntegrationStatus.mock.calls.length).toBeGreaterThan(
        callsBeforeFocus
      )
    );
    expect(screen.getByText(`local:${BranchKpiState.Available}`)).toBeTruthy();
  });

  it("invalidates insights when a focus refresh changes GitHub connection state", async () => {
    let githubIntegrationStatus: GitHubIntegrationStatus | null = {
      connected: false,
    };
    const getGitHubIntegrationStatus = vi.fn(
      async () => githubIntegrationStatus
    );
    installDesktopApi({ getGitHubIntegrationStatus });
    useDesktopAuthMock.mockReturnValue(authState());
    const queryClient = createQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderWithProvider(<ProviderProbe />, queryClient);

    expect(
      await screen.findByText(`local:${BranchKpiState.Gated}`)
    ).toBeTruthy();

    invalidateQueries.mockClear();
    githubIntegrationStatus = legacyConnectedGitHubStatus();
    globalThis.dispatchEvent(new Event("focus"));

    expect(
      await screen.findByText(`local:${BranchKpiState.Available}`)
    ).toBeTruthy();
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["github"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["insights"],
    });
  });

  it("ignores a stale disconnected refresh that resolves after a newer connected refresh", async () => {
    const staleDisconnectedStatus = createDeferredGitHubStatus();
    const connectedStatus = createDeferredGitHubStatus();
    const getGitHubIntegrationStatus = vi
      .fn<() => Promise<GitHubIntegrationStatus | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(staleDisconnectedStatus.promise)
      .mockReturnValueOnce(connectedStatus.promise);
    const openGitHubConnect = vi.fn(async () => ({ ok: true }));
    installDesktopApi({ getGitHubIntegrationStatus, openGitHubConnect });
    useDesktopAuthMock.mockReturnValue(authState());

    renderWithProvider(<ProviderProbe />);

    expect(
      await screen.findByText(`local:${BranchKpiState.Gated}`)
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "connect" }));

    await waitFor(() =>
      expect(getGitHubIntegrationStatus).toHaveBeenCalledTimes(3)
    );

    globalThis.dispatchEvent(new Event("focus"));

    await waitFor(() =>
      expect(getGitHubIntegrationStatus).toHaveBeenCalledTimes(4)
    );

    connectedStatus.resolve(legacyConnectedGitHubStatus());

    expect(
      await screen.findByText(`local:${BranchKpiState.Available}`)
    ).toBeTruthy();

    staleDisconnectedStatus.resolve({ connected: false });
    await staleDisconnectedStatus.promise;

    expect(screen.getByText(`local:${BranchKpiState.Available}`)).toBeTruthy();
  });

  it("marks org GitHub tiles available only when active provenance proves the payload", async () => {
    installDesktopApi();
    useDesktopAuthMock.mockReturnValue(authState());

    renderWithProvider(
      <ProviderProbe withPayloadAvailability withProvenance />
    );

    expect(
      await screen.findByText(`org:${BranchKpiState.Available}`)
    ).toBeTruthy();
  });

  it("lets explicit disconnected status override stale active org payload provenance", async () => {
    installDesktopApi({ githubIntegrationStatus: { connected: false } });
    useDesktopAuthMock.mockReturnValue(authState());

    renderWithProvider(
      <ProviderProbe withPayloadAvailability withProvenance />
    );

    expect(await screen.findByText(`org:${BranchKpiState.Gated}`)).toBeTruthy();
  });

  it("keeps org GitHub tiles gated when payload proof lacks active provenance", async () => {
    installDesktopApi();
    useDesktopAuthMock.mockReturnValue(authState());

    renderWithProvider(<ProviderProbe withPayloadAvailability />);

    expect(await screen.findByText(`org:${BranchKpiState.Gated}`)).toBeTruthy();
  });

  it("fails closed when desktop status payloads are malformed", async () => {
    installDesktopApi({
      apiKeyStatus: { value: true },
      runtimeStatus: { healthy: true },
    });
    useDesktopAuthMock.mockReturnValue(authState());

    renderWithProvider(<ProviderProbe />);

    expect(await screen.findByText("scopes:me")).toBeTruthy();
  });

  it("signs in before opening GitHub connect and invalidates provider queries on success", async () => {
    const openGitHubConnect = vi.fn(async () => ({ ok: true }));
    const beginSignIn = vi.fn(async () => ({ ok: true }));
    installDesktopApi({ openGitHubConnect });
    useDesktopAuthMock.mockReturnValue(
      authState({ state: { status: "signed-out" }, beginSignIn })
    );
    const queryClient = createQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderWithProvider(<ProviderProbe />, queryClient);

    fireEvent.click(await screen.findByRole("button", { name: "connect" }));

    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(1));
    expect(openGitHubConnect).toHaveBeenCalledWith({
      returnTo: "/insights",
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["github"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["insights"],
    });
  });

  it("does not invalidate provider queries when the connect IPC call rejects", async () => {
    const openGitHubConnect = vi.fn(() =>
      Promise.reject(new Error("GitHub connect unavailable"))
    );
    installDesktopApi({ openGitHubConnect });
    useDesktopAuthMock.mockReturnValue(authState());
    const queryClient = createQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderWithProvider(<ProviderProbe />, queryClient);

    fireEvent.click(await screen.findByRole("button", { name: "connect" }));

    await waitFor(() => expect(openGitHubConnect).toHaveBeenCalledTimes(1));
    invalidateQueries.mockClear();
    await waitFor(() => {
      expect(invalidateQueries).not.toHaveBeenCalled();
    });
  });

  it("opens GitHub install for a fresh org without an App installation", async () => {
    const openGitHubConnect = vi.fn(async () => ({ ok: true }));
    installDesktopApi({
      githubIntegrationStatus: {
        connected: false,
        githubDataConnection: {
          connected: false,
          sources: [],
          oauthRequiredReasons: [
            GitHubOAuthRequiredReason.NoAppInstallation,
            GitHubOAuthRequiredReason.NoUserGrant,
          ],
        },
      },
      openGitHubConnect,
    });
    useDesktopAuthMock.mockReturnValue(authState());

    renderWithProvider(<ProviderProbe />);

    fireEvent.click(await screen.findByRole("button", { name: "connect" }));

    await waitFor(() =>
      expect(openGitHubConnect).toHaveBeenCalledWith({
        install: true,
        returnTo: "/insights",
      })
    );
  });

  it("uses standard GitHub authorize for user-grant recovery states", async () => {
    const openGitHubConnect = vi.fn(async () => ({ ok: true }));
    installDesktopApi({
      githubIntegrationStatus: {
        connected: false,
        githubDataConnection: {
          connected: false,
          sources: [],
          oauthRequiredReasons: [
            GitHubOAuthRequiredReason.NoAppInstallation,
            GitHubOAuthRequiredReason.CredentialRevoked,
          ],
        },
      },
      openGitHubConnect,
    });
    useDesktopAuthMock.mockReturnValue(authState());

    renderWithProvider(<ProviderProbe />);

    fireEvent.click(await screen.findByRole("button", { name: "connect" }));

    await waitFor(() =>
      expect(openGitHubConnect).toHaveBeenCalledWith({
        returnTo: "/insights",
      })
    );
  });
});

function ProviderProbe({
  withPayloadAvailability = false,
  withProvenance = false,
}: {
  withPayloadAvailability?: boolean;
  withProvenance?: boolean;
}) {
  const source = useInsightsDataSource();
  const payloadAvailability = withPayloadAvailability
    ? { "kpi:merged": InsightsTileAvailabilityState.Available }
    : undefined;
  const payloadGitHubProvenance = withProvenance
    ? {
        checkedAt: "2026-07-06T00:00:00.000Z",
        state: InsightsGitHubProvenanceState.Active,
      }
    : undefined;
  const orgAvailability = source.getTileAvailability?.({
    tileId: "kpi:merged",
    section: InsightsSection.Delivery,
    scope: InsightsScope.Org,
    payloadAvailability,
    payloadGitHubProvenance,
  });
  const localAvailability = source.getTileAvailability?.({
    tileId: "kpi:merged",
    section: InsightsSection.Delivery,
    scope: InsightsScope.Me,
  });
  return (
    <div>
      <div>scopes:{source.availableScopes.join(",")}</div>
      <div>org:{orgAvailability?.state}</div>
      <div>local:{localAvailability?.state}</div>
      <button onClick={() => source.onConnectGitHub?.()} type="button">
        connect
      </button>
    </div>
  );
}

function renderWithProvider(
  children: ReactNode,
  queryClient = createQueryClient()
) {
  render(
    <QueryClientProvider client={queryClient}>
      <DesktopInsightsProvider>{children}</DesktopInsightsProvider>
    </QueryClientProvider>
  );
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function installDesktopApi({
  apiKeyStatus = { hasApiKey: true },
  githubIntegrationStatus = null,
  getGitHubIntegrationStatus = vi.fn(async () => githubIntegrationStatus),
  openGitHubConnect = vi.fn(async () => ({ ok: true })),
  runtimeStatus = { gatewayHealthy: true },
}: {
  apiKeyStatus?: unknown;
  githubIntegrationStatus?: Awaited<
    ReturnType<NonNullable<Window["desktopApi"]["getGitHubIntegrationStatus"]>>
  >;
  getGitHubIntegrationStatus?: ReturnType<typeof vi.fn>;
  openGitHubConnect?: ReturnType<typeof vi.fn>;
  runtimeStatus?: unknown;
} = {}) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      db: {
        getInsights: vi.fn(async () => ({ charts: {}, kpis: [] })),
      },
      getApiKeyStatus: vi.fn(async () => apiKeyStatus),
      getGitHubIntegrationStatus,
      getRuntimeStatus: vi.fn(async () => runtimeStatus),
      openGitHubConnect,
    },
  });
}

function legacyConnectedGitHubStatus(): GitHubIntegrationStatus {
  return {
    connected: true,
    installation: {
      accountLogin: "closedloop-ai",
      accountType: "Organization",
      claimedAt: "2026-07-06T00:00:00.000Z",
      createdAt: "2026-07-06T00:00:00.000Z",
      id: "github-installation-1",
      installationId: "12345",
      repositoryCount: 1,
      repositorySelection: "all",
      status: GitHubInstallationStatus.Active,
    },
  };
}

function createDeferredGitHubStatus(): {
  promise: Promise<GitHubIntegrationStatus | null>;
  resolve: (status: GitHubIntegrationStatus | null) => void;
} {
  let resolveStatus: (status: GitHubIntegrationStatus | null) => void =
    () => {};
  const promise = new Promise<GitHubIntegrationStatus | null>((resolve) => {
    resolveStatus = resolve;
  });
  return { promise, resolve: resolveStatus };
}

function authState(
  overrides: Partial<{
    beginSignIn: ReturnType<typeof vi.fn>;
    state: { status: string };
  }> = {}
) {
  return {
    beginSignIn: vi.fn(async () => ({ ok: true })),
    state: { status: "authenticated" },
    ...overrides,
  };
}
