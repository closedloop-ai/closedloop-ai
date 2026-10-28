/**
 * @file sidebar-shell-v2.test.tsx
 * @description The desktop mount of the shared v2 `ShellSidebar` (ISS-9734,
 * PLN-2016 M3), asserted against the real `Sidebar` at the real mount site.
 *
 * The sibling `sidebar-workspace-experience.test.tsx` is the KEY-OFF record —
 * what the population outside the rollout renders — and every case there mounts
 * under `DesktopAppCoreProvider`'s all-off flag adapter. This file owns the
 * key-ON tree and the branch between the two, so neither arm can start rendering
 * unconditionally without a case here going red.
 */

import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import {
  NavigationActorStanding,
  NavigationDestinationStatus,
  NavigationProjectionStatus,
  type NavigationViewModel,
  pendingNavigationCount,
  toNavigationCount,
} from "@repo/api/src/types/navigation-view-model";
import { SHELL_SIDEBAR_V2_FLAG_KEY } from "@repo/api/src/types/shell-sidebar-v2-flag";
import { WORKSPACE_MENU_TRIGGER_LABEL } from "@repo/api/src/types/workspace-menu";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  ShellNavigationGroupId,
  ShellNavigationItemId,
  ShellNavigationSurface,
  shellNavigationGateKeys,
} from "@repo/app/shared/lib/shell-navigation-contract";
import { ENTRY_STATE_WORD } from "@repo/app/shell/v2/components/shell-sidebar";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags-labs-detail";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import { pageTitleForNav } from "../../../navigation/nav-config";
import { NavId } from "../../../navigation/route-table";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { Sidebar } from "../Sidebar";
import {
  DESKTOP_LABS_NAV_SECTION_STORAGE_KEY,
  DESKTOP_SHELL_V2_SECTION_PERSISTENCE_KEY_PREFIX,
} from "../sidebar-persistence";
import { shellItemLabel } from "./shell-item-label-test-helpers";

const INVITE_TEST_ID = "invite-team-dialog";
const GUIDED_CARD_TEST_ID = "guided-getting-started-card";
/** The Agents count label the shared hook folds a not-ready read down to. */
const FOLDED_ZERO_LABEL = "0 recently finished sessions";
/** Row names, matched loosely because the fold appends a state word or a badge. */
const DASHBOARD_ROW_NAME = /Dashboard/;
const AGENTS_ROW_NAME = /Agents/;
const LABS_SECTION_NAME = /Labs/;
const CLEAR_SEARCH_NAME = "Clear search";
/** The state word the v2 fold appends to an errored row. */
const UNAVAILABLE_STATE_WORD =
  ENTRY_STATE_WORD[NavigationDestinationStatus.CapabilityError];
/** The Labs search box's accessible name (inline in `SidebarSearchForm`). */
const SEARCH_TEXTBOX_NAME = "Search";
/** The v2 Branches row's label, as the shared contract declares it. */
const BRANCHES_ROW_LABEL = shellItemLabel(ShellNavigationItemId.Branches);

const authState = vi.hoisted(() => ({ status: "authenticated" as string }));
const identityState = vi.hoisted(() => ({
  identity: null as {
    organizationName: string | null;
    email: string;
    firstName: string | null;
    lastName: string | null;
  } | null,
  isResolved: false,
}));
const projection = vi.hoisted(() => ({ ready: true }));
const agentsActivity = vi.hoisted(() => ({ count: undefined as unknown }));
const sessionLimitsReads = vi.hoisted(() => ({ count: 0 }));

vi.mock(
  "../../../shared-agent-sessions/desktop-auth-provider",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../shared-agent-sessions/desktop-auth-provider")
      >();
    return {
      ...actual,
      useDesktopAuth: () => ({
        state: { status: authState.status, userId: "user_1" },
        signOut: () => Promise.resolve(),
        signIn: () => Promise.resolve(),
      }),
    };
  }
);
vi.mock("../../../shared-agent-sessions/use-desktop-identity", () => ({
  useDesktopIdentity: () => identityState,
}));
/**
 * The session-limits summary renders nothing without a live usage snapshot, so
 * counting the read is how the footer's THIRD slot is asserted at all: a v2
 * footer that dropped `SessionLimitsFooter` would call this zero times and look
 * identical on screen.
 */
