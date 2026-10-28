import {
  AGENTS_NAV_FEATURE_FLAG_KEY,
  ArtifactFlag,
  ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { ShellNavigationRouteId } from "@repo/app/shared/lib/shell-navigation-contract";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import {
  GlobalSidebar,
  LABS_MOVED_NAV_SECTION_STORAGE_KEY,
  LABS_NAV_SECTION_STORAGE_KEY,
} from "../sidebar";
import { primaryNavTitle } from "./primary-nav-title.test-helpers";

const LABS_SECTION_TITLE = "Labs";

/**
 * ISS-8759 — the web sidebar's Labs regrouping.
 *
 * Lives beside `sidebar.test.tsx` rather than inside it: that file is already
 * at ~990 logical lines and the 1,000-line ceiling is a lint error.
 *
 * The permutation that matters is the NESTED one. Two gates stack here — this
 * move's own flag, and the Labs CONTAINER flag whose pre-resolution render is
 * `null` — so turning both off exercises neither. Every case below names both.
 */

const enabledFlags = new Set<string>();

const mockUseFeatureFlag = vi.fn((flag: string) => ({
  key: flag,
  enabled: enabledFlags.has(flag),
  variant: undefined,
  payload: undefined,
}));

const mockUseOrganization = vi.fn();
const mockUseParams = vi.fn();

const ALL_ITEM_FLAGS = [
  ArtifactFlag.Documents,
  ArtifactFlag.Issues,
  AGENTS_NAV_FEATURE_FLAG_KEY,
];

vi.mock("@repo/auth/client", () => ({
  CreateOrganization: () => null,
  useAuth: () => ({ isSignedIn: true }),
  useClerk: () => ({ signOut: vi.fn() }),
  useOrganization: () => mockUseOrganization(),
  useOrganizationList: () => ({ isLoaded: true, userMemberships: null }),
  useUser: () => ({
    isLoaded: true,
    user: {
      fullName: "Test User",
      imageUrl: null,
      primaryEmailAddress: { emailAddress: "test@example.com" },
    },
  }),
}));

vi.mock("@repo/app/desktop/hooks/use-electron-release", () => ({
  useLatestElectronRelease: () => ({
    data: null,
    isError: false,
    isPending: false,
  }),
}));

// The menu's own presentation and item sets are pinned in packages/app; here
// it is a marker, so this suite's assertions stay about the Labs nav.
vi.mock(
  "@repo/app/settings/v2/components/workspace-menu/workspace-menu",
  () => ({
    WorkspaceMenu: () => <div data-testid="workspace-menu">Workspace</div>,
  })
);

vi.mock("@repo/analytics/client", () => ({
  // The no-PostHog-key shape, which settles from the first render — so the
  // shell's rollout branch reads the same value these cases always gave it.
  postHogFeatureFlagsEnabled: false,
  useFeatureFlag: (flag: string) => mockUseFeatureFlag(flag),
  useFeatureFlagsLoaded: () => true,
  usePostHogDistinctId: () => undefined,
}));

const shellAuthSnapshot = {
  getToken: () => Promise.resolve(null),
  isLoaded: true,
  orgId: "org_a" as string | null,
  userId: "user_a" as string | null,
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

// ISS-12135: the workspace menu's org-name read is a query this suite's
// react-query mock does not serve; `null` keeps the menu on Clerk's name.
vi.mock(
  "@/lib/workspace-menu-host/use-active-organization-record-name",
  () => ({
    useActiveOrganizationRecordName: () => null,
  })
);

vi.mock("@repo/design-system/components/ui/sidebar", () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar">{children}</div>
  ),
  SidebarHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-header">{children}</div>
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
  SidebarInset: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-inset">{children}</div>
  ),
  SidebarMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu">{children}</div>
  ),
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-group-label">{children}</div>
  ),
  SidebarNavLinkItem: ({
    href,
    title,
    trailing,
  }: {
    href?: string;
    title: React.ReactNode;
    trailing?: React.ReactNode;
  }) => (
    <div data-testid="sidebar-nav-link-item">
      {href ? <a href={href}>{title}</a> : <span>{title}</span>}
      {trailing}
    </div>
  ),
  SidebarMenuButton: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu-button">{children}</div>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu-item">{children}</div>
  ),
  // ISS-9888: this factory REPLACES the module, so every export the tree
  // reaches has to be here — a missing one fails the render itself rather than
  // the behaviour under test. Rendered as a real node so the separator the Labs
  // controls open with is assertable, not silently swallowed.
  SidebarSeparator: () => <div data-testid="sidebar-separator" />,
}));

