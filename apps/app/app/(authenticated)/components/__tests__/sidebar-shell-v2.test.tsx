import {
  NavigationActorStanding,
  type NavigationDestinationCount,
  NavigationDestinationStatus,
  NavigationProjectionStatus,
  type NavigationViewModel,
  pendingNavigationCount,
  toNavigationCount,
  unavailableNavigationCount,
} from "@repo/api/src/types/navigation-view-model";
import { SHELL_SIDEBAR_V2_FLAG_KEY } from "@repo/api/src/types/shell-sidebar-v2-flag";
import {
  ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  ShellNavigationGroupId,
  ShellNavigationItemId,
  ShellNavigationSurface,
  shellNavigationGateKeys,
} from "@repo/app/shared/lib/shell-navigation-contract";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * ISS-9734 / PLN-2016 M2 — the web mount of the shared v2 sidebar.
 *
 * Drives `GlobalSidebar`, the component the authenticated layout actually
 * mounts, rather than `WebShellSidebar` on its own: the criterion this replaces
 * (ISS-9734 AC5, retired with `WorkspaceExperienceRoot`) was about the WIRING,
 * and a suite that renders the v2 component directly stays green when the mount
 * site stops reaching it.
 *
 * The design-system sidebar is stubbed, the count badge and the collapsible
 * section are NOT: the badge's accessible name and the disclosure's
 * `aria-expanded` are half of what is being asserted, so stubbing them would
 * assert the stub.
 */

const harness = vi.hoisted(() => ({
  agentsActivity: {
    count: undefined as NavigationDestinationCount | undefined,
    isActiveCalls: [] as boolean[],
  },
  enabledFlags: new Set<string>(),
  inbox: {
    available: true,
    badgeFails: false,
    badgeThrows: 0,
    reads: 0,
    result: { isLoading: true } as Record<string, unknown>,
  },
  // Whether the shell has reached its mount effect. True by default, matching
  // every render after the first; the pre-mount case below is the first render.
  mounted: true,
  pathname: "/test-org/dashboard",
  // The three signals `useFeatureFlagsSettledForUser` composes. Default is the
  // no-PostHog-key build, which settles from the first render.
  postHog: {
    distinctId: undefined as string | undefined,
    enabled: false,
    flagsLoaded: true,
  },
  shellV2Enabled: false,
  viewModel: null as NavigationViewModel | null,
}));

const SIGNED_IN_USER_ID = "user-1";

vi.mock("@repo/analytics/client", () => ({
  // A getter, not a literal: the rollout-key cases below turn a real PostHog
  // client on, and `useFeatureFlagsSettledForUser` reads this as a module
  // binding rather than through a hook.
  get postHogFeatureFlagsEnabled() {
    return harness.postHog.enabled;
  },
  useFeatureFlag: (flag: string) => ({
    enabled:
      flag === SHELL_SIDEBAR_V2_FLAG_KEY
        ? harness.shellV2Enabled
        : harness.enabledFlags.has(flag),
    key: flag,
    payload: undefined,
    variant: undefined,
  }),
  useFeatureFlagsLoaded: () => harness.postHog.flagsLoaded,
  usePostHogDistinctId: () => harness.postHog.distinctId,
}));

vi.mock("@repo/app/shell/v2/hooks/use-navigation-view-model", () => ({
  useNavigationViewModel: () => harness.viewModel ?? readyViewModel(),
}));

// The real hook resolves to `true` inside `render`'s effect flush, so the FIRST
// render — the one that has to match the server's — is unobservable through it.
vi.mock("@repo/app/shared/hooks/use-is-mounted", () => ({
  useIsMounted: () => harness.mounted,
}));

// `AGENTS_NAV_BADGE_MAX` and `AGENTS_NAV_COUNT_NOUN` live in an unmocked
// module, so the cap and the noun asserted below are the real ones rather than
// a copy this file agrees with itself about.
vi.mock("@repo/app/agents/hooks/use-agents-nav-activity", async (original) => ({
  ...(await original<
    typeof import("@repo/app/agents/hooks/use-agents-nav-activity")
  >()),
  useAgentsNavActivity: ({ isActive }: { isActive: boolean }) => {
    harness.agentsActivity.isActiveCalls.push(isActive);
    return {
      count: harness.agentsActivity.count,
      // The trap this mount must not fall into: the hook folds an unsettled
      // read to a settled zero for its own label.
      label: "0 recently finished sessions",
      markVisited: vi.fn(),
    };
  },
}));

