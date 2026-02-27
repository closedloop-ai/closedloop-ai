import { cleanup, render } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalSidebar } from "../sidebar";

// Mock dependencies
const mockQueryClientClear = vi.fn();
const mockUseSidebar = vi.fn();
const mockUseOrganization = vi.fn();

// Mock @repo/auth/client
vi.mock("@repo/auth/client", () => ({
  OrganizationSwitcher: () => (
    <div data-testid="org-switcher">Organization Switcher</div>
  ),
  UserButton: () => <div data-testid="user-button">User Button</div>,
  useOrganization: () => mockUseOrganization(),
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
  SidebarMenuButton: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu-button">{children}</div>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu-item">{children}</div>
  ),
  useSidebar: () => mockUseSidebar(),
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

vi.mock("../sidebar-favorites", () => ({
  SidebarFavorites: () => <div data-testid="sidebar-favorites">Favorites</div>,
}));

vi.mock("@repo/design-system/components/ui/mode-toggle", () => ({
  ModeToggle: () => <div data-testid="mode-toggle">Mode Toggle</div>,
}));

vi.mock("@repo/notifications/components/trigger", () => ({
  NotificationsTrigger: () => (
    <div data-testid="notifications-trigger">Notifications</div>
  ),
}));

vi.mock("../inbox-badge", () => ({
  InboxBadge: () => null,
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

    // Default sidebar state
    mockUseSidebar.mockReturnValue({
      open: true,
      state: "expanded",
      isMobile: false,
      openMobile: false,
      setOpen: vi.fn(),
      setOpenMobile: vi.fn(),
      toggleSidebar: vi.fn(),
    });

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

describe("GlobalSidebar - Conditional Rendering", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization(),
      isLoaded: true,
    });
  });

  test("renders organization avatar when sidebar is collapsed", () => {
    mockUseSidebar.mockReturnValue({
      open: false,
      state: "collapsed",
    });

    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization({
        name: "Test Org",
        imageUrl: "https://example.com/avatar.jpg",
      }),
      isLoaded: true,
    });

    const { container } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    // Avatar container should render when sidebar is collapsed
    const avatar = container.querySelector('[data-slot="avatar"]');
    expect(avatar).not.toBeNull();
    // Fallback shows the first letter (JSDOM can't load images so AvatarImage won't render)
    const fallback = container.querySelector('[data-slot="avatar-fallback"]');
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toBe("T");
  });

  test("displays organization name fallback when imageUrl is missing", () => {
    mockUseSidebar.mockReturnValue({
      open: false,
      state: "collapsed",
    });

    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization({
        name: "Acme Corp",
        imageUrl: undefined,
      }),
      isLoaded: true,
    });

    const { container } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    // Should show fallback with first letter of org name in the avatar fallback
    const fallback = container.querySelector('[data-slot="avatar-fallback"]');
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toBe("A");
  });

  test("displays 'O' fallback when organization name is missing", () => {
    mockUseSidebar.mockReturnValue({
      open: false,
      state: "collapsed",
    });

    mockUseOrganization.mockReturnValue({
      organization: createMockOrganization({
        name: undefined as unknown as string,
        imageUrl: undefined,
      }),
      isLoaded: true,
    });

    const { container } = render(
      <GlobalSidebar>
        <div>Content</div>
      </GlobalSidebar>
    );

    // Should show "O" fallback in avatar
    const fallback = container.querySelector('[data-slot="avatar-fallback"]');
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toBe("O");
  });
});
