import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudSocketError } from "../../../../shared/cloud-socket-error";
import { ConnectionSecurityMode } from "../../../../shared/connection-security";
import { DESKTOP_LABS_NAV_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags-labs-detail";
import {
  SYNC_LANE_IDS,
  SyncLaneDrainState,
  SyncLaneId,
} from "../../../../shared/sync-burndown-contract";
import { CloudStatusKind } from "../../../hooks/use-cloud-status";
import { DesktopAppPanel } from "../../../settings-v2/panels/desktop-app-panel";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import { desktopAppPanelMountReads } from "./desktop-app-panel-mount-reads";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

describe("Settings gateway health on Relay / Gateway", () => {
  it("updates an idle cloud socket to the visible missing-key failure after mount", async () => {
    vi.useFakeTimers();
    const api = installDesktopApi(
      { cloudStatus: { state: CloudStatusKind.Idle } },
      { cloudStatus: { state: CloudStatusKind.Idle } },
      {
        cloudStatus: {
          error: CloudSocketError.MissingApiKey,
          state: CloudStatusKind.Degraded,
        },
      }
    );

    renderPanel();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Idle")).toBeDefined();
    expect(screen.queryByText(CloudSocketError.MissingApiKey)).toBeNull();
    // One shared-poll read plus RelayGatewayTab's existing one-shot runtime
    // metadata read. The cloud-status hook shares the former with History Sync.
    expect(api.getRuntimeStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByText("Connection failed")).toBeDefined();
    expect(screen.getByText(CloudSocketError.MissingApiKey)).toBeDefined();
    expect(api.getRuntimeStatus).toHaveBeenCalledTimes(3);
  });

  it("shows the decrypt-failure reason when a stored key cannot be decrypted", async () => {
    vi.useFakeTimers();
    installDesktopApi(
      { cloudStatus: { state: CloudStatusKind.Idle } },
      {
        cloudStatus: {
          error: CloudSocketError.DecryptionFailed,
          state: CloudStatusKind.Degraded,
        },
      }
    );

    renderPanel();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Idle")).toBeDefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByText("Connection failed")).toBeDefined();
    expect(screen.getByText(CloudSocketError.DecryptionFailed)).toBeDefined();
  });

  // ISS-4715 made the main process report `disabled` for this, so the pairing
  // below is now a VERSION-SKEW case rather than the current shape: an older
  // main still sending `degraded` for a connection the user switched off. The
  // Desktop setting is checked first, so it still reads "Disabled" either way.
  it("labels a user-disabled degraded socket as disabled", async () => {
    const api = installDesktopApi({
      cloudStatus: {
        error: "Cloud connection disabled by user",
        state: CloudStatusKind.Degraded,
      },
    });
    api.getCloudConnectionEnabled.mockResolvedValue(false);

    renderPanel();

    expect(await screen.findByText("Disabled")).toBeDefined();
    expect(screen.queryByText("Connection failed")).toBeNull();
  });

  it("renders the healthy gateway rollup and its runtime details on Relay / Gateway", async () => {
    const api = installDesktopApi(
      { gatewayHealthy: true },
      {
        connectionSecurity: {
          detail: "Managed key with request signing is configured.",
          mode: ConnectionSecurityMode.Enhanced,
        },
        gatewayHealthy: true,
        port: 41_777,
      }
    );
    renderPanel();

    await awaitConnectionStatusSection();

    await waitFor(() => expect(api.getRuntimeStatus).toHaveBeenCalled());
    // The rollup, the port, and the security posture now sit in one section.
    expect(screen.getByText("Connected")).toBeDefined();
    expect(screen.getByText("41777")).toBeDefined();
    // ISS-5310: this cell was fed `runtimeStatus.security`, which the
    // GetRuntimeStatus IPC has never returned, so it rendered the "..."
    // placeholder forever while the real posture sat on `connectionSecurity` and
    // was shown only by the Labs card this change removes. It reads the real
    // field now — assert the detail, and assert the placeholder is gone, or the
    // regression comes straight back.
    expect(
      screen.getByText("Managed key with request signing is configured.")
    ).toBeDefined();
    expect(screen.queryByText("...")).toBeNull();
    // The card is gone from Labs — the rollup lives in exactly one place.
    expect(screen.queryByText("Gateway Health")).toBeNull();
  });

  it("renders needs-attention gateway status when reachable but unhealthy", async () => {
    installDesktopApi({}, { gatewayHealthy: false, serverAlive: true });
    renderPanel();

    await awaitConnectionStatusSection();

    expect(await screen.findByText("Needs Attention")).toBeDefined();
  });

  it("renders offline gateway status when the server is not alive", async () => {
    installDesktopApi({}, { gatewayHealthy: false, serverAlive: false });
    renderPanel();

    await awaitConnectionStatusSection();

    expect(await screen.findByText("Offline")).toBeDefined();
  });

  it.each([
    ["malformed metadata", "legacy-security-status", "..."],
    [
      "future metadata",
      { detail: "Future security mode is configured.", mode: "future_mode" },
      "Future security mode is configured.",
    ],
  ])(
    "keeps valid gateway health with %s",
    async (_name, connectionSecurity, expectedDetail) => {
      installDesktopApi(
        {},
        {
          connectionSecurity,
          gatewayHealthy: true,
          port: 41_777,
        }
      );
      renderPanel();

      await awaitConnectionStatusSection();

      expect(await screen.findByText("Connected")).toBeDefined();
      expect(screen.getByText("41777")).toBeDefined();
      expect(screen.getByText(expectedDetail)).toBeDefined();
    }
  );

  it.each([0, 65_536, "41777", Number.POSITIVE_INFINITY])(
    "omits invalid gateway port value %s",
    async (port) => {
      installDesktopApi(
        {},
        {
          connectionSecurity: {
            detail: "Managed key with request signing is configured.",
            mode: ConnectionSecurityMode.Enhanced,
          },
          gatewayHealthy: true,
          port,
        }
      );
      renderPanel();

      await awaitConnectionStatusSection();

      expect(await screen.findByText("Connected")).toBeDefined();
      expect(screen.queryByText(String(port))).toBeNull();
    }
  );

  it.each([
    ["missing payload", undefined],
    ["missing gatewayHealthy", {}],
    ["malformed payload", "not-a-runtime-status"],
    ["malformed gatewayHealthy", { gatewayHealthy: "true" }],
  ])("renders offline gateway status for %s", async (_name, runtimeStatus) => {
    installDesktopApi({}, runtimeStatus);
    renderPanel();

    await awaitConnectionStatusSection();

    expect(await screen.findByText("Offline")).toBeDefined();
  });

  it("renders offline gateway status when the Labs runtime read fails", async () => {
    const api = installDesktopApi({});
    api.getRuntimeStatus.mockRejectedValueOnce(new Error("status unavailable"));
    renderPanel();

    await awaitConnectionStatusSection();

    expect(await screen.findByText("Offline")).toBeDefined();
  });

  it.each([
    ["connected", { gatewayHealthy: true, port: 41_777 }, "Connected"],
    [
      "needs attention",
      { gatewayHealthy: false, serverAlive: true },
      "Needs Attention",
    ],
    ["offline", {}, "Offline"],
  ])(
    "keeps %s gateway status critical a11y and contrast clean in both themes",
    async (_name, runtimeStatus, expectedStatus) => {
      for (const theme of [A11yTheme.Light, A11yTheme.Dark]) {
        cleanup();
        installDesktopApi({}, runtimeStatus);

        const { container } = render(
          <A11yThemeRoot theme={theme}>
            {withAuthProviders(<DesktopAppPanel />)}
          </A11yThemeRoot>
        );

        await awaitConnectionStatusSection();

        await expectCriticalAxeClean(container);
        expectElementContrast(screen.getByText(expectedStatus), {
          background: themeBackground(theme),
          label: `gateway ${expectedStatus} ${theme}`,
        });
      }
    }
  );
});

// The panel's blocks read the auth, API, query and feature-flag ports, so all
// four must be present or the panel throws and nothing renders. The bare
// desktopApi stub omits the auth bridge, so auth settles signed-out. The
// adapter is inert: no block issues a remote request on this surface.
const inertApiAdapter: ApiAdapter = {
  resolveApiOrigin: () => "http://test.local",
  fetch: () => Promise.reject(new Error("no remote REST API in tests")),
};

function withAuthProviders(node: ReactElement): ReactElement {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <ApiAdapterProvider adapter={inertApiAdapter}>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            // ISS-5309: Labs sits behind the `labsNav` container gate, default
            // OFF. This suite is about what the gate reveals, not the gate, so
            // seed it open.
            enabledFlags: [DESKTOP_LABS_NAV_FEATURE_FLAG_KEY],
          })}
        >
          <DesktopAuthProvider>{node}</DesktopAuthProvider>
        </FeatureFlagAdapterProvider>
      </ApiAdapterProvider>
    </QueryClientProvider>
  );
}

