import type { AgentSessionListResponse } from "@repo/api/src/types/agent-session";
import type { DesktopFeatureFlagAssignment } from "@repo/api/src/types/desktop-feature-flags";
import { ReadInitiator } from "@repo/api/src/types/read-initiator";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
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
import { DESKTOP_LABS_NAV_FEATURE_FLAG_KEY } from "../../shared/feature-flags-labs-detail";
import { DesktopNavigationApp } from "../App";
import type * as BoundedViewModule from "../components/insights/desktop-insights-bounded-view";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "../navigation/desktop-adapter";
import { DesktopAppCoreProvider } from "../shared-agent-sessions/desktop-app-core-provider";
import { setupReturningInstallStorage } from "./local-storage-fixture";

// ISS-8929: the counter is module-scoped and one-shot. Vitest runs a mock
// factory on the module's FIRST import and the registry caches it for the rest
// of the file, so exactly one case here may read this — a second would see the
// chunk already loaded and could only assert 1, whatever the route does.
const boundedViewModule = vi.hoisted(() => ({ loadCount: 0 }));

// The lazy boundary this file is named for is `insights-view.tsx`'s
// `lazy(() => import("./desktop-insights-bounded-view"))`, and counting that
// module's first evaluation is the only way to observe it from out here: every
// other signal below — the rendered copy, the `list()` IPC — is identical
// whether the import is deferred or static. `importOriginal` returns the real
// module, so this counts the load without replacing any behavior the rest of
// the case asserts (the bounded view is what drives `list()` and renders both
// the loading and the empty string).
vi.mock(
  "../components/insights/desktop-insights-bounded-view",
  async (importOriginal) => {
    boundedViewModule.loadCount += 1;
    return await importOriginal<typeof BoundedViewModule>();
  }
);

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

const activeNavigations = new Set<DesktopNavigation>();

describe("Insights route initial navigation", () => {
  // This suite asserts the app shell, so it must not launch as a first run:
  // the guided onboarding modal covers the shell when no first-run key is stored.
  setupReturningInstallStorage();

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

  it("defers the bounded-view chunk and its session IPC until Load insights", async () => {
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
    // mount signal `app-shell-sessions.test.tsx` uses for this route.
    expect(
      await screen.findByRole("heading", { name: "Insights" })
    ).toBeDefined();
    // Explicit timeout: this file configures no `asyncUtilTimeout`, so the
    // default is 1s — too tight for a wait that spans flag hydration AND the
    // lazy route import under CI CPU contention (the app-shell suites give the
    // same sentinel 15s via `ASYNC_SETTLE_TIMEOUT_MS` in `app-shell-harness.tsx`
    // for that reason). 5s matches the list() wait below and
    // stays well inside this test's 15s budget.
    expect(
      await screen.findByText("Local session history", undefined, {
        timeout: 5000,
      })
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Load insights" })).toBeDefined();
    // The gate card is on screen and the chunk behind it has not been evaluated.
    // Making the `lazy()` at `insights-view.tsx:11` a static top-level import
    // reddens this line and nothing else in the file.
    expect(boundedViewModule.loadCount).toBe(0);
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
          readInitiator: ReadInitiator.User,
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
    // The click, and only the click, loaded it. This is what keeps the `toBe(0)`
    // above honest: a counter wired to a module nothing imports would satisfy
    // that assertion forever, which is the defect ISS-8929 records.
    expect(boundedViewModule.loadCount).toBe(1);

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
      notifyRendererReady: vi.fn(),
      // ISS-5037: Insights displays under the Labs section, which is behind
      // the default-OFF `labsNav` container gate. This suite is about the
      // route's lazy-loading behavior, so open the gate.
      //
      // ISS-8753 — SEEDED AS AN ASSIGNMENT, matching `app-shell-harness.tsx`.
      // The signed-in user's PostHog assignment is the only source the gate
      // reads, so the retired `getAllFlags` registry stub this replaced opened
      // nothing and the route rendered `LabsPageUnavailable`. That fallback
      // reuses the destination's own title, so the "Insights" heading above
      // stayed true and only the view's own copy caught it.
      getE2eSeededFeatureFlags: vi.fn(() =>
        Promise.resolve({
          userId: ASSIGNMENT_SUBJECT,
          resolved: true,
          flags: {
            [DESKTOP_LABS_NAV_FEATURE_FLAG_KEY]: true,
            [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]: true,
          },
        } satisfies DesktopFeatureFlagAssignment)
      ),
    },
  });
}

/**
 * A legible marker in the seeded payload, never an identity. The canonical
 * owner is `E2E_FEATURE_FLAG_ASSIGNMENT_SUBJECT` in
 * `src/main/lifecycle/e2e-feature-flag-assignment.ts`; this mirrors it in
 * spelling only, because importing it would drag a `node:fs`-bearing
 * main-process module into a jsdom renderer suite — the same local copy the
 * other renderer suites keep. The value is not load-bearing either way: the
 * provider folds a seeded assignment through `readFeatureAssignment` with a
 * `null` subject, and that boundary skips the identity check entirely when the
 * subject is null.
 */
const ASSIGNMENT_SUBJECT = "e2e-harness";
