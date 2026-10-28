import {
  AGENTS_NAV_FEATURE_FLAG_KEY,
  ArtifactFlag,
  ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  LOST_WORK_NAV_FEATURE_FLAG_KEY,
  SHELL_SIDEBAR_V2_FEATURE_FLAG_KEY,
  TOKENOPS_WASTE_NAV_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { ShellNavigationRouteId } from "@repo/app/shared/lib/shell-navigation-contract";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import {
  GlobalSidebar,
  JUDGES_NAV_TITLE,
  LABS_MOVED_NAV_SECTION_STORAGE_KEY,
} from "../sidebar";
import { primaryNavTitle } from "./primary-nav-title.test-helpers";

const LABS_SECTION_TITLE = "Labs";
const INSIGHTS_NAV_TITLE = "Insights";
const PACKS_NAV_TITLE = "Packs";

const sidebarHarness = vi.hoisted(() => ({
  guidedGettingStartedCard: vi.fn(),
  pathname: "/test-org",
  searchParams: new URLSearchParams(),
}));

// Mock dependencies
const mockQueryClientClear = vi.fn();
// One stable client identity per test. The org-change clear now hangs its
// "which org does this cache hold" marker off the QueryClient itself
// (ISS-7344), so a fresh object per render would hide a missed clear; a fresh
// object per TEST keeps that marker from leaking across cases.
let mockQueryClient = { clear: mockQueryClientClear };
const mockUseOrganization = vi.fn();
const mockUseParams = vi.fn();
const AGENT_SESSIONS_DASHBOARD_LINK_RE = /agent sessions dashboard/i;
/** The web path PRD-797 retired; written out because no constant names it now. */
const RETIRED_ROUTINES_PATH = "/routines";

const flagResult = (flag: string, enabled: boolean) => ({
  key: flag,
  enabled,
  variant: undefined,
  payload: undefined,
});

// Defaults to every flag enabled EXCEPT the sidebar rollout key (PLN-2016 M2).
// `GlobalSidebar` now picks between two whole sidebars on that key, so an
// all-true fixture would move this entire file onto the v2 tree without a
// single assertion changing. Every case here is about the legacy tree, which is
// what the key-off population renders; the v2 tree has its own suite.
// Individual tests override the implementation to exercise flag-gated
// visibility.
const mockUseFeatureFlag = vi.fn((flag: string) => flagResult(flag, true));

// ISS-5037: the Labs section is now behind its own container flag, so a test
// that asserts a Labs ITEM (Insights, Judges, Packs) has to open the container
// first. This resolves ONLY the container flag, keeping every per-item flag off
// — which is what makes an item assertion under it meaningful.
const onlyLabsContainerEnabled = (flag: string) =>
  flagResult(
    flag,
    flag === LABS_NAV_SECTION_FEATURE_FLAG_KEY ||
      flag === ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY
  );

// Mock @repo/auth/client
vi.mock("@repo/auth/client", () => ({
  CreateOrganization: () => null,
  useClerk: () => ({ signOut: vi.fn() }),
  useOrganizationList: () => ({ isLoaded: true, userMemberships: null }),
  useUser: () => ({
    isLoaded: true,
    user: {
      fullName: "Test User",
      imageUrl: null,
      primaryEmailAddress: { emailAddress: "test@example.com" },
    },
  }),
  useOrganization: () => mockUseOrganization(),
  // GlobalSidebar renders useOrgSlug, which reads isSignedIn to gate its
  // dev-only throw; the tests supply an org slug so the throw is never reached.
  useAuth: () => ({ isSignedIn: true }),
}));

// The rollout key is forced OFF at the MOCK BOUNDARY, above every per-case
// override (PLN-2016 M2). Several cases below install their own
// `mockImplementation` — `onlyLabsContainerEnabled` among them — and any that
// answered `true` for every key would swap this whole file onto the v2 tree,
// where the first hook reaches a real API client and throws for want of a
// provider. This file is the legacy tree's suite; the v2 tree has its own.
vi.mock("@repo/analytics/client", () => ({
  // The no-PostHog-key shape: the shell's rollout branch waits for an answer
  // that describes the signed-in user, and this build settles from the first
  // render, so every case here renders exactly as it did.
  postHogFeatureFlagsEnabled: false,
  useFeatureFlag: (flag: string) =>
    flag === SHELL_SIDEBAR_V2_FEATURE_FLAG_KEY
      ? flagResult(flag, false)
      : mockUseFeatureFlag(flag),
  useFeatureFlagsLoaded: () => true,
  usePostHogDistinctId: () => undefined,
}));

// The shell reads the signed-in identity through this port, so it has to
// resolve here. Defaults to a signed-in member, so every pre-existing case in
// this file renders exactly as before.
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

// Mock @tanstack/react-query
vi.mock("@repo/app/desktop/hooks/use-electron-release", () => ({
  useLatestElectronRelease: () => ({
    data: null,
    isError: false,
    isPending: false,
  }),
}));

// The menu's own presentation is pinned in packages/app; here it is a marker,
// so these assertions stay about the shell that mounts it.
vi.mock(
  "@repo/app/settings/v2/components/workspace-menu/workspace-menu",
  () => ({
    WorkspaceMenu: () => <div data-testid="workspace-menu">Workspace</div>,
  })
);

// The legacy arm never calls this hook, but `sidebar.tsx` imports the v2 mount
// statically, so its module graph loads either way — and it reaches
// `shared/query/query-client.ts`, which needs react-query exports this file's
// narrow mock does not provide. Stubbing the hook keeps that graph out of the
// legacy arm's suite entirely.
vi.mock("@repo/app/shell/v2/hooks/use-navigation-view-model", async () => {
  const { PENDING_NAVIGATION_VIEW_MODEL } = await vi.importActual<
    typeof import("@repo/api/src/types/navigation-view-model")
  >("@repo/api/src/types/navigation-view-model");
  return { useNavigationViewModel: () => PENDING_NAVIGATION_VIEW_MODEL };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mockQueryClient,
}));