function renderPanel(): void {
  render(withAuthProviders(<DesktopAppPanel />));
}

/**
 * ISS-5768: the History Sync cell must read the WHOLE-APP backlog off the live
 * runtime-status payload, not the session-lane-only `cloudSync.caughtUp`.
 *
 * This renders the real `DesktopAppPanel` against a real `getRuntimeStatus`
 * mock — no hook mocking — so it covers the production wiring end to end:
 * main-process payload key, `useCloudSyncBacklog`, `describeCloudSyncStatus`,
 * DOM. Replacing `useCloudSyncBacklog(active)` in `relay-gateway-tab.tsx` with
 * any fixed value fails the first case here.
 */
describe("Settings History Sync completeness (ISS-5768)", () => {
  /**
   * A settled row for every lane the burn-down reports, with the named lanes
   * overridden.
   *
   * `SyncBurndownReporter` builds all six lanes on every sample, and ISS-6206's
   * IPC boundary check requires every one of them — so a fixture naming one lane
   * is not a smaller real payload, it is one the renderer now rejects, and the
   * assertion below would be measuring the rejection instead of the verdict.
   */
  function lanesWith(
    overrides: Partial<Record<SyncLaneId, Record<string, unknown>>> = {}
  ): Record<string, unknown>[] {
    return SYNC_LANE_IDS.map((lane) => ({
      lane,
      state: SyncLaneDrainState.Drained,
      itemsRemaining: 0,
      itemsRemainingIsLowerBound: false,
      deadLetteredCount: 0,
      unmeasuredRows: 0,
      ...overrides[lane],
    }));
  }

  /** Every lane drained — the only shape that may render "Up to date". */
  const DRAINED_LANES = lanesWith();

  /**
   * The reported machine: session lanes drained and `caughtUp` true, while the
   * component inventory still owes 2,985 rows and the invocation-parts lane has
   * abandoned one item — in a lane `cloudSync` has no field for.
   */
  const REPORTED_LANES = lanesWith({
    [SyncLaneId.InvocationParts]: {
      state: SyncLaneDrainState.DrainedWithDeadLetters,
      deadLetteredCount: 1,
    },
    [SyncLaneId.ComponentInventory]: {
      state: SyncLaneDrainState.Draining,
      itemsRemaining: 2985,
    },
  });

  const CAUGHT_UP_SESSION_LANE = {
    identified: true,
    pendingBackfillSessions: 0,
    pendingIncrementalSessions: 0,
    backfilling: false,
    caughtUp: true,
    deadLetteredSessions: 0,
    deadLetteredComponents: 0,
  };

  function runtimeStatus(lanes: unknown[]): unknown {
    return {
      cloudStatus: { state: CloudStatusKind.Idle },
      cloudSync: CAUGHT_UP_SESSION_LANE,
      cloudReadReadiness: {
        sampledAtIso: "2026-08-10T12:00:00.000Z",
        importComplete: true,
        lanes,
      },
    };
  }

  it("refuses 'Up to date' while another lane still owes work", async () => {
    installDesktopApi(runtimeStatus(REPORTED_LANES));

    renderPanel();
    await awaitConnectionStatusSection();
    await waitFor(() => {
      expect(screen.getByText("Syncing (2,985 left)")).toBeDefined();
    });
    expect(screen.queryByText("Up to date")).toBeNull();
  });

  it("says 'Up to date' once every lane owes nothing", async () => {
    // The counterfactual: identical `cloudSync`, drained backlog. Without it the
    // assertion above could pass on copy that simply never renders.
    installDesktopApi(runtimeStatus(DRAINED_LANES));

    renderPanel();
    await awaitConnectionStatusSection();
    await waitFor(() => {
      expect(screen.getByText("Up to date")).toBeDefined();
    });
  });
});

