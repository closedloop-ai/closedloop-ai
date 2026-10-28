import {
  SettingsLocalDeviceReason,
  SettingsLocalDeviceStatus,
} from "@repo/api/src/types/settings-host-capabilities";
import { useSettingsHostAdapter } from "@repo/app/shared/settings-host/provider";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { DesktopAppCoreProvider } from "../../shared-agent-sessions/desktop-app-core-provider";

/**
 * ISS-8379: the port is only worth anything if the desktop shell actually mounts
 * it. Without this, deleting the `SettingsHostAdapterProvider` from the core
 * provider would leave every adapter suite green while every Settings surface on
 * desktop silently fell back to the WEB adapter and reported its own host as
 * "web" — the one thing the port exists to get right.
 */

const DEVICE = {
  machineName: "workshop-mini",
  platform: "darwin",
  appVersion: "1.2.3",
  gatewayPort: 41_234,
  gatewayReachable: true,
  computeTargetId: "ct-01",
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function stubDesktopApi(value: Record<string, unknown>): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDesktopAuthState: () =>
        Promise.resolve({
          status: DesktopAuthStatus.Authenticated,
          userId: "user-1",
          organizationId: "org-1",
        }),
      onDesktopAuthStateChanged: () => () => {
        // no auth transitions in this suite
      },
      getSyncConsentRecord: () =>
        Promise.resolve({
          tier: "full",
          organizationId: "org-1",
          bound: true,
        }),
      getRuntimeStatus: () => Promise.resolve({}),
      ...value,
    },
    writable: true,
  });
}

beforeEach(() => {
  stubDesktopApi({
    getSettingsLocalDevice: () => Promise.resolve({ ...DEVICE }),
  });
});

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("DesktopAppCoreProvider settings host port (ISS-8379)", () => {
  it("mounts the desktop adapter, and it reads through the real bridge", async () => {
    const { result } = renderHook(() => useSettingsHostAdapter(), {
      wrapper: DesktopAppCoreProvider,
    });

    await waitFor(() => expect(result.current.host).toBe("desktop"));
    await expect(result.current.readLocalDevice()).resolves.toEqual({
      status: SettingsLocalDeviceStatus.Ready,
      snapshot: DEVICE,
    });
  });

  it("still reports the desktop host when the bridge method is missing", async () => {
    // A version-skewed install: the shell is desktop, so the panel must be told
    // "desktop, device unavailable" rather than silently reading as the web app.
    stubDesktopApi({});

    const { result } = renderHook(() => useSettingsHostAdapter(), {
      wrapper: DesktopAppCoreProvider,
    });

    await waitFor(() => expect(result.current.host).toBe("desktop"));
    await expect(result.current.readLocalDevice()).resolves.toEqual({
      status: SettingsLocalDeviceStatus.Unavailable,
      reason: SettingsLocalDeviceReason.BridgeUnavailable,
    });
  });
});