// All THREE navigation hooks, per `apps/app/AGENTS.md`. `useSearchParams` is
// not read by anything this suite renders today — `<Search />` is stubbed — but
// the factory REPLACES the module, so a consumer that reaches the navigation
// port indirectly fails on a missing export rather than on its own behavior.
vi.mock("next/navigation", () => ({
  useParams: () => mockUseParams(),
  usePathname: vi.fn(() => "/test-org"),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock("@/lib/environment", () => ({ appEnvironment: "local" }));

vi.mock("../search", () => ({
  Search: () => <div data-testid="search">Search</div>,
}));

vi.mock("../sidebar-teams", () => ({
  SidebarTeams: () => <div data-testid="sidebar-teams">Teams</div>,
}));

vi.mock("../guided-onboarding-dialog-host", () => ({
  WebGuidedOnboardingDialogHost: () => null,
}));

// Rendered as a real node, not `null`: this suite's whole point is that a row
// changing SECTION keeps the badge that rides on it, and a badge stubbed to
// `null` cannot tell a carried badge from a dropped one.
vi.mock("../inbox-badge", () => ({
  InboxBadge: () => <span data-testid="inbox-badge" />,
}));

vi.mock("@repo/app/agents/components/agents-nav-badge", () => ({
  AgentsNavBadge: () => <span data-testid="agents-nav-badge" />,
}));

vi.mock("@repo/app/onboarding/components/guided-getting-started-card", () => ({
  GuidedGettingStartedCard: () => null,
}));

// ISS-9891. The PROVIDER is stubbed, not the component: `DevModeSidebarItem`
// renders for real, so what is asserted below is the shipped switch — its role,
// its accessible name, and the call it emits — rather than a placeholder that
// would sit happily in the wrong section. Eligibility is pinned available
// because placement is this suite's subject; the eligibility gate itself is
// covered in the component's own suite.
const mockSetDevModeEnabled = vi.fn();
const devModeState = {
  isDevModeAvailable: true,
  isDevModeEnabled: true,
  setDevModeEnabled: (enabled: boolean) => mockSetDevModeEnabled(enabled),
};

vi.mock("@repo/app/shared/feature-flags/dev-mode/dev-mode-provider", () => ({
  useDevMode: () => devModeState,
}));

vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: ({ trigger }: { trigger?: React.ReactNode }) => (
    <div data-testid="invite-team-dialog">{trigger}</div>
  ),
}));

function renderSidebar() {
  render(
    <GlobalSidebar>
      <div>Content</div>
    </GlobalSidebar>,
    { wrapper: WebFeatureFlagProvider }
  );
}

/** The `SidebarGroup` whose collapsible trigger carries the given label. */
function sectionNamed(name: string): HTMLElement {
  const section = screen
    .getAllByTestId("sidebar-group")
    .find(
      (candidate) => within(candidate).queryByRole("button", { name }) !== null
    );
  if (!section) {
    throw new Error(`No sidebar section labelled "${name}" was rendered`);
  }
  return section;
}

function labsSection(): HTMLElement {
  return sectionNamed(LABS_SECTION_TITLE);
}

