/**
 * Regression (FEA-2932): first navigation to `/branches` must show the branches
 * skeleton scaffold while the lazy `BranchesView` chunk loads — NOT the shared
 * blank centered "Loading…" `PageFallback` flashing across the whole body for
 * the ~200ms fetch before cards + table snap in at once.
 *
 * The `BranchesView` mock suspends on a controllable gate so the load window is
 * held open deterministically: while suspended we assert the skeleton (and the
 * absence of the blank fallback text); after the gate releases we assert the
 * real view replaces it.
 */

import type { AgentSessionListResponse } from "@repo/api/src/types/agent-session";
import { cleanup, render, screen } from "@testing-library/react";
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
import { DesktopNavigationApp } from "../App";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "../navigation/desktop-adapter";
import { DesktopAppCoreProvider } from "../shared-agent-sessions/desktop-app-core-provider";

// Gate that keeps the mocked BranchesView suspended until the test releases it,
// so the chunk-load fallback stays on screen long enough to assert against.
// `reset()` re-arms a fresh pending promise so each test starts suspended even
// though the mock closure re-reads `branchesGate.promise` at throw time.
const branchesGate = vi.hoisted(() => {
  const gate = {
    settled: false,
    promise: Promise.resolve<void>(undefined),
    release: () => {
      // Replaced by reset() with the resolver for the current promise.
    },
    reset() {
      gate.settled = false;
      gate.promise = new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    },
  };
  gate.reset();
  return gate;
});

vi.mock("../components/branches/branches-view", () => ({
  BranchesView: () => {
    if (!branchesGate.settled) {
      // Throwing a promise suspends the nearest boundary — the dedicated
      // Suspense wrapping BranchesView, whose fallback is BranchesLoading.
      throw branchesGate.promise;
    }
    return <div data-testid="mock-branches-view">Branches loaded</div>;
  },
}));

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

const activeNavigations = new Set<DesktopNavigation>();

describe("Branches route initial navigation", () => {
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
    branchesGate.reset();
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

  it("shows the branches skeleton, not a blank Loading… canvas, while the chunk loads", async () => {
    renderDesktopApp("#/branches");

    // Load window held open: the branches skeleton scaffold is on screen and
    // the shared blank "Loading…" PageFallback is not.
    expect(
      await screen.findByTestId("branches-loading-skeleton")
    ).toBeDefined();
    expect(screen.queryByText("Loading...")).toBeNull();
    expect(screen.queryByTestId("mock-branches-view")).toBeNull();

    // Chunk resolves → the real view replaces the skeleton.
    branchesGate.settled = true;
    branchesGate.release();
    expect(await screen.findByTestId("mock-branches-view")).toBeDefined();
    expect(screen.queryByTestId("branches-loading-skeleton")).toBeNull();
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
      getAllFlags: vi.fn(() => Promise.resolve({ flags: [] })),
    },
  });
}
