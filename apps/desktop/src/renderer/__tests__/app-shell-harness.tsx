/**
 * Shared harness for the desktop app-shell suites (ISS-5147).
 *
 * `app-shell.test.tsx` grew to 1,342 logical lines covering four unrelated
 * responsibilities behind one `describe`, which put it on the shrink-only
 * `noExcessiveLinesPerFile` grandfather list and made hardening any assertion
 * inside it trip `check:grandfather-line-growth`. The suite is now split by
 * responsibility — sidebar persistence, the Sessions surface, and shell routing
 * plus the Labs gate — and everything those three genuinely share lives here:
 * the desktopApi stub, the browser-global installers, the render entry point,
 * and the query helpers.
 *
 * This is NOT a test file (no `*.test.tsx` suffix, so vitest does not collect
 * it) and it deliberately holds no `vi.mock` calls: module mocks are hoisted
 * per test FILE, so each suite declares the ones its routes actually need.
 * Because that hoisting runs above every import, this module's own
 * `../App` import still resolves against those mocks.
 */
import {
  AgentSessionState,
  type AgentSessionsPageData,
} from "@repo/api/src/types/agent-session";
import {
  cleanup,
  configure,
  type RenderResult,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import {
  DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
  DESKTOP_LABS_NAV_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_DETAIL_READ_SOURCE_FEATURE_FLAG_KEY,
  DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY,
} from "../../shared/feature-flags";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../shared/local-session-source-status";
import type { SessionLimitsSnapshot } from "../../shared/session-limits-channel";
import { DesktopNavigationApp } from "../App";
import { dashboardOnboardedStorageKey } from "../components/dashboard/dashboard-storage-keys";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "../navigation/desktop-adapter";
import { DesktopAppCoreProvider } from "../shared-agent-sessions/desktop-app-core-provider";
import {
  agentSessionAnalytics,
  agentSessionDetail,
  agentSessionListItem,
  agentSessionUsage,
  filterSessionsList,
  type ShellSessionsListRequest,
} from "./app-shell-session-fixtures";
import { installLocalStorage } from "./local-storage-fixture";

const activeNavigations = new Set<DesktopNavigation>();

export const DESKTOP_SIDEBAR_OPEN_STORAGE_KEY =
  "closedloop.desktop.sidebar.open";
export const DASHBOARD_NAV_LINK_RE = /Dashboard/;
export const SHOW_COMMENTS_BUTTON_NAME = /show comments panel/i;

let restoreLocalStorage: (() => void) | undefined;
let restoreResizeObserver: (() => void) | undefined;

// FEA-2023: CI runners share CPU across parallel jobs. These suites drive heavy
// real-component renders (the shared-wrappers test alone takes ~2.9s on an idle
// dev machine) and walk routes via sequential async `findBy*` settles. On
// vitest's 5s default test budget and testing-library's 1s default async-util
// budget, CPU starvation (the same class as the FEA-1523 build-runner timeouts)
// intermittently turned passing renders into "Test timed out" / "Unable to find
// element" flakes that flapped `desktop#test`. Give both budgets deliberate,
// generous headroom, kept decoupled — the per-assertion async budget is strictly
// smaller than the whole-test budget, so a genuinely missing element still fails
// with testing-library's descriptive error before the generic test timeout
// fires (it is never masked, only given room to settle under load).
export const ASYNC_SETTLE_TIMEOUT_MS = 15_000;
export const TEST_TIMEOUT_MS = 30_000;

/**
 * Register the lifecycle every app-shell suite needs: the jsdom gaps the shell
 * renders against, the per-test browser-global installers, and the teardown that
 * disposes navigations so a leaked hash listener cannot bleed into the next case.
 *
 * Called at the top of each suite's `describe` so the split files share one
 * setup rather than three copies drifting apart.
 */
export function setupAppShellSuite(): void {
  vi.setConfig({ hookTimeout: TEST_TIMEOUT_MS, testTimeout: TEST_TIMEOUT_MS });
  configure({ asyncUtilTimeout: ASYNC_SETTLE_TIMEOUT_MS });

  beforeAll(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
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
    restoreResizeObserver = installResizeObserver();
    restoreLocalStorage = installLocalStorage();
    // ISS-5112 Step F: these suites model the STEADY-STATE shell — routing,
    // breadcrumbs, sidebar search, the Labs gate — on an install that has run
    // before. Say so, rather than leaving it implied by an empty store.
    //
    // It is load-bearing now that the guest-landing gate holds the shell back on
    // a first run until the flag snapshot lands: without the seed every case
    // here is a "first launch", and the hold renders a bare background over the
    // whole shell. That collides head-on with the ISS-5037 Labs deep-link hold,
    // whose own case deliberately keeps `getAllFlags` open forever — two holds
    // for one window, and the coarser one wins. A real deep-linker has launched
    // before, so production never stacks them.
    window.localStorage.setItem(dashboardOnboardedStorageKey, "1");
    installDesktopApi();
  });

  afterEach(() => {
    try {
      for (const navigation of activeNavigations) {
        navigation.dispose();
      }
      activeNavigations.clear();
      cleanup();
      window.localStorage.clear();
      window.location.hash = "";
    } finally {
      restoreResizeObserver?.();
      restoreResizeObserver = undefined;
      restoreLocalStorage?.();
      restoreLocalStorage = undefined;
    }
  });
}