function signInAs(role: string) {
  mockUseOrganization.mockReturnValue({
    organization: { id: "org-123", slug: "test-org" },
    isLoaded: true,
    membership: { role },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  enabledFlags.clear();
  // `SidebarCollapsibleSection` is NOT stubbed by this suite, so its real
  // localStorage persistence runs. Clearing keeps one case's collapse from
  // deciding the next one's first render.
  globalThis.localStorage.clear();
  mockUseParams.mockReturnValue({ orgSlug: "test-org" });
  signInAs("org:admin");
});

afterEach(cleanup);

describe("ISS-8759 — Search moves under Labs (AC3)", () => {
  test("renders Search inside the Labs section, and nowhere else, when Labs is on", () => {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);

    renderSidebar();

    // Exactly one Search in the whole shell, and it is the one under Labs —
    // so this cannot pass by rendering it in both places.
    expect(screen.getAllByTestId("search")).toHaveLength(1);
    expect(within(labsSection()).getByTestId("search")).toBeInTheDocument();
  });

  // Operator ruling 2026-09-01: "search should not be visible when Labs is not
  // present or collapsed." This case previously asserted the opposite — that
  // Search was pinned outside the collapsible body and survived a collapse —
  // and it is inverted here because that behaviour was deliberately retired,
  // not because it went red.
  test("hides Search with the rows when the user collapses the Labs section", () => {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);

    renderSidebar();

    const labs = labsSection();
    // Positive sibling first: both are there while the section is open, so the
    // post-collapse assertions are about the collapse and not about the move.
    expect(within(labs).getByTestId("search")).toBeInTheDocument();
    expect(
      within(labs).getByRole("link", { name: "Inbox" })
    ).toBeInTheDocument();

    fireEvent.click(
      within(labs).getByRole("button", { name: LABS_SECTION_TITLE })
    );

    // Search shares the rows' fate now: it lives inside the collapsible body,
    // so a collapse takes it away with them.
    expect(within(labsSection()).queryByTestId("search")).toBeNull();
    expect(
      within(labsSection()).queryByRole("link", {
        name: primaryNavTitle(ShellNavigationRouteId.Inbox),
      })
    ).toBeNull();
    // Gone from the whole shell, not merely relocated out of the section.
    expect(screen.queryByTestId("search")).toBeNull();
    // Positive sibling for those three absences: the section itself is still
    // rendered and collapsed, so this is the disclosure and not an empty tree.
    expect(
      within(labsSection()).getByRole("button", { name: LABS_SECTION_TITLE })
    ).toBeInTheDocument();
  });

  test("keeps Search above the nav when the Labs container is off", () => {
    renderSidebar();

    // ISS-10244: the container answers WHERE the moved surfaces render, not
    // whether they render at all. With Labs absent the sidebar reads through
    // the pre-move grouping, so Search is back above the nav rather than gone —
    // the operator's "not visible when Labs is not present" ruling scoped the
    // moved layout, and outside it there is no Labs for Search to be inside of.
    expect(screen.getAllByTestId("search")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: LABS_SECTION_TITLE })
    ).toBeNull();
    // Positive sibling — the shell did render, so the missing disclosure above
    // is the gate's doing and not an empty tree.
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
  });
});

describe("ISS-8759 — what stays and what moves (AC1)", () => {
  test("keeps Dashboard, Sessions and Branches out of Labs", () => {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);

    renderSidebar();

    const labs = labsSection();
    for (const stayed of ["Dashboard", "Sessions", "Branches"]) {
      expect(screen.getByRole("link", { name: stayed })).toBeInTheDocument();
      expect(within(labs).queryByRole("link", { name: stayed })).toBeNull();
    }
    // Sessions and Branches keep the Artifacts section, they are not orphaned
    // into the top-level group.
    const artifacts = sectionNamed("Artifacts");
    expect(
      within(artifacts).getByRole("link", { name: "Sessions" })
    ).toBeInTheDocument();
    expect(
      within(artifacts).getByRole("link", { name: "Branches" })
    ).toBeInTheDocument();
  });

  test("keeps Documents and Issues in Artifacts, ahead of Sessions and Branches", () => {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    for (const flag of ALL_ITEM_FLAGS) {
      enabledFlags.add(flag);
    }

    renderSidebar();

    const labs = labsSection();
    const artifacts = sectionNamed("Artifacts");
    expect(
      within(artifacts)
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(["Documents", "Issues", "Sessions", "Branches"]);
    for (const stayed of ["Documents", "Issues"]) {
      expect(within(labs).queryByRole("link", { name: stayed })).toBeNull();
      expect(screen.getAllByRole("link", { name: stayed })).toHaveLength(1);
    }
  });

  test("moves every other destination and the Your Teams section into Labs", () => {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    for (const flag of ALL_ITEM_FLAGS) {
      enabledFlags.add(flag);
    }

    renderSidebar();

    const labs = labsSection();
    for (const moved of ["Inbox", "My Tasks", "Agents"]) {
      expect(
        within(labs).getByRole("link", { name: moved })
      ).toBeInTheDocument();
      // One statement per destination: it is in Labs and only in Labs.
      expect(screen.getAllByRole("link", { name: moved })).toHaveLength(1);
    }
    expect(within(labs).getByTestId("sidebar-teams")).toBeInTheDocument();
    expect(screen.getAllByTestId("sidebar-teams")).toHaveLength(1);
  });

  test("keeps every destination in the nav when the Labs container is off", () => {
    for (const flag of ALL_ITEM_FLAGS) {
      enabledFlags.add(flag);
    }

    renderSidebar();

    // ISS-10244's whole reason for keeping a second shape. `LabsNavSection`
    // renders `null` with the container off, so reading the canonical list
    // through `labsMovedNavGroup` here would take all five of these rows out of
    // the sidebar entirely — for every account outside the `labs-nav-section`
    // rollout AND for every viewer in the customer view, where that key is
    // suppressed. Each name is asserted present, which is the mutation a single
    // unconditional `LABS_MOVED_SIDEBAR_SHAPE` kills.
    //
    // Your Teams is deliberately NOT in this list: ISS-11248 retired its
    // pre-Labs home, so a closed container removes it rather than re-homing it.
    // Pinned in the ISS-11248 describe below.
    for (const kept of ["Inbox", "My Tasks", "Documents", "Issues", "Agents"]) {
      expect(screen.getByRole("link", { name: kept })).toBeInTheDocument();
    }
    // Positive sibling for the position: Labs really is off.
    expect(
      screen.queryByRole("button", { name: LABS_SECTION_TITLE })
    ).toBeNull();
  });
});

