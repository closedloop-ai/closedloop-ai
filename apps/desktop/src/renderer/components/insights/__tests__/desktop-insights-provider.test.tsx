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
import { type ReactNode, useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { DesktopInsightsProvider } from "../desktop-insights-provider";

const {
  useDesktopAuthMock,
  useDesktopAppCoreModeMock,
  useApiClientMock,
  apiGetMock,
  getInsightsMock,
} = vi.hoisted(() => ({
  useDesktopAuthMock: vi.fn(),
  useDesktopAppCoreModeMock: vi.fn(),
  useApiClientMock: vi.fn(),
  apiGetMock: vi.fn(async () => ({ charts: {}, kpis: [] })),
  getInsightsMock: vi.fn(async () => ({ charts: {}, kpis: [] })),
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));

vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: useDesktopAppCoreModeMock,
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: useApiClientMock,
}));

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

describe("DesktopInsightsProvider source selection (PLN-1138 Phase 3)", () => {
  afterEach(resetMocks);

  it("authenticated + online (Cloud mode) exposes me and org", async () => {
    installDesktopApi();
    useDesktopAuthMock.mockReturnValue(authState());
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Cloud);

    renderWithProvider(<ScopesProbe />);

    expect(await screen.findByText("scopes:me,org")).toBeTruthy();
  });

  it("Cloud mode reads own-data (me scope) from the cloud, not local SQLite (PRD-461 D3)", async () => {
    installDesktopApi();
    useDesktopAuthMock.mockReturnValue(authState());
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Cloud);

    renderWithProvider(<InvokeReadsProbe scope={InsightsScope.Me} />);

    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(
        expect.stringContaining("/insights/delivery?period=30&scope=me")
      )
    );
    expect(apiGetMock).toHaveBeenCalledWith(
      expect.stringContaining("/insights/utilization?period=30&scope=me")
    );
    expect(apiGetMock).toHaveBeenCalledWith(
      expect.stringContaining("/insights/agents?period=30&scope=me")
    );
    // The D3 fix: authenticated own-data metrics must read the cloud, not local
    // SQLite. Delivery never touches the local DB in Cloud mode. (Agents and
    // Utilization each issue a best-effort local read to overlay one desktop-only
    // chart slice — the Autonomy Trend, FEA-3454, and the Event Activity heatmap
    // fallback, FEA-3684 — but the KPIs and every other slice still come from the
    // cloud, which is authoritative whenever it returns the slice.)
    expect(getInsightsMock).not.toHaveBeenCalledWith(
      InsightsSection.Delivery,
      "30",
      InsightsScope.Me
    );
  });

  it("Cloud mode (me scope) uses the cloud Event Activity heatmap when the cloud slice is populated (FEA-3684)", async () => {
    // FEA-3684: cloud /insights/utilization now computes activityHeatmap, and
    // cloud is authoritative when the slice is present — the best-effort local
    // read is issued but the populated cloud heatmap wins, so no fallback.
    const cloudHeatmap = {
      days: ["2026-07-01", "2026-07-02"],
      cells: [
        { day: "2026-07-01", hour: 9, human: 3, agent: 5 },
        { day: "2026-07-02", hour: 14, human: 1, agent: 8 },
      ],
    };
    apiGetMock.mockResolvedValue({
      kpis: [],
      charts: { activityHeatmap: cloudHeatmap },
    });
    // Local read returns a DIFFERENT populated heatmap; the cloud slice must win.
    getInsightsMock.mockResolvedValueOnce({
      kpis: [],
      charts: {
        activityHeatmap: {
          days: ["2026-07-01"],
          cells: [{ day: "2026-07-01", hour: 3, human: 99, agent: 99 }],
        },
      },
    });
    installDesktopApi();
    useDesktopAuthMock.mockReturnValue(authState());
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Cloud);

    renderWithProvider(<UtilizationHeatmapProbe scope={InsightsScope.Me} />);

    // Cloud heatmap (2 cells) wins over the local 1-cell fallback.
    expect(await screen.findByText("heatmap-cells:2")).toBeTruthy();
  });

  it("Cloud mode (me scope) falls back to the local Event Activity heatmap when the cloud slice is absent (deploy-window/legacy regression, FEA-3684)", async () => {
    // Deploy window: the request hits an OLDER/rolled-back cloud route (or a
    // legacy synced session yields no cells), so activityHeatmap is absent from
    // the cloud Utilization response. Without a fallback the card renders empty
    // even though the local session_turn_bucket table still holds the data — so
    // the best-effort local overlay must splice in the local heatmap.
    apiGetMock.mockResolvedValue({ kpis: [], charts: {} });
    const localHeatmap = {
      days: ["2026-07-01", "2026-07-02"],
      cells: [
        { day: "2026-07-01", hour: 9, human: 3, agent: 5 },
        { day: "2026-07-02", hour: 14, human: 1, agent: 8 },
        { day: "2026-07-02", hour: 15, human: 0, agent: 2 },
      ],
    };
    // One-shot local read (Utilization, for the overlay) — mockResolvedValueOnce
    // keeps this populated payload from leaking past resetMocks() into later tests.
    getInsightsMock.mockResolvedValueOnce({
      kpis: [],
      charts: { activityHeatmap: localHeatmap },
    });
    installDesktopApi();
    useDesktopAuthMock.mockReturnValue(authState());
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Cloud);

    renderWithProvider(<UtilizationHeatmapProbe scope={InsightsScope.Me} />);

    // The local 3-cell heatmap fills the empty cloud slice.
    expect(await screen.findByText("heatmap-cells:3")).toBeTruthy();
    // The fallback read is the Utilization section (best-effort local overlay).
    await waitFor(() =>
      expect(getInsightsMock).toHaveBeenCalledWith(
        InsightsSection.Utilization,
        "30",
        InsightsScope.Me
      )
    );
  });

  it("Cloud mode (me scope) overlays the local Autonomy Trend onto the cloud Agents response", async () => {
    // The autonomyTrend slice is desktop-only — the cloud /insights/agents route
    // never computes it (no cloud turn-level data), so authenticated desktop must
    // splice the local series in or the shared dashboard hides the Autonomy Trend
    // row. See FEA-3454 and the overlay helper.
    const localAutonomy = {
      series: [{ key: "autonomy", label: "Autonomy" }],
      points: [{ date: "2026-07-01", values: { autonomy: 42 } }],
    };
    // One-shot: cloud/me mode issues exactly one local read (Agents, for the
    // overlay). mockResolvedValueOnce keeps this populated payload from leaking
    // past resetMocks() (which only mockClear()s) into later tests.
    getInsightsMock.mockResolvedValueOnce({
      kpis: [],
      charts: { autonomyTrend: localAutonomy },
    });
    // Cloud omits the trend (empty payload) — the overlay must fill it.
    apiGetMock.mockResolvedValue({ kpis: [], charts: {} });
    installDesktopApi();
    useDesktopAuthMock.mockReturnValue(authState());
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Cloud);

    renderWithProvider(<AgentsAutonomyProbe scope={InsightsScope.Me} />);

    expect(await screen.findByText("autonomy-points:1")).toBeTruthy();
    // The local read that supplies the overlay was the Agents section only.
    await waitFor(() =>
      expect(getInsightsMock).toHaveBeenCalledWith(
        InsightsSection.Agents,
        "30",
        InsightsScope.Me
      )
    );
  });

  it("signed out / offline (Local mode) exposes only me and reads the local database", async () => {
    installDesktopApi();
    useDesktopAuthMock.mockReturnValue(
      authState({ state: { status: "signed-out" } })
    );
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Local);

    renderWithProvider(<InvokeReadsProbe scope={InsightsScope.Me} />);

    expect(await screen.findByText("scopes:me")).toBeTruthy();
    await waitFor(() =>
      expect(getInsightsMock).toHaveBeenCalledWith(
        InsightsSection.Delivery,
        "30",
        InsightsScope.Me
      )
    );
    expect(getInsightsMock).toHaveBeenCalledWith(
      InsightsSection.Utilization,
      "30",
      InsightsScope.Me
    );
    expect(getInsightsMock).toHaveBeenCalledWith(
      InsightsSection.Agents,
      "30",
      InsightsScope.Me
    );
    // Local mode must not touch the cloud read path.
    expect(apiGetMock).not.toHaveBeenCalled();
  });
});

