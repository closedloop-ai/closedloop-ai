import { useRealtimeClient } from "@repo/app/shared/realtime/realtime-provider";
import { RealtimeStatus } from "@repo/realtime-client/port";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesktopAuthStatus,
  SyncObservabilityTier,
} from "../../../shared/contracts";
import { DesktopAppCoreProvider } from "../../shared-agent-sessions/desktop-app-core-provider";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";

/**
 * PLN-2162 M4: the realtime port is only worth anything if the Cloud-mode
 * stack mounts it. Driven through `DesktopAppCoreProvider`, so removing the
 * provider from the stack reds this.
 */

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("DesktopAppCoreProvider realtime port (PLN-2162 M4)", () => {
  it("mounts the IPC port in Cloud mode", async () => {
    stubDesktopApi(DesktopAuthStatus.Authenticated);

    const { result } = renderHook(() => useRealtimeClient(), {
      wrapper: DesktopAppCoreProvider,
    });

    await waitFor(() => expect(result.current).not.toBeNull());
  });

  it("mounts none while signed out", async () => {
    const realtime = stubDesktopApi(DesktopAuthStatus.SignedOut);

    const { result } = renderHook(
      () => ({
        client: useRealtimeClient(),
        authStatus: useDesktopAuth().state.status,
      }),
      { wrapper: DesktopAppCoreProvider }
    );

    await waitFor(() =>
      expect(result.current.authStatus).toBe(DesktopAuthStatus.SignedOut)
    );
    expect(realtime.onEvent).not.toHaveBeenCalled();
    expect(result.current.client).toBeNull();
  });
});

function stubDesktopApi(status: DesktopAuthStatus) {
  const realtime = {
    join: vi.fn(() =>
      Promise.resolve({ status: RealtimeStatus.Connecting, joined: false })
    ),
    leave: vi.fn(() => Promise.resolve()),
    onEvent: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDesktopAuthState: () =>
        Promise.resolve({
          status,
          userId: status === DesktopAuthStatus.Authenticated ? "user-1" : null,
          organizationId:
            status === DesktopAuthStatus.Authenticated ? "org-1" : null,
        }),
      onDesktopAuthStateChanged: () => () => undefined,
      getSyncConsentRecord: () =>
        Promise.resolve({
          tier: SyncObservabilityTier.Full,
          organizationId: "org-1",
          bound: true,
        }),
      getRuntimeStatus: () => Promise.resolve({}),
      realtime,
    },
    writable: true,
  });
  return realtime;
}
