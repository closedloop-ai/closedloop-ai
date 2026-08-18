import type { AgentSessionListResponse } from "@repo/api/src/types/agent-session";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { type Deferred, deferred } from "../../../test/deferred.js";
import { DESKTOP_LABS_NAV_FEATURE_FLAG_KEY } from "../../shared/feature-flags";
import { DesktopNavigationApp } from "../App";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "../navigation/desktop-adapter";
import { DesktopAppCoreProvider } from "../shared-agent-sessions/desktop-app-core-provider";

const analyticsModuleState = vi.hoisted(() => ({
  loadCount: 0,
  renderCount: 0,
}));

vi.mock(
  "@repo/app/agents/components/analytics/agent-telemetry-analytics",
  () => {
    analyticsModuleState.loadCount += 1;
    return {
      AgentTelemetryAnalytics: () => {
        analyticsModuleState.renderCount += 1;
        return (
          <div data-testid="mock-agent-telemetry-analytics">
            Loaded analytics module
          </div>
        );
      },
    };
  }
);

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

const activeNavigations = new Set<DesktopNavigation>();

describe("Insights route initial navigation", () => {
  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: false,
        media: "",
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
  });

  beforeEach(() => {
    analyticsModuleState.loadCount = 0;
    analyticsModuleState.renderCount = 0;
    installDesktopApi(deferred<AgentSessionListResponse>());
  });

  afterEach(() => {
    for (const navigation of activeNavigations) {
      navigation.dispose();
    }
    activeNavigations.clear();
    cleanup();
    window.location.hash = "";
  });

  it("renders the desktop shell before importing shared analytics", async () => {
    const listDeferred = deferred<AgentSessionListResponse>();
    installDesktopApi(listDeferred);
    await renderDesktopApp("#/insights");

    // ISS-5037: Insights is a Labs destination, so the first frame at this URL
    // is the container gate's HOLD — and the hold deliberately renders the
    // destination's own PageShell + title, which is the whole point (the flag
    // resolving open must be a no-op on screen). That makes the "Insights"
    // heading true of BOTH the hold and the loaded page, so waiting on the
    // heading does not prove the page mounted. Wait on the view's own opt-in
    // copy, which only the real Insights view renders — the same unambiguous
    // mount signal `app-shell.test.tsx` uses for this route.
    expect(
      await screen.findByRole("heading", { name: "Insights" })
    ).toBeDefined();
    // Explicit timeout: this file configures no `asyncUtilTimeout`, so the
    // default is 1s — too tight for a wait that spans flag hydration AND the
    // lazy route import under CI CPU contention (`app-shell.test.tsx` gives the
    // same sentinel 15s for that reason). 5s matches the list() wait below and
    // stays well inside this test's 15s budget.
    expect(
      await screen.findByText("Local session history", undefined, {
        timeout: 5000,
      })
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Load insights" })).toBeDefined();
    expect(analyticsModuleState.loadCount).toBe(0);
    expect(analyticsModuleState.renderCount).toBe(0);
    expect(window.desktopApi.agentSessionsApi.list).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.analytics).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Load insights" }));

    // The lazy bounded-view chunk mounting fires the list() IPC call; that call
    // is the robust mount signal (FEA-3989 removed the "Recent session activity"
    // card heading that formerly signaled mount). Wait for it rather than a
    // rendered string that can lag chunk resolution under CI parallelism.
    await vi.waitFor(
      () =>
        expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith({
          limit: 25,
          offset: 0,
        }),
      { timeout: 5000 }
    );

    // While the deferred list() is unresolved, the bounded view shows its
    // in-progress state.
    expect(await screen.findByText("Loading recent sessions...")).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.analytics).not.toHaveBeenCalled();
    expect(analyticsModuleState.loadCount).toBe(0);
    expect(analyticsModuleState.renderCount).toBe(0);

    listDeferred.resolve({ items: [], total: 0, viewerScope: "self" });
    expect(await screen.findByText("No synced sessions found.")).toBeDefined();
  }, 15_000);
});

function renderDesktopApp(initialHash: string) {
  window.location.hash = initialHash;
  const navigation = createDesktopNavigation();
  activeNavigations.add(navigation);
  return render(
    <DesktopAppCoreProvider>
      <DesktopNavigationApp navigation={navigation} />
    </DesktopAppCoreProvider>
  );
}

function installDesktopApi(listDeferred: Deferred<AgentSessionListResponse>) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: {
        analytics: vi.fn(),
        detail: vi.fn(),
        list: vi.fn(() => listDeferred.promise),
        usage: vi.fn(),
      },
      db: {
        getSubAgents: vi.fn(),
        getTools: vi.fn(),
        getWorkflowData: vi.fn(),
      },
      getRuntimeStatus: vi.fn(() => new Promise(() => {})),
      // ISS-5037: Insights displays under the Labs section, which is behind
      // the default-OFF `labsNav` container gate. This suite is about the
      // route's lazy-loading behavior, so open the gate.
      getAllFlags: vi.fn(() =>
        Promise.resolve({
          flags: [{ key: DESKTOP_LABS_NAV_FEATURE_FLAG_KEY, value: true }],
        })
      ),
    },
  });
}
