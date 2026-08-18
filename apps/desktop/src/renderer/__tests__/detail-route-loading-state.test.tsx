import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../shared/local-session-source-status";
import { DesktopNavigationApp } from "../App";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "../navigation/desktop-adapter";
import {
  detailTitleKey,
  usePublishDetailTitle,
} from "../navigation/detail-title-context";

/**
 * ISS-4838 + ISS-4839: the desktop shell's DETAIL-route loading presentation,
 * which ships unconditionally as of ISS-5366 (the `detail-route-loading-state`
 * Labs flag retired to its enabled state).
 *
 * ISS-4772 switched detail routing to the LIVE route ids, so a route change
 * always commits — and a cold open therefore blanked the body to the shared
 * centered "Loading..." and parked a generic "Session" noun in the breadcrumb's
 * name slot for the whole chunk load. Both are the UI claiming something it does
 * not know yet.
 *
 * The guarantee these tests hold is that a detail route's LOADING state stays
 * distinguishable from its empty/not-found one: a detail-shaped skeleton that
 * NAMES what is loading (never the anonymous centered "Loading..."), a
 * breadcrumb that HOLDS its trailing slot as a pending segment (never a
 * placeholder noun), and — the other side of the same rule — a read that SETTLES
 * without a name dropping back to the static noun rather than skeletoning
 * against a body that already says "not found".
 *
 * The detail view is mocked as a marker that SUSPENDS on a controllable gate, so
 * the loading window is held open deterministically — the same technique
 * `branches-route-loading-skeleton` uses for the branches chunk. Topbar is
 * mocked to a marker that prints its breadcrumb labels, so the breadcrumb model
 * is asserted through the real `buildBreadcrumbs` wiring without standing up the
 * chrome's provider stack.
 */

const BREADCRUMB_SEPARATOR = " / ";

// The gate the mocked detail suspends on, plus the title it publishes once it
// renders. `reset()` re-arms a fresh pending promise per test.
const detailGate = vi.hoisted(() => {
  const gate = {
    settled: false,
    title: null as string | null,
    // Whether the detail's own READ has settled, published alongside the title.
    // A not-found / errored detail settles with no name at all.
    titleSettled: false,
    promise: Promise.resolve<void>(undefined),
    release: () => {
      // Replaced by reset() with the resolver for the current promise.
    },
    reset() {
      gate.settled = false;
      gate.title = null;
      gate.titleSettled = false;
      gate.promise = new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    },
  };
  gate.reset();
  return gate;
});

// The shell still reads unrelated Labs flags (Labs nav, startup readiness); this
// suite exercises none of them, so they resolve off without standing up the
// desktop flag provider.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
}));

