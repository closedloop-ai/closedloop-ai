import { GITHUB_ERROR_CODES } from "@repo/api/src/types/github-status";
import { OrgAdminRole } from "@repo/api/src/types/org-admin-role";
import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
import {
  embeddedOrganizationProfileAppearance,
  embeddedProfileAppearance,
} from "@repo/auth/components/appearance";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { SettingsTab } from "../../settings-tabs";
import { SettingsPage } from "../settings-page";

const COMPLIANCE_TAB_NAME = "Compliance";

const mockSearchParams = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockUserProfile = vi.fn();
const mockOrganizationProfile = vi.fn();

const CARD_ANCHOR = "github-integration";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => mockSearchParams(),
}));

vi.mock("@repo/app/shared/feature-flags/feature-flagged", () => ({
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
    return <EmbeddedAccountUiDouble headings={ORGANIZATION_EMBED_HEADINGS} />;
  },
  OrganizationSwitcher: () => null,
  Show: ({ children, fallback, when }: ShowProps) =>
    when(mockHasRole) ? children : fallback,
  UserProfile: (props: Record<string, unknown>) => {
    mockUserProfile(props);
    return <EmbeddedAccountUiDouble headings={PROFILE_EMBED_HEADINGS} />;
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

vi.mock("../api-keys-settings-panel", () => ({
  ApiKeysSettingsPanel: () => null,
}));

// Stands in for an anchored card on the Integrations tab: the page's fragment
// scroll is generic, so any card id is a valid target.
vi.mock("../github-integration-card", () => ({
  GitHubIntegrationCard: () => <div id={CARD_ANCHOR} tabIndex={-1} />,
}));

vi.mock("@repo/app/settings/v2/panels/plugins/google-drive-card", () => ({
  GoogleDriveCard: () => null,
}));

// This suite mocks `FeatureFlagged` to always render children, so a gated card
// still mounts for real here. The Pensero card calls auth-backed query hooks
// and needs an <AuthAdapterProvider>, which this suite does not mount.
vi.mock(
  "@repo/app/settings/v2/panels/api-keys/pensero-credential-card",
  () => ({
    PenseroCredentialCard: () => null,
  })
);

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

// Simulate an org owner who is NOT also an admin. `grantAdminRole` answers yes
// to both privileged roles at once, so it stays green for a gate that only ever
// asks Clerk about `org:admin` — this one does not.
function grantOwnerRoleOnly() {
  mockHasRole.mockImplementation(
    (params: { role: string } | { permission: string }) =>
      "role" in params && params.role === OrgAdminRole.Owner
  );
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
      </QueryClientProvider>,
      { wrapper: WebFeatureFlagProvider }
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
      </QueryClientProvider>,
      { wrapper: WebFeatureFlagProvider }
    );

    await waitFor(() => {
      expect(invalidateSpy).not.toHaveBeenCalled();
      expect(replaceStateSpy).not.toHaveBeenCalled();
    });
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();

    replaceStateSpy.mockRestore();
  });

  it.each([
    [GITHUB_ERROR_CODES.NOT_AUTHENTICATED, "Please sign in to connect GitHub."],
    [
      GITHUB_ERROR_CODES.NOT_CONFIGURED,
      "GitHub integration is not configured.",
    ],
    [
      GITHUB_ERROR_CODES.MISSING_PARAMS,
      "Invalid authorization request. Please try again.",
    ],
    [
      GITHUB_ERROR_CODES.INVALID_STATE,
      "Security validation failed. Please try again.",
    ],
    [
      GITHUB_ERROR_CODES.CONNECTION_FAILED,
      "Failed to connect to GitHub. Please try again.",
    ],
    [
      GITHUB_ERROR_CODES.OAUTH_FAILED,
      "Authorization failed. Please try again.",
    ],
    ["unknown_code", "An error occurred."],
  ])(
    "toasts the exact message for GitHub error code %s",
    async (code, message) => {
      mockSearchParams.mockReturnValue(
        new URLSearchParams({ github: "error", code })
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      render(
        <QueryClientProvider client={queryClient}>
          <SettingsPage initialTab="integrations" isAdmin={false} />
        </QueryClientProvider>,
        { wrapper: WebFeatureFlagProvider }
      );

      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(message));
    }
  );

  it.each([
    ["an empty code", "github=error&code="],
    ["no code param at all", "github=error"],
  ])(
    "still toasts the generic error message with %s",
    async (_label, query) => {
      mockSearchParams.mockReturnValue(new URLSearchParams(query));
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      render(
        <QueryClientProvider client={queryClient}>
          <SettingsPage initialTab="integrations" isAdmin={false} />
        </QueryClientProvider>,
        { wrapper: WebFeatureFlagProvider }
      );

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("An error occurred.")
      );
    }
  );

  it.each(["__proto__", "constructor"])(
    "uses the generic error message for prototype key %s",
    async (code) => {
      mockSearchParams.mockReturnValue(
        new URLSearchParams({ github: "error", code })
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      render(
        <QueryClientProvider client={queryClient}>
          <SettingsPage initialTab="integrations" isAdmin={false} />
        </QueryClientProvider>,
        { wrapper: WebFeatureFlagProvider }
      );

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("An error occurred.")
      );
    }
  );
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
      </QueryClientProvider>,
      { wrapper: WebFeatureFlagProvider }
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

    expect(
      screen.getByRole("tab", { name: COMPLIANCE_TAB_NAME })
    ).toBeInTheDocument();
  });

  it("hides the Compliance tab from non-admins (FEA-4029)", () => {
    renderSettings(false);

    expect(
      screen.queryByRole("tab", { name: COMPLIANCE_TAB_NAME })
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
      </QueryClientProvider>,
      { wrapper: WebFeatureFlagProvider }
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
      </QueryClientProvider>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(screen.queryByText("compliance-panel")).not.toBeInTheDocument();
    expect(screen.getByText("Admins only")).toBeInTheDocument();
  });

  it("shows the Compliance panel body to an org owner who is not an admin", () => {
    grantOwnerRoleOnly();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <SettingsPage initialTab={SettingsTab.Compliance} isAdmin={true} />
      </QueryClientProvider>,
      { wrapper: WebFeatureFlagProvider }
    );

    expect(screen.getByText("compliance-panel")).toBeInTheDocument();
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
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
      </QueryClientProvider>,
      { wrapper: WebFeatureFlagProvider }
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
      </QueryClientProvider>,
      { wrapper: WebFeatureFlagProvider }
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
      </QueryClientProvider>,
      { wrapper: WebFeatureFlagProvider }
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
      </QueryClientProvider>,
      { wrapper: WebFeatureFlagProvider }
    );
  }

  it("scrolls the fragment's card into view and focuses it after mount", () => {
    // A cold load cannot rely on the browser's own fragment scroll: it looks
    // for the element before React has rendered the tab and gives up silently.
    globalThis.location.hash = `#${CARD_ANCHOR}`;

    renderSettings();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.id).toBe(CARD_ANCHOR);
  });

  it("leaves scroll position alone when the URL carries no fragment", () => {
    renderSettings();

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement?.id).not.toBe(CARD_ANCHOR);
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

describe("SettingsPage heading outline (ISS-5151)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.mockReturnValue(new URLSearchParams());
    grantAdminRole();
  });

  it.each([
    {
      tab: SettingsTab.Profile,
      demoted: PROFILE_EMBED_HEADINGS,
    },
    {
      tab: SettingsTab.Organization,
      demoted: ORGANIZATION_EMBED_HEADINGS,
    },
  ])(
    "leaves the $tab tab with one level-1 heading and demotes the embed's",
    async ({ tab, demoted }) => {
      renderTab(tab);

      // The positive half of the count: the ONE surviving `h1` is the page's,
      // by name. A bare length assertion also passes on a page with no
      // headings at all.
      await waitFor(() =>
        expect(
          screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)
        ).toEqual(["Settings"])
      );
      // Demoted, not deleted — the embed's own headings stay reachable by
      // heading navigation, one level under the page's.
      expect(
        screen
          .getAllByRole("heading", { level: 2 })
          .map((h) => h.textContent)
          .filter((text) => demoted.includes(text ?? ""))
      ).toEqual(demoted);
    }
  );

  it.each([
    { tab: SettingsTab.CustomFields, label: "Custom Fields" },
    { tab: SettingsTab.Compliance, label: COMPLIANCE_TAB_NAME },
    { tab: SettingsTab.Integrations, label: "Compute & Integrations" },
    { tab: SettingsTab.ApiKeys, label: "API Keys" },
  ])(
    "leaves the $tab tab — which embeds nothing — with its single page heading",
    async ({ tab, label }) => {
      // ISS-5151 measured the non-Clerk tabs already correct at one `h1`. They
      // are pinned so the wrapper cannot regress the tabs it does not touch.
      renderTab(tab);

      // Without this the case is vacuous when a tab does not open: Settings
      // bounces an unavailable tab back to Profile, and the outline assertion
      // below would then be checking Profile a second time under another name.
      // (Tags is absent from this list for exactly that reason — it is flag
      // gated, and this suite's flag context resolves it off.)
      expect(screen.getByRole("tab", { name: label })).toHaveAttribute(
        "aria-selected",
        "true"
      );
      await waitFor(() =>
        expect(
          screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)
        ).toEqual(["Settings"])
      );
    }
  );
});

/** The page headings Clerk's embedded `UserProfile` renders as its own `h1`s. */
const PROFILE_EMBED_HEADINGS = ["Account", "Profile details"];

/** The same, for the embedded `OrganizationProfile`. */
const ORGANIZATION_EMBED_HEADINGS = ["Organization", "General"];

/**
 * Stands in for Clerk's embedded account UI, which renders its navbar title and
 * its page title as `h1`s of its own — the shape ISS-5151 counted in production
 * and the installed `@clerk/ui` bundle emits. Deliberately not derived from the
 * component under test.
 */
function EmbeddedAccountUiDouble({
  headings,
}: Readonly<{ headings: readonly string[] }>) {
  return (
    <div>
      {headings.map((heading) => (
        <h1 key={heading}>{heading}</h1>
      ))}
    </div>
  );
}

function renderTab(tab: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsPage initialTab={tab} isAdmin />
    </QueryClientProvider>,
    { wrapper: WebFeatureFlagProvider }
  );
}
