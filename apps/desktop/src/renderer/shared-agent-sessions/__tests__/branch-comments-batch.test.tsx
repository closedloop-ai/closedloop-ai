import { useTraceCommentsDataSource } from "@repo/app/shared/trace-comments/trace-comments-provider";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesktopAuthStatus,
  SyncObservabilityTier,
} from "../../../shared/contracts";
import { DesktopAppCoreMode } from "../desktop-app-core-mode";
import {
  DesktopAppCoreProvider,
  useDesktopAppCoreMode,
} from "../desktop-app-core-provider";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);
const originalOnline = Object.getOwnPropertyDescriptor(
  window.navigator,
  "onLine"
);

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  if (originalOnline) {
    Object.defineProperty(window.navigator, "onLine", originalOnline);
  } else {
    Reflect.deleteProperty(window.navigator, "onLine");
  }
});

describe("ISS-12282 desktop production comment source", () => {
  it.each([DesktopAppCoreMode.Cloud, DesktopAppCoreMode.Local])(
    "sends the batch through cloud IPC in %s mode",
    async (mode) => {
      const cloudApiFetch = vi.fn().mockResolvedValue({
        kind: "response",
        status: 200,
        statusText: "OK",
        headers: [["content-type", "application/json"]],
        bodyText: JSON.stringify({ success: true, data: [] }),
      });
      Object.defineProperty(window.navigator, "onLine", {
        configurable: true,
        value: mode === DesktopAppCoreMode.Cloud,
      });
      Object.defineProperty(window, "desktopApi", {
        configurable: true,
        value: {
          getDesktopAuthState: vi.fn().mockResolvedValue({
            status: DesktopAuthStatus.Authenticated,
            userId: "user-1",
            organizationId: "org-1",
          }),
          onDesktopAuthStateChanged: vi.fn(() => () => undefined),
          getSyncConsentRecord: vi.fn().mockResolvedValue({
            tier: SyncObservabilityTier.Full,
            organizationId: "org-1",
            bound: true,
          }),
          cloudApiFetch,
        },
      });
      const view = renderHook(
        () => ({
          source: useTraceCommentsDataSource(),
          mode: useDesktopAppCoreMode(),
        }),
        { wrapper: DesktopAppCoreProvider }
      );
      await waitFor(() => expect(view.result.current.mode).toBe(mode));
      const read = view.result.current.source.listBranchSessions;
      expect(read).toBeTypeOf("function");
      vi.spyOn(Date, "now").mockReturnValue(1000);
      await expect(read?.("branch-1", { timeoutMs: 5000 })).resolves.toEqual(
        []
      );
      expect(cloudApiFetch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          path: "/branches/branch-1/trace-comments?surface=branch_timeline&includeSessions=true",
          method: "GET",
          timeoutMs: 5000,
        })
      );
    }
  );
});