export function findSharedRouteHeading(name: string) {
  // Inherits the file-wide asyncUtilTimeout configured above (FEA-2023).
  return screen.findByRole("heading", { name });
}

export function getDesktopSessionDetailScrollElements() {
  const workspace = document.querySelector(".sd3");
  const traceScroller = document.querySelector(".sd3-scroll");
  const detailShell = workspace?.parentElement;
  const contentViewport = detailShell?.parentElement;
  return { contentViewport, detailShell, traceScroller, workspace };
}

// The Sessions/Branches pages have no in-body heading — their page name lives
// in the Topbar breadcrumb (the current segment is marked aria-current="page").
// Scope to the labeled breadcrumb nav so a matching sidebar nav label can't
// satisfy it.
export function findTopbarCurrentPage(name: string) {
  // Inherits the file-wide asyncUtilTimeout configured above (FEA-2023).
  return within(
    screen.getByRole("navigation", { name: "breadcrumb" })
  ).findByText(name, { selector: '[aria-current="page"]' });
}

/**
 * Mount the desktop shell at `initialHash`.
 *
 * The return type is annotated rather than inferred: exporting this from a
 * shared module made TypeScript try to name `render`'s inferred result through
 * a transitive `pretty-format` path (TS2742), which is not portable.
 */
export function renderDesktopApp(
  initialHash: string
): RenderResult & { navigation: DesktopNavigation } {
  window.location.hash = initialHash;
  const navigation = createDesktopNavigation();
  activeNavigations.add(navigation);
  return {
    navigation,
    ...render(
      <DesktopAppCoreProvider>
        <DesktopNavigationApp navigation={navigation} />
      </DesktopAppCoreProvider>
    ),
  };
}

function installResizeObserver(): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver"
  );
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserver {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    },
  });

  return () => {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
      return;
    }
    Object.defineProperty(globalThis, "ResizeObserver", originalDescriptor);
  };
}

/**
 * ISS-5037: the Labs nav section (and every destination FOCUS_MODE folds into
 * it — Insights, Packs, Plans, Audit, Help) is now behind the `labsNav`
 * container gate, default OFF. These shell cases are about ROUTING, not the
 * gate, so the stub seeds the flag ON by default; the gate's own off/on
 * behavior is asserted in the dedicated ISS-5037 cases below and in
 * `navigation/__tests__/nav-config-labs-gate.test.ts`.
 */
