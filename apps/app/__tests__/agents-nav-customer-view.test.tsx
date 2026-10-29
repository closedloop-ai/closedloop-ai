import { CustomerViewProvider } from "@repo/analytics/customer-view";
import { AGENTS_NAV_FLAG_KEY } from "@repo/api/src/types/agents-nav-flag";
import { DEV_MODE_EXEMPT_FLAG_KEYS } from "@repo/app/shared/feature-flags/dev-mode/dev-mode-contract";
import { AGENTS_NAV_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { GlobalSidebar } from "@/app/(authenticated)/components/sidebar";

/**
 * ISS-7835 — dev mode OFF must produce the customer view, and ISS-5041 — the
 * Agents destination must be gated at all.
 *
 * These two are ONE mechanism, which is why they are asserted together here.
 * The customer view works by suppressing client PostHog reads
 * (`suppressesFeatureFlag`); Agents carried no flag, so there was nothing to
 * suppress and a staff viewer who turned dev mode off still saw it. The fix is
 * the flag, and the proof has to run the REAL `@repo/analytics/client` — a
 * suite that mocks that module (as `sidebar.test.tsx` does) cannot see
 * suppression at all and would stay green with the gate removed.
 *
 * Only the PostHog SDK below it is mocked. The underlying read is pinned ON in
 * every case that exercises suppression, so the ONLY thing that can hide Agents
 * is the customer view — an assertion that would otherwise pass for the wrong
 * reason. The localStorage fixture pins the same value for the
 * PostHog-disabled binding (`readFallbackFeatureFlag`), so the test asserts the
 * same contract whether or not this environment carries a PostHog key.
 */

const FALLBACK_FEATURE_FLAGS_STORAGE_KEY = "closedloop:e2e-feature-flags";
const AGENTS_BADGE_TEST_ID = "agents-nav-badge";

// Referenced through a hoisted handle rather than by importing `@posthog/next`:
// that package is a dependency of `@repo/analytics`, not of this app, so an
// import here resolves at runtime but fails `tsc`.
const { postHogFeatureFlagMock } = vi.hoisted(() => ({
  postHogFeatureFlagMock: vi.fn(),
}));

vi.mock("@posthog/next", () => ({
  useFeatureFlag: (flag: string) => postHogFeatureFlagMock(flag),
  usePostHog: vi.fn(() => ({
    identify: vi.fn(),
    capture: vi.fn(),
    reset: vi.fn(),
    startSessionRecording: vi.fn(),
    stopSessionRecording: vi.fn(),
    set_config: vi.fn(),
  })),
}));

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
  useOrganization: () => ({
    organization: {
      id: "org-123",
      name: "Test Organization",
      slug: "test-org",
    },
    isLoaded: true,
  }),
  useAuth: () => ({ isSignedIn: true }),
}));

const authSnapshot = {
  getToken: () => Promise.resolve(null),
  isLoaded: true,
  orgId: "org_a" as string | null,
  userId: "user_a" as string | null,
};

vi.mock("@repo/app/shared/auth/use-auth-snapshot", () => ({
  useAuthSnapshot: () => authSnapshot,
  useOptionalAuthSnapshot: () => authSnapshot,
}));

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

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "test-org" }),
  usePathname: () => "/test-org",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/environment", () => ({ appEnvironment: "local" }));

// ISS-5041 trap 3: the sidebar special-cases `AGENTS_NAV_PATH` to hang this
// badge off the row as `trailing`. Rendered as a findable node rather than
// stubbed to null, so the assertions below can prove the badge leaves WITH the
// row instead of surviving it.
vi.mock("@repo/app/agents/components/agents-nav-badge", () => ({
  AgentsNavBadge: () => <span data-testid={AGENTS_BADGE_TEST_ID} />,
}));

vi.mock("@repo/app/onboarding/components/guided-getting-started-card", () => ({
  GuidedGettingStartedCard: () => null,
}));

vi.mock("@repo/design-system/components/ui/sidebar", () => {
  const passthrough =
    (testId: string) =>
    ({ children }: { children?: React.ReactNode }) => (
      <div data-testid={testId}>{children}</div>
    );
  return {
    Sidebar: passthrough("sidebar"),
    SidebarContent: passthrough("sidebar-content"),
    SidebarFooter: passthrough("sidebar-footer"),
    SidebarGroup: passthrough("sidebar-group"),
    SidebarGroupContent: passthrough("sidebar-group-content"),
    SidebarGroupLabel: passthrough("sidebar-group-label"),
    SidebarHeader: passthrough("sidebar-header"),
    SidebarInset: passthrough("sidebar-inset"),
    SidebarMenu: passthrough("sidebar-menu"),
    SidebarMenuButton: passthrough("sidebar-menu-button"),
    SidebarMenuItem: passthrough("sidebar-menu-item"),
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
    // ISS-9888: the factory REPLACES the module, so an export the tree reaches
    // and this list omits fails the RENDER rather than the assertion. Nothing
    // here turns both Labs flags on today, so `LabsControls` — the only thing
    // that renders a separator — is never reached; this is present so that the
    // next case which does turn them on fails on its own assertion instead of
    // on a missing export.
    SidebarSeparator: () => <div data-testid="sidebar-separator" />,
  };
});