/**
 * ISS-5310 (stage cid 3726701537): the gateway health rollup lives on Relay /
 * Gateway, folded into Connection Status. ISS-10246 moved that block onto the
 * tabless Desktop App panel, so there is no tab to select — but waiting on the
 * section title still keeps every "Offline" assertion a statement about the
 * health derivation rather than about a block that has not mounted yet.
 */
async function awaitConnectionStatusSection(): Promise<void> {
  await screen.findByText("Connection Status");
}

function installDesktopApi(...runtimeStatusResults: unknown[]): {
  getCloudConnectionEnabled: ReturnType<typeof vi.fn>;
  getSettings: ReturnType<typeof vi.fn>;
  getRuntimeStatus: ReturnType<typeof vi.fn>;
} {
  const getRuntimeStatus = vi.fn();
  const getSettings = vi.fn(async () => ({}));
  const getCloudConnectionEnabled = vi.fn(async () => true);
  for (const runtimeStatusResult of runtimeStatusResults) {
    getRuntimeStatus.mockResolvedValueOnce(runtimeStatusResult);
  }
  // FEA-3256: the Relay / Gateway block's History Sync cell polls
  // getRuntimeStatus on a shared 1s interval while visible, so the
  // finite mockResolvedValueOnce queue would otherwise drain and resolve
  // `undefined`. Repeat the last queued payload as the steady-state default.
  const steadyState = runtimeStatusResults.at(-1) ?? {};
  getRuntimeStatus.mockResolvedValue(steadyState);

  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      ...desktopAppPanelMountReads(),
      getSettings,
      getRuntimeStatus,
      getCloudConnectionEnabled,
      updateSettings: vi.fn(async () => undefined),
    },
  });

  return { getCloudConnectionEnabled, getRuntimeStatus, getSettings };
}
