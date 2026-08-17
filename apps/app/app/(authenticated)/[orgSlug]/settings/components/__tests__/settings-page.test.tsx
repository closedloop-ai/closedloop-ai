import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
import {
  embeddedOrganizationProfileAppearance,
  embeddedProfileAppearance,
} from "@repo/auth/components/appearance";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_API_KEY_CARD_ANCHOR,
  SettingsTab,
} from "../../settings-tabs";
import { SettingsPage } from "../settings-page";

const mockSearchParams = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockUserProfile = vi.fn();
const mockOrganizationProfile = vi.fn();
const mockSessionSyncPolicyCard = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => mockSearchParams(),
}));

vi.mock("@repo/analytics/components/feature-flagged", () => ({
  FeatureFlagged: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// `Show` renders `children` only when its `when` predicate passes against the
// stubbed `has`, and `fallback` otherwise — so the admin gate is observable in
// tests instead of always rendering the panel. `mockHasRole` drives whether the
// simulated member is an org admin/owner.
const mockHasRole = vi.fn();

type ShowProps = {
  children: ReactNode;
  fallback?: ReactNode;
  when: (
    has: (params: { role: string } | { permission: string }) => boolean
  ) => boolean;
};

vi.mock("@repo/auth/client", () => ({
  OrganizationProfile: (props: Record<string, unknown>) => {
    mockOrganizationProfile(props);
    return null;
  },
  OrganizationSwitcher: () => null,
  Show: ({ children, fallback, when }: ShowProps) =>
    when(mockHasRole) ? children : fallback,
  UserProfile: (props: Record<string, unknown>) => {
    mockUserProfile(props);
    return null;
  },
  // Nothing here is about the flag window; the page just needs a signed-in user
  // to compare PostHog's distinct id against.
  useUser: () => ({ isLoaded: true, user: { id: "user_settings_page" } }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

vi.mock(
  "@repo/app/custom-fields/components/custom-fields-settings-tab",
  () => ({
    CustomFieldsSettingsTab: () => null,
  })
);

vi.mock("@repo/app/agents/components/agent-compliance-settings-tab", () => ({
  AgentComplianceSettingsTab: () => <div>compliance-panel</div>,
}));

vi.mock("@repo/app/shared/components/user-link", () => ({
  UserLink: () => null,
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [] }),
  useUpdateUser: () => ({ mutate: vi.fn() }),
}));

// Stands in for the real card as an anchor target. The production card owns
// this id itself (`anthropic-api-key-card-anchor.test.tsx` asserts that); here
// it only needs to exist so the page's fragment scroll has something to find.
vi.mock("../anthropic-api-key-card", () => ({
  AnthropicApiKeyCard: () => (
    <div id={ANTHROPIC_API_KEY_CARD_ANCHOR} tabIndex={-1} />
  ),
}));

vi.mock("../api-keys-settings-panel", () => ({
  ApiKeysSettingsPanel: () => null,
}));

vi.mock("../cloud-compute-mode-card", () => ({
  CloudComputeModeCard: () => null,
}));

vi.mock("../github-integration-card", () => ({
  GitHubIntegrationCard: () => null,
}));

vi.mock("../google-integration-card", () => ({
  GoogleIntegrationCard: () => null,
}));

vi.mock("../linear-integration-card", () => ({
  LinearIntegrationCard: () => null,
}));

vi.mock("../local-compute-targets-card", () => ({
  LocalComputeTargetsCard: () => null,
}));

vi.mock("../organization-slug-settings", () => ({
  OrganizationSlugSettings: () => null,
}));

vi.mock("../session-frustration-card", () => ({
  SessionFrustrationCard: () => null,
}));

vi.mock("../transcript-search-card", () => ({
  TranscriptSearchCard: () => null,
}));

// Observable mock: record the props (notably `isAdmin`) and render a probe so a
// test can assert the Organization tab actually mounts the card with the current
// admin state — removing the mount or flipping `isAdmin` then fails a test.
vi.mock("../session-sync-policy-card", () => ({
  SessionSyncPolicyCard: (props: { isAdmin: boolean }) => {
    mockSessionSyncPolicyCard(props);
    return <div data-testid="session-sync-policy-card" />;
  },
}));

// Simulate an org admin/owner unless a test overrides it.
function grantAdminRole() {
  mockHasRole.mockImplementation(
    (params: { role: string } | { permission: string }) =>
      "role" in params &&
      (params.role === "org:admin" || params.role === "org:owner")
  );
}

// Simulate a plain member: no admin/owner role.
function denyAdminRole() {
  mockHasRole.mockReturnValue(false);
}

describe("SettingsPage GitHub callback recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.mockReturnValue(new URLSearchParams());
    grantAdminRole();
  });

  it("invalidates GitHub queries when returning from GitHub connect", async () => {
    mockSearchParams.mockReturnValue(new URLSearchParams("github=connected"));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPage initialTab="integrations" isAdmin={false} />
      </QueryClientProvider>
    );

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: githubKeys.all,
      })
    );
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "GitHub connected successfully"
    );
  });

  it("preserves URL params and skips invalidation on requires_confirmation", async () => {
    mockSearchParams.mockReturnValue(
      new URLSearchParams(
        "github=requires_confirmation&priorAccountId=1&priorAccountLogin=old&newAccountId=2&newAccountLogin=new&newInstallationId=99"
      )
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const replaceStateSpy = vi.spyOn(globalThis.history, "replaceState");

    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPage initialTab="integrations" isAdmin={false} />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(invalidateSpy).not.toHaveBeenCalled();
      expect(replaceStateSpy).not.toHaveBeenCalled();
    });
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();

    replaceStateSpy.mockRestore();
  });
});