vi.mock("@/app/(authenticated)/components/search", () => ({
  Search: () => null,
}));
vi.mock("@/app/(authenticated)/components/sidebar-teams", () => ({
  SidebarTeams: () => null,
}));
vi.mock("@/app/(authenticated)/components/account-menu", () => ({
  AccountMenu: () => null,
}));
vi.mock(
  "@/app/(authenticated)/components/guided-onboarding-dialog-host",
  () => ({
    WebGuidedOnboardingDialogHost: () => null,
  })
);
vi.mock("@/app/(authenticated)/components/inbox-badge", () => ({
  InboxBadge: () => null,
}));
vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: ({ trigger }: { trigger?: React.ReactNode }) => (
    <div>{trigger}</div>
  ),
}));

beforeEach(() => {
  postHogFeatureFlagMock.mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.removeItem(FALLBACK_FEATURE_FLAGS_STORAGE_KEY);
});

describe("agentsNav key parity (ISS-5041)", () => {
  // The desktop parity row in `apps/desktop/test/feature-flags-cross-surface.test.ts`
  // compares two aliases of the ONE `@repo/api` constant, so it cannot see a
  // web-side re-declaration. This is the other half.
  test("the web alias resolves to the shared @repo/api constant", () => {
    expect(AGENTS_NAV_FEATURE_FLAG_KEY).toBe(AGENTS_NAV_FLAG_KEY);
  });

  test("the shared constant is the literal the desktop settings store persists", () => {
    // An INDEPENDENT literal on purpose — deriving it from the constant it
    // polices would agree with any rename. `agentsNav` is a persisted
    // `DesktopSettings` field name (ISS-5310), so renaming it to match the
    // kebab-case PostHog convention would strand every desktop user who has
    // already opted in. That is the mutation this pins.
    expect(AGENTS_NAV_FLAG_KEY).toBe("agentsNav");
  });
});

describe("Agents nav under the customer view (ISS-7835 / ISS-5041)", () => {
  test("a staff viewer who leaves dev mode does NOT see Agents", () => {
    renderSidebar({ agentsFlagOn: true, inDevMode: false });

    // The bug: with Agents always-on there was no flag for the customer view to
    // suppress, so this row rendered anyway.
    expect(queryAgentsLink()).toBeNull();
    // Trap 3: the badge rides on the row as `trailing`, so it must go too.
    expect(screen.queryByTestId(AGENTS_BADGE_TEST_ID)).toBeNull();
    // The section itself still renders (Sessions/Branches/Documents are
    // always-on), so the absence above is Agents being gated — not an empty
    // sidebar that would make any query return null.
    expect(screen.getByRole("link", { name: "Sessions" })).toBeInTheDocument();
  });

  test("the same staff viewer DOES see Agents while in dev mode", () => {
    renderSidebar({ agentsFlagOn: true, inDevMode: true });

    // The positive sibling for the case above: same locator, same flag value,
    // only the customer view differs. Without this, the assertion above could
    // be proving the absence of a locator that never matched anything.
    expect(queryAgentsLink()).toHaveAttribute("href", "/test-org/agents");
    expect(screen.getByTestId(AGENTS_BADGE_TEST_ID)).toBeInTheDocument();
  });

  test("a viewer whose org is not entitled does NOT see Agents", () => {
    // No customer view involved — this is the plain ISS-5041 gate, and it is
    // the ONLY permutation that exercises it. Suppressing the flag AND turning
    // it off would short-circuit on the customer view and never reach the gate.
    renderSidebar({ agentsFlagOn: false, inDevMode: true });

    expect(queryAgentsLink()).toBeNull();
    expect(screen.getByRole("link", { name: "Sessions" })).toBeInTheDocument();
  });

  test("leaving dev mode hides Agents with no reload and no cache clear", () => {
    // ISS-7835 AC3. The PostHog read below stays pinned ON and the localStorage
    // fixture is never touched between the two renders, so anything that
    // required clearing either one would leave Agents on screen here.
    const { rerender } = renderSidebar({
      agentsFlagOn: true,
      inDevMode: true,
    });
    expect(queryAgentsLink()).not.toBeNull();

    rerender(
      <CustomerViewProvider active exemptFlagKeys={DEV_MODE_EXEMPT_FLAG_KEYS}>
        <GlobalSidebar>
          <div />
        </GlobalSidebar>
      </CustomerViewProvider>
    );

    expect(queryAgentsLink()).toBeNull();
  });
});

function queryAgentsLink() {
  return screen.queryByRole("link", { name: "Agents" });
}

function renderSidebar({
  agentsFlagOn,
  inDevMode,
}: {
  agentsFlagOn: boolean;
  inDevMode: boolean;
}) {
  // Pin the underlying read for BOTH runtime bindings of `useFeatureFlag`, so
  // the presence of a PostHog key in the environment cannot change what this
  // test proves.
  postHogFeatureFlagMock.mockImplementation((flag: string) =>
    flag === AGENTS_NAV_FEATURE_FLAG_KEY ? agentsFlagOn : false
  );
  if (agentsFlagOn) {
    localStorage.setItem(
      FALLBACK_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ [AGENTS_NAV_FEATURE_FLAG_KEY]: true })
    );
  }

  return render(
    <CustomerViewProvider
      active={!inDevMode}
      exemptFlagKeys={DEV_MODE_EXEMPT_FLAG_KEYS}
    >
      <GlobalSidebar>
        <div />
      </GlobalSidebar>
    </CustomerViewProvider>,
    { wrapper: WebFeatureFlagProvider }
  );
}