vi.mock("../../../hooks/use-session-limits", async (original) => {
  const actual =
    await original<typeof import("../../../hooks/use-session-limits")>();
  return {
    ...actual,
    useSessionLimits: () => {
      sessionLimitsReads.count += 1;
      return actual.useSessionLimits();
    },
  };
});
vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: ({ trigger }: { trigger?: React.ReactNode }) => (
    <div data-testid="invite-team-dialog">{trigger}</div>
  ),
}));
vi.mock("@repo/app/onboarding/components/guided-getting-started-card", () => ({
  GuidedGettingStartedCard: () => (
    <div data-testid="guided-getting-started-card" />
  ),
}));
/**
 * The desktop flag assignment has ARRIVED. Without it the adapter holds the
 * projection read for ten seconds, and every case below would assert against a
 * pending tree rather than the one a settled desktop renders.
 */
vi.mock("../../../feature-flags/desktop-feature-flag-provider", async () => {
  const actual = await vi.importActual<
    typeof import("../../../feature-flags/desktop-feature-flag-provider")
  >("../../../feature-flags/desktop-feature-flag-provider");
  return { ...actual, useDesktopFeatureFlagsResolved: () => true };
});
/**
 * The cloud projection, stubbed at the shared hook rather than at the IPC
 * bridge: the transport itself is the subject of
 * `desktop-shell-navigation-transport.test.tsx`, and a bare `desktopApi` here
 * would put every case behind react-query's retry schedule.
 */
vi.mock("@repo/app/shell/v2/hooks/use-navigation-view-model", () => ({
  useNavigationViewModel: (destinationIds: readonly string[]) => {
    if (!projection.ready) {
      return ERRORED_VIEW_MODEL;
    }
    const destinations: Record<string, { status: string }> = {};
    for (const id of destinationIds) {
      destinations[id] = { status: NavigationDestinationStatus.Ready };
    }
    return { ...READY_VIEW_MODEL, destinations };
  },
}));
vi.mock("@repo/app/agents/hooks/use-agents-nav-activity", async (original) => ({
  ...(await original<
    typeof import("@repo/app/agents/hooks/use-agents-nav-activity")
  >()),
  useAgentsNavActivity: () => ({
    count: agentsActivity.count,
    // The fold the review constraint is about: a not-ready read still produces
    // this sentence. Nothing the desktop mount renders may carry it.
    label: FOLDED_ZERO_LABEL,
    markVisited: vi.fn(),
  }),
}));

const READY_VIEW_MODEL: NavigationViewModel = {
  destinations: {},
  organizationId: "org-123",
  projectionStatus: NavigationProjectionStatus.Ready,
  standing: NavigationActorStanding.Member,
};
const ERRORED_VIEW_MODEL: NavigationViewModel = {
  destinations: {},
  organizationId: null,
  projectionStatus: NavigationProjectionStatus.Error,
  standing: NavigationActorStanding.Unknown,
};

/**
 * Every desktop nav gate the contract declares, so nothing is closed by
 * omission — DERIVED, never hand-listed. A sixth desktop gate would be closed
 * in every case below while the tree assertions still passed, so the list has
 * to learn about it from the contract itself (the sibling adapter suite reads
 * the same function).
 */
const ALL_DESKTOP_NAV_GATES: readonly string[] = shellNavigationGateKeys(
  ShellNavigationSurface.Desktop
);

/** Where the v2 tree persists the Labs section's open state (PLN-2016 D9). */
const LABS_V2_PERSISTENCE_KEY = `${DESKTOP_SHELL_V2_SECTION_PERSISTENCE_KEY_PREFIX}.${ShellNavigationGroupId.Labs}`;

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