// ISS-12135: the workspace menu's org-name read is a query this suite's
// react-query mock does not serve; `null` keeps the menu on Clerk's name.
vi.mock(
  "@/lib/workspace-menu-host/use-active-organization-record-name",
  () => ({
    useActiveOrganizationRecordName: () => null,
  })
);

// Mock sidebar module completely
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
  SidebarGroupContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-group-content">{children}</div>
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
  SidebarNavLinkItem: ({
    href,
    title,
    icon,
    trailing,
  }: {
    href?: string;
    title: React.ReactNode;
    icon?: React.ReactNode;
    trailing?: React.ReactNode;
  }) => (
    <div data-testid="sidebar-nav-link-item">
      {icon}
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
  // ISS-9888: the factory REPLACES the module, so an export the tree reaches
  // and this list omits fails the render rather than the behaviour under test.
  SidebarSeparator: () => <div data-testid="sidebar-separator" />,
}));

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useParams: () => mockUseParams(),
  usePathname: () => sidebarHarness.pathname,
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  useSearchParams: () => sidebarHarness.searchParams,
}));

// Mock environment lib - default to local
vi.mock("@/lib/environment", () => ({
  appEnvironment: "local",
}));

// Mock other components to simplify testing
vi.mock("../search", () => ({
  Search: () => <div data-testid="search">Search</div>,
}));

vi.mock("../sidebar-teams", () => ({
  SidebarTeams: () => <div data-testid="sidebar-teams">Teams</div>,
}));

vi.mock("../guided-onboarding-dialog-host", () => ({
  WebGuidedOnboardingDialogHost: () => null,
}));

vi.mock("../inbox-badge", () => ({
  InboxBadge: () => null,
}));

// The Agents activity badge reads live session data through the auth/API stack;
// this suite exercises nav structure/flag gating, not the badge, so stub it out
// (its own behavior is covered in agents/components/__tests__/agents-nav-badge).
vi.mock("@repo/app/agents/components/agents-nav-badge", () => ({
  AgentsNavBadge: () => null,
}));