vi.mock("@repo/collaboration/client/inbox-count", () => ({
  useUnreadInboxCount: () => {
    harness.inbox.reads += 1;
    return harness.inbox.result;
  },
}));

// The REAL `LiveblocksErrorBoundary` is kept (only the availability read is
// doubled), so the badge mount below is asserted through the boundary the
// sidebar actually renders rather than through a stand-in (ISS-10202).
vi.mock(
  "@repo/collaboration/client/liveblocks-error-boundary",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useLiveblocksAvailability: () => ({ isAvailable: harness.inbox.available }),
  })
);

vi.mock("@repo/auth/client", () => ({
  CreateOrganization: () => null,
  useAuth: () => ({ isSignedIn: true }),
  useClerk: () => ({ signOut: vi.fn() }),
  useOrganization: () => ({
    isLoaded: true,
    membership: { role: "org:admin" },
    organization: {
      id: "org-123",
      name: "Test Organization",
      slug: "test-org",
    },
  }),
  useOrganizationList: () => ({ isLoaded: true, userMemberships: null }),
  useUser: () => ({
    isLoaded: true,
    user: { fullName: "Test User", id: SIGNED_IN_USER_ID },
  }),
}));

const shellAuthSnapshot = {
  getToken: () => Promise.resolve(null),
  isLoaded: true,
  orgId: "org-123" as string | null,
  userId: "user-1" as string | null,
};

vi.mock("@repo/app/shared/auth/use-auth-snapshot", () => ({
  useAuthSnapshot: () => shellAuthSnapshot,
  useOptionalAuthSnapshot: () => shellAuthSnapshot,
}));

const mockQueryClientClear = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ clear: mockQueryClientClear }),
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

vi.mock(
  "@repo/app/settings/v2/components/workspace-menu/workspace-menu",
  () => ({
    WorkspaceMenu: () => <div data-testid="workspace-menu">Workspace</div>,
  })
);

// A real node, not null: the wiring cases below read its ABSENCE as "the v2 tree
// rendered", and a badge stubbed to null cannot tell a dropped legacy row from
// a legacy row that rendered.
vi.mock("@repo/app/agents/components/agents-nav-badge", () => ({
  AgentsNavBadge: () => <span data-testid="legacy-agents-badge" />,
}));
/**
 * React absorbs a throw or two of its own accord, so a failing badge fails its
 * first `BADGE_THROW_BUDGET` renders — the same 3 measured in
 * `collaboration-provider-wrapper.test.tsx`.
 */
const BADGE_THROW_BUDGET = 3;
const BADGE_FAILURE_MESSAGE = "inbox-badge-render-failed";

vi.mock("../inbox-badge", () => ({
  InboxBadge: () => {
    if (
      harness.inbox.badgeFails &&
      harness.inbox.badgeThrows < BADGE_THROW_BUDGET
    ) {
      harness.inbox.badgeThrows += 1;
      throw new Error(BADGE_FAILURE_MESSAGE);
    }
    return <span data-testid="legacy-inbox-badge" />;
  },
}));

vi.mock("../guided-onboarding-dialog-host", () => ({
  WebGuidedOnboardingDialogHost: () => <div data-testid="onboarding-host" />,
}));
vi.mock("@repo/app/onboarding/components/guided-getting-started-card", () => ({
  GuidedGettingStartedCard: () => <div data-testid="getting-started-card" />,
}));
vi.mock("../search", () => ({
  Search: () => <div data-testid="search" />,
}));
vi.mock("../sidebar-teams", () => ({
  SidebarTeams: () => <div data-testid="sidebar-teams" />,
}));
vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: ({ trigger }: { trigger?: React.ReactNode }) => (
    <div data-testid="invite-team-dialog">{trigger}</div>
  ),
}));