describe("DesktopInsightsProvider tile availability — Local mode", () => {
  afterEach(resetMocks);

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
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Local);

    renderWithProvider(<TileProbe />);

    expect(
      await screen.findByText(`local:${BranchKpiState.Available}`)
    ).toBeTruthy();
  });

  it("falls back to legacy connected status when the data-connection field is omitted", async () => {
    installDesktopApi({
      githubIntegrationStatus: legacyConnectedGitHubStatus(),
    });
    useDesktopAuthMock.mockReturnValue(authState());
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Local);

    renderWithProvider(<TileProbe />);

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
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Local);

    renderWithProvider(<TileProbe />);

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
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Local);

    renderWithProvider(<TileProbe />);

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
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Local);

    renderWithProvider(<TileProbe />);

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

  it("ignores a stale disconnected refresh that resolves after a newer connected refresh", async () => {
    const staleDisconnectedStatus = createDeferredGitHubStatus();
    const connectedStatus = createDeferredGitHubStatus();
    // getGitHubIntegrationStatus is called: once on mount (refresh), twice by the
    // connect flow (install pre-flight + post-connect refresh), once by the focus
    // refresh. The last two returns are deferred so the newer (focus) resolves
    // before the older (post-connect) — the stale sequence must be ignored.
    const getGitHubIntegrationStatus = vi
      .fn<() => Promise<GitHubIntegrationStatus | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(staleDisconnectedStatus.promise)
      .mockReturnValueOnce(connectedStatus.promise);
    const openGitHubConnect = vi.fn(async () => ({ ok: true }));
    installDesktopApi({ getGitHubIntegrationStatus, openGitHubConnect });
    useDesktopAuthMock.mockReturnValue(authState());
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Local);

    renderWithProvider(<TileProbe />);

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
});