vi.mock("@repo/app/onboarding/components/guided-getting-started-card", () => ({
  GuidedGettingStartedCard: (props: Record<string, unknown>) => {
    sidebarHarness.guidedGettingStartedCard(props);
    return null;
  },
}));

// Mock organization object matching Clerk's OrganizationResource shape
const createMockOrganization = (overrides?: Record<string, unknown>) => ({
  id: "org-123",
  name: "Test Organization",
  slug: "test-org",
  imageUrl: "https://example.com/org.jpg",
  hasImage: true,
  publicMetadata: {},
  membersCount: 5,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  sidebarHarness.guidedGettingStartedCard.mockClear();
  sidebarHarness.pathname = "/test-org";
  sidebarHarness.searchParams = new URLSearchParams();
  mockQueryClient = { clear: mockQueryClientClear };
  mockUseParams.mockReturnValue({ orgSlug: "test-org" });
});

describe("GlobalSidebar - Cache Invalidation", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();

    // Default organization state
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      isLoaded: true,
    });
  });

  test("does not clear cache on initial mount", () => {
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      isLoaded: true,
    });

    render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(mockQueryClientClear).not.toHaveBeenCalled();
  });

  test("clears the cache when the org changes across a sidebar remount", () => {
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization({ id: "org-a", slug: "org-a" }),
      isLoaded: true,
    });

    const { unmount } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    // Mounting alone must not clear, so the assertion below is attributable to
    // the org change and not to the second render.
    expect(mockQueryClientClear).not.toHaveBeenCalled();

    // ISS-7344: this is the remount that used to reset the in-component ref,
    // making the org-b mount look like a first load and skip the clear while
    // the module-singleton cache still held org A's rows.
    unmount();
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization({ id: "org-b", slug: "org-b" }),
      isLoaded: true,
    });

    render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(mockQueryClientClear).toHaveBeenCalledTimes(1);
  });

  test("does not clear cache when organization metadata changes but ID stays same", () => {
    const { rerender } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    // Initial render with org-123
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization({ id: "org-123", name: "Original" }),
      isLoaded: true,
    });

    rerender(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    // Update name but keep same ID
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization({
        id: "org-123",
        name: "Updated Name",
      }),
      isLoaded: true,
    });

    rerender(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    // Cache should not be cleared (same org ID)
    expect(mockQueryClientClear).not.toHaveBeenCalled();
  });
});

describe("GlobalSidebar - Cross-org nav hrefs (ISS-6567)", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("builds nav hrefs from the active org, not a foreign URL slug", () => {
    // The gated state: the URL names an org the user is not a member of, while
    // every id in the sidebar comes from hooks scoped to the active org.
    mockUseParams.mockReturnValue({ orgSlug: "craft-five" });
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization({ slug: "closedloop-ai" }),
      isLoaded: true,
    });

    const { container } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    const hrefs = [...container.querySelectorAll("a")].map((anchorEl) =>
      anchorEl.getAttribute("href")
    );

    // Positive siblings: without these, "nothing names craft-five" would be
    // satisfied by a sidebar that rendered no links at all.
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.some((href) => href?.startsWith("/closedloop-ai/"))).toBe(
      true
    );
    expect(hrefs.filter((href) => href?.includes("craft-five"))).toEqual([]);
  });

  test("renders no nav hrefs at all until the active org resolves", () => {
    // ISS-7344: the window with no concrete org. Every nav url interpolates the
    // slug, so an empty one yields `//my-tasks` — protocol-relative, which the
    // browser reads as the HOST `my-tasks` and navigates off-site. The rows stay
    // on screen and inert instead of linking anywhere.
    mockUseParams.mockReturnValue({ orgSlug: "craft-five" });
    mockUseOrganization.mockReturnValue({
      organization: null,
      isLoaded: false,
    });

    const { container } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    const hrefs = [...container.querySelectorAll("a")].map((anchorEl) =>
      anchorEl.getAttribute("href")
    );

    expect(hrefs).toEqual([]);
    expect(hrefs.filter((href) => href?.startsWith("//"))).toEqual([]);
    expect(hrefs.filter((href) => href?.includes("craft-five"))).toEqual([]);
    // The rows themselves are still painted — this holds the links, not the nav.
    expect(screen.getByText("My Tasks")).toBeInTheDocument();
  });
});

