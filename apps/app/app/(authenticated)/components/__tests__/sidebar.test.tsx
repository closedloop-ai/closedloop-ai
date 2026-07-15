import { cleanup, render } from "@testing-library/react";
import type React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalSidebar } from "../sidebar";

// Mock dependencies
const mockQueryClientClear = vi.fn();
const mockUseOrganization = vi.fn();
const AGENT_SESSIONS_DASHBOARD_LINK_RE = /agent sessions dashboard/i;

const flagResult = (flag: string, enabled: boolean) => ({
  key: flag,
  enabled,
  variant: undefined,
  payload: undefined,
});

// Defaults to every flag enabled; individual tests override the implementation
// to exercise flag-gated visibility.
const mockUseFeatureFlag = vi.fn((flag: string) => flagResult(flag, true));

// Mock @repo/auth/client
vi.mock("@repo/auth/client", () => ({
  useOrganization: () => mockUseOrganization(),
  // GlobalSidebar renders useOrgSlug, which reads isSignedIn to gate its
  // dev-only throw; the tests supply an org slug so the throw is never reached.
  useAuth: () => ({ isSignedIn: true }),
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (flag: string) => mockUseFeatureFlag(flag),
}));

// Mock @tanstack/react-query
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    clear: mockQueryClientClear,
  }),
}));

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
}));

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ orgSlug: "test-org" })),
  usePathname: vi.fn(() => "/test-org"),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
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

vi.mock("../account-menu", () => ({
  AccountMenu: () => <div data-testid="account-menu">Account Menu</div>,
}));

vi.mock("../inbox-badge", () => ({
  InboxBadge: () => null,
}));

vi.mock("@/components/compute-target-popover", () => ({
  ComputeTargetPopover: () => (
    <div data-testid="compute-target-popover">Compute Target</div>
  ),
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
      </GlobalSidebar>
    );

    expect(mockQueryClientClear).not.toHaveBeenCalled();
  });

  test("does not clear cache when organization metadata changes but ID stays same", () => {
    const { rerender } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
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

describe("GlobalSidebar - Account Menu", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      isLoaded: true,
    });
  });

  test("renders the combined account menu in the header", () => {
    const { getByTestId } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    expect(getByTestId("account-menu")).not.toBeNull();
  });
});

describe("GlobalSidebar - Feature Flag Hydration", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      isLoaded: true,
    });
  });

  test("does not render a separate Agent Management section", () => {
    const markup = renderToString(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    expect(markup).not.toContain("Agent Management");
    expect(markup).toContain("Teams");
  });

  test("uses canonical browser QA routes for insights and agent sessions", () => {
    const { getByRole, queryByRole } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    expect(getByRole("link", { name: "Insights" })).toHaveAttribute(
      "href",
      "/test-org/insights"
    );
    expect(getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "href",
      "/test-org/sessions"
    );
    expect(getByRole("link", { name: "Agent Monitoring" })).toHaveAttribute(
      "href",
      "/test-org/loops/monitoring"
    );
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
    // Only the Agents artifact flag is enabled so the assertions isolate the
    // Agents-related nav items from the other artifact links.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag === "agents")
    );
  });

  test("no longer renders an Agent Insights link (folded into Agent Monitoring)", () => {
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      membership: { role: "org:member" },
      isLoaded: true,
    });

    const { queryByRole } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
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
      </GlobalSidebar>
    );

    expect(getByRole("link", { name: "Packs" })).toHaveAttribute(
      "href",
      "/test-org/admin/catalog"
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
      </GlobalSidebar>
    );

    expect(getByRole("link", { name: "Packs" })).toHaveAttribute(
      "href",
      "/test-org/admin/catalog"
    );
  });

  test("hides the Packs link when the Agents flag is off, even for admins", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, false)
    );
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      membership: { role: "org:admin" },
      isLoaded: true,
    });

    const { queryByRole } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    expect(queryByRole("link", { name: "Packs" })).toBeNull();
    expect(queryByRole("link", { name: "Agent Insights" })).toBeNull();
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

  test("hides the Artifacts section when every item flag is disabled", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, false)
    );

    const { queryByText } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    expect(queryByText("Artifacts")).toBeNull();
    expect(queryByText("Documents")).toBeNull();
  });

  test("shows the Artifacts section when at least one item flag is enabled", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag === "documents-nav")
    );

    const { queryByText } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    expect(queryByText("Artifacts")).not.toBeNull();
    expect(queryByText("Documents")).not.toBeNull();
    expect(queryByText("Issues")).toBeNull();
  });
});