const mockSetDevModeEnabled = vi.fn();
vi.mock("@repo/app/shared/feature-flags/dev-mode/dev-mode-provider", () => ({
  useDevMode: () => ({
    isDevModeAvailable: true,
    isDevModeEnabled: true,
    setDevModeEnabled: mockSetDevModeEnabled,
  }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "test-org" }),
  usePathname: () => harness.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/environment", () => ({ appEnvironment: "local" }));

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
  // Renders `children` and keeps `aria-disabled`, because the unresolved-row
  // branch of the composite says what it is through both.
  SidebarMenuButton: ({
    children,
    ...rest
  }: React.ComponentProps<"button">) => (
    <button data-testid="sidebar-menu-button" type="button" {...rest}>
      {children}
    </button>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu-item">{children}</div>
  ),
  // `trailing` is rendered: the count badges ride there, and a stub that drops
  // it would make every badge assertion below unfalsifiable.
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
  SidebarSeparator: () => <div data-testid="sidebar-separator" />,
}));

import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { GlobalSidebar } from "../sidebar";
import {
  shellGroupLabel,
  shellItemLabel,
} from "./shell-navigation-labels.test-helpers";

/** The name the hook's own `label` would announce for an unsettled read. */
const SETTLED_ZERO_AGENTS_LABEL = /0 recently finished sessions/;

const WEB_DESTINATION_IDS: readonly string[] = [
  ShellNavigationItemId.Dashboard,
  ShellNavigationItemId.Documents,
  ShellNavigationItemId.Issues,
  ShellNavigationItemId.Sessions,
  ShellNavigationItemId.Branches,
  ShellNavigationItemId.Inbox,
  ShellNavigationItemId.Insights,
  ShellNavigationItemId.MyTasks,
  ShellNavigationItemId.Packs,
  ShellNavigationItemId.LostWork,
  ShellNavigationItemId.TokenOpsWaste,
  ShellNavigationItemId.Judges,
  ShellNavigationItemId.Agents,
];

function readyViewModel(
  status: NavigationDestinationStatus = NavigationDestinationStatus.Ready
): NavigationViewModel {
  const destinations: Record<string, { status: NavigationDestinationStatus }> =
    {};
  for (const id of WEB_DESTINATION_IDS) {
    destinations[id] = { status };
  }
  return {
    destinations,
    organizationId: "org-123",
    projectionStatus: NavigationProjectionStatus.Ready,
    standing: NavigationActorStanding.Member,
  };
}

function projectionOnly(
  projectionStatus: NavigationProjectionStatus
): NavigationViewModel {
  return {
    destinations: {},
    organizationId: null,
    projectionStatus,
    standing: NavigationActorStanding.Unknown,
  };
}

function renderSidebar(options?: Parameters<typeof render>[1]) {
  render(
    <GlobalSidebar envBadge="localhost">
      <div>Content</div>
    </GlobalSidebar>,
    { wrapper: WebFeatureFlagProvider, ...options }
  );
}

// React recovers a failed CONCURRENT render by re-rendering the whole root
// synchronously and announcing that through the root's `onRecoverableError`,
// separately from — and in addition to — the boundary catch that did its job.
// React's default handler is `reportError`, which in jsdom becomes a
// process-level uncaught exception, so vitest fails the JOB on a green suite
// (ISS-9661). Reading each announcement off this one root, and asserting it,
// keeps the throw, the recovery and the boundary catch all intact.
function recoveredCauseMessage(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error ? cause.message : undefined;
}

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

/**
 * The non-navigable row for a destination. It stays focusable — a destination
 * whose capability has not resolved is still one the user needs to find — so it
 * is a button, not a link.
 */
function unresolvedRow(label: string): HTMLElement {
  const row = screen.getByText(label).closest("button");
  if (row === null) {
    throw new Error(`No unresolved row was rendered for "${label}"`);
  }
  return row;
}