vi.mock("../components/sessions/SessionsView", () => ({
  SessionsView: () => <div data-testid="sessions-list-marker">list</div>,
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
vi.mock("../components/layout/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar-marker" />,
}));
vi.mock("../components/layout/mac-window-controls-underlay", () => ({
  MacWindowControlsUnderlay: () => null,
}));

// Print the breadcrumb labels the shell computed, so the trail is observable
// without the real Topbar's provider stack.
vi.mock("../components/layout/Topbar", () => ({
  Topbar: ({
    breadcrumbs,
  }: {
    breadcrumbs: { label: string; href?: string; pending?: boolean }[];
  }) => (
    <>
      <div data-testid="breadcrumb-marker">
        {breadcrumbs.map((crumb) => crumb.label).join(BREADCRUMB_SEPARATOR)}
      </div>
      {/* How many segments are flagged pending, and whether the PARENT still
          carries its href — the two properties `buildBreadcrumbs` controls that
          the label join alone cannot show. */}
      <div data-testid="breadcrumb-pending-marker">
        {breadcrumbs.filter((crumb) => crumb.pending).length}
      </div>
      <div data-testid="breadcrumb-parent-href">{breadcrumbs[0]?.href}</div>
    </>
  ),
}));

vi.mock("../components/sessions/SessionDetailView", () => ({
  SessionDetailView: ({ sessionId }: { sessionId: string }) =>
    MockSessionDetail({ sessionId }),
}));

const activeNavigations = new Set<DesktopNavigation>();
let desktopApiDescriptor: PropertyDescriptor | undefined;
let matchMediaDescriptor: PropertyDescriptor | undefined;
let resizeObserverDescriptor: PropertyDescriptor | undefined;

describe("Desktop detail-route loading state (ISS-4838 / ISS-4839)", () => {
  beforeEach(() => {
    detailGate.reset();
    installStubs();
  });

  afterEach(() => {
    for (const navigation of activeNavigations) {
      navigation.dispose();
    }
    activeNavigations.clear();
    cleanup();
    window.location.hash = "";
    restoreStubs();
  });

  it("shows a detail-shaped skeleton naming what is loading, not a bare Loading…, while the detail chunk resolves", async () => {
    await renderShell("#/sessions/s-1");

    // The fallback is a detail-shaped skeleton that says WHICH page is opening.
    expect(
      screen.getByRole("status", { name: "Loading session" })
    ).toBeTruthy();
    expect(screen.getByTestId("detail-route-fallback")).toBeTruthy();
    // …and the anonymous centered "Loading..." canvas is gone.
    expect(screen.queryByText("Loading...")).toBeNull();
    expect(screen.queryByTestId("session-detail-marker")).toBeNull();
  });

  it("marks the trailing crumb pending, not a placeholder noun, while the detail name is unresolved", async () => {
    await renderShell("#/sessions/s-1");

    // The name slot is HELD as a pending segment rather than filled with a
    // placeholder noun the user would have to re-read when it settles.
    expect(screen.getByTestId("breadcrumb-marker").textContent).toBe(
      `Sessions${BREADCRUMB_SEPARATOR}Loading session`
    );
    // …and it is flagged `pending` so Topbar renders a skeleton in the slot.
    expect(screen.getByTestId("breadcrumb-pending-marker").textContent).toBe(
      "1"
    );
  });

  it("keeps the parent crumb a LINK while the name resolves, so the detail never presents as its own list", async () => {
    await renderShell("#/sessions/s-1");

    // Regression guard: dropping the trailing slot entirely would make
    // "Sessions" the FINAL crumb, which Topbar renders as `aria-current="page"`
    // with its link suppressed — a loading session detail would announce itself
    // as the Sessions LIST and lose the breadcrumb back affordance for the whole
    // load. The parent must still carry its href.
    expect(screen.getByTestId("breadcrumb-parent-href").textContent).toBe(
      "/sessions"
    );
  });

  it("releases the hold and shows the real name once the detail publishes its title", async () => {
    await renderShell("#/sessions/s-1");
    expect(screen.getByTestId("breadcrumb-marker").textContent).toBe(
      `Sessions${BREADCRUMB_SEPARATOR}Loading session`
    );

    // The detail chunk resolves and publishes the session's name — the hold is
    // for an UNRESOLVED name, not a permanent suppression of the segment.
    detailGate.settled = true;
    detailGate.title = "Nightly regression sweep";
    await act(async () => {
      detailGate.release();
      await Promise.resolve();
    });

    expect(await screen.findByTestId("session-detail-marker")).toBeTruthy();
    expect(screen.getByTestId("breadcrumb-marker").textContent).toBe(
      `Sessions${BREADCRUMB_SEPARATOR}Nightly regression sweep`
    );
    // The skeleton is gone once real content is on screen.
    expect(screen.queryByTestId("detail-route-fallback")).toBeNull();
  });

  it("drops the pending crumb back to the static noun once a nameless detail SETTLES", async () => {
    // codex review on PR #4266: a detail that settles as not-found or a provider
    // error publishes `title: null` exactly like one still loading. Keyed on the
    // title alone, the trail would skeleton FOREVER while the body renders
    // "Session not found" — the shell contradicting the settled page. The
    // published `settled` flag bounds the hold to the loading window it names,
    // which is what keeps LOADING and NOT-FOUND two different states.
    await renderShell("#/sessions/s-1");
    expect(screen.getByTestId("breadcrumb-marker").textContent).toBe(
      `Sessions${BREADCRUMB_SEPARATOR}Loading session`
    );

    // The read settles with NO name — the not-found / provider-error case.
    detailGate.settled = true;
    detailGate.title = null;
    detailGate.titleSettled = true;
    await act(async () => {
      detailGate.release();
      await Promise.resolve();
    });
    expect(await screen.findByTestId("session-detail-marker")).toBeTruthy();

    // The trail agrees with the settled body: a static noun, no live region
    // still claiming the name is on its way.
    expect(screen.getByTestId("breadcrumb-marker").textContent).toBe(
      `Sessions${BREADCRUMB_SEPARATOR}Session`
    );
    expect(screen.getByTestId("breadcrumb-pending-marker").textContent).toBe(
      "0"
    );
  });
});

/**
 * The mocked session detail: suspends on {@link detailGate} until the test
 * releases it (standing in for the lazy chunk + first data read), then renders a
 * marker and publishes `detailGate.title` to the breadcrumb exactly as the real
 * `SessionDetailView` publishes the loaded session's name.
 */
function MockSessionDetail({ sessionId }: { sessionId: string }) {
  if (!detailGate.settled) {
    throw detailGate.promise;
  }
  usePublishDetailTitle(
    detailTitleKey("session", sessionId),
    detailGate.title,
    detailGate.titleSettled
  );
  return <div data-testid="session-detail-marker">detail:{sessionId}</div>;
}

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

function restoreStubs() {
  restoreDescriptor(window, "desktopApi", desktopApiDescriptor);
  restoreDescriptor(window, "matchMedia", matchMediaDescriptor);
  restoreDescriptor(globalThis, "ResizeObserver", resizeObserverDescriptor);
  desktopApiDescriptor = undefined;
  matchMediaDescriptor = undefined;
  resizeObserverDescriptor = undefined;
}

function restoreDescriptor(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined
) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}

async function renderShell(initialHash: string): Promise<void> {
  window.location.hash = initialHash;
  const navigation = createDesktopNavigation();
  activeNavigations.add(navigation);
  render(<DesktopNavigationApp navigation={navigation} />);
  await act(async () => {
    await Promise.resolve();
  });
}