describe("DesktopInsightsProvider tile availability — Cloud mode", () => {
  afterEach(resetMocks);

  it("marks org GitHub tiles available only when active provenance proves the payload", async () => {
    installDesktopApi();
    useDesktopAuthMock.mockReturnValue(authState());
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Cloud);

    renderWithProvider(<TileProbe withPayloadAvailability withProvenance />);

    expect(
      await screen.findByText(`org:${BranchKpiState.Available}`)
    ).toBeTruthy();
  });

  it("lets explicit disconnected status override stale active org payload provenance", async () => {
    installDesktopApi({ githubIntegrationStatus: { connected: false } });
    useDesktopAuthMock.mockReturnValue(authState());
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Cloud);

    renderWithProvider(<TileProbe withPayloadAvailability withProvenance />);

    expect(await screen.findByText(`org:${BranchKpiState.Gated}`)).toBeTruthy();
  });

  it("keeps org GitHub tiles gated when payload proof lacks active provenance", async () => {
    installDesktopApi();
    useDesktopAuthMock.mockReturnValue(authState());
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Cloud);

    renderWithProvider(<TileProbe withPayloadAvailability />);

    expect(await screen.findByText(`org:${BranchKpiState.Gated}`)).toBeTruthy();
  });

  it("marks me GitHub tiles available from the cloud payload even when the local GitHub App is disconnected (FEA-3721)", async () => {
    // Production regression: in authenticated Cloud mode the `me`-scope cloud
    // /insights/delivery response already carries populated GitHub delivery
    // values plus per-tile availability (merged/merge-rate), but the desktop
    // used to force `me` tiles to the Local sourceKind and re-gate them on the
    // LOCAL GitHub App connection — rendering populated cloud KPIs as 0/blank.
    // The local connection is explicitly NOT connected here; the tiles must
    // still resolve Available by trusting the cloud payload, exactly like org.
    installDesktopApi({ githubIntegrationStatus: { connected: false } });
    useDesktopAuthMock.mockReturnValue(authState());
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Cloud);

    renderWithProvider(<TileProbe withMePayloadAvailability />);

    expect(
      await screen.findByText(`local:${BranchKpiState.Available}`)
    ).toBeTruthy();
  });
});

describe("DesktopInsightsProvider GitHub connect", () => {
  afterEach(resetMocks);

  it("invalidates insights when a focus refresh changes GitHub connection state", async () => {
    let githubIntegrationStatus: GitHubIntegrationStatus | null = {
      connected: false,
    };
    const getGitHubIntegrationStatus = vi.fn(
      async () => githubIntegrationStatus
    );
    installDesktopApi({ getGitHubIntegrationStatus });
    useDesktopAuthMock.mockReturnValue(authState());
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Local);
    const queryClient = createQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderWithProvider(<TileProbe />, queryClient);

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

  it("signs in before opening GitHub connect and invalidates provider queries on success", async () => {
    const openGitHubConnect = vi.fn(async () => ({ ok: true }));
    const beginSignIn = vi.fn(async () => ({ ok: true }));
    installDesktopApi({ openGitHubConnect });
    useDesktopAuthMock.mockReturnValue(
      authState({ state: { status: "signed-out" }, beginSignIn })
    );
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Local);
    const queryClient = createQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderWithProvider(<TileProbe />, queryClient);

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
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Cloud);
    const queryClient = createQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderWithProvider(<TileProbe />, queryClient);

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
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Cloud);

    renderWithProvider(<TileProbe />);

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
    useDesktopAppCoreModeMock.mockReturnValue(DesktopAppCoreMode.Cloud);

    renderWithProvider(<TileProbe />);

    fireEvent.click(await screen.findByRole("button", { name: "connect" }));

    await waitFor(() =>
      expect(openGitHubConnect).toHaveBeenCalledWith({
        returnTo: "/insights",
      })
    );
  });
});

