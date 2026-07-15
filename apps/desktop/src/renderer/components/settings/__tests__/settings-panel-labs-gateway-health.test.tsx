import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionSecurityMode } from "../../../../shared/connection-security";
import { SettingsPanel } from "../SettingsPanel";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  cleanup();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

describe("SettingsPanel Labs gateway health", () => {
  it("reads gateway health only after Labs activation and renders healthy runtime details", async () => {
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
    render(<SettingsPanel />);

    await waitFor(() => expect(api.getRuntimeStatus).toHaveBeenCalledTimes(1));

    await openLabsTab();

    await waitFor(() => expect(api.getRuntimeStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Gateway Health")).toBeDefined();
    expect(screen.getByText("Connected")).toBeDefined();
    expect(screen.getByText("41777")).toBeDefined();
    expect(
      screen.getByText("Managed key with request signing is configured.")
    ).toBeDefined();
  });

  it("renders needs-attention gateway status when reachable but unhealthy", async () => {
    installDesktopApi({}, { gatewayHealthy: false, serverAlive: true });
    render(<SettingsPanel />);

    await openLabsTab();

    expect(await screen.findByText("Needs Attention")).toBeDefined();
  });

  it("renders offline gateway status when the server is not alive", async () => {
    installDesktopApi({}, { gatewayHealthy: false, serverAlive: false });
    render(<SettingsPanel />);

    await openLabsTab();

    expect(await screen.findByText("Offline")).toBeDefined();
  });

  it.each([
    ["malformed metadata", "legacy-security-status", undefined],
    [
      "future metadata",
      { detail: "Future security mode is configured.", mode: "future_mode" },
      "Future security mode is configured.",
    ],
  ])("keeps valid gateway health with %s", async (_name, connectionSecurity, expectedDetail) => {
    installDesktopApi(
      {},
      {
        connectionSecurity,
        gatewayHealthy: true,
        port: 41_777,
      }
    );
    render(<SettingsPanel />);

    await openLabsTab();

    expect(await screen.findByText("Connected")).toBeDefined();
    expect(screen.getByText("41777")).toBeDefined();
    if (expectedDetail) {
      expect(screen.getByText(expectedDetail)).toBeDefined();
    }
  });

  it.each([
    0,
    65_536,
    "41777",
    Number.POSITIVE_INFINITY,
  ])("omits invalid gateway port value %s", async (port) => {
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
    render(<SettingsPanel />);

    await openLabsTab();

    expect(await screen.findByText("Connected")).toBeDefined();
    expect(screen.queryByText(String(port))).toBeNull();
  });

  it.each([
    ["missing payload", undefined],
    ["missing gatewayHealthy", {}],
    ["malformed payload", "not-a-runtime-status"],
    ["malformed gatewayHealthy", { gatewayHealthy: "true" }],
  ])("renders offline gateway status for %s", async (_name, runtimeStatus) => {
    installDesktopApi({}, runtimeStatus);
    render(<SettingsPanel />);

    await openLabsTab();

    expect(await screen.findByText("Offline")).toBeDefined();
  });

  it("renders offline gateway status when the Labs runtime read fails", async () => {
    const api = installDesktopApi({});
    api.getRuntimeStatus.mockRejectedValueOnce(new Error("status unavailable"));
    render(<SettingsPanel />);

    await openLabsTab();

    expect(await screen.findByText("Offline")).toBeDefined();
  });

  // FEA-2829: the Labs panel is driven by the shared feature-flag registry
  // (FEATURE_FLAGS) rather than a hand-rolled list, so every user-facing flag —
  // including newly-added ones like Transcript Sync (FEA-2715) — renders without
  // a second edit, while `hiddenFromLabs` flags (shared UI flags and flags that
  // already have a dedicated control elsewhere) stay out of the panel.
  it("renders registry flags and hides hiddenFromLabs flags", async () => {
    installDesktopApi({ gatewayHealthy: true }, { gatewayHealthy: true });
    render(<SettingsPanel />);

    await openLabsTab();

    // Newly-surfaced registry flags that the old hand-rolled list omitted.
    expect(await screen.findByText("Transcript Sync")).toBeDefined();
    expect(screen.getByText("Auto-Update & Restart")).toBeDefined();
    expect(screen.getByText("Session Completion Notifications")).toBeDefined();
    // `hiddenFromLabs`: the shared kebab-case UI flag has no Labs toggle...
    expect(screen.queryByText("Collapsible Comments Rail")).toBeNull();
    // ...and Cloud flags owned by the Relay/Gateway tab are not duplicated here
    // ("Pause Remote Commands" is the registry label for `cloudCommandsPaused`).
    expect(screen.queryByText("Pause Remote Commands")).toBeNull();
  });

  it.each([
    ["connected", { gatewayHealthy: true, port: 41_777 }, "Connected"],
    [
      "needs attention",
      { gatewayHealthy: false, serverAlive: true },
      "Needs Attention",
    ],
    ["offline", {}, "Offline"],
  ])("keeps %s gateway status critical a11y and contrast clean in both themes", async (_name, runtimeStatus, expectedStatus) => {
    for (const theme of [A11yTheme.Light, A11yTheme.Dark]) {
      cleanup();
      installDesktopApi({}, runtimeStatus);

      const { container } = render(
        <A11yThemeRoot theme={theme}>
          <SettingsPanel />
        </A11yThemeRoot>
      );

      await openLabsTab();

      await expectCriticalAxeClean(container);
      expectElementContrast(screen.getByText(expectedStatus), {
        background: themeBackground(theme),
        label: `gateway ${expectedStatus} ${theme}`,
      });
    }
  });
});

async function openLabsTab(): Promise<void> {
  const labsTab = await screen.findByRole("tab", { name: "Labs" });
  act(() => {
    window.dispatchEvent(
      new CustomEvent("desktop:navigate-settings-tab", { detail: "labs" })
    );
  });
  await waitFor(() => {
    expect(labsTab.getAttribute("aria-selected")).toBe("true");
  });
  await screen.findByText("Gateway Health");
}

function installDesktopApi(...runtimeStatusResults: unknown[]): {
  getRuntimeStatus: ReturnType<typeof vi.fn>;
} {
  const getRuntimeStatus = vi.fn();
  for (const runtimeStatusResult of runtimeStatusResults) {
    getRuntimeStatus.mockResolvedValueOnce(runtimeStatusResult);
  }

  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getSettings: vi.fn(async () => ({})),
      getRuntimeStatus,
      getCloudCommandsPaused: vi.fn(async () => false),
      getCloudConnectionEnabled: vi.fn(async () => true),
      getAgentMonitorHooksEnabled: vi.fn(async () => false),
      updateSettings: vi.fn(async () => undefined),
    },
  });

  return { getRuntimeStatus };
}
