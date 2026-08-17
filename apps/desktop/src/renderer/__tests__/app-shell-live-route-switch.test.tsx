import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../shared/local-session-source-status";
import { DesktopNavigationApp } from "../App";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "../navigation/desktop-adapter";

/**
 * ISS-4772 (Step 1): a route change must update the RENDERED view immediately.
 * The content, breadcrumb, and viewport class are selected from the LIVE route
 * ids (not their `useDeferredValue` counterparts), so navigating from the list
 * to a detail swaps the visible view in one commit — the deferred background
 * render that could stall after long uptime no longer gates the swap. This mocks
 * the list and detail views as light markers (routing is under test, not the
 * view internals) and asserts the swap lands within a single act() flush, and
 * that a deliberately-slow lazy detail child still switches the view off the
 * list.
 */

// A hoisted control the SessionDetailView mock reads: when a `suspendUntil`
// promise is set, the mock suspends on it (simulating a slow lazy chunk / data
// read) before rendering the marker. Reset per test.
const detailControls = vi.hoisted(() => ({
  suspendUntil: null as null | Promise<void>,
  // ISS-4772 (wongk cid 3696061975): every sessionId the detail mock has
  // MOUNTED for, in order. React identity is the thing under test in the
  // remount case below, and a mount log is the only direct evidence of it — a
  // re-render with a new prop looks identical from the DOM.
  mounts: [] as string[],
}));

vi.mock("../components/UpdateBanner", () => ({ UpdateBanner: () => null }));
vi.mock("../components/desktop-session-expired-banner", () => ({
  DesktopSessionExpiredBanner: () => null,
}));
vi.mock("../components/desktop-sync-prompt", () => ({
  DesktopSyncPrompt: () => null,
}));
vi.mock("../components/first-launch-import-banner", () => ({
  FirstLaunchImportBanner: () => null,
}));
vi.mock("../components/opt-in-distributions-banner", () => ({
  OptInDistributionsBanner: () => null,
}));
vi.mock("../components/command-palette/command-palette", () => ({
  CommandPalette: () => null,
}));
// The Sidebar/Topbar pull the shared auth+query provider stack (nav badges,
// breadcrumb data). This suite tests the AppShell content SELECTION, not the
// chrome, so mock them to light markers and render the shell provider-free.
vi.mock("../components/layout/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar-marker" />,
}));
vi.mock("../components/layout/Topbar", () => ({
  Topbar: () => <div data-testid="topbar-marker" />,
}));
vi.mock("../components/layout/mac-window-controls-underlay", () => ({
  MacWindowControlsUnderlay: () => null,
}));
// The feature-flag provider reads IPC flags; the shell only consumes flag
// booleans for nav gating, irrelevant to routing. Stub the flag hook off.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
}));

// The list view is a light marker so this suite asserts routing, not the
// SessionsView internals (covered by its own render tests).
vi.mock("../components/sessions/SessionsView", () => ({
  SessionsView: () => <div data-testid="sessions-list-marker">list</div>,
}));