/** Labs ships CLOSED in the v2 hierarchy, so its rows need opening first. */
function expandLabs(): HTMLElement {
  fireEvent.click(
    within(sectionNamed("Labs")).getByRole("button", {
      name: "Labs",
    })
  );
  return sectionNamed("Labs");
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.enabledFlags.clear();
  // Every web gate the contract declares, open, so a row missing below is a
  // decision this mount made rather than a gate nobody opened. Cases that need
  // a gate CLOSED delete that one key.
  for (const key of shellNavigationGateKeys(ShellNavigationSurface.Web)) {
    harness.enabledFlags.add(key);
  }
  // Not a contract gate: the Labs MENU MOUNT reads its own key on BOTH arms,
  // split off the shape key so `labs-nav-section` can go to 100%. The cases
  // below assert rows that live inside Labs, so the menu has to be open for
  // them to mount at all.
  harness.enabledFlags.add(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);
  harness.shellV2Enabled = true;
  harness.viewModel = null;
  harness.mounted = true;
  harness.pathname = "/test-org/dashboard";
  harness.agentsActivity.count = undefined;
  harness.agentsActivity.isActiveCalls.length = 0;
  harness.inbox.available = true;
  harness.inbox.badgeFails = false;
  harness.inbox.badgeThrows = 0;
  harness.inbox.reads = 0;
  harness.inbox.result = { isLoading: true };
  harness.postHog.distinctId = undefined;
  harness.postHog.enabled = false;
  harness.postHog.flagsLoaded = true;
  globalThis.localStorage.clear();
});

afterEach(cleanup);

