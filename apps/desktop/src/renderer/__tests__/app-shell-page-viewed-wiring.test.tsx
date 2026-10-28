/**
 * ISS-10502 (#7748 review): pins the PRODUCTION `page_viewed` call site — the
 * shell's `useDesktopPageViewedEvent` wiring in `App.tsx`. The hook's own unit
 * suite drives a synthetic harness, so without this test deleting the App.tsx
 * block keeps every suite green (root AGENTS.md: a new helper owes an
 * assertion that its production caller invokes it). Chrome and route views are
 * mocked to light markers, exactly as `app-shell-live-route-switch.test.tsx`
 * does — routing/emission is under test, not the view internals.
 */

import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsPageName,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../shared/local-session-source-status";
import { DesktopNavigationApp } from "../App";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "../navigation/desktop-adapter";
import { DesktopAppCoreProvider } from "../shared-agent-sessions/desktop-app-core-provider";
import { setupReturningInstallStorage } from "./local-storage-fixture";

vi.mock("../components/UpdateBanner", () => ({ UpdateBanner: () => null }));
vi.mock("../components/desktop-session-expired-banner", () => ({
  DesktopSessionExpiredBanner: () => null,
}));
vi.mock("../components/desktop-sync-prompt", () => ({
  DesktopSyncPrompt: () => null,
}));
vi.mock("../components/opt-in-distributions-banner", () => ({
  OptInDistributionsBanner: () => null,
}));
vi.mock("../components/command-palette/command-palette", () => ({
  CommandPalette: () => null,
}));
vi.mock("../components/layout/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar-marker" />,
}));
vi.mock("../components/layout/Topbar", () => ({
  Topbar: () => <div data-testid="topbar-marker" />,
}));
vi.mock("../components/layout/mac-window-controls-underlay", () => ({
  MacWindowControlsUnderlay: () => null,
}));
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
  useFeatureFlagEnabledOptional: () => false,
}));
vi.mock("../components/sessions/SessionsView", () => ({
  SessionsView: () => <div data-testid="sessions-list-marker">list</div>,
}));
vi.mock("../components/branches/branches-view", () => ({
  BranchesView: () => <div data-testid="branches-list-marker">branches</div>,
}));
vi.mock("../components/dashboard/DashboardPage", () => ({
  DashboardPage: ({ isActive }: { isActive: boolean }) => (
    <div data-active={String(isActive)} data-testid="dashboard-list-marker" />
  ),
}));

const activeNavigations = new Set<DesktopNavigation>();
let desktopApiDescriptor: PropertyDescriptor | undefined;
let matchMediaDescriptor: PropertyDescriptor | undefined;
let resizeObserverDescriptor: PropertyDescriptor | undefined;

function installStubs() {
  matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
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
  resizeObserverDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver"
  );
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    },
  });
  desktopApiDescriptor = Object.getOwnPropertyDescriptor(window, "desktopApi");
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getAgentMonitorUrl: vi.fn(() =>
        Promise.resolve({
          localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
          ready: true,
        })
      ),
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      notifyRendererReady: vi.fn(),
      onDbChanged: vi.fn(() => () => undefined),
    },
  });
}

function restoreStub(descriptor: PropertyDescriptor | undefined, key: string) {
  if (descriptor) {
    Object.defineProperty(window, key, descriptor);
  } else {
    Reflect.deleteProperty(window, key);
  }
}

function renderShell(initialHash: string, capture: SurfaceAnalyticsCapture) {
  window.location.hash = initialHash;
  const navigation = createDesktopNavigation();
  activeNavigations.add(navigation);
  return render(
    <SurfaceAnalyticsProvider capture={capture} surface={Surface.Desktop}>
      <DesktopAppCoreProvider>
        <DesktopNavigationApp navigation={navigation} />
      </DesktopAppCoreProvider>
    </SurfaceAnalyticsProvider>
  );
}

async function navigateHash(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
}

function pageViewedNames(capture: ReturnType<typeof vi.fn>): unknown[] {
  return capture.mock.calls
    .filter(([event]) => event === OnboardingAnalyticsEvent.PageViewed)
    .map(([, properties]) => properties[OnboardingAnalyticsProperty.PageName]);
}

describe("App shell page_viewed wiring (ISS-10502)", () => {
  // The shell, not a first run: the guest landing replaces the shell when no
  // first-run key is stored.
  setupReturningInstallStorage();

  beforeEach(() => {
    installStubs();
  });

  afterEach(() => {
    for (const navigation of activeNavigations) {
      navigation.dispose();
    }
    activeNavigations.clear();
    cleanup();
    window.location.hash = "";
    restoreStub(desktopApiDescriptor, "desktopApi");
    if (matchMediaDescriptor) {
      Object.defineProperty(window, "matchMedia", matchMediaDescriptor);
    } else {
      Reflect.deleteProperty(window, "matchMedia");
    }
    if (resizeObserverDescriptor) {
      Object.defineProperty(
        globalThis,
        "ResizeObserver",
        resizeObserverDescriptor
      );
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
    desktopApiDescriptor = undefined;
    matchMediaDescriptor = undefined;
    resizeObserverDescriptor = undefined;
  });

  it("emits page_viewed from the shell on the landing page and again per nav switch", async () => {
    const capture = vi.fn<SurfaceAnalyticsCapture>();
    renderShell("#/sessions", capture);
    await screen.findByTestId("sessions-list-marker");

    expect(pageViewedNames(capture)).toEqual([
      OnboardingAnalyticsPageName.Sessions,
    ]);

    await navigateHash("#/branches");
    await screen.findByTestId("branches-list-marker");

    expect(pageViewedNames(capture)).toEqual([
      OnboardingAnalyticsPageName.Sessions,
      OnboardingAnalyticsPageName.Branches,
    ]);
  });

  it("deactivates the dashboard under Settings and reactivates it on close", async () => {
    const capture = vi.fn<SurfaceAnalyticsCapture>();
    renderShell("#/dashboard", capture);
    const dashboard = await screen.findByTestId("dashboard-list-marker");
    expect(dashboard.getAttribute("data-active")).toBe("true");

    await navigateHash("#/settings");
    expect(dashboard.getAttribute("data-active")).toBe("false");

    await navigateHash("#/dashboard");
    expect(dashboard.getAttribute("data-active")).toBe("true");
  });
});
