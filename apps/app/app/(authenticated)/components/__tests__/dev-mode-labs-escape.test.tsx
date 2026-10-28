import { DEV_MODE_FLAG_KEY } from "@repo/api/src/types/dev-mode-flag";
import { DEV_MODE_ESCAPE_TARGET_PROPS } from "@repo/app/shared/feature-flags/dev-mode/dev-mode-escape-focus";
import {
  ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type React from "react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { GlobalSidebar } from "../sidebar";

const LABS_SECTION_TITLE = "Labs";

/**
 * PR #6961 — what happens when the dev-mode toggle unmounts its own switch.
 *
 * Turning dev mode OFF suppresses the two nav-placement flags, so the Labs
 * section — switch included — leaves the tree in the same frame. The two
 * defects this file pins:
 *
 *  - whitlockk: on the v2 workspace tree there is no AccountMenu to fall back to,
 *    so without the footer fallback row the viewer is stranded in the customer
 *    view with no way back.
 *  - davetho (P2): nothing moved focus off the removed switch, stranding
 *    keyboard and screen-reader users at a dead node.
 *
 * Unlike `sidebar-labs-nav-move.test.tsx`, whose flag mock is static, this
 * suite models the SUPPRESSION LOOP: the mocked `useFeatureFlag` subscribes to
 * the same dev-mode store the switch writes, mirroring
 * `packages/analytics/client.ts` + `customer-view.ts` (every non-exempt key
 * settles `false` while dev mode is off; `DEV_MODE_FLAG_KEY` is the one exempt
 * key). That loop is what makes the toggle a real transition here rather than
 * a mocked callback.
 */

const devModeStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { enabled: true };
  return {
    getSnapshot: () => state.enabled,
    reset: () => {
      state.enabled = true;
      listeners.clear();
    },
    set: (enabled: boolean) => {
      state.enabled = enabled;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

const enabledFlags = vi.hoisted(() => new Set<string>());

vi.mock("@repo/app/shared/feature-flags/dev-mode/dev-mode-provider", () => ({
  useDevMode: () => ({
    isDevModeAvailable: true,
    isDevModeEnabled: useSyncExternalStore(
      devModeStore.subscribe,
      devModeStore.getSnapshot,
      devModeStore.getSnapshot
    ),
    setDevModeEnabled: (enabled: boolean) => devModeStore.set(enabled),
  }),
}));

vi.mock("@repo/analytics/client", () => ({
  // The no-PostHog-key shape, which settles from the first render — so the
  // shell's rollout branch reads the same value these cases always gave it.
  postHogFeatureFlagsEnabled: false,
  useFeatureFlagsLoaded: () => true,
  usePostHogDistinctId: () => undefined,
  useFeatureFlag: (flag: string) => {
    const devModeOn = useSyncExternalStore(
      devModeStore.subscribe,
      devModeStore.getSnapshot,
      devModeStore.getSnapshot
    );
    const suppressed = devModeOn ? false : flag !== DEV_MODE_FLAG_KEY;
    return {
      enabled: suppressed ? false : enabledFlags.has(flag),
      key: flag,
      payload: undefined,
      variant: undefined,
    };
  },
}));

vi.mock("@repo/auth/client", () => ({
  useAuth: () => ({ isSignedIn: true }),
  useOrganization: () => ({
    isLoaded: true,
    membership: { role: "org:member" },
    organization: { id: "org-123", slug: "test-org" },
  }),
  useUser: () => ({ isLoaded: true, user: { id: "user-123" } }),
}));

const shellAuthSnapshot = {
  getToken: () => Promise.resolve(null),
  isLoaded: true,
  orgId: "org-123" as string | null,
  userId: "user-1" as string | null,
};

vi.mock("@repo/app/shared/auth/use-auth-snapshot", () => ({
  useAuthSnapshot: () => shellAuthSnapshot,
  useOptionalAuthSnapshot: () => shellAuthSnapshot,
}));

// `sidebar.tsx` imports the v2 mount statically, so its module graph loads on
// the legacy arm too and reaches `shared/query/query-client.ts`, which needs
// react-query exports this file's narrow mock does not provide.
vi.mock("@repo/app/shell/v2/hooks/use-navigation-view-model", async () => {
  const { PENDING_NAVIGATION_VIEW_MODEL } = await vi.importActual<
    typeof import("@repo/api/src/types/navigation-view-model")
  >("@repo/api/src/types/navigation-view-model");
  return { useNavigationViewModel: () => PENDING_NAVIGATION_VIEW_MODEL };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ clear: vi.fn() }),
}));

