/**
 * @file sidebar-workspace-experience.test.tsx
 * @description The desktop sidebar's workspace chrome (ISS-8370 D7), the
 * desktop half of the 2026-09-03 operator ruling: one menu presentation in the
 * same position as web's, and the DESKTOP item set behind it. Mounts the real
 * `Sidebar` under the real app-core stack and the in-memory navigation adapter,
 * with the identity reads pinned so both the signed-in and the guest item sets
 * can be walked.
 *
 * ISS-9734 (PLN-2016 M3): these are now the KEY-OFF cases. `Sidebar` branches on
 * `shell-sidebar-v2`, and `DesktopAppCoreProvider` mounts the all-off static
 * flag adapter, so every case here describes what the population outside the
 * rollout renders. The first case below makes that load-bearing rather than
 * incidental; the key-ON chrome is asserted in `sidebar-shell-v2.test.tsx`,
 * against the same mount site.
 */

import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import { NavigationDestinationStatus } from "@repo/api/src/types/navigation-view-model";
import {
  OnboardingHost,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WORKSPACE_MENU_TRIGGER_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu";
import { WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY } from "@repo/api/src/types/workspace-menu-invite-entry-flag";
import {
  GETTING_STARTED_CARD_LABEL,
  GETTING_STARTED_STEP_CONTENT,
} from "@repo/app/onboarding/components/getting-started-card-shell";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
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
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import { NavId } from "../../../navigation/route-table";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import type * as AdapterModule from "../../../workspace-menu-host/desktop-workspace-menu-host-adapter";
import {
  dashboardOnboardedStorageKey,
  writeFlag,
} from "../../dashboard/dashboard-storage-keys";
import { seedDashboardRecord } from "../../onboarding/__tests__/guest-guided-onboarding-handoff-fixtures";
import { INVITE_SPOTLIGHT_INVITE_LABEL } from "../../onboarding/invite-spotlight";
import { Sidebar } from "../Sidebar";

const INVITE_TEST_ID = "invite-team-dialog";
const GUIDED_CARD_TEST_ID = "guided-getting-started-card";
const THEME_ITEM_NAME = "Theme";

const authState = vi.hoisted(() => ({
  status: "authenticated" as string,
}));
const identityState = vi.hoisted(() => ({
  identity: null as {
    organizationName: string | null;
    email: string;
    firstName: string | null;
    lastName: string | null;
  } | null,
  isResolved: false,
}));
const adapterFactory = vi.hoisted(() => ({ calls: 0 }));
const guidedCardProps = vi.hoisted(() => ({
  last: null as Record<string, unknown> | null,
}));

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
// The host adapter factory is the provider's one product; counting it is what
// proves the provider is mounted under v2 and ONLY under v2.
vi.mock(
  "../../../workspace-menu-host/desktop-workspace-menu-host-adapter",
  async (importOriginal) => {
    const actual = await importOriginal<typeof AdapterModule>();
    return {
      ...actual,
      createDesktopWorkspaceMenuHostAdapter: (
        ...args: Parameters<typeof actual.createDesktopWorkspaceMenuHostAdapter>
      ) => {
        adapterFactory.calls += 1;
        return actual.createDesktopWorkspaceMenuHostAdapter(...args);
      },
    };
  }
);
// The invite entry's dialog mints real invitations through the BFF; here it is
// a marker so the assertion is about WHETHER the footer keeps the entry.
vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: ({ trigger }: { trigger?: React.ReactNode }) => (
    <div data-testid="invite-team-dialog">{trigger}</div>
  ),
}));
// The guided-onboarding recovery card (ISS-8353) decides its own visibility
// off a guided snapshot read; here it is a marker recording its props, so the
// assertion is about WHETHER each footer mounts it and what it is handed.
vi.mock("@repo/app/onboarding/components/guided-getting-started-card", () => ({
  GuidedGettingStartedCard: (props: Record<string, unknown>) => {
    guidedCardProps.last = props;
    return <div data-testid="guided-getting-started-card" />;
  },
}));

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
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {},
  });
  adapterFactory.calls = 0;
  guidedCardProps.last = null;
  authState.status = DesktopAuthStatus.Authenticated;
  identityState.isResolved = true;
  identityState.identity = {
    organizationName: "Closedloop",
    email: "ada@closedloop.ai",
    firstName: "Ada",
    lastName: "Lovelace",
  };
  // A returning guest parked on the Dashboard, so the sidebar's onboarding host
  // publishes a guest run for the guest cases. Without a store the run cannot
  // be read, and every guest account entry point is withheld (ISS-11480).
  stubLocalStorage();
  writeFlag(dashboardOnboardedStorageKey);
  seedDashboardRecord();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * `enabledFlags` mounts a static adapter INSIDE `DesktopAppCoreProvider`, whose
 * own adapter is all-off — the nearer provider wins, which is how a case turns
 * one key on without the real PostHog bridge.
 */