// The session detail is a light marker. When `detailControls.suspendUntil` is
// set the mock SUSPENDS on it before rendering the marker — exactly as the real
// lazily-loaded `SessionDetailView` chunk suspends its App-level `<Suspense
// fallback={<PageFallback/>}>` boundary while the chunk resolves — so we can
// prove the LIVE-id switch hides the list even while the detail chunk is still
// resolving (it shows the App PageFallback, never the stale list).
const settledSuspenders = new WeakSet<Promise<void>>();
vi.mock("../components/sessions/SessionDetailView", () => ({
  SessionDetailView: ({ sessionId }: { sessionId: string }) => {
    const pending = detailControls.suspendUntil;
    if (pending && !settledSuspenders.has(pending)) {
      throw pending.then(() => {
        settledSuspenders.add(pending);
      });
    }
    // Records a MOUNT, not a render. The dep array MUST stay empty: with
    // `[sessionId]` the effect re-fires on a plain prop change too, which
    // measures re-renders and would pass with or without the remount key (it
    // did, on the first cut of this test). The id is read through a ref so the
    // empty deps stay honest.
    const sessionIdRef = useRef(sessionId);
    sessionIdRef.current = sessionId;
    useEffect(() => {
      detailControls.mounts.push(sessionIdRef.current);
    }, []);
    return <div data-testid="session-detail-marker">detail:{sessionId}</div>;
  },
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
      getAllFlags: vi.fn(() => Promise.resolve({ flags: [] })),
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
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

function renderShell(initialHash: string) {
  window.location.hash = initialHash;
  const navigation = createDesktopNavigation();
  activeNavigations.add(navigation);
  return {
    navigation,
    ...render(<DesktopNavigationApp navigation={navigation} />),
  };
}

// jsdom fires `hashchange` on a later tick and testing-library's `act` does not
// flush it deterministically; dispatch it explicitly so the desktop hash host's
// listener runs inside the current act() flush.
async function navigateHash(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
}

describe("App shell live-id route switch (ISS-4772)", () => {
  beforeEach(() => {
    detailControls.suspendUntil = null;
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

  it("REMOUNTS the detail view on a detail A -> B switch, rather than reusing the instance", async () => {
    // ISS-4772 (wongk cid 3696061975) — the `key={detailSessionId}` guarantee.
    //
    // Without the key React reuses the element at this tree position across the
    // two ids: only the `sessionId` prop and the query key change, never the
    // component instance, so the `refetchOnMount: "always"` default on
    // `agentSessionKeys.details()` never fires and B renders from its (possibly
    // stale or empty) `staleTime: Infinity` cache entry without a read.
    //
    // This lives at the render layer on purpose. It is NOT observable from the
    // Electron e2e: `applyDesktopSessionsListPollDefaults` gives the detail key
    // a 5s `refetchInterval` with `refetchIntervalInBackground: true`, so a
    // reused instance is healed by the poll well inside any honest assertion
    // timeout — the remount and the poll produce the same end state there, and
    // separating them would take a timing assertion, which the repo bans.
    // Component identity has no such ambiguity here.
    detailControls.mounts.length = 0;

    renderShell("#/sessions/s-a");
    await act(async () => {
      await Promise.resolve();
    });
    expect(detailControls.mounts).toEqual(["s-a"]);

    // Detail -> detail, with no intervening list.
    await navigateHash("#/sessions/s-b");

    // A SECOND mount happened for B. Without `key={detailSessionId}` this stays
    // ["s-a"]: the DOM still reads "detail:s-b" (the prop changed), which is
    // exactly why a DOM-only assertion cannot pin this.
    expect(detailControls.mounts).toEqual(["s-a", "s-b"]);
    expect(screen.getByTestId("session-detail-marker").textContent).toContain(
      "detail:s-b"
    );
  });

  it("swaps the list for the detail view within one flush when the route changes", async () => {
    renderShell("#/sessions");
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("sessions-list-marker")).toBeTruthy();
    expect(screen.queryByTestId("session-detail-marker")).toBeNull();

    // Navigate to a session detail. The LIVE-id selection commits the detail in
    // this same flush — no deferred second commit is required.
    await navigateHash("#/sessions/s-1");

    const detail = screen.getByTestId("session-detail-marker");
    expect(detail.textContent).toContain("detail:s-1");
    // The list keep-alive body is replaced by the detail content — the list
    // marker is no longer in the tree.
    expect(screen.queryByTestId("sessions-list-marker")).toBeNull();
  });

  it("switches off the list even when the detail child is a slow-resolving lazy chunk", async () => {
    // The detail body suspends until this promise resolves (a slow lazy chunk /
    // data read). The point: the LIVE-id branch selection swaps the OUTER content
    // off the list immediately; only the detail's own inner Suspense fallback
    // shows while the slow child resolves — the list is already gone.
    let resolveChunk: () => void = () => undefined;
    const chunkReady = new Promise<void>((resolve) => {
      resolveChunk = resolve;
    });
    detailControls.suspendUntil = chunkReady;

    renderShell("#/sessions");
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("sessions-list-marker")).toBeTruthy();

    // Navigate while the detail chunk is still resolving. React keeps the
    // last-good content on screen during a synchronous suspend (it does not flash
    // a fallback for already-visible content) — the detail is NOT yet shown.
    await navigateHash("#/sessions/s-slow");
    expect(screen.queryByTestId("session-detail-marker")).toBeNull();

    // Once the slow chunk resolves, the LIVE-id branch commits the detail and the
    // list is gone — the route change still lands the view (no wedge on the old
    // list), which is the Step-1 guarantee the regression variant pins.
    await act(async () => {
      resolveChunk();
      await chunkReady;
      await Promise.resolve();
    });
    expect(screen.getByTestId("session-detail-marker").textContent).toContain(
      "detail:s-slow"
    );
    expect(screen.queryByTestId("sessions-list-marker")).toBeNull();
  });
});