describe("ISS-8759 — reachability of the moved rows", () => {
  test("AC6 — moved rows keep their org-scoped hrefs, so a deep link still resolves", () => {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    for (const flag of ALL_ITEM_FLAGS) {
      enabledFlags.add(flag);
    }

    renderSidebar();

    const labs = labsSection();
    const expectedHrefs: Record<string, string> = {
      Inbox: "/test-org/inbox",
      "My Tasks": "/test-org/my-tasks",
      Agents: "/test-org/agents",
    };
    for (const [name, href] of Object.entries(expectedHrefs)) {
      expect(within(labs).getByRole("link", { name })).toHaveAttribute(
        "href",
        href
      );
    }
  });

  test("AC5 — a NON-ADMIN member sees Search and every moved row inside Labs", () => {
    signInAs("org:member");
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    for (const flag of ALL_ITEM_FLAGS) {
      enabledFlags.add(flag);
    }

    renderSidebar();

    const labs = labsSection();
    expect(within(labs).getByTestId("search")).toBeInTheDocument();
    for (const moved of ["Inbox", "My Tasks", "Agents"]) {
      expect(
        within(labs).getByRole("link", { name: moved })
      ).toBeInTheDocument();
    }
  });

  test("carries the Inbox and Agents badges into Labs with their rows", () => {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(AGENTS_NAV_FEATURE_FLAG_KEY);

    renderSidebar();

    const labs = labsSection();
    expect(within(labs).getByTestId("inbox-badge")).toBeInTheDocument();
    expect(within(labs).getByTestId("agents-nav-badge")).toBeInTheDocument();
  });

  test("keeps a moved row's own per-item flag authoritative inside Labs", () => {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    // Agents' flag deliberately left off.

    renderSidebar();

    const labs = labsSection();
    expect(
      within(labs).queryByRole("link", {
        name: primaryNavTitle(ShellNavigationRouteId.Agents),
      })
    ).toBeNull();
    // Positive sibling: an ungated moved row renders, so the null above is
    // the per-item gate and not a broken Labs render. Agents rendering with
    // its flag on is pinned by the badge test above.
    expect(
      within(labs).getByRole("link", { name: "My Tasks" })
    ).toBeInTheDocument();
  });
});

/**
 * The Labs section persists its expanded state in localStorage, and before
 * ISS-8759 that section held five optional extras. After the move it also holds
 * Your Teams and six routes, so a pre-rollout "I collapsed Labs" is a
 * preference about a section that no longer exists — reusing its key would
 * hydrate the moved section closed and strand the user on
 * Dashboard/Sessions/Branches plus a collapsed header.
 *
 * `SidebarCollapsibleSection` is deliberately left UNSTUBBED here: the defect
 * lives in its real read/write, so a stub would assert nothing.
 */
describe("ISS-8759 — the moved Labs section persists under its own key", () => {
  function enableMovedShape() {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    for (const flag of ALL_ITEM_FLAGS) {
      enabledFlags.add(flag);
    }
  }

  test("a pre-rollout collapsed Labs does not hide Your Teams or the moved rows", () => {
    globalThis.localStorage.setItem(LABS_NAV_SECTION_STORAGE_KEY, "false");
    enableMovedShape();

    renderSidebar();

    const labs = labsSection();
    expect(within(labs).getByTestId("sidebar-teams")).toBeInTheDocument();
    expect(
      within(labs).getByRole("link", { name: "Inbox" })
    ).toBeInTheDocument();
  });

  test("collapsing the moved section leaves the pre-move preference untouched, so a rollback restores it", () => {
    enableMovedShape();

    renderSidebar();

    fireEvent.click(
      within(labsSection()).getByRole("button", { name: LABS_SECTION_TITLE })
    );

    expect(
      globalThis.localStorage.getItem(LABS_MOVED_NAV_SECTION_STORAGE_KEY)
    ).toBe("false");
    expect(
      globalThis.localStorage.getItem(LABS_NAV_SECTION_STORAGE_KEY)
    ).toBeNull();
  });
});