export function installDesktopApi({
  labsNav = true,
  agentsNav = true,
  flagsGate,
  sessionDetailReadSource = false,
  subscriptionSessionLimits = false,
  getSessionLimits,
}: {
  labsNav?: boolean;
  /**
   * ISS-5310: Agents moved into Labs behind its own per-item flag, default OFF.
   * Same reasoning as `labsNav` — these shell cases are about ROUTING, so the
   * stub seeds it ON; the gate's own four-combination behavior is asserted in
   * `navigation/__tests__/nav-config-labs-gate.test.ts`.
   */
  agentsNav?: boolean;
  /**
   * ISS-5037: hold `getAllFlags` open until this settles, so a case can drive
   * the shell's UNRESOLVED window (the startup race the Hold outcome protects)
   * rather than the immediate resolution every other case gets.
   */
  flagsGate?: Promise<void>;
  /**
   * ISS-5607: the session-detail read-source badge's Labs gate. Seeded OFF,
   * matching its real default — every other shell case must see the pane
   * exactly as it ships, and `session-detail-read-source-topbar.test.tsx`
   * drives both poles through the real route.
   */
  sessionDetailReadSource?: boolean;
  /**
   * PRD-538 R5/R6 (ISS-5354): the subscription session-limits Labs gate. Seeded
   * OFF, matching its real default — the feature is not product-approved, and
   * with it off the reading component must not mount at all.
   */
  subscriptionSessionLimits?: boolean;
  /**
   * The snapshot bridge the sidebar footer reads. Omitted by default so shell
   * cases that say nothing about session limits do not accidentally mount them;
   * `session-limits-labs-gate.test.tsx` injects a spy to assert the flag-off
   * case performs no read at all.
   */
  getSessionLimits?: () => Promise<SessionLimitsSnapshot | null>;
} = {}) {
  const items = [
    agentSessionListItem({
      id: "s-active",
      name: "Shell Active Session",
      status: "active",
    }),
    agentSessionListItem({
      id: "s-completed",
      name: "Shell Completed Session",
      status: "completed",
    }),
    agentSessionListItem({
      id: "s-failed",
      name: "Shell Failed Session",
      status: "failed",
    }),
    agentSessionListItem({
      id: "s-pending",
      name: "Shell Pending Session",
      state: AgentSessionState.PendingApproval,
      status: "active",
    }),
    agentSessionListItem({
      id: "s-blocked",
      name: "Shell Blocked Session",
      state: AgentSessionState.Blocked,
      status: "failed",
    }),
    agentSessionListItem({
      id: "s-abandoned",
      name: "Shell Abandoned Session",
      status: "abandoned",
    }),
    ...Array.from({ length: 19 }, (_, index) =>
      agentSessionListItem({
        id: `s-filler-${index + 1}`,
        name: `Shell Filler Session ${index + 1}`,
        status: "completed",
      })
    ),
    agentSessionListItem({
      id: "s-page-two",
      name: "Shell Page Two Session",
      status: "completed",
    }),
  ];

  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: {
        analytics: vi.fn(() => Promise.resolve(agentSessionAnalytics())),
        detail: vi.fn((id: string) => {
          const item = items.find((session) => session.id === id);
          return Promise.resolve(item ? agentSessionDetail(item) : null);
        }),
        list: vi.fn((request: ShellSessionsListRequest = {}) =>
          Promise.resolve(filterSessionsList(items, request))
        ),
        // FEA-4157: the Sessions view reads its list + summary through ONE
        // combined `pageData` IPC call. Serve the list half from the same filter
        // helper as `list` and pair it with the usage aggregate, so the shared
        // search/status/pagination assertions hold on whichever read the surface
        // under test uses (the list-only `list` still backs insights + panels).
        pageData: vi.fn((request: ShellSessionsListRequest = {}) =>
          Promise.resolve({
            list: filterSessionsList(items, request),
            usage: agentSessionUsage(filterSessionsList(items, request).total),
          } satisfies AgentSessionsPageData)
        ),
        usage: vi.fn(() => Promise.resolve(agentSessionUsage(items.length))),
      },
      db: {
        getDiagnostics: vi.fn(),
        getSubAgents: vi.fn(),
        getTools: vi.fn(),
        getWorkflowData: vi.fn(),
        // Agent components IPC (FEA-2923 / T-16.2).
        listAgentComponents: vi.fn(async () => ({ items: [], total: 0 })),
        getAgentComponentDetail: vi.fn(async () => null),
        // Pack catalog IPC (FEA-4087): the top-level Packs view mounts the
        // shared PluginsPanel, which reads these on render. Empty is a valid
        // ready state — the view renders its shell + an empty catalog.
        getCatalog: vi.fn(async () => []),
        getInstalledPacks: vi.fn(async () => []),
        getInstallRuns: vi.fn(async () => []),
      },
      getRuntimeStatus: vi.fn(() => new Promise(() => {})),
      getAgentMonitorUrl: vi.fn(() =>
        Promise.resolve({
          localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
          planExtractionEnabled: true,
          ready: true,
          url: "http://127.0.0.1:0",
        })
      ),
      getAllFlags: vi.fn(async () => {
        await flagsGate;
        return {
          flags: [
            { key: DESKTOP_LABS_NAV_FEATURE_FLAG_KEY, value: labsNav },
            { key: DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY, value: agentsNav },
            {
              key: DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY,
              value: subscriptionSessionLimits,
            },
            {
              key: DESKTOP_SESSION_DETAIL_READ_SOURCE_FEATURE_FLAG_KEY,
              value: sessionDetailReadSource,
            },
          ],
        };
      }),
      ...(getSessionLimits ? { getSessionLimits } : {}),
      onDbChanged: vi.fn(() => () => undefined),
      // FEA-4233: the local IPC trace-comments sink. Without it the shared
      // comments-rail discovery read rejects, so the rail never reaches
      // settled-empty; a resolving empty `list` lets it settle and fold to the
      // slim re-open handle for these zero-comment sessions.
      traceCommentsApi: {
        create: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(async () => []),
        reply: vi.fn(),
        update: vi.fn(),
      },
    },
  });
}
