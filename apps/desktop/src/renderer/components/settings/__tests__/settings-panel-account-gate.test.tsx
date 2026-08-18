import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import { SettingsPanel } from "../SettingsPanel";

// The unified Account tab reads GitHub status through the shared react-query
// hook, so mount the API + query ports. The adapter is inert: the signed-out
// account surface never issues the request (`enabled: false`), so no remote
// call is made.
const inertApiAdapter: ApiAdapter = {
  resolveApiOrigin: () => "http://test.local",
  fetch: () => Promise.reject(new Error("no remote REST API in tests")),
};

function installDesktopApi(settings: Record<string, unknown>) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getSettings: vi.fn(() => Promise.resolve(settings)),
      // The default relay-gateway tab mounts on render and reads runtime state.
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      getCloudCommandsPaused: vi.fn(() => Promise.resolve(false)),
      getCloudConnectionEnabled: vi.fn(() => Promise.resolve(true)),
      getAgentMonitorHooksEnabled: vi.fn(() => Promise.resolve(false)),
    },
  });
}

// The Account tab is selected by default, so its DesktopAccountTab mounts and
// reads `useDesktopAuth()` — wrap in the auth port. The bare desktopApi stub
// above omits the auth bridge, so auth settles signed-out and the tab renders
// its unified GitHub-first sign-in surface (the unified-auth-onboarding flow is
// always-on, FEA-3999).
function renderPanel(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ApiAdapterProvider adapter={inertApiAdapter}>
        <DesktopAuthProvider>
          <SettingsPanel />
        </DesktopAuthProvider>
      </ApiAdapterProvider>
    </QueryClientProvider>
  );
}

describe("SettingsPanel account tab (FEA-4133 always-on)", () => {
  it("always renders the Account tab regardless of prior gate settings", async () => {
    // FEA-4133: first-party desktop auth graduated to always-on. The Account tab
    // is no longer gated on any desktop setting — it renders unconditionally.
    installDesktopApi({});
    renderPanel();

    await screen.findByRole("tab", { name: "Account" });
    expect(screen.queryByRole("tab", { name: "Account" })).not.toBeNull();
  });

  it("selects the Account tab by default", async () => {
    installDesktopApi({});
    renderPanel();

    const accountTab = await screen.findByRole("tab", { name: "Account" });
    // The default lands on Account (the first tab), not Relay / Gateway.
    await waitFor(() =>
      expect(accountTab.getAttribute("aria-selected")).toBe("true")
    );
  });
});