beforeEach(() => {
  // A FRESH store per case, and the reason is not hygiene for its own sake:
  // section open state is persisted (PLN-2016 D9), so a case that expanded Labs
  // left the next one's `expandLabs()` COLLAPSING it. That went unseen locally
  // because a newer Node shadows jsdom's `localStorage` with an experimental
  // global that throws unless the process was started with `--localstorage-file`
  // — the persistence path silently no-opped here and ran in CI.
  stubLocalStorage();
  setDesktopApi({});
  authState.status = DesktopAuthStatus.Authenticated;
  identityState.isResolved = true;
  identityState.identity = {
    organizationName: "Closedloop",
    email: "ada@closedloop.ai",
    firstName: "Ada",
    lastName: "Lovelace",
  };
  projection.ready = true;
  agentsActivity.count = undefined;
  sessionLimitsReads.count = 0;
});

afterEach(() => {
  cleanup();
});

function setDesktopApi(value: Record<string, unknown>): void {
  Object.defineProperty(window, "desktopApi", { configurable: true, value });
}

function renderSidebar({
  activeNav = NavId.Dashboard,
  enabledFlags = [SHELL_SIDEBAR_V2_FLAG_KEY, ...ALL_DESKTOP_NAV_GATES],
  hiddenNavIds,
  initialPath = "/dashboard",
}: {
  activeNav?: NavId;
  enabledFlags?: readonly string[];
  hiddenNavIds?: readonly NavId[];
  initialPath?: string;
} = {}) {
  const memoryNav = createMemoryNavigation({ initialPath });
  const view = render(
    <DesktopAppCoreProvider>
      <NavigationProvider adapter={memoryNav.adapter}>
        {/* Below the core provider's all-off adapter, so this one wins — the
            same nesting `DesktopFeatureFlagProvider` uses in production. */}
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
        >
          <SidebarProvider>
            <Sidebar activeNav={activeNav} hiddenNavIds={hiddenNavIds} />
          </SidebarProvider>
        </FeatureFlagAdapterProvider>
      </NavigationProvider>
    </DesktopAppCoreProvider>
  );
  return { ...view, memoryNav };
}

function sidebarRootCount(): number {
  return document.querySelectorAll('[data-sidebar="sidebar"]').length;
}

function footer(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    '[data-sidebar="footer"]'
  );
  if (!element) {
    throw new Error("sidebar footer not rendered");
  }
  return element;
}

/** Group titles in DOM order, which is the rendered hierarchy as a plain list. */
function groupTitles(): string[] {
  return Array.from(
    document.querySelectorAll('[data-sidebar="group-label"]')
  ).map((element) => element.textContent?.trim() ?? "");
}

function expandLabs(): void {
  fireEvent.click(screen.getByRole("button", { name: LABS_SECTION_NAME }));
}

describe("Sidebar — the shell-sidebar-v2 branch (PLN-2016 D1)", () => {
  it("mounts the shared ShellSidebar only with the key on", () => {
    // An ERRORED projection is what tells the two trees apart without reading a
    // class name: the v2 rows come from the fold, so an unread capability leaves
    // them announced-but-inert, while every legacy row is a link whatever the
    // cloud said.
    projection.ready = false;
    renderSidebar();

    expect(sidebarRootCount()).toBe(1);
    expect(
      screen.queryByRole("link", { name: pageTitleForNav(NavId.Dashboard) })
    ).toBeNull();
    const dashboard = screen.getByRole("button", { name: DASHBOARD_ROW_NAME });
    expect(dashboard.getAttribute("aria-disabled")).toBe("true");
    expect(within(dashboard).getByText(UNAVAILABLE_STATE_WORD)).toBeDefined();
  });

  it("keeps today's sidebar with the key off, on the same failed read", () => {
    projection.ready = false;
    renderSidebar({ enabledFlags: ALL_DESKTOP_NAV_GATES });

    expect(sidebarRootCount()).toBe(1);
    expect(
      screen.getByRole("link", { name: "Dashboard" }).getAttribute("href")
    ).toBe("/dashboard");
    expect(screen.queryByText(UNAVAILABLE_STATE_WORD)).toBeNull();
  });

  it("renders the v2 hierarchy: Artifacts nested inside Labs (PLN-2016 D2)", () => {
    renderSidebar();

    // Outside Labs, exactly what PRD-690 R3 keeps there.
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeDefined();
    expect(groupTitles()).toEqual(["Artifacts", "Labs"]);

    expandLabs();

    // The contract correction: Agents lives in Labs › Artifacts, so a SECOND
    // Artifacts group appears inside Labs. The legacy tree has one.
    expect(groupTitles()).toEqual(["Artifacts", "Labs", "Artifacts"]);
    expect(screen.getByRole("link", { name: "Agents" })).toBeDefined();
  });
});

