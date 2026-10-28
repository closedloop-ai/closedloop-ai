/**
 * @file sidebar-rollout-assignment.test.tsx
 * @description ISS-8361 — the desktop `Sidebar` mount resolved through the REAL
 * `DesktopFeatureFlagProvider`, not a static adapter.
 *
 * `sidebar-shell-v2.test.tsx` owns the two trees and hands the mount a static
 * flag adapter; `desktop-posthog-flag-cutover.test.tsx` owns the provider and
 * reads it through generic probes. Neither proves the mount site is WIRED to the
 * provider for this key, so a mount that read a local Labs value, or a key the
 * PostHog assignment never carries, would keep both suites green. Here the only
 * stub is the IPC bridge main answers across — the assignment arrives through
 * the same boundary read a shipped launch uses — and every case waits for that
 * assignment to SETTLE before it asserts, so a legacy tree cannot be satisfied
 * by the pending window that renders legacy for everyone.
 *
 * The rollout key is written as a LITERAL on purpose. It is the name of a flag
 * PostHog holds, which this repo does not own: a fixture built from
 * `SHELL_SIDEBAR_V2_FLAG_KEY` would agree with a renamed constant, or with a
 * desktop mount switched onto a different key than the web mount reads, and
 * every case here would stay green while the ramp reached one shell and not
 * the other.
 */

import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import type { DesktopFeatureFlagAssignment } from "@repo/api/src/types/desktop-feature-flags";
import {
  NavigationActorStanding,
  NavigationProjectionStatus,
  type NavigationViewModel,
} from "@repo/api/src/types/navigation-view-model";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import {
  DesktopFeatureFlagProvider,
  useDesktopFeatureFlagsResolved,
} from "../../../feature-flags/desktop-feature-flag-provider";
import { pageTitleForNav } from "../../../navigation/nav-config";
import { NavId } from "../../../navigation/route-table";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { Sidebar } from "../Sidebar";

/** The PostHog flag key, as PostHog spells it. See the file header. */
const ROLLOUT_WIRE_KEY = "shell-sidebar-v2";
/**
 * A LOCAL Labs setting persisted under the rollout key's own name. The desktop
 * renderer used to consult such values; a mount that still did would open v2
 * for this profile while the web shell, which has no Labs store, stayed legacy.
 */
const LOCAL_LABS_VALUE = { [ROLLOUT_WIRE_KEY]: true };
const SIGNED_IN_USER_ID = "user_desktop_rollout";
const OTHER_USER_ID = "user_someone_else";
const DASHBOARD_ROW_NAME = /Dashboard/;

vi.mock(
  "../../../shared-agent-sessions/desktop-auth-provider",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../shared-agent-sessions/desktop-auth-provider")
      >();
    return {
      ...actual,
      useDesktopAuth: () => ({
        state: {
          status: DesktopAuthStatus.Authenticated,
          userId: SIGNED_IN_USER_ID,
        },
        signOut: () => Promise.resolve(),
        signIn: () => Promise.resolve(),
      }),
    };
  }
);
vi.mock("../../../shared-agent-sessions/use-desktop-identity", () => ({
  useDesktopIdentity: () => ({ identity: null, isResolved: true }),
}));
vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: () => null,
}));
vi.mock("@repo/app/onboarding/components/guided-getting-started-card", () => ({
  GuidedGettingStartedCard: () => null,
}));
/**
 * An ERRORED projection is what tells the trees apart without reading a class
 * name, exactly as `sidebar-shell-v2.test.tsx` uses it: a v2 row is built from
 * the fold, so an unread capability leaves it announced but inert, while every
 * legacy row is a link whatever the cloud said. It also holds when a closed
 * assignment takes Labs away, where a nested-Artifacts count cannot.
 */
vi.mock("@repo/app/shell/v2/hooks/use-navigation-view-model", () => ({
  useNavigationViewModel: (): NavigationViewModel => ({
    destinations: {},
    organizationId: null,
    projectionStatus: NavigationProjectionStatus.Error,
    standing: NavigationActorStanding.Unknown,
  }),
}));

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

let originalDesktopApiDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  stubLocalStorage();
  originalDesktopApiDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "desktopApi"
  );
});

