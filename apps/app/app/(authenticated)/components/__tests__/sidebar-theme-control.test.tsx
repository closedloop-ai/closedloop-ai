import { SHELL_SIDEBAR_V2_FLAG_KEY } from "@repo/api/src/types/shell-sidebar-v2-flag";
import { WORKSPACE_MENU_TRIGGER_LABEL } from "@repo/api/src/types/workspace-menu";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { ThemeProvider } from "@repo/design-system/providers/theme";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installPointerCaptureShims } from "@/__tests__/helpers/pointer-capture-shims";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { GlobalSidebar } from "../sidebar";

/**
 * ISS-9889 — the theme control has to be REACHABLE from the authenticated
 * shell, on whichever tree the workspace-experience root chooses.
 *
 * Deliberately not a render of `ThemeSubmenu`, `AccountMenu`, or
 * `WorkspaceMenu` on their own: the control was already covered in isolation
 * and that coverage stayed green while the v2 tree shipped without it. So this
 * drives `GlobalSidebar` — the component the authenticated layout mounts — with
 * the real sidebar primitives, the real identity menus, the real
 * `ThemeSubmenu`, and the real `next-themes` provider, and mocks only what
 * sits outside the path from the shell to the theme control.
 *
 * It also asserts the theme actually CHANGES rather than that a row exists: a
 * menu item wired to nothing would satisfy the weaker check.
 */

installPointerCaptureShims();

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

// Every flag on except the sidebar rollout key (PLN-2016 M2): this file asserts
// the LEGACY tree's theme control, and `GlobalSidebar` now branches between two
// whole sidebars on that key.
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

vi.mock("../guided-onboarding-dialog-host", () => ({
  WebGuidedOnboardingDialogHost: () => null,
}));

vi.mock("@repo/app/onboarding/components/guided-getting-started-card", () => ({
  GuidedGettingStartedCard: () => null,
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
vi.mock("../inbox-badge", () => ({ InboxBadge: () => null }));
vi.mock("@repo/app/agents/components/agents-nav-badge", () => ({
  AgentsNavBadge: () => null,
}));
vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: ({ trigger }: { trigger?: React.ReactNode }) => (
    <div>{trigger}</div>
  ),
}));

const THEME_STORAGE_KEY = "theme";
const THEME_TRIGGER_LABEL = "Theme";

/**
 * Explicit rather than the 5s default. Each case drives a full `GlobalSidebar`
 * mount plus four real Radix pointer interactions through jsdom, which is
 * genuinely slow on a loaded machine — the default is close enough to the
 * honest runtime to fail on scheduling noise alone. This is a bound on a
 * deterministic interaction sequence, not a hang mask: nothing here waits on a
 * timer, a network call, or a retry.
 */
const INTERACTION_TIMEOUT_MS = 30_000;

function renderSidebar() {
  return render(
    <ThemeProvider>
      <SidebarProvider>
        <GlobalSidebar envBadge={null}>
          <div>Content</div>
        </GlobalSidebar>
      </SidebarProvider>
    </ThemeProvider>,
    { wrapper: WebFeatureFlagProvider }
  );
}

/**
 * Walks the shell exactly as a user does: open the identity menu the tree
 * mounted, open the theme submenu inside it, pick a theme. Returns the chosen
 * radio item so the caller asserts against the control it actually operated
 * rather than any element bearing the same words.
 */
async function chooseThemeFromShell(
  triggerLabel: string,
  themeLabel: string
): Promise<HTMLElement> {
  const user = userEvent.setup();

  await user.click(screen.getByRole("button", { name: triggerLabel }));
  const menu = await screen.findByRole("menu");

  await user.click(
    within(menu).getByRole("menuitem", { name: THEME_TRIGGER_LABEL })
  );

  const option = await screen.findByRole("menuitemradio", {
    name: themeLabel,
  });
  await user.click(option);
  return option;
}

describe("GlobalSidebar — theme control reachability (ISS-9889)", () => {
  beforeEach(() => {
    mockUseOrganizationList.mockClear();
    document.documentElement.className = "";
  });

  afterEach(() => {
    document.documentElement.className = "";
  });

  test(
    "a signed-in user reaches the theme control from the workspace menu and switching applies",
    async () => {
      renderSidebar();

      const option = await chooseThemeFromShell(
        WORKSPACE_MENU_TRIGGER_LABEL,
        "Dark"
      );

      expect(option).toHaveAttribute("aria-checked", "true");
      expect(document.documentElement).toHaveClass("dark");
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    },
    INTERACTION_TIMEOUT_MS
  );

  test(
    "the choice is restored on the next load, not just written",
    async () => {
      const view = renderSidebar();

      await chooseThemeFromShell(WORKSPACE_MENU_TRIGGER_LABEL, "Light");
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

      // The reload, actually performed rather than inferred: tear the tree down,
      // clear what only the live provider could have put on the document, then
      // mount a fresh provider and touch nothing. Asserting the persisted key and
      // the class from the FIRST mount would prove the write happened and say
      // nothing about whether anything reads it back.
      view.unmount();
      document.documentElement.className = "";
      render(
        <ThemeProvider>
          <div />
        </ThemeProvider>,
        { wrapper: WebFeatureFlagProvider }
      );

      await waitFor(() =>
        expect(document.documentElement).toHaveClass("light")
      );
    },
    INTERACTION_TIMEOUT_MS
  );
});