describe("GlobalSidebar - Feature Flag Hydration", () => {
  afterEach(() => {
    cleanup();
    globalThis.localStorage.clear();
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, true)
    );
  });
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.localStorage.clear();

    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      isLoaded: true,
    });
  });

  test("does not render a separate Agent Management section", async () => {
    render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    await waitFor(() => {
      expect(screen.getByText("Artifacts")).toBeInTheDocument();
      expect(screen.queryByText("Agent Management")).toBeNull();
    });
    expect(screen.getByText("Teams")).toBeInTheDocument();
  });

  test("persists Labs state under the moved section's own key", async () => {
    // ISS-10244 retired `nav-labs-move`, so the container being ON now selects
    // the Labs-MOVED shape outright rather than one of two rollout positions.
    // That shape deliberately persists under its own key (ISS-8759), so a
    // collapse recorded against the pre-move section can never be inherited by
    // a section holding a different set of rows. The key is imported from
    // `sidebar.tsx` rather than restated here, so a rename cannot leave this
    // asserting a string nothing writes.
    mockUseFeatureFlag.mockImplementation(onlyLabsContainerEnabled);

    render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    fireEvent.click(
      await screen.findByRole("button", { name: LABS_SECTION_TITLE })
    );

    expect(
      globalThis.localStorage.getItem(LABS_MOVED_NAV_SECTION_STORAGE_KEY)
    ).toBe("false");
  });

  test("uses canonical browser QA routes for insights and agent sessions", () => {
    const { getByRole, queryByRole } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(getByRole("link", { name: INSIGHTS_NAV_TITLE })).toHaveAttribute(
      "href",
      "/test-org/insights"
    );
    expect(getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "href",
      "/test-org/sessions"
    );
    // FEA-3983/3970: Agent Monitoring was removed (superseded by the Dashboard),
    // so the sidebar no longer lists it.
    expect(queryByRole("link", { name: "Agent Monitoring" })).toBeNull();
    expect(
      document.querySelector('a[href="/test-org/agent-sessions/dashboard"]')
    ).toBeNull();
    expect(
      queryByRole("link", { name: AGENT_SESSIONS_DASHBOARD_LINK_RE })
    ).toBeNull();
  });
});