describe("SettingsPage tab list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.mockReturnValue(new URLSearchParams());
    grantAdminRole();
  });

  function renderSettings(isAdmin: boolean) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPage initialTab="profile" isAdmin={isAdmin} />
      </QueryClientProvider>
    );
  }

  it("does not render an Admin tab for admins (FEA-3975)", () => {
    renderSettings(true);

    expect(
      screen.queryByRole("tab", { name: "Admin" })
    ).not.toBeInTheDocument();
    // Custom Fields, the other admin-only tab, still renders.
    expect(
      screen.getByRole("tab", { name: "Custom Fields" })
    ).toBeInTheDocument();
  });

  it("renders the Compliance tab for admins (FEA-4029)", () => {
    renderSettings(true);

    expect(screen.getByRole("tab", { name: "Compliance" })).toBeInTheDocument();
  });

  it("hides the Compliance tab from non-admins (FEA-4029)", () => {
    renderSettings(false);

    expect(
      screen.queryByRole("tab", { name: "Compliance" })
    ).not.toBeInTheDocument();
  });

  it("renders the Compliance panel on the Compliance tab for admins (FEA-4029)", () => {
    grantAdminRole();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <SettingsPage initialTab={SettingsTab.Compliance} isAdmin={true} />
      </QueryClientProvider>
    );

    expect(screen.getByText("compliance-panel")).toBeInTheDocument();
  });

  it("gates the Compliance panel body behind the admin role, not just the tab (FEA-4029)", () => {
    // A member who reaches the panel (e.g. a stale deep-link) sees the
    // admins-only fallback, never the compliance data.
    denyAdminRole();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <SettingsPage initialTab={SettingsTab.Compliance} isAdmin={true} />
      </QueryClientProvider>
    );

    expect(screen.queryByText("compliance-panel")).not.toBeInTheDocument();
    expect(screen.getByText("Admins only")).toBeInTheDocument();
  });

  it("mounts the session-sync policy card on the Organization tab with the admin state (ISS-4563)", () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <SettingsPage initialTab={SettingsTab.Organization} isAdmin={true} />
      </QueryClientProvider>
    );

    expect(screen.getByTestId("session-sync-policy-card")).toBeInTheDocument();
    expect(mockSessionSyncPolicyCard).toHaveBeenCalledWith(
      expect.objectContaining({ isAdmin: true })
    );
  });

  it("passes the non-admin state through to the session-sync policy card (ISS-4563)", () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <SettingsPage initialTab={SettingsTab.Organization} isAdmin={false} />
      </QueryClientProvider>
    );

    expect(mockSessionSyncPolicyCard).toHaveBeenCalledWith(
      expect.objectContaining({ isAdmin: false })
    );
  });

  it("labels the compute/integrations tab honestly (FEA-3976)", () => {
    renderSettings(false);

    expect(
      screen.getByRole("tab", { name: "Compute & Integrations" })
    ).toBeInTheDocument();
    // The old bare "Integrations" label is gone.
    expect(
      screen.queryByRole("tab", { name: "Integrations" })
    ).not.toBeInTheDocument();
  });

  it("does not render the empty More Integrations placeholder (FEA-3976)", () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <SettingsPage initialTab={SettingsTab.Integrations} isAdmin={false} />
      </QueryClientProvider>
    );

    expect(screen.queryByText("More Integrations")).not.toBeInTheDocument();
  });
});

describe("SettingsPage embedded Clerk theming (FEA-3965)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.mockReturnValue(new URLSearchParams());
    grantAdminRole();
  });

  it("renders UserProfile wired to the design-system embedded appearance", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPage initialTab="profile" isAdmin={false} />
      </QueryClientProvider>
    );

    expect(mockUserProfile).toHaveBeenCalledWith(
      expect.objectContaining({ appearance: embeddedProfileAppearance })
    );
  });

  it("renders OrganizationProfile wired to the org embedded appearance", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPage initialTab="organization" isAdmin={false} />
      </QueryClientProvider>
    );

    expect(mockOrganizationProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        appearance: embeddedOrganizationProfileAppearance,
      })
    );
  });
});

describe("SettingsPage card deep-link fragment", () => {
  const scrollIntoView = vi.fn();
  let originalScrollIntoView: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.mockReturnValue(new URLSearchParams());
    grantAdminRole();
    originalScrollIntoView = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView"
    );
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
      writable: true,
    });
  });

  afterEach(() => {
    if (originalScrollIntoView) {
      Object.defineProperty(
        Element.prototype,
        "scrollIntoView",
        originalScrollIntoView
      );
    } else {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
    globalThis.location.hash = "";
  });

  function renderSettings() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPage initialTab={SettingsTab.Integrations} isAdmin />
      </QueryClientProvider>
    );
  }

  it("scrolls the fragment's card into view and focuses it after mount", () => {
    // A cold load cannot rely on the browser's own fragment scroll: it looks
    // for the element before React has rendered the tab and gives up silently.
    globalThis.location.hash = `#${ANTHROPIC_API_KEY_CARD_ANCHOR}`;

    renderSettings();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.id).toBe(ANTHROPIC_API_KEY_CARD_ANCHOR);
  });

  it("leaves scroll position alone when the URL carries no fragment", () => {
    renderSettings();

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement?.id).not.toBe(ANTHROPIC_API_KEY_CARD_ANCHOR);
  });

  it("does not throw when the fragment names no card on the page", () => {
    // Stale bookmarks and renamed anchors must degrade to "no scroll", not to
    // a render crash on the whole Settings page.
    globalThis.location.hash = "#no-such-card";

    renderSettings();

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });
});