describe("the mount is the branch (replaces the retired ISS-9734 AC5)", () => {
  test("renders the v2 sidebar only with the key on", () => {
    renderSidebar();

    // The v2 hierarchy nests its own Artifacts group under Labs, so "Artifacts"
    // names two disclosures; the legacy tree has at most one. Paired with the
    // absence of the legacy row badges, which only the legacy `NavLinkRow`
    // renders.
    expandLabs();
    expect(screen.getAllByRole("button", { name: "Artifacts" })).toHaveLength(
      2
    );
    expect(screen.queryByTestId("legacy-agents-badge")).toBeNull();
    expect(screen.queryByTestId("legacy-inbox-badge")).toBeNull();
    // One sidebar root: the composite brings its own, so a mount INSIDE the
    // host's `<Sidebar>` would nest two (and a Sheet in a Sheet on mobile).
    expect(screen.getAllByTestId("sidebar")).toHaveLength(1);
  });

  test("renders the legacy sidebar only with the key off", () => {
    harness.shellV2Enabled = false;

    renderSidebar();

    expect(screen.getByTestId("legacy-agents-badge")).toBeInTheDocument();
    expect(screen.getAllByTestId("sidebar")).toHaveLength(1);
    // The v2-only shape is absent: no second Artifacts disclosure.
    expect(
      screen.queryAllByRole("button", { name: "Artifacts" }).length
    ).toBeLessThan(2);
  });

  test("keeps the shell's own side effects under the v2 arm", () => {
    renderSidebar();

    // The onboarding host and the org-change cache sweep live OUTSIDE the
    // branch, so neither arm can drop them.
    expect(screen.getByTestId("onboarding-host")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-inset")).toBeInTheDocument();
  });

  test("keeps the legacy tree while a bootstrap true has not been confirmed for this user", () => {
    // A real PostHog client serving the ANONYMOUS bootstrap: `identify()` has
    // not landed and the post-identify flag load has not delivered, so this
    // `true` describes a distinct id the user does not have. Committing the v2
    // tree on it would mount the rollout for a user whose assignment is off —
    // and keep it mounted, because a failed `/flags` never corrects it.
    harness.postHog.enabled = true;
    harness.postHog.flagsLoaded = false;
    harness.postHog.distinctId = undefined;
    harness.shellV2Enabled = true;

    renderSidebar();

    expect(screen.getByTestId("legacy-agents-badge")).toBeInTheDocument();
  });

  test("keeps the legacy tree on the render the server has to match", () => {
    // Settled does not cover this. The default harness is the no-PostHog-key
    // build, which reports settled from the very first render and resolves the
    // key off the local fixture — and that fixture is read only when
    // `globalThis.window` is defined. So the server renders legacy while the
    // client's first render would render v2, and the disagreement is the whole
    // sidebar subtree rather than one row.
    harness.mounted = false;
    harness.shellV2Enabled = true;

    renderSidebar();

    expect(screen.getByTestId("legacy-agents-badge")).toBeInTheDocument();
    expect(
      screen.queryAllByRole("button", { name: "Artifacts" }).length
    ).toBeLessThan(2);
  });

  test("mounts v2 once PostHog has answered for the signed-in user", () => {
    harness.postHog.enabled = true;
    harness.postHog.flagsLoaded = true;
    harness.postHog.distinctId = SIGNED_IN_USER_ID;
    harness.shellV2Enabled = true;

    renderSidebar();

    // The same live client, the same `true`, now keyed on this user: the hold
    // above is about the identity behind the answer and not about a hook that
    // never ran.
    expect(screen.queryByTestId("legacy-agents-badge")).toBeNull();
    expect(screen.getAllByTestId("sidebar")).toHaveLength(1);
  });

  test("mounts the workspace menu in the header, and keeps the legacy footer rows gone", () => {
    renderSidebar();

    const header = screen.getByTestId("sidebar-header");
    expect(within(header).getByTestId("workspace-menu")).toBeInTheDocument();
    // One mount of the menu, not two.
    expect(screen.getAllByTestId("workspace-menu")).toHaveLength(1);
    expect(screen.queryByTestId("invite-team-dialog")).toBeNull();
    expect(screen.getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "href",
      "/test-org/sessions"
    );
    // Named once: the same destination reachable twice is two rows claiming to
    // be the same place.
    expect(screen.getAllByRole("link", { name: "Sessions" })).toHaveLength(1);
  });
});

describe("what an unresolved projection may render", () => {
  test.each([
    [NavigationProjectionStatus.Pending, "Loading"],
    [NavigationProjectionStatus.Error, "Unavailable"],
  ])(
    "a %s projection keeps the row, says so in text, and links nowhere",
    (projectionStatus, word) => {
      harness.viewModel = projectionOnly(projectionStatus);

      renderSidebar();

      // The destination is still THERE — dropping it would turn a read that
      // never landed into "this place does not exist for you" — but it is not a
      // link, and it says which of the two it is in words rather than in a
      // shade of grey (WCAG 1.4.1).
      expect(
        screen.queryByRole("link", {
          name: shellItemLabel(ShellNavigationItemId.Sessions),
        })
      ).toBeNull();
      const row = unresolvedRow("Sessions");
      expect(row).toHaveAttribute("aria-disabled", "true");
      expect(within(row).getByText(word)).toBeInTheDocument();
    }
  );

  test("host controls survive a projection that resolved nothing", () => {
    harness.viewModel = projectionOnly(NavigationProjectionStatus.Error);

    renderSidebar();
    const labs = expandLabs();

    // Search and Your Teams are host affordances, not destinations: a failed
    // actor read says nothing about them.
    expect(within(labs).getByTestId("search")).toBeInTheDocument();
    expect(within(labs).getByTestId("sidebar-teams")).toBeInTheDocument();
  });
});

describe("counts the host layers onto the projection", () => {
  test("renders the unread inbox count with a noun", () => {
    harness.inbox.result = { count: 3, isLoading: false };

    renderSidebar();
    const labs = expandLabs();

    expect(
      within(labs).getByRole("status", { name: "3 unread notifications" })
    ).toBeInTheDocument();
  });

  test.each([
    ["still loading", { isLoading: true }, true],
    ["failed", { error: new Error("nope"), isLoading: false }, true],
    ["unavailable", { count: 4, isLoading: false }, false],
  ])(
    "renders no inbox badge when the count is %s",
    (_label, result, available) => {
      harness.inbox.result = result as Record<string, unknown>;
      harness.inbox.available = available;

      renderSidebar();
      const labs = expandLabs();

      expect(within(labs).queryByRole("status")).toBeNull();
      // The row itself is untouched: an unreadable count is not a reason to
      // take the destination away.
      expect(
        within(labs).getByRole("link", { name: "Inbox" })
      ).toBeInTheDocument();
    }
  );

  test("caps the Agents badge at the hook's max and names the true count", () => {
    harness.agentsActivity.count = toNavigationCount(12);

    renderSidebar();
    const labs = expandLabs();

    const badge = within(labs).getByRole("status", {
      name: "12 recently finished sessions",
    });
    // `9+`, from AGENTS_NAV_BADGE_MAX, reached through `resolveRoute` rather
    // than a cap this adapter re-declared.
    expect(badge).toHaveTextContent("9+");
  });

  test.each([
    ["pending", pendingNavigationCount()],
    ["unavailable", unavailableNavigationCount()],
  ])(
    "never announces a settled zero while the Agents count is %s",
    (_label, count) => {
      harness.agentsActivity.count = count;

      renderSidebar();
      const labs = expandLabs();

      // The review constraint on PR #7266: the hook's own `label` folds an
      // unsettled read to "0 recently finished sessions". This mount never
      // passes that label anywhere, so no badge and no such name exists.
      expect(screen.queryByText(SETTLED_ZERO_AGENTS_LABEL)).toBeNull();
      expect(
        within(labs).getByRole("link", { name: "Agents" })
      ).toBeInTheDocument();
    }
  );

  test("drains the Agents badge on the Agents route", () => {
    harness.pathname = "/test-org/agents";

    renderSidebar();

    expect(harness.agentsActivity.isActiveCalls).toContain(true);
  });

  test("does not treat a sibling route as the Agents route", () => {
    harness.pathname = "/test-org/agents-archive";

    renderSidebar();

    expect(harness.agentsActivity.isActiveCalls).not.toContain(true);
  });
});

describe("the inbox count is read where the row is, not where the shell is", () => {
  test("opens no subscription while Liveblocks is unavailable", () => {
    harness.inbox.available = false;

    renderSidebar();
    const labs = expandLabs();

    // `CollaborationProviderWrapper` holds inbox hooks off with
    // `isAvailable === false` through its whole bootstrap window, and this
    // adapter is mounted on every authenticated page. The row is still there
    // and simply carries no badge, exactly as the legacy `InboxBadge` behaves.
    expect(harness.inbox.reads).toBe(0);
    expect(
      within(labs).getByRole("link", { name: "Inbox" })
    ).toBeInTheDocument();
    expect(within(labs).queryByRole("status")).toBeNull();
  });

  test("opens one once Liveblocks is available", () => {
    harness.inbox.result = { count: 3, isLoading: false };

    renderSidebar();

    expect(harness.inbox.reads).toBeGreaterThan(0);
  });

  test("keeps the sidebar mounted when Liveblocks becomes available", () => {
    harness.inbox.available = false;
    harness.inbox.result = { count: 3, isLoading: false };
    const tree = () => (
      <GlobalSidebar envBadge="localhost">
        <div>Content</div>
      </GlobalSidebar>
    );

    const { rerender } = render(tree(), { wrapper: WebFeatureFlagProvider });
    const inboxBeforeFlip = within(expandLabs()).getByRole("link", {
      name: "Inbox",
    });

    harness.inbox.available = true;
    rerender(tree());

    // Labs ships closed, so a remounted sidebar would also have closed it: the
    // same node AND the badge inside the still-open section both say it stayed.
    const labs = sectionNamed("Labs");
    expect(within(labs).getByRole("link", { name: "Inbox" })).toBe(
      inboxBeforeFlip
    );
    expect(
      within(labs).getByRole("status", { name: "3 unread notifications" })
    ).toBeInTheDocument();
  });
});

describe("every affordance keeps exactly one home", () => {
  test("Labs holds the dev-mode switch when it is there", () => {
    renderSidebar();
    const labs = expandLabs();

    expect(
      within(labs).getByRole("switch", { name: "Dev mode" })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("switch", { name: "Dev mode" })).toHaveLength(1);
  });

  test("the footer keeps only the dev-mode switch when Labs is absent", () => {
    harness.enabledFlags.delete(LABS_NAV_SECTION_FEATURE_FLAG_KEY);

    renderSidebar();

    const footer = screen.getByTestId("sidebar-footer");
    // ISS-11248. The switch stays: it is the way back out of the customer view
    // that closed Labs.
    expect(
      within(footer).getByRole("switch", { name: "Dev mode" })
    ).toBeInTheDocument();
    // Absent, not relocated — nowhere in the shell, matching desktop.
    expect(screen.queryByTestId("sidebar-teams")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: shellGroupLabel(ShellNavigationGroupId.Labs),
      })
    ).toBeNull();
    // The footer's other rows are unchanged — the env badge is the same node
    // both arms render.
    expect(within(footer).getByText("localhost")).toBeInTheDocument();
    expect(
      within(footer).getByTestId("getting-started-card")
    ).toBeInTheDocument();
  });
});