function renderSidebar(
  enabledFlags: readonly string[] = [],
  initialPath = "/sessions"
) {
  const memoryNav = createMemoryNavigation({ initialPath });
  return render(
    <DesktopAppCoreProvider>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
      >
        <NavigationProvider adapter={memoryNav.adapter}>
          <SidebarProvider>
            <Sidebar activeNav={NavId.Sessions} />
          </SidebarProvider>
        </NavigationProvider>
      </FeatureFlagAdapterProvider>
    </DesktopAppCoreProvider>
  );
}

function header(): HTMLElement | null {
  return document.querySelector('[data-sidebar="header"]');
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

/** The chrome as a fact table: where the account trigger is, and what else the footer holds. */
function chrome() {
  const head = header();
  return {
    headerTrigger: head
      ? within(head).queryByRole("button", {
          name: WORKSPACE_MENU_TRIGGER_LABEL,
        })
      : null,
    footerTrigger: within(footer()).queryByRole("button", {
      name: WORKSPACE_MENU_TRIGGER_LABEL,
    }),
    guidedCard: within(footer()).queryByTestId(GUIDED_CARD_TEST_ID),
    invite: within(footer()).queryByTestId(INVITE_TEST_ID),
  };
}

/** The workspace trigger, in the header; throws rather than returning null so a case reads as "no header" instead of a type error. */
function headerTrigger(): HTMLElement {
  const trigger = chrome().headerTrigger;
  if (!trigger) {
    throw new Error("the workspace menu trigger is not in the sidebar header");
  }
  return trigger;
}

/** The `data-sidebar` regions in DOM order, so placement is a plain sequence. */
function sidebarRegionOrder(): string[] {
  return Array.from(
    document.querySelectorAll(
      '[data-sidebar="header"], [data-sidebar="content"], [data-sidebar="footer"]'
    )
  ).map((element) => element.getAttribute("data-sidebar") ?? "");
}

async function openMenu(trigger: HTMLElement): Promise<HTMLElement> {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return await screen.findByRole("menu");
}

function menuItemNames(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
}

describe("Sidebar — workspace chrome (ISS-8370 D7)", () => {
  it("renders the legacy tree, because shell-sidebar-v2 is closed in this harness", () => {
    renderSidebar();

    // The v2 arm builds its rows from the navigation projection, which this
    // harness's bare `desktopApi` cannot answer — so a v2 row would be an inert
    // button carrying a state word. A live link is the legacy tree, and it is
    // what every other case in this file is describing.
    expect(
      screen.getByRole("link", { name: "Dashboard" }).getAttribute("href")
    ).toBe("/dashboard");
    expect(
      screen.queryByText(
        ENTRY_STATE_WORD[NavigationDestinationStatus.CapabilityError]
      )
    ).toBeNull();
    expect(
      screen.queryByText(ENTRY_STATE_WORD[NavigationDestinationStatus.Pending])
    ).toBeNull();
  });

  it("puts the workspace menu at the top of navigation, keeps the invite entry in the footer while ISS-10362's flag is off, and drops the footer account menu", async () => {
    renderSidebar();

    const facts = chrome();
    expect(facts.footerTrigger).toBeNull();
    expect(facts.invite).not.toBeNull();
    expect(facts.guidedCard).not.toBeNull();
    // Common placement (operator ruling 2026-09-03): the header precedes the
    // navigation, as it does on web.
    expect(sidebarRegionOrder()).toEqual(["header", "content", "footer"]);
    // The menu host really mounted, so the adapter was built.
    expect(adapterFactory.calls).toBeGreaterThan(0);

    const menu = await openMenu(headerTrigger());
    const names = menuItemNames(menu);
    // The DESKTOP item set: Settings, Diagnostics, Theme, Log out — and the
    // signed-in address in the body — with Members (ISS-8368), the
    // org-switching pair and the download entry absent, not disabled.
    expect(names).toEqual([
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings],
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Diagnostics],
      THEME_ITEM_NAME,
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.LogOut],
    ]);
    expect(within(menu).getByText("ada@closedloop.ai")).toBeDefined();
    for (const absent of [
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Members],
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.SwitchWorkspace],
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.CreateWorkspace],
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.DownloadDesktop],
    ]) {
      expect(within(menu).queryByText(absent)).toBeNull();
    }
    // Both destinations are port links, so navigation flows through the
    // desktop adapter exactly as the legacy footer's did.
    expect(
      within(menu)
        .getByRole("menuitem", {
          name: WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings],
        })
        .getAttribute("href")
    ).toBe("/settings");
    expect(
      within(menu)
        .getByRole("menuitem", {
          name: WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Diagnostics],
        })
        .getAttribute("href")
    ).toBe("/diagnostics");
  });

  // ISS-10942 moved this case here from `sidebar-account-menu.test.tsx`. The
  // contract is unchanged and still live — the return target has to carry the
  // route's SEARCH params, not just its path — but that file's fixture is a
  // settled signed-out device, and a guest now gets the local Getting started
  // module instead of the server-owned card this asserts on. This suite is the
  // authenticated one, so the assertion follows the surface it describes.
  it("keeps the guided-onboarding recovery card in the footer, ahead of the invite entry (ISS-8353)", () => {
    renderSidebar();

    expect(chrome().guidedCard).not.toBeNull();
    // The card precedes the menu that holds the invite entry.
    expect(
      Array.from(
        footer().querySelectorAll(
          `[data-testid="${GUIDED_CARD_TEST_ID}"], [data-testid="${INVITE_TEST_ID}"]`
        )
      ).map((element) => element.getAttribute("data-testid"))
    ).toEqual([GUIDED_CARD_TEST_ID, INVITE_TEST_ID]);
    expect(guidedCardProps.last).toEqual(
      expect.objectContaining({
        analysisStarted: true,
        host: OnboardingHost.Desktop,
        syncConsentReadSettled: true,
      })
    );
  });

  it("keeps the guest arm: a signed-out desktop gets the account door plus Settings and Diagnostics, and no Log out", async () => {
    authState.status = DesktopAuthStatus.SignedOut;
    identityState.identity = null;
    renderSidebar();

    const menu = await openMenu(headerTrigger());

    expect(menuItemNames(menu)).toEqual([
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.SignIn],
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.CreateAccount],
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings],
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Diagnostics],
      THEME_ITEM_NAME,
    ]);
  });
});

