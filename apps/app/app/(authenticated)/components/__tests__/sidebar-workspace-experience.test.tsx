import { SHELL_SIDEBAR_V2_FLAG_KEY } from "@repo/api/src/types/shell-sidebar-v2-flag";
import { cleanup, render, screen, within } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { GlobalSidebar } from "../sidebar";

/**
 * ISS-8370 D7 — the sidebar's workspace chrome. The same mocks as
 * `sidebar.test.tsx` around the nav, plus the real `WorkspaceHeader` and its
 * Clerk-backed host provider, so what this file proves — which rows the chrome
 * renders, and that the host provider really mounts — is proved against the
 * production wiring rather than a stub of it.
 */

const mockUseOrganizationList = vi.fn(() => ({
  isLoaded: true,
  setActive: vi.fn(),
  userMemberships: { data: [], hasNextPage: false, isLoading: false },
}));

vi.mock("@repo/auth/client", () => ({
  CreateOrganization: () => null,
  useAuth: () => ({ isSignedIn: true }),
  useClerk: () => ({ signOut: vi.fn() }),
  useOrganization: () => ({
    isLoaded: true,
    membership: { role: "org:member" },
    organization: {
      id: "org-123",
      imageUrl: null,
      name: "Test Organization",
      slug: "test-org",
    },
  }),
  useOrganizationList: (...args: unknown[]) =>
    mockUseOrganizationList(...(args as [])),
  useUser: () => ({
    isLoaded: true,
    user: {
      fullName: "Test User",
      imageUrl: null,
      primaryEmailAddress: { emailAddress: "test@example.com" },
    },
  }),
}));

// Every flag on except the sidebar rollout key (PLN-2016 M2). The cases in this
// file are the KEY-OFF record — what the population that has not been rolled
// out to renders — and `GlobalSidebar` now branches between two whole sidebars
// on that key, so an all-true fixture would move them onto the v2 tree with no
// assertion changing. The key-on chrome is asserted in
// `sidebar-shell-v2.test.tsx`, against the same mount site.
vi.mock("@repo/analytics/client", () => ({
  // The no-PostHog-key shape, which settles from the first render — so the
  // shell's rollout branch reads the same value these cases always gave it.
  postHogFeatureFlagsEnabled: false,
  useFeatureFlag: (flag: string) => ({
    enabled: flag !== SHELL_SIDEBAR_V2_FLAG_KEY,
    key: flag,
    payload: undefined,
    variant: undefined,
  }),
  useFeatureFlagsLoaded: () => true,
  usePostHogDistinctId: () => undefined,
}));

const shellAuthSnapshot = {
  getToken: () => Promise.resolve(null),
  isLoaded: true,
  orgId: "org-123",
  userId: "user-1",
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

vi.mock("@repo/app/desktop/hooks/use-electron-release", () => ({
  useLatestElectronRelease: () => ({
    data: null,
    isError: false,
    isPending: false,
  }),
}));

// The menu's own presentation and item sets are pinned in packages/app; here
// it is a marker so the assertion is about WHERE the sidebar mounts it.
vi.mock(
  "@repo/app/settings/v2/components/workspace-menu/workspace-menu",
  () => ({
    WorkspaceMenu: () => <div data-testid="workspace-menu">Workspace</div>,
  })
);

vi.mock("../guided-onboarding-dialog-host", () => ({
  WebGuidedOnboardingDialogHost: () => null,
}));

vi.mock("@repo/app/onboarding/components/guided-getting-started-card", () => ({
  GuidedGettingStartedCard: () => null,
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
  SidebarGroupContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
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
  // ISS-9888: the factory REPLACES the module, so an export the tree reaches
  // and this list omits fails the render rather than the behaviour under test.
  SidebarSeparator: () => <div data-testid="sidebar-separator" />,
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
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "test-org" }),
  usePathname: () => "/test-org",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/environment", () => ({ appEnvironment: "local" }));
vi.mock("../search", () => ({ Search: () => <div>Search</div> }));
vi.mock("../sidebar-teams", () => ({ SidebarTeams: () => <div>Teams</div> }));
vi.mock("../account-menu", () => ({
  AccountMenu: () => <div data-testid="account-menu">Account Menu</div>,
}));
vi.mock("../inbox-badge", () => ({ InboxBadge: () => null }));
vi.mock("@repo/app/agents/components/agents-nav-badge", () => ({
  AgentsNavBadge: () => null,
}));
vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: ({ trigger }: { trigger?: React.ReactNode }) => (
    <div data-testid="invite-team-dialog">{trigger}</div>
  ),
}));

function renderSidebar() {
  return render(
    <GlobalSidebar envBadge="localhost">
      <div>Content</div>
    </GlobalSidebar>,
    { wrapper: WebFeatureFlagProvider }
  );
}

describe("GlobalSidebar — workspace chrome (ISS-8370 D7)", () => {
  beforeEach(() => {
    mockUseOrganizationList.mockClear();
  });

  afterEach(cleanup);

  test("renders the workspace menu in the header and no legacy footer rows", () => {
    renderSidebar();

    const header = screen.getByTestId("sidebar-header");
    expect(within(header).getByTestId("workspace-menu")).toBeInTheDocument();
    expect(screen.queryByTestId("account-menu")).not.toBeInTheDocument();
    expect(screen.queryByTestId("invite-team-dialog")).not.toBeInTheDocument();
    // Everything else in the footer is kept.
    const footer = screen.getByTestId("sidebar-footer");
    expect(within(footer).getByText("localhost")).toBeInTheDocument();
    // The navigation is unchanged.
    expect(screen.getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "href",
      "/test-org/sessions"
    );
    // The Clerk-backed workspace-menu host really mounted.
    expect(mockUseOrganizationList).toHaveBeenCalled();
  });
});