vi.mock("@repo/design-system/components/ui/sidebar", () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar">{children}</div>
  ),
  SidebarContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-content">{children}</div>
  ),
  SidebarFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-footer">{children}</div>
  ),
  SidebarGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-group">{children}</div>
  ),
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-group-label">{children}</div>
  ),
  SidebarHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-header">{children}</div>
  ),
  SidebarInset: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-inset">{children}</div>
  ),
  SidebarMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu">{children}</div>
  ),
  SidebarMenuButton: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu-button">{children}</div>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu-item">{children}</div>
  ),
  SidebarNavLinkItem: ({
    href,
    title,
  }: {
    href?: string;
    title: React.ReactNode;
  }) => (
    <div data-testid="sidebar-nav-link-item">
      {href ? <a href={href}>{title}</a> : <span>{title}</span>}
    </div>
  ),
  SidebarSeparator: () => <div data-testid="sidebar-separator" />,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "test-org" }),
  usePathname: () => "/test-org",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/environment", () => ({ appEnvironment: "local" }));
vi.mock("../search", () => ({ Search: () => <div>Search</div> }));
vi.mock("../sidebar-teams", () => ({
  SidebarTeams: () => <div data-testid="sidebar-teams">Teams</div>,
}));
vi.mock("../workspace-header", () => ({
  WorkspaceHeader: () => <div data-testid="workspace-header" />,
}));
vi.mock("../guided-onboarding-dialog-host", () => ({
  WebGuidedOnboardingDialogHost: () => null,
}));
vi.mock("../inbox-badge", () => ({ InboxBadge: () => null }));
vi.mock("@repo/app/agents/components/agents-nav-badge", () => ({
  AgentsNavBadge: () => null,
}));
vi.mock("@repo/app/onboarding/components/guided-getting-started-card", () => ({
  GuidedGettingStartedCard: () => null,
}));
vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: ({ trigger }: { trigger?: React.ReactNode }) => (
    <div data-testid="invite-team-dialog">{trigger}</div>
  ),
}));

// A stub, but marked with the REAL escape-target props: that the production
// trigger carries the attribute is pinned against the real component in
// `account-menu.test.tsx`; what THIS suite proves is that the Labs switch's
// off-transition hands focus to whatever carries the marker.
vi.mock("../account-menu", () => ({
  AccountMenu: () => (
    <button type="button" {...DEV_MODE_ESCAPE_TARGET_PROPS}>
      Account Menu
    </button>
  ),
}));

function renderSidebar() {
  render(
    <GlobalSidebar>
      <button type="button">Content action</button>
    </GlobalSidebar>,
    { wrapper: WebFeatureFlagProvider }
  );
}

function labsSection(): HTMLElement {
  const section = screen.getAllByTestId("sidebar-group").find(
    (candidate) =>
      within(candidate).queryByRole("button", {
        name: LABS_SECTION_TITLE,
      }) !== null
  );
  if (!section) {
    throw new Error("No Labs sidebar section was rendered");
  }
  return section;
}

function footer(): HTMLElement {
  return screen.getByTestId("sidebar-footer");
}

function devModeSwitch(scope: HTMLElement): HTMLElement {
  return within(scope).getByRole("switch", { name: "Dev mode" });
}

function queryDevModeSwitch(scope: HTMLElement): HTMLElement | null {
  return within(scope).queryByRole("switch", { name: "Dev mode" });
}

beforeEach(() => {
  devModeStore.reset();
  enabledFlags.clear();
  enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
  enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);
  globalThis.localStorage.clear();
});