/**
 * ISS-9891 (dev-mode switch) — the non-nav CONTROL Labs takes over.
 *
 * It is owned by Labs exactly when the Labs container renders, and has a
 * fallback home when Labs is absent — it is the way back out of the customer
 * view that closed Labs.
 */
describe("ISS-9891 — the Labs section takes the dev-mode switch", () => {
  function footer(): HTMLElement {
    return screen.getByTestId("sidebar-footer");
  }

  function devModeSwitch(scope: HTMLElement) {
    return within(scope).queryByRole("switch", { name: "Dev mode" });
  }

  test("the switch renders under Labs and nowhere else when Labs is on", () => {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);

    renderSidebar();

    const labs = labsSection();
    // Exactly one in the whole shell, and it is the one under Labs, so the case
    // cannot pass by rendering the control in both places.
    expect(screen.getAllByRole("switch", { name: "Dev mode" })).toHaveLength(1);
    expect(devModeSwitch(labs)).toBeInTheDocument();
  });

  test("a rule marks where the destinations end and the controls begin", () => {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);

    renderSidebar();

    // The seam is part of the placement, not decoration: without it the two
    // operate-style rows read as two more nav destinations. It belongs to the
    expect(
      within(labsSection()).getByTestId("sidebar-separator")
    ).toBeInTheDocument();
  });

  test("the moved dev-mode switch still operates the choice", () => {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);

    renderSidebar();

    const moved = within(labsSection()).getByRole("switch", {
      name: "Dev mode",
    });
    expect(moved).toHaveAttribute("aria-checked", "true");

    fireEvent.click(moved);

    // A moved-but-unwired control passes "it renders under Labs". This is the
    // assertion it fails: the switch in its new home still reaches the store.
    expect(mockSetDevModeEnabled).toHaveBeenCalledWith(false);
  });

  test("when Labs is off, only the dev-mode switch keeps a fallback home", () => {
    renderSidebar();

    // ISS-11248. The switch survives because it is the escape hatch.
    expect(devModeSwitch(footer())).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: LABS_SECTION_TITLE })
    ).toBeNull();
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
  });

  test("the moved controls share the section's fate when Labs is collapsed", () => {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);

    renderSidebar();

    const labs = labsSection();
    // Positive sibling first, so the post-collapse null is about the collapse
    // and not about the move.
    expect(devModeSwitch(labs)).toBeInTheDocument();

    fireEvent.click(
      within(labs).getByRole("button", { name: LABS_SECTION_TITLE })
    );

    expect(screen.queryByRole("switch", { name: "Dev mode" })).toBeNull();
    // The disclosure is still there — this is a collapse, not an empty tree.
    expect(
      within(labsSection()).getByRole("button", { name: LABS_SECTION_TITLE })
    ).toBeInTheDocument();
  });

  test("AC5 — a NON-ADMIN member gets the moved switch", () => {
    signInAs("org:member");
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);

    renderSidebar();

    const labs = labsSection();
    expect(devModeSwitch(labs)).toBeInTheDocument();
  });
});

/**
 * ISS-11248 — Your Teams is HIDDEN when Labs is absent.
 *
 * Reported on production web: it rendered in its pre-Labs home whenever
 * `labs-nav-section` resolved false, which the ISS-7477 customer view forces for
 * every viewer who turns dev mode off — so a customer was the likeliest person
 * to see an internal-only surface. Desktop has never rendered it. The operator
 * ruled on 2026-09-26 that there is no fallback placement for it.
 *
 * Every absence below is paired with a positive on the SAME locator, in the
 * flag-ON render, because `queryByTestId(...) === null` is equally satisfied by
 * a typo, a render that threw, a missing provider, or an unsettled mount. The
 * dev-mode positive is asserted in the very same disabled-flag render as the
 * absence, so a diff that hides both cannot pass.
 */
