import type { AgentSessionListResponse } from "@repo/api/src/types/agent-session";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
    installDesktopApi(createDeferred<AgentSessionListResponse>());
  });

  afterEach(() => {
    for (const navigation of activeNavigations) {
      navigation.dispose();
    }
    activeNavigations.clear();
    window.location.hash = "";
  });

  it("renders the desktop shell before importing shared analytics", async () => {
    const listDeferred = createDeferred<AgentSessionListResponse>();
    installDesktopApi(listDeferred);
    await renderDesktopApp("#/insights");

    expect(
      await screen.findByRole("heading", { name: "Agent Monitoring" })
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Load insights" })).toBeDefined();
    expect(analyticsModuleState.loadCount).toBe(0);
    expect(analyticsModuleState.renderCount).toBe(0);
    expect(window.desktopApi.agentSessionsApi.list).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.analytics).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Load insights" }));

    expect(
      await screen.findByText("Recent session activity", {}, { timeout: 5000 })
    ).toBeDefined();
    expect(screen.getByText("Loading recent sessions...")).toBeDefined();
    // The list() IPC call is dispatched from an effect that can lag the
    // "Recent session activity" render under CI parallelism — wait for it
    // rather than asserting synchronously (was an intermittent CI flake).
    await vi.waitFor(() =>
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
      })
    );
    expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.analytics).not.toHaveBeenCalled();
    expect(analyticsModuleState.loadCount).toBe(0);
    expect(analyticsModuleState.renderCount).toBe(0);

    listDeferred.resolve({ items: [], total: 0, viewerScope: "self" });
    expect(await screen.findByText("No synced sessions found.")).toBeDefined();
  });
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
      getAllFlags: vi.fn(() => Promise.resolve({ flags: [] })),
    },
  });
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