function resetMocks() {
  vi.restoreAllMocks();
  useDesktopAuthMock.mockReset();
  useDesktopAppCoreModeMock.mockReset();
  useApiClientMock.mockReset();
  useApiClientMock.mockReturnValue({ get: apiGetMock });
  apiGetMock.mockClear();
  getInsightsMock.mockClear();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
}

function ScopesProbe() {
  const source = useInsightsDataSource();
  return <div>scopes:{source.availableScopes.join(",")}</div>;
}

function InvokeReadsProbe({ scope }: { scope: InsightsScope }) {
  const source = useInsightsDataSource();
  useEffect(() => {
    Promise.all([
      source.getDelivery("30", scope),
      source.getUtilization("30", scope),
      source.getAgents("30", scope),
    ]).catch(() => undefined);
  }, [source, scope]);
  return <div>scopes:{source.availableScopes.join(",")}</div>;
}

function UtilizationHeatmapProbe({ scope }: { scope: InsightsScope }) {
  const source = useInsightsDataSource();
  const [cellCount, setCellCount] = useState<number | null>(null);
  useEffect(() => {
    source
      .getUtilization("30", scope)
      .then((response) =>
        setCellCount(response.charts.activityHeatmap?.cells.length ?? 0)
      )
      .catch(() => setCellCount(-1));
  }, [source, scope]);
  return <div>heatmap-cells:{cellCount === null ? "pending" : cellCount}</div>;
}

function AgentsAutonomyProbe({ scope }: { scope: InsightsScope }) {
  const source = useInsightsDataSource();
  const [pointCount, setPointCount] = useState<number | null>(null);
  useEffect(() => {
    source
      .getAgents("30", scope)
      .then((response) =>
        setPointCount(response.charts.autonomyTrend?.points.length ?? 0)
      )
      .catch(() => setPointCount(-1));
  }, [source, scope]);
  return (
    <div>autonomy-points:{pointCount === null ? "pending" : pointCount}</div>
  );
}

function TileProbe({
  withPayloadAvailability = false,
  withProvenance = false,
  withMePayloadAvailability = false,
}: {
  withPayloadAvailability?: boolean;
  withProvenance?: boolean;
  withMePayloadAvailability?: boolean;
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
  // FEA-3721: in Cloud mode the `me` cloud response carries per-tile
  // `payloadAvailability` (buildDeliveryTileAvailability is scope-independent)
  // and NO `githubProvenance` (that is org-only). This mirrors the shared
  // dashboard, which threads `sections[tile.section].tileAvailability` into the
  // `me` availability call.
  const meAvailability = source.getTileAvailability?.({
    tileId: "kpi:merged",
    section: InsightsSection.Delivery,
    scope: InsightsScope.Me,
    payloadAvailability: withMePayloadAvailability
      ? {
          "kpi:merged": InsightsTileAvailabilityState.Available,
          "kpi:merge-rate": InsightsTileAvailabilityState.Available,
        }
      : undefined,
  });
  return (
    <div>
      <div>scopes:{source.availableScopes.join(",")}</div>
      <div>org:{orgAvailability?.state}</div>
      <div>local:{meAvailability?.state}</div>
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
  githubIntegrationStatus = null,
  getGitHubIntegrationStatus = vi.fn(async () => githubIntegrationStatus),
  openGitHubConnect = vi.fn(async () => ({ ok: true })),
}: {
  githubIntegrationStatus?: Awaited<
    ReturnType<NonNullable<Window["desktopApi"]["getGitHubIntegrationStatus"]>>
  >;
  getGitHubIntegrationStatus?: ReturnType<typeof vi.fn>;
  openGitHubConnect?: ReturnType<typeof vi.fn>;
} = {}) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      db: {
        getInsights: getInsightsMock,
      },
      getGitHubIntegrationStatus,
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