describe("ISS-11248 — the container-absent shape hides Your Teams", () => {
  function footer(): HTMLElement {
    return screen.getByTestId("sidebar-footer");
  }

  test("renders no Your Teams, and keeps the dev-mode switch", () => {
    for (const flag of ALL_ITEM_FLAGS) {
      enabledFlags.add(flag);
    }

    renderSidebar();

    // The shell really mounted and really settled on the container-absent
    // shape — so the nulls below are the ruling, not an empty tree.
    expect(
      screen.queryByRole("button", { name: LABS_SECTION_TITLE })
    ).toBeNull();
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-footer")).toBeInTheDocument();

    // Absent, not relocated: nowhere in the shell, footer included.
    expect(screen.queryByTestId("sidebar-teams")).toBeNull();
    expect(within(footer()).queryByTestId("sidebar-teams")).toBeNull();

    // AC2, same render: the escape hatch out of the customer view survives.
    expect(
      within(footer()).getByRole("switch", { name: "Dev mode" })
    ).toBeInTheDocument();
  });

  test("Your Teams DOES render on the flag-on path, on the same locator", () => {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    for (const flag of ALL_ITEM_FLAGS) {
      enabledFlags.add(flag);
    }

    renderSidebar();

    // The counterfactual for the case above: this id and these matchers find
    // real nodes in this harness, so the nulls there are the gate's doing and
    // not a broken query.
    const labs = labsSection();
    expect(within(labs).getByTestId("sidebar-teams")).toBeInTheDocument();
    expect(
      within(labs).getByRole("switch", { name: "Dev mode" })
    ).toBeInTheDocument();
  });
});

describe("the split gate — shape and menu move independently", () => {
  test("applies the moved shape with no Labs menu when only the shape key is on", () => {
    // The rollout this split exists for: `labs-nav-section` at 100% so every
    // viewer gets the moved layout, `enable-labs-nav-section` closed so the
    // internal menu stays off. One key could not express it.
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    for (const flag of ALL_ITEM_FLAGS) {
      enabledFlags.add(flag);
    }

    renderSidebar();

    expect(
      screen.queryByRole("button", { name: LABS_SECTION_TITLE })
    ).toBeNull();
    // Moved out of the nav by the shape key, and not re-homed anywhere else.
    for (const moved of ["Inbox", "My Tasks"]) {
      expect(screen.queryByRole("link", { name: moved })).toBeNull();
    }
    // Positive siblings on the SAME queries, so the nulls above are the gates
    // and not a locator that never resolves in this harness.
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-footer")).toBeInTheDocument();
  });

  test("renders the Labs menu with those destinations when both keys are on", () => {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    for (const flag of ALL_ITEM_FLAGS) {
      enabledFlags.add(flag);
    }

    renderSidebar();

    const labs = labsSection();
    for (const moved of ["Inbox", "My Tasks"]) {
      expect(
        within(labs).getByRole("link", { name: moved })
      ).toBeInTheDocument();
    }
  });

  // The shape at 100% with the menu shut takes `LabsControls` — and with it the
  // dev-mode switch — off the screen, so the footer fallback has to key off the
  // MENU rather than the shape. A shape-only predicate here leaves the whole
  // legacy shell with no way INTO the customer view.
  test("keeps the dev-mode switch in the footer when the menu key alone is off", () => {
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);

    renderSidebar();

    expect(
      screen.queryByRole("button", { name: LABS_SECTION_TITLE })
    ).toBeNull();
    expect(
      within(screen.getByTestId("sidebar-footer")).getByRole("switch", {
        name: "Dev mode",
      })
    ).toBeInTheDocument();
  });

  // whitlockk, PR #8156: `enable-labs-nav-section` on with `labs-nav-section` off
  // would render Insights, Packs, Lost work, TokenOps waste, Judges and Help as
  // links whose ROUTES still gate on `labs-nav-section` — every click a
  // not-found. `useLabsMenuVisible` ANDs the two, so the combination cannot
  // render a menu at all rather than being documented as unsupported.
  test("renders no Labs menu when the menu key is on but the shape key is off", () => {
    enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    for (const flag of ALL_ITEM_FLAGS) {
      enabledFlags.add(flag);
    }

    renderSidebar();

    expect(
      screen.queryByRole("button", { name: LABS_SECTION_TITLE })
    ).toBeNull();
    // The rows whose routes are gated by the SHAPE key, which is the pairing
    // that would land a click on a not-found.
    for (const gated of ["Insights", "Packs", "Lost work"]) {
      expect(screen.queryByRole("link", { name: gated })).toBeNull();
    }
    // The pre-move nav is intact around them, so the nulls above are the gate
    // and not an unrendered shell.
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Documents" })).toBeInTheDocument();
  });
});