/**
 * The split `enable-labs-nav-section` gate, on the arm that was still reading
 * the old key when this PR's first head landed (codex P1 on #8156).
 *
 * The v2 tree reaches Labs through the shared contract, where `labs-nav-section`
 * gates the Labs GROUP — and a closed group does not merely hide the section, it
 * re-homes Documents, Inbox, My Tasks, Issues, Agents and Search back
 * into the nav (`SHELL_CONTAINER_ABSENT_HOME`). So the menu key cannot be added
 * as a second gate there; the host drops the built section instead, which is
 * what the legacy `LabsNavSection` returning `null` already does. Both halves
 * are asserted on one render: no menu, and no re-homing.
 */
describe("the v2 arm honours the split menu gate", () => {
  test("drops the Labs section without re-homing its rows when the menu key is off", () => {
    harness.enabledFlags.delete(ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY);

    renderSidebar();

    expect(
      screen.queryByRole("button", {
        name: shellGroupLabel(ShellNavigationGroupId.Labs),
      })
    ).toBeNull();
    // The shape key is still open, so these stay OUT of the nav rather than
    // falling back to their pre-move homes — the whole point of the split.
    for (const moved of ["My Tasks", "Inbox"]) {
      expect(screen.queryByRole("link", { name: moved })).toBeNull();
    }
    expect(screen.queryByTestId("sidebar-teams")).toBeNull();
    // Positive siblings on the same queries: the tree rendered, and the switch
    // took its footer fallback because its home inside Labs never mounted.
    expect(screen.getByRole("link", { name: "Sessions" })).toBeInTheDocument();
    expect(
      within(screen.getByTestId("sidebar-footer")).getByRole("switch", {
        name: "Dev mode",
      })
    ).toBeInTheDocument();
  });

  test("keeps the section and its rows with both keys open", () => {
    renderSidebar();

    const labs = expandLabs();
    expect(
      within(labs).getByRole("link", { name: "Inbox" })
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("sidebar-footer")).queryByRole("switch", {
        name: "Dev mode",
      })
    ).toBeNull();
  });
});