describe("Sidebar — the v2 chrome (PLN-2016 D7)", () => {
  it("keeps the workspace menu in the header and the desktop footer intact", () => {
    renderSidebar();

    const head = document.querySelector<HTMLElement>('[data-sidebar="header"]');
    expect(head).not.toBeNull();
    expect(
      within(head as HTMLElement).getByRole("button", {
        name: WORKSPACE_MENU_TRIGGER_LABEL,
      })
    ).toBeDefined();
    // Exactly one mount of the menu: the composite wraps the slot itself, so a
    // second wrapper would put the trigger on screen twice.
    expect(
      screen.getAllByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL })
    ).toHaveLength(1);
    // The desktop divergence ISS-8370 recorded: the card and the invite entry
    // stay in the footer, and the invite entry keeps its spotlight anchor.
    expect(within(footer()).getByTestId(GUIDED_CARD_TEST_ID)).toBeDefined();
    expect(within(footer()).getByTestId(INVITE_TEST_ID)).toBeDefined();
    expect(
      within(footer()).getByRole("button", { name: "Invite your team" })
    ).toBeDefined();
  });

  it("mounts the session-limits summary in the v2 footer, behind its own gate", () => {
    renderSidebar({
      enabledFlags: [
        SHELL_SIDEBAR_V2_FLAG_KEY,
        ...ALL_DESKTOP_NAV_GATES,
        DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY,
      ],
    });
    expect(sessionLimitsReads.count).toBeGreaterThan(0);

    // And it stays behind that gate: PRD-538 is not product-approved, so with
    // the key off the reading component never mounts — no snapshot IPC, no
    // interval, nothing.
    cleanup();
    sessionLimitsReads.count = 0;
    renderSidebar();
    expect(sessionLimitsReads.count).toBe(0);
  });

  it("sizes the invite row to the nav rows on the v2 arm only", () => {
    // `SidebarMenuButton` bases at `text-base` and the composite renders nav
    // rows at `text-sm`, so the shared invite entry goes out a size larger than
    // the column above it unless the v2 footer says otherwise. The correction is
    // passed IN rather than baked into the shared component, because the off arm
    // is the tree users have today and a restyle of it is not this change's to
    // make.
    renderSidebar();
    expect(
      within(footer()).getByRole("button", { name: "Invite your team" })
        .className
    ).toContain("text-sm");

    cleanup();
    renderSidebar({ enabledFlags: ALL_DESKTOP_NAV_GATES });
    expect(
      within(footer()).getByRole("button", { name: "Invite your team" })
        .className
    ).not.toContain("text-sm");
  });

  it("reserves the macOS drag strip first, and nothing elsewhere", () => {
    setDesktopApi({ platform: "darwin" });
    const { container } = renderSidebar();

    const strip = container.querySelector(".app-region-drag");
    expect(strip).not.toBeNull();
    // FIRST inside the sidebar root: it clears the stoplights off the header
    // below it, which it cannot do from anywhere else.
    const root = document.querySelector('[data-sidebar="sidebar"]');
    expect(root?.firstElementChild).toBe(strip);

    cleanup();
    setDesktopApi({ platform: "win32" });
    const windows = renderSidebar();
    expect(windows.container.querySelector(".app-region-drag")).toBeNull();
  });
});