/**
 * ISS-10362 — the invite entry's move from the footer into the workspace menu,
 * on the host that has no Members row to hold it.
 *
 * Both permutations are here on purpose. The desktop sidebar itself is ungated
 * since ISS-10195 retired `workspace-experience-v2`, so this flag is the only
 * gate over the entry and "flag off" is the shipped placement rather than a
 * screen nobody can reach.
 */
describe("Sidebar — invite placement (ISS-10362)", () => {
  it("moves the invite entry into the workspace menu, leaving none behind in the footer", async () => {
    renderSidebar([WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY]);

    expect(chrome().invite).toBeNull();

    const menu = await openMenu(headerTrigger());
    expect(menuItemNames(menu)).toContain(
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Invite]
    );
    // MOVED, not duplicated: one place to invite from, on one surface.
    expect(
      menuItemNames(menu).filter(
        (name) =>
          name === WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Invite]
      )
    ).toHaveLength(1);
  });

  it("keeps the footer entry when the workspace menu cannot show one", async () => {
    // ISS-11247. The footer surrendered its row on the KEY alone, while the
    // menu's invite row lives inside `ReadyWorkspaceMenu`. A failed
    // `GET /desktop/identity` settles as `{identity: null, isResolved: true}`
    // for the rest of the session, which the host adapter reads as
    // `Error/ReadFailed` — so a signed-in desktop user had no invite affordance
    // anywhere in the shell.
    identityState.identity = null;
    identityState.isResolved = true;

    renderSidebar([WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY]);

    expect(chrome().invite).not.toBeNull();
    // ...and the REASON it is kept, asserted on the same render rather than
    // assumed: the menu carries no invite row in a non-Ready standing, so there
    // is nothing there to hold the row the footer would otherwise have
    // surrendered. A bare "row present" also passes when the standing is Ready,
    // which is the case above.
    //
    // BEHAVIOR CHANGE (ISS-11400): this used to read that reason off a DISABLED
    // trigger. A non-Ready standing now opens a real menu — Settings,
    // Diagnostics, the theme and Log out need no settled identity — so the
    // proxy stopped being true while the contract it stood for did not. Asserted
    // directly on the opened menu now, which is what ISS-11247 was always about.
    const menu = await openMenu(headerTrigger());
    expect(menuItemNames(menu)).not.toContain(
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Invite]
    );
    // Same locator, positive: the menu really did open, so the absence above is
    // about a withheld row and not about an empty query.
    expect(menuItemNames(menu)).toContain(
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings]
    );
  });

  it("keeps the footer entry while the identity read is still in flight", async () => {
    // The unresolved standing is `Pending`, which is equally not `Ready`: the
    // menu renders no invite row then either, so handing the row over on the
    // key alone would blank the affordance for the whole read.
    identityState.identity = null;
    identityState.isResolved = false;

    renderSidebar([WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY]);

    expect(chrome().invite).not.toBeNull();
    const menu = await openMenu(headerTrigger());
    expect(menuItemNames(menu)).not.toContain(
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Invite]
    );
    expect(menuItemNames(menu)).toContain(
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings]
    );
  });

  it("leaves the entry in the footer and out of the menu while the flag is off", async () => {
    renderSidebar();

    expect(chrome().invite).not.toBeNull();

    const menu = await openMenu(headerTrigger());
    expect(menuItemNames(menu)).not.toContain(
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Invite]
    );
  });

  it("replaces the guest's invite door with the Getting started module", async () => {
    // ISS-10942: the footer row a guest used to get was a SIGNUP door, not an
    // invite entry — a guest has no organization to invite anyone into. The
    // operator replaced it with the Getting started module, which carries the
    // same account offer the retired dashboard header button carried. A guest
    // therefore has no invite affordance here at all, by instruction.
    authState.status = DesktopAuthStatus.SignedOut;
    identityState.identity = null;

    renderSidebar([WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY]);

    expect(
      within(footer()).queryByRole("button", {
        name: INVITE_SPOTLIGHT_INVITE_LABEL,
      })
    ).toBeNull();
    // ...and the module that took its place is really there, with the account
    // step's own label on its action.
    const gettingStarted = within(footer()).getByRole("region", {
      name: GETTING_STARTED_CARD_LABEL,
    });
    expect(
      within(gettingStarted).getByRole("button", {
        name: GETTING_STARTED_STEP_CONTENT[PendingOnboardingStep.CreateAccount]
          .label,
      }).textContent
    ).toContain(
      GETTING_STARTED_STEP_CONTENT[PendingOnboardingStep.CreateAccount].label
    );

    const menu = await openMenu(headerTrigger());
    expect(menuItemNames(menu)).not.toContain(
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Invite]
    );
  });

  it("gives a guest no invite row and reserves no space for one with the key closed", () => {
    // The DEFAULT population: key closed, signed out. The sibling guest case
    // above runs with the key OPEN, where the key alone already withholds the
    // row — so it cannot see this. `useDesktopFooterKeepsInvite` answers for
    // BOTH the row and the legacy arm's bottom padding, and while the guest
    // term lived only on the row the two disagreed here: the row returned null
    // and the footer still padded to `pb-0` for it.
    //
    // The signed-in read below is the same assertion's positive half: it is
    // what proves `pb-0` is reachable at all, so the guest `pb-1` is a real
    // difference rather than a class that never appears.
    renderSidebar();
    expect(chrome().invite).not.toBeNull();
    expect(footer().className).toContain("pb-0");
    cleanup();

    authState.status = DesktopAuthStatus.SignedOut;
    identityState.identity = null;
    renderSidebar();

    expect(chrome().invite).toBeNull();
    expect(footer().className).toContain("pb-1");
    expect(
      within(footer()).getByRole("region", { name: GETTING_STARTED_CARD_LABEL })
    ).not.toBeNull();
  });

  it("never offers desktop the manage-members row either way", async () => {
    // The move is invite-only (Marisol, 2026-09-17: "so it has invite; not
    // manage"). Members stays unreachable here — its panel body is Clerk's
    // `<OrganizationProfile>` and this renderer mounts no Clerk provider — so
    // turning the invite entry on must not drag the roster in with it.
    renderSidebar([WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY]);

    const menu = await openMenu(headerTrigger());
    expect(menuItemNames(menu)).not.toContain(
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Members]
    );
  });
});
