/**
 * FEA-4262: the branch-detail "Back" affordance on Desktop honors a
 * `?from=session` referrer. When the branch detail is opened via a session's
 * Branch cross-link it carries `?from=session`, and Back returns to the sessions
 * list the user came from instead of the static Branches list; an absent or
 * unrecognized referrer keeps the Branches-list fallback.
 *
 * These cases live in their own focused file — not `app-shell.test.tsx`, which is
 * grandfathered over the 1,000-line ceiling and therefore shrink-only (see the
 * root size rule and `biome.jsonc`). `branch-detail-view` is mocked to a marker
 * that surfaces the resolved `backHref` so this suite exercises App.tsx's
 * referrer→Back wiring, not the detail page internals (those are covered by
 * `branch-detail-view.test.tsx`).
 */

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
import { DesktopNavigationApp } from "../App";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "../navigation/desktop-adapter";
import { DesktopAppCoreProvider } from "../shared-agent-sessions/desktop-app-core-provider";

// Branch detail is mocked to a marker exposing the resolved back href, mirroring
// the marker mock in app-shell.test.tsx.
vi.mock("../components/branches/branch-detail-view", () => ({
  BranchDetailView: ({
    branchId,
    backHref,
  }: {
    branchId: string;
    backHref: string;
  }) => (
    <div data-back-href={backHref} data-testid="branch-detail">
      {branchId}
    </div>
  ),
}));

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

const activeNavigations = new Set<DesktopNavigation>();
let restoreResizeObserver: (() => void) | undefined;

describe("Desktop branch-detail Back navigation (FEA-4262)", () => {
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
    restoreResizeObserver = installResizeObserver();
    installDesktopApi();
  });

  afterEach(() => {
    for (const navigation of activeNavigations) {
      navigation.dispose();
    }
    activeNavigations.clear();
    cleanup();
    window.location.hash = "";
    restoreResizeObserver?.();
    restoreResizeObserver = undefined;
  });

  it("points branch-detail Back at the sessions list when arriving via ?from=session", async () => {
    renderDesktopApp("#/branches/b-1?from=session");

    const detail = await screen.findByTestId("branch-detail");
    expect(detail.getAttribute("data-back-href")).toBe("/sessions");
  });

  it("keeps branch-detail Back on the Branches list when the referrer is absent or unknown", async () => {
    renderDesktopApp("#/branches/b-1?from=bogus");

    const detail = await screen.findByTestId("branch-detail");
    expect(detail.getAttribute("data-back-href")).toBe("/branches");
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

function installResizeObserver(): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
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
  return () => {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
      return;
    }
    Object.defineProperty(globalThis, "ResizeObserver", originalDescriptor);
  };
}

function installDesktopApi() {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: {
        analytics: vi.fn(() => new Promise(() => undefined)),
        detail: vi.fn(() => new Promise(() => undefined)),
        list: vi.fn(() => new Promise(() => undefined)),
        pageData: vi.fn(() => new Promise(() => undefined)),
        usage: vi.fn(() => new Promise(() => undefined)),
      },
      db: {
        getSubAgents: vi.fn(),
        getTools: vi.fn(),
        getWorkflowData: vi.fn(),
      },
      getAllFlags: vi.fn(() => Promise.resolve({ flags: [] })),
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      onDbChanged: vi.fn(() => () => undefined),
    },
  });
}