describe("GlobalSidebar - Agents nav (insights + admin catalog)", () => {
  afterEach(() => {
    cleanup();
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, true)
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // All other artifact flags off; Agents and its Packs Labs link carry no
    // per-item flag (FEA-3994) so these assertions isolate the Agents-related
    // nav items. ISS-5037: the Labs CONTAINER flag is opened so the Packs link
    // is reachable at all — with it closed there is no Labs section to assert on.
    mockUseFeatureFlag.mockImplementation(onlyLabsContainerEnabled);
  });

  test("no longer renders an Agent Insights link", () => {
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      membership: { role: "org:member" },
      isLoaded: true,
    });

    const { queryByRole } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(queryByRole("link", { name: "Agent Insights" })).toBeNull();
  });

  test("shows the Packs link for a non-admin member", () => {
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      membership: { role: "org:member" },
      isLoaded: true,
    });

    const { getByRole } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(getByRole("link", { name: PACKS_NAV_TITLE })).toHaveAttribute(
      "href",
      "/test-org/packs"
    );
  });

  test("shows the Packs link for an org admin", () => {
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      membership: { role: "org:admin" },
      isLoaded: true,
    });

    const { getByRole } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(getByRole("link", { name: PACKS_NAV_TITLE })).toHaveAttribute(
      "href",
      "/test-org/packs"
    );
  });

  test("shows the Packs link with every per-item flag off (no item flag, FEA-3994)", () => {
    // ISS-5037: only the Labs container flag is on. Packs still has no per-item
    // flag of its own, so this remains the always-on assertion FEA-3994 wanted —
    // it just now runs inside an opened container.
    mockUseFeatureFlag.mockImplementation(onlyLabsContainerEnabled);
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      membership: { role: "org:admin" },
      isLoaded: true,
    });

    const { getByRole, queryByRole } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(getByRole("link", { name: PACKS_NAV_TITLE })).toHaveAttribute(
      "href",
      "/test-org/packs"
    );
    expect(queryByRole("link", { name: "Agent Insights" })).toBeNull();
  });

  // ISS-5037 (ISS-4779 closed-by-default): the Labs CONTAINER gate. Driven with
  // every per-item flag ON, so a pass cannot come from the items being gated —
  // the container is the only thing that can remove the whole section.
  test("renders no Labs section at all when the Labs container flag is off", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag !== ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY)
    );
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      membership: { role: "org:admin" },
      isLoaded: true,
    });

    const { queryByRole, queryByText } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    // No header, no items, no empty collapsed shell.
    expect(queryByText(LABS_SECTION_TITLE)).toBeNull();
    expect(queryByRole("link", { name: INSIGHTS_NAV_TITLE })).toBeNull();
    expect(queryByRole("link", { name: JUDGES_NAV_TITLE })).toBeNull();
    expect(queryByRole("link", { name: PACKS_NAV_TITLE })).toBeNull();
    // The rest of the sidebar is untouched — the gate removed one section, it
    // did not break the nav.
    expect(queryByRole("link", { name: "Sessions" })).not.toBeNull();
  });

  test("renders the Labs section and its items when the container flag is on", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, true)
    );
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      membership: { role: "org:admin" },
      isLoaded: true,
    });

    const { getByRole, getByText } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(getByText(LABS_SECTION_TITLE)).toBeInTheDocument();
    expect(getByRole("link", { name: INSIGHTS_NAV_TITLE })).toHaveAttribute(
      "href",
      "/test-org/insights"
    );
    expect(getByRole("link", { name: PACKS_NAV_TITLE })).toHaveAttribute(
      "href",
      "/test-org/packs"
    );
  });

  // Lost work and TokenOps waste each answer to their own key, so opening one
  // inside an open Labs container must not open the other.
  test.each([
    {
      openKey: LOST_WORK_NAV_FEATURE_FLAG_KEY,
      shown: "Lost work",
      hidden: "TokenOps waste",
      href: "/test-org/insights/lost-work",
    },
    {
      openKey: TOKENOPS_WASTE_NAV_FEATURE_FLAG_KEY,
      shown: "TokenOps waste",
      hidden: "Lost work",
      href: "/test-org/insights/tokenops-waste",
    },
  ])(
    "renders only $shown when only its own key is on inside the Labs container",
    ({ openKey, shown, hidden, href }) => {
      mockUseFeatureFlag.mockImplementation((flag: string) =>
        flagResult(
          flag,
          onlyLabsContainerEnabled(flag).enabled || flag === openKey
        )
      );
      mockUseOrganization.mockReturnValue({
        organization: createMockOrganization(),
        membership: { role: "org:admin" },
        isLoaded: true,
      });

      const { getByRole, queryByRole } = render(
        <GlobalSidebar>
          <div>Content</div>
        </GlobalSidebar>,
        { wrapper: WebFeatureFlagProvider }
      );

      expect(getByRole("link", { name: shown })).toHaveAttribute("href", href);
      expect(queryByRole("link", { name: hidden })).toBeNull();
    }
  );

  test("hides both Lost work and TokenOps waste with only the Labs container on", () => {
    mockUseFeatureFlag.mockImplementation(onlyLabsContainerEnabled);
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      membership: { role: "org:admin" },
      isLoaded: true,
    });

    const { getByRole, queryByRole } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    // Packs carries no per-item key, so it proves the container is open.
    expect(getByRole("link", { name: PACKS_NAV_TITLE })).toBeInTheDocument();
    expect(queryByRole("link", { name: "Lost work" })).toBeNull();
    expect(queryByRole("link", { name: "TokenOps waste" })).toBeNull();
  });

  // ISS-5037: the container must COMPOSE with the per-item flags, not shadow
  // them — an item whose own flag is off stays hidden even inside an open
  // container, and its persisted value is not touched by the container.
  test("keeps per-item Labs flags authoritative inside an open container", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag !== "the-one-flag")
    );
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      membership: { role: "org:admin" },
      isLoaded: true,
    });

    const { getByRole, queryByRole, getByText } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(getByText(LABS_SECTION_TITLE)).toBeInTheDocument();
    expect(getByRole("link", { name: INSIGHTS_NAV_TITLE })).toBeInTheDocument();
    // Judges' own flag is off, so it stays hidden inside the open container.
    expect(queryByRole("link", { name: JUDGES_NAV_TITLE })).toBeNull();
  });

  test("no longer renders the retired Loops Labs link (ISS-4477)", () => {
    // Loops is removed from nav & UI: the sidebar must not render a Loops
    // destination in the Labs section under any flag configuration.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, true)
    );
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      membership: { role: "org:admin" },
      isLoaded: true,
    });

    const { queryByRole } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(queryByRole("link", { name: "Loops" })).toBeNull();
  });
});