describe("Sidebar — v2 routing and the Search control", () => {
  it("drops a row App.tsx has hidden", () => {
    renderSidebar({ hiddenNavIds: [NavId.Branches] });

    expect(screen.queryByRole("link", { name: BRANCHES_ROW_LABEL })).toBeNull();
    expect(screen.getByRole("link", { name: "Sessions" })).toBeDefined();
  });

  it("takes Search away with the Labs container, rather than re-homing it above the nav", () => {
    // The shared container-absent table gives Search a home above the primary
    // rows, which is the WEB answer to a closed container. Desktop's ruling
    // (2026-09-01) is that Search goes when Labs does.
    renderSidebar({ enabledFlags: [SHELL_SIDEBAR_V2_FLAG_KEY] });

    expect(groupTitles()).toEqual(["Artifacts"]);
    expect(
      screen.queryByRole("textbox", { name: SEARCH_TEXTBOX_NAME })
    ).toBeNull();
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeDefined();
  });

  it("submits the Labs search to the Sessions list and clears back to it", () => {
    const { memoryNav } = renderSidebar();
    expandLabs();

    const box = screen.getByRole("textbox", { name: SEARCH_TEXTBOX_NAME });
    fireEvent.change(box, { target: { value: "needle" } });
    fireEvent.submit(box.closest("form") as HTMLFormElement);
    expect(memoryNav.getCurrentHref()).toBe("/sessions?search=needle");

    fireEvent.click(screen.getByRole("button", { name: CLEAR_SEARCH_NAME }));
    expect(memoryNav.getCurrentHref()).toBe("/sessions");
  });

  it("lights the canonical row for a route-table alias (PLN-2016 D8)", () => {
    // `/subagents` is a legacy path alias of Agents. The active path comes from
    // the resolved nav id, not from the hash the user is standing on, so the
    // row lights; deriving it from `usePath()` would leave nothing active.
    renderSidebar({
      activeNav: NavId.Agents,
      initialPath: "/subagents",
    });
    expandLabs();

    expect(
      screen.getByRole("link", { name: "Agents" }).getAttribute("data-active")
    ).toBe("true");
  });
});

describe("Sidebar — the v2 Agents badge (PLN-2016 D5)", () => {
  it("announces a landed count with the noun the counting hook owns", () => {
    agentsActivity.count = toNavigationCount(3);
    renderSidebar();
    expandLabs();

    const badge = within(
      screen.getByRole("link", { name: AGENTS_ROW_NAME })
    ).getByRole("status");
    // The announced name comes from the noun the counting hook owns, and the
    // pill shows the raw number because 3 is under the cap it also owns.
    expect(badge.getAttribute("aria-label")).toBe(
      "3 recently finished sessions"
    );
    expect(badge.textContent).toBe("3");
  });

  it("never announces the folded zero while the count is still pending", () => {
    agentsActivity.count = pendingNavigationCount();
    renderSidebar();
    expandLabs();

    // The review constraint from PR #7266: the shared hook folds a pending read
    // to "0 recently finished sessions", and a mount that passed that label
    // through would announce it on a row whose read has not landed.
    const agents = screen.getByRole("link", { name: AGENTS_ROW_NAME });
    expect(within(agents).queryByRole("status")).toBeNull();
    expect(agents.textContent).toBe("Agents");
    expect(screen.queryByText(FOLDED_ZERO_LABEL)).toBeNull();
    expect(document.body.innerHTML).not.toContain(FOLDED_ZERO_LABEL);
  });
});

describe("Sidebar — the v2 section persistence namespace (PLN-2016 D9)", () => {
  it("persists an expanded section under the v2 prefix, not the legacy key", () => {
    renderSidebar();
    expandLabs();

    expect(globalThis.localStorage.getItem(LABS_V2_PERSISTENCE_KEY)).toBe(
      "true"
    );
    // The legacy key belongs to the legacy Labs list. Writing it from here
    // would move a section only the OFF arm renders, so a rollback would find a
    // preference this user never set.
    expect(
      globalThis.localStorage.getItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY)
    ).toBeNull();
  });

  it("restores from the v2 key and never hydrates from the legacy one", () => {
    globalThis.localStorage.setItem(LABS_V2_PERSISTENCE_KEY, "true");
    globalThis.localStorage.setItem(
      DESKTOP_LABS_NAV_SECTION_STORAGE_KEY,
      "false"
    );
    renderSidebar();

    // Open with no click, so the section hydrated from the v2 key. The legacy
    // "collapsed" preference sitting beside it neither closes this section nor
    // changes value — which is what makes the rollback arm truthful.
    expect(screen.getByRole("link", { name: "Agents" })).toBeDefined();
    expect(
      globalThis.localStorage.getItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY)
    ).toBe("false");
  });
});
