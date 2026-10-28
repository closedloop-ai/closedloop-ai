import { useUndoStackOptional } from "@repo/app/undo/hooks/use-undo-stack";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopNavigationApp } from "../App";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "../navigation/desktop-adapter";
import { DesktopAppCoreProvider } from "../shared-agent-sessions/desktop-app-core-provider";
import { setupReturningInstallStorage } from "./local-storage-fixture";

/**
 * ISS-9092 — the undo keybinding layer is MOUNTED by the desktop renderer, and
 * mounted inside a real undo stack provider.
 *
 * Desktop coverage is owed its own test rather than inferred from web
 * (`apps/desktop/AGENTS.md` -> "Cross-surface work covers both adapters"). The
 * layer renders no DOM of its own, so a mount is otherwise invisible: delete the
 * two lines from `App.tsx` and every other desktop suite stays green.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. It proves the wiring — the layer is in the
 * renderer's provider stack, with a stack provider above it, so the chord
 * handler is installed and has somewhere to resolve against. It CANNOT prove the
 * chord arrives: jsdom has no native application menu, and on macOS the Edit
 * menu's `role: "editMenu"` owns Cmd+Z as a menu accelerator. NOTHING in this
 * repo proves that question today and no Electron e2e is pending: Playwright
 * drives Electron over CDP `Input.dispatchKeyEvent`, which bypasses the native
 * menu entirely, so such a spec would be green by construction on exactly the
 * question it claims to settle. It is ISS-10242, which asks for a human on a
 * real build — which is why this file deliberately does not press a key and
 * claim desktop support from it.
 */

// The real layer renders `null`, so it cannot be found in the DOM. This stand-in
// keeps the PRODUCTION mount position under test while reporting two facts: that
// it rendered at all, and whether a real `UndoStackProvider` is above it.
vi.mock("@repo/app/undo/components/undo-keybinding-layer", () => ({
  UndoKeybindingLayer: () => {
    const stack = useUndoStackOptional();
    return (
      <div
        data-has-stack={String(Boolean(stack))}
        data-testid="undo-layer-marker"
      />
    );
  },
}));

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
      getAgentMonitorUrl: vi.fn(() => new Promise(() => undefined)),
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      notifyRendererReady: vi.fn(),
      onDbChanged: vi.fn(() => () => undefined),
    },
  });
}

function restoreDescriptor(
  descriptor: PropertyDescriptor | undefined,
  host: object,
  key: string
) {
  if (descriptor) {
    Object.defineProperty(host, key, descriptor);
    return;
  }
  Reflect.deleteProperty(host, key);
}

describe("the desktop renderer mounts the undo keybinding layer (ISS-9092)", () => {
  // Modelled as a returning install: a first run opens the guided onboarding
  // modal over the shell, which is not this suite's subject.
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
    restoreDescriptor(desktopApiDescriptor, window, "desktopApi");
    restoreDescriptor(matchMediaDescriptor, window, "matchMedia");
    restoreDescriptor(resizeObserverDescriptor, globalThis, "ResizeObserver");
    desktopApiDescriptor = undefined;
    matchMediaDescriptor = undefined;
    resizeObserverDescriptor = undefined;
  });

  it("renders the layer inside a real undo stack provider", () => {
    const navigation = createDesktopNavigation();
    activeNavigations.add(navigation);

    render(
      <DesktopAppCoreProvider>
        <DesktopNavigationApp navigation={navigation} />
      </DesktopAppCoreProvider>
    );

    // Plain assertions: this project's vitest config loads no jest-dom setup,
    // so `toBeInTheDocument` / `toHaveAttribute` are not registered here.
    const marker = screen.getByTestId("undo-layer-marker");
    expect(marker).not.toBeNull();
    // The stack provider half. Mounting the layer with no provider above it
    // would render this marker just the same, while the chord resolved nothing
    // for the life of the app.
    expect(marker.getAttribute("data-has-stack")).toBe("true");
  });
});