afterEach(cleanup);

describe("PR #6961 — the workspace tree keeps a way back out of the customer view", () => {
  test("turning dev mode off from Labs leaves a footer switch that turns it back on", () => {
    renderSidebar();

    // The switch's one home while Labs is on: inside Labs, not the
    // footer. Both halves asserted so the round trip below is a real move.
    expect(devModeSwitch(labsSection())).toBeInTheDocument();
    expect(queryDevModeSwitch(footer())).toBeNull();

    fireEvent.click(devModeSwitch(labsSection()));

    // Suppression removed the Labs section entirely — the correct customer
    // view — and the footer now carries the way back. The defect was this
    // switch being NOWHERE: the tree renders no AccountMenu to fall back to.
    expect(
      screen.queryByRole("button", { name: LABS_SECTION_TITLE })
    ).toBeNull();
    const fallback = devModeSwitch(footer());
    expect(fallback).toHaveAttribute("aria-checked", "false");

    fireEvent.click(fallback);

    // Round trip: Labs is back, the switch went home with it, and there is
    // exactly one switch — the fallback did not linger as a duplicate.
    expect(devModeSwitch(labsSection())).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(queryDevModeSwitch(footer())).toBeNull();
    expect(screen.getAllByRole("switch", { name: "Dev mode" })).toHaveLength(1);
  });
});

describe("PR #6961 P2 — the transition hands orphaned focus to the durable escape target", () => {
  test("the off-transition focuses the footer fallback switch", async () => {
    renderSidebar();

    fireEvent.click(devModeSwitch(labsSection()));

    await waitFor(() => expect(devModeSwitch(footer())).toHaveFocus());
  });

  test("the on-transition focuses the switch back in Labs", async () => {
    devModeStore.set(false);
    renderSidebar();

    fireEvent.click(devModeSwitch(footer()));

    await waitFor(() => expect(devModeSwitch(labsSection())).toHaveFocus());
  });

  test("focus that survived the transition is never stolen", async () => {
    renderSidebar();
    const survivor = screen.getByRole("button", { name: "Content action" });
    survivor.focus();

    fireEvent.click(devModeSwitch(labsSection()));

    // The fallback mounted (the transition happened) …
    expect(devModeSwitch(footer())).toBeInTheDocument();
    // … and after the hand-off's microtask, the still-mounted focus owner —
    // here a control outside the sidebar — kept it.
    await Promise.resolve();
    expect(survivor).toHaveFocus();
  });
});

/**
 * ISS-11248 — the customer-view route to a closed Labs container.
 *
 * AC1 names two routes to `labs-nav-section` being false, and this is the one a
 * real customer takes: dev mode goes off, `packages/analytics/client.ts`
 * suppresses every non-exempt key, and the container closes for a viewer whose
 * PostHog assignment is ON. This suite's mock models that loop rather than
 * hardcoding `false`, so the transition here is the production one — which is
 * why the case lives beside the escape-focus cases and not in the static-flag
 * suite.
 */
describe("ISS-11248 — suppression hides Your Teams", () => {
  test("the customer view leaves Your Teams nowhere, and keeps the way back", () => {
    renderSidebar();

    // Dev mode is ON, the assignment is ON, so the internal surface renders —
    // the positive on the exact locator the post-transition null uses.
    expect(within(labsSection()).getByTestId("sidebar-teams")).toBeTruthy();

    fireEvent.click(devModeSwitch(labsSection()));

    // Suppression settled `labs-nav-section` false. Before ISS-11248 the
    // surface reappeared in its pre-Labs home at exactly this moment, which
    // is the reported defect: the customer view is the state most likely to be
    // looked at by a customer.
    expect(
      screen.queryByRole("button", { name: LABS_SECTION_TITLE })
    ).toBeNull();
    expect(screen.queryByTestId("sidebar-teams")).toBeNull();
    // AC2, same render: the exempt `DEV_MODE_FLAG_KEY` still resolves, so the
    // viewer is not stranded.
    expect(devModeSwitch(footer())).toHaveAttribute("aria-checked", "false");
  });
});