describe("GlobalSidebar - Artifacts section flag gating", () => {
  afterEach(() => {
    cleanup();
    // Restore the default (all flags enabled) so other suites are unaffected.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, true)
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, true)
    );
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      isLoaded: true,
    });
  });

  test("keeps the Artifacts section rendered for the always-on items even when every flag is off", () => {
    // As of FEA-4155 Branches/Sessions are always-on (no flag), so the
    // Artifacts section never fully empties. Documents, Issues and Agents are
    // each gated by their own key.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, false)
    );

    const { getByText, queryByText } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(getByText("Artifacts")).not.toBeNull();
    expect(getByText("Branches")).not.toBeNull();
    expect(getByText("Sessions")).not.toBeNull();
    expect(
      queryByText(primaryNavTitle(ShellNavigationRouteId.Documents))
    ).toBeNull();
    expect(
      queryByText(primaryNavTitle(ShellNavigationRouteId.Issues))
    ).toBeNull();
    expect(
      queryByText(primaryNavTitle(ShellNavigationRouteId.Agents))
    ).toBeNull();
  });

  test("renders Agents in the Artifacts section when its flag is ON", () => {
    // The positive sibling for the `queryByText("Agents")` null above: without
    // it, that assertion would keep passing if the row were deleted outright
    // rather than gated.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag === AGENTS_NAV_FEATURE_FLAG_KEY)
    );

    const { getByText } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(getByText("Agents")).not.toBeNull();
  });

  test("hides only the still-gated Issues item when its flag is off (FEA-4155)", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag !== ArtifactFlag.Issues)
    );

    const { queryByText } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(queryByText("Artifacts")).not.toBeNull();
    // FEA-4155: Branches/Sessions are always-on regardless of flag state.
    expect(queryByText("Branches")).not.toBeNull();
    expect(queryByText("Sessions")).not.toBeNull();
    expect(
      queryByText(primaryNavTitle(ShellNavigationRouteId.Issues))
    ).toBeNull();
  });

  test("offers no Routines link even with every flag ON (PRD-797 AC-001.1)", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, true)
    );

    const { queryAllByRole } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(
      queryAllByRole("link").filter((link) =>
        link.getAttribute("href")?.endsWith(RETIRED_ROUTINES_PATH)
      )
    ).toEqual([]);
  });

  test("renders the Documents nav item behind its own flag, independent of Issues", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag === ArtifactFlag.Documents)
    );

    const { getByRole, queryByText } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(
      getByRole("link", {
        name: primaryNavTitle(ShellNavigationRouteId.Documents),
      })
    ).toHaveAttribute("href", "/test-org/documents");
    expect(
      queryByText(primaryNavTitle(ShellNavigationRouteId.Issues))
    ).toBeNull();
  });
});