afterEach(() => {
  cleanup();
  if (originalDesktopApiDescriptor) {
    Object.defineProperty(window, "desktopApi", originalDesktopApiDescriptor);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  vi.unstubAllGlobals();
});

describe("Sidebar — the rollout key through the real desktop flag provider (ISS-8361)", () => {
  it("mounts v2 when the signed-in account's PostHog assignment turns the key on", async () => {
    installBridge({
      assignment: {
        flags: { [ROLLOUT_WIRE_KEY]: true },
        resolved: true,
        userId: SIGNED_IN_USER_ID,
      },
    });

    renderSidebar();
    await waitForAssignmentSettled();

    const dashboard = await screen.findByRole("button", {
      name: DASHBOARD_ROW_NAME,
    });
    expect(dashboard.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.queryByRole("link", { name: pageTitleForNav(NavId.Dashboard) })
    ).toBeNull();
  });

  // Each case below settles the assignment and then finds the LEGACY row. The
  // positive `link` assertion is what makes the case able to fail: a v2 mount
  // renders that row as a disabled button, never a link.
  it.each([
    [
      "the key is absent from the assignment — PostHog has no such flag yet",
      {
        flags: {},
        resolved: true,
        userId: SIGNED_IN_USER_ID,
      } satisfies DesktopFeatureFlagAssignment,
    ],
    [
      "the assignment turns the key off",
      {
        flags: { [ROLLOUT_WIRE_KEY]: false },
        resolved: true,
        userId: SIGNED_IN_USER_ID,
      } satisfies DesktopFeatureFlagAssignment,
    ],
    [
      "the key is on for a DIFFERENT account",
      {
        flags: { [ROLLOUT_WIRE_KEY]: true },
        resolved: true,
        userId: OTHER_USER_ID,
      } satisfies DesktopFeatureFlagAssignment,
    ],
    [
      "the flag service could not evaluate, whatever the payload carries",
      {
        flags: { [ROLLOUT_WIRE_KEY]: true },
        resolved: false,
        userId: SIGNED_IN_USER_ID,
      } satisfies DesktopFeatureFlagAssignment,
    ],
  ])("keeps the legacy tree when %s", async (_case, assignment) => {
    installBridge({ assignment });

    renderSidebar();
    await waitForAssignmentSettled();

    const dashboard = await screen.findByRole("link", { name: "Dashboard" });
    expect(dashboard.getAttribute("href")).toBe("/dashboard");
  });

  it("keeps the legacy tree when the assignment request fails", async () => {
    installBridge({
      assignment: () => Promise.reject(new Error("flags bridge down")),
    });

    renderSidebar();
    await waitForAssignmentSettled();

    const dashboard = await screen.findByRole("link", { name: "Dashboard" });
    expect(dashboard.getAttribute("href")).toBe("/dashboard");
  });

  it("cannot be opened by a local Labs value under the rollout key's name", async () => {
    installBridge({
      assignment: { flags: {}, resolved: true, userId: SIGNED_IN_USER_ID },
      localLabsFlags: LOCAL_LABS_VALUE,
    });

    renderSidebar();
    await waitForAssignmentSettled();

    const dashboard = await screen.findByRole("link", { name: "Dashboard" });
    expect(dashboard.getAttribute("href")).toBe("/dashboard");
  });
});

function renderSidebar() {
  const memoryNav = createMemoryNavigation({ initialPath: "/dashboard" });
  return render(
    <DesktopAppCoreProvider>
      <NavigationProvider adapter={memoryNav.adapter}>
        <DesktopFeatureFlagProvider>
          <AssignmentSettledProbe />
          <SidebarProvider>
            <Sidebar activeNav={NavId.Dashboard} />
          </SidebarProvider>
        </DesktopFeatureFlagProvider>
      </NavigationProvider>
    </DesktopAppCoreProvider>
  );
}

function AssignmentSettledProbe(): React.ReactNode {
  const resolved = useDesktopFeatureFlagsResolved();
  return <div data-testid="assignment-settled">{String(resolved)}</div>;
}

async function waitForAssignmentSettled(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId("assignment-settled").textContent).toBe("true")
  );
}

/**
 * The main-process bridge, reduced to what the flag provider reads: the auth
 * state it keys the assignment on, the assignment itself, and the LOCAL flag
 * registry a retired adapter used to consult. The E2E seed member is left off,
 * which the provider reads as "no seed" — a shipped launch's answer.
 */
function installBridge({
  assignment,
  localLabsFlags = {},
}: {
  assignment:
    | DesktopFeatureFlagAssignment
    | (() => Promise<DesktopFeatureFlagAssignment | null>);
  localLabsFlags?: Record<string, boolean>;
}): void {
  const bridge = {
    getAllFlags: vi.fn(() =>
      Promise.resolve({
        flags: Object.entries(localLabsFlags).map(([key, value]) => ({
          key,
          value,
        })),
      })
    ),
    getDesktopAuthState: vi.fn(() =>
      Promise.resolve({
        organizationId: "org_desktop_rollout",
        status: DesktopAuthStatus.Authenticated,
        userId: SIGNED_IN_USER_ID,
      })
    ),
    getDesktopFeatureFlags: vi.fn(() =>
      typeof assignment === "function"
        ? assignment()
        : Promise.resolve(assignment)
    ),
    onDesktopAuthStateChanged: vi.fn(() => () => {
      // No account transition in these cases.
    }),
    onFlagsChanged: vi.fn(() => () => {
      // No local flag change in these cases.
    }),
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: bridge,
  });
}
