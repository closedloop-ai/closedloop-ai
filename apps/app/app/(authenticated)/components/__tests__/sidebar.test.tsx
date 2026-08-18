import { ROUTINES_FEATURE_FLAG_KEY } from "@repo/api/src/types/routines";
import {
  ArtifactFlag,
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
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

// ISS-5037: the Labs section is now behind its own container flag, so a test
// that asserts a Labs ITEM (Insights, Judges, Packs) has to open the container
// first. This resolves ONLY the container flag, keeping every per-item flag off
// — which is what makes an item assertion under it meaningful.
const onlyLabsContainerEnabled = (flag: string) =>
  flagResult(flag, flag === LABS_NAV_SECTION_FEATURE_FLAG_KEY);

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

// The Agents activity badge reads live session data through the auth/API stack;
// this suite exercises nav structure/flag gating, not the badge, so stub it out
// (its own behavior is covered in agents/components/__tests__/agents-nav-badge).
vi.mock("@repo/app/agents/components/agents-nav-badge", () => ({
  AgentsNavBadge: () => null,
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
      </GlobalSidebar>
    );

    expect(getByRole("link", { name: "Packs" })).toHaveAttribute(
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
      </GlobalSidebar>
    );

    expect(getByRole("link", { name: "Packs" })).toHaveAttribute(
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
      flagResult(flag, flag !== LABS_NAV_SECTION_FEATURE_FLAG_KEY)
    );
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      membership: { role: "org:admin" },
      isLoaded: true,
    });

    const { queryByRole, queryByText } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    // No header, no items, no empty collapsed shell.
    expect(queryByText("Labs")).toBeNull();
    expect(queryByRole("link", { name: "Insights" })).toBeNull();
    expect(queryByRole("link", { name: "Judges" })).toBeNull();
    expect(queryByRole("link", { name: "Packs" })).toBeNull();
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
      </GlobalSidebar>
    );

    expect(getByText("Labs")).toBeInTheDocument();
    expect(getByRole("link", { name: "Insights" })).toHaveAttribute(
      "href",
      "/test-org/insights"
    );
    expect(getByRole("link", { name: "Packs" })).toHaveAttribute(
      "href",
      "/test-org/packs"
    );
  });

  // ISS-5280 (review): the case above enables EVERY flag, so it would still
  // pass if a per-item gate came back on either retired link. This one opens
  // ONLY the Labs container, so the two links can appear for exactly one
  // reason: they carry no `featureFlag` of their own any more. Re-adding either
  // per-surface gate fails this test.
  test("renders both retired Insights links with only the Labs container flag on", () => {
    mockUseFeatureFlag.mockImplementation(onlyLabsContainerEnabled);
    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      membership: { role: "org:admin" },
      isLoaded: true,
    });

    const { getByRole, queryByRole } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    expect(getByRole("link", { name: "Lost work" })).toHaveAttribute(
      "href",
      "/test-org/insights/lost-work"
    );
    expect(getByRole("link", { name: "TokenOps waste" })).toHaveAttribute(
      "href",
      "/test-org/insights/tokenops-waste"
    );
    // The resolver really is selective — Insights and Judges still carry their
    // own flags and stay hidden. Without this, an accidentally-permissive
    // resolver would make the two assertions above vacuous.
    expect(queryByRole("link", { name: "Insights" })).toBeNull();
    expect(queryByRole("link", { name: "Judges" })).toBeNull();
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
      </GlobalSidebar>
    );

    expect(getByText("Labs")).toBeInTheDocument();
    expect(getByRole("link", { name: "Insights" })).toBeInTheDocument();
    // Judges' own flag is off, so it stays hidden inside the open container.
    expect(queryByRole("link", { name: "Judges" })).toBeNull();
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
      </GlobalSidebar>
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
    // Agents (FEA-3994), Documents (FEA-4140), and — as of FEA-4155 —
    // Branches/Sessions are all always-on (no flag), so the Artifacts section
    // never fully empties. Only Issues stays flag-gated and hides when off.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, false)
    );

    const { getByText, queryByText } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    expect(getByText("Artifacts")).not.toBeNull();
    expect(getByText("Agents")).not.toBeNull();
    expect(getByText("Documents")).not.toBeNull();
    // FEA-4155: always-on now — visible even with every flag off.
    expect(getByText("Branches")).not.toBeNull();
    expect(getByText("Sessions")).not.toBeNull();
    // Issues is still gated, so it stays hidden with its flag off.
    expect(queryByText("Issues")).toBeNull();
  });

  test("hides only the still-gated Issues item when its flag is off (FEA-4155)", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag !== ArtifactFlag.Issues)
    );

    const { queryByText } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    expect(queryByText("Artifacts")).not.toBeNull();
    // FEA-4155: Branches/Sessions are always-on regardless of flag state.
    expect(queryByText("Branches")).not.toBeNull();
    expect(queryByText("Sessions")).not.toBeNull();
    expect(queryByText("Issues")).toBeNull();
  });

  test("hides the Routines nav item when the routines flag is OFF (FEA-4348 / ISS-4396)", () => {
    // Routines is gated behind the PostHog `routines` flag (default off) until
    // GA. Every OTHER flag is ON so only the routines gate can hide the row —
    // if this assertion passed with all flags off it would prove nothing.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag !== ROUTINES_FEATURE_FLAG_KEY)
    );

    const { queryByRole } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    expect(queryByRole("link", { name: "Routines" })).toBeNull();
  });

  test("shows the Routines nav item when the routines flag is ON (FEA-4348 / ISS-4396)", () => {
    // Mirror of the flag-OFF case: every OTHER flag is OFF and only routines is
    // ON, so the Routines row surfacing is attributable to its own flag alone.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, flag === ROUTINES_FEATURE_FLAG_KEY)
    );

    const { getByRole } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    expect(getByRole("link", { name: "Routines" })).toHaveAttribute(
      "href",
      "/test-org/routines"
    );
  });

  test("renders the Documents nav item linking to the org-scoped index (FEA-4140)", () => {
    // The org-level Documents index shipped (FEA-4140): the primary "Documents"
    // affordance is restored always-on and links to the real `/documents`
    // index. Flags off proves it is not gated.
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, false)
    );

    const { getByRole } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    expect(getByRole("link", { name: "Documents" })).toHaveAttribute(
      "href",
      "/test-org/documents"
    );
  });
});