describe("the Inbox badge's Liveblocks boundary mount (ISS-10202)", () => {
  test("keeps a failing badge off the shell instead of taking the sidebar down", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    // `navItemTrailing` — the one call site of the badge — is on the legacy
    // nav tree (`sidebar.tsx:405`), so that is the branch this mount lives on.
    harness.shellV2Enabled = false;
    harness.inbox.badgeFails = true;

    const recoveredCauses: (string | undefined)[] = [];

    try {
      // No outer boundary: without the mount at the badge, this render THROWS
      // and the case fails outright rather than asserting anything below.
      // `onRecoverableError` is scoped to THIS root only, so a genuine uncaught
      // error anywhere else in the project still fails the run.
      renderSidebar({
        onRecoverableError: (error) =>
          recoveredCauses.push(recoveredCauseMessage(error)),
      });

      // Reaching this line at all IS the assertion: the shell rendered rather
      // than the throw escaping. What the badge shows afterwards is the
      // boundary's own degradation, pinned in `packages/collaboration`, and
      // this suite doubles the availability read so it cannot observe it here.
      expect(screen.getByTestId("sidebar-content")).toBeInTheDocument();
      // The badge really did fail its full budget, so the assertion above
      // cannot be satisfied by a render in which nothing ever threw.
      expect(harness.inbox.badgeThrows).toBe(BADGE_THROW_BUDGET);
      // React really did announce a recovery, and every announcement is this
      // badge's own throw. Asserting the identity rather than dropping the
      // notices is what keeps the handler above from being a silencer: remove
      // it and this collects nothing, so the case goes red here instead of the
      // announcements landing on `reportError` and failing the job on a green
      // suite.
      expect(new Set(recoveredCauses)).toEqual(
        new Set([BADGE_FAILURE_MESSAGE])
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
