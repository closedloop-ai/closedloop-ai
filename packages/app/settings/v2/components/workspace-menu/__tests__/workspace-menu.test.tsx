import { buildMembersSettingsRoute } from "@repo/api/src/types/settings-route-links";
import {
  DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES,
  WORKSPACE_MENU_ENTRY_IDS,
  WORKSPACE_MENU_ENTRY_LABEL,
  WORKSPACE_MENU_TRIGGER_LABEL,
  WorkspaceMenuCapabilityReason,
  WorkspaceMenuEntryId,
  WorkspaceMenuProjectionStatus,
  workspaceMenuCapabilityError,
  workspaceMenuCapabilityReady,
  workspaceMenuCapabilityUnavailable,
} from "@repo/api/src/types/workspace-menu";
import { WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY } from "@repo/api/src/types/workspace-menu-invite-entry-flag";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../../../shared/feature-flags/static-feature-flag-adapter";
import { WorkspaceMenuHostAdapterProvider } from "../../../../../shared/workspace-menu-host/provider";
import {
  buildDesktopWorkspaceMenuCapabilities,
  buildWebWorkspaceMenuCapabilities,
} from "../../../../../shared/workspace-menu-host/workspace-menu-capabilities";
import type { WorkspaceMenuHostAdapter } from "../../../../../shared/workspace-menu-host/workspace-menu-host-adapter";
import {
  createDesktopGuestWorkspaceMenuHostAdapterFixture,
  createDesktopWorkspaceMenuHostAdapterFixture,
  createWebWorkspaceMenuHostAdapterFixture,
  READY_WORKSPACE_MENU_PROJECTION,
} from "../../../../../shared/workspace-menu-host/workspace-menu-host-fixtures";
import { WorkspaceMenu } from "../workspace-menu";
import { DOWNLOAD_LOOKUP_FAILED_DETAIL } from "../workspace-menu-download-item";

// The real dialog reaches `POST /organizations/invitations` through
// `useInviteMembers`, which needs an API provider this harness does not mount.
// The stand-in reports its controlled `open` so a case can prove the row opens
// it rather than merely that the row rendered.
vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: ({ open }: { open?: boolean }) =>
    open ? <div data-testid="invite-team-dialog-open" /> : null,
}));

/**
 * The menu is a sidebar-header item, so it needs a `SidebarProvider` ancestor
 * exactly as the shell gives it one. That is a real mount-site contract, not
 * test scaffolding — see the component's own note.
 */
function wrap(children: ReactNode): ReactNode {
  return (
    <NavigationProvider
      adapter={
        createMemoryNavigation({
          initialPath: "/dashboard",
          orgSlug: "closedloop",
        }).adapter
      }
    >
      <SidebarProvider>{children}</SidebarProvider>
    </NavigationProvider>
  );
}

function renderMenu(adapter: WorkspaceMenuHostAdapter | null): void {
  render(
    wrap(
      adapter ? (
        <WorkspaceMenuHostAdapterProvider adapter={adapter}>
          <WorkspaceMenu />
        </WorkspaceMenuHostAdapterProvider>
      ) : (
        <WorkspaceMenu />
      )
    )
  );
}

/**
 * Radix dropdowns open on pointerdown, not click. Returns the menu element so a
 * caller cannot accidentally assert against an unopened menu — an empty render
 * would otherwise satisfy every "this entry is absent" assertion.
 */
function openMenu(): HTMLElement {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL }),
    { button: 0, ctrlKey: false }
  );
  return screen.getByRole("menu");
}

// Imported, not restated: the contract calls itself the single source for this
// set, and a second copy here is the drift that constant exists to prevent.
const OMITTED_ON_DESKTOP = DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES;

const ACTIVE_WORKSPACE_NAME = /Closedloop/;
// The label the design-system component renders; it has no exported constant.
const THEME_ROW_LABEL = "Theme";
const STILL_SIGNED_IN = /still signed in/i;

describe("shared presentation", () => {
  test("both hosts expose the same trigger name, not an org switcher", () => {
    // The operator ruling: one presentation, two item sets. The accessible name
    // is part of the presentation, and calling it a switcher would promise
    // switching on a host that has none.
    const { unmount } = render(
      wrap(
        <WorkspaceMenuHostAdapterProvider
          adapter={createWebWorkspaceMenuHostAdapterFixture()}
        >
          <WorkspaceMenu />
        </WorkspaceMenuHostAdapterProvider>
      )
    );
    expect(
      screen.getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL })
    ).toBeTruthy();
    unmount();

    renderMenu(createDesktopWorkspaceMenuHostAdapterFixture());
    expect(
      screen.getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL })
    ).toBeTruthy();
  });
});

describe("desktop item set", () => {
  test("renders none of the entries the contract omits on desktop", () => {
    renderMenu(createDesktopWorkspaceMenuHostAdapterFixture());
    openMenu();

    // Positive control FIRST. Without it every absence assertion below is also
    // satisfied by a menu that rendered nothing at all, which is how this test
    // passed while the dropdown was never opening.
    expect(
      screen.getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings]
      )
    ).toBeTruthy();

    for (const entry of OMITTED_ON_DESKTOP) {
      expect(screen.queryByText(WORKSPACE_MENU_ENTRY_LABEL[entry])).toBeNull();
    }
  });

  test("keeps Diagnostics, Settings and Log out", () => {
    // Members is deliberately NOT in this list any more (ISS-8368): the panel
    // it links to is Clerk's OrganizationProfile embed, which cannot mount in
    // the desktop renderer, so the entry is omitted rather than left pointing
    // at a panel that resolves `unavailable`. The absence is asserted by the
    // omitted-set loop above.
    renderMenu(createDesktopWorkspaceMenuHostAdapterFixture());
    openMenu();

    for (const entry of [
      WorkspaceMenuEntryId.Settings,
      WorkspaceMenuEntryId.Diagnostics,
      WorkspaceMenuEntryId.LogOut,
    ]) {
      expect(screen.getByText(WORKSPACE_MENU_ENTRY_LABEL[entry])).toBeTruthy();
    }
  });

  test("states the signed-in address, which it has no submenu to carry", () => {
    renderMenu(createDesktopWorkspaceMenuHostAdapterFixture());
    openMenu();

    expect(screen.getByText("ada@closedloop.ai")).toBeTruthy();
  });
});

describe("web item set", () => {
  test("renders the top-level entries desktop omits, Members included", () => {
    // Members is the ISS-8368 addition to the omitted set, and this is what
    // makes that an omission on DESKTOP rather than a deletion from the
    // product. `CreateWorkspace` is deliberately absent from this list: it
    // renders inside the workspace-switcher submenu, which this test does not
    // open, so asserting it here would fail for a reason that has nothing to
    // do with the capability under test.
    renderMenu(createWebWorkspaceMenuHostAdapterFixture());
    openMenu();

    for (const entry of [
      WorkspaceMenuEntryId.SwitchWorkspace,
      WorkspaceMenuEntryId.DownloadDesktop,
      WorkspaceMenuEntryId.Members,
    ]) {
      expect(screen.getByText(WORKSPACE_MENU_ENTRY_LABEL[entry])).toBeTruthy();
    }
  });

  test("names the Members deep link by contract, not by hand", () => {
    renderMenu(createWebWorkspaceMenuHostAdapterFixture());
    openMenu();

    const members = screen.getByText(
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Members]
    );
    expect(members.closest("a")?.getAttribute("href")).toBe(
      `/closedloop${buildMembersSettingsRoute()}`
    );
  });

  test("renders the download entry inert when the release read failed", () => {
    // Web HAS the feature and the read failed, so the entry must not render a
    // dead link — but ISS-9753 keeps the row present and inert rather than
    // absent, so it can say why and a keyboard user can reach it. Desktop's
    // absence stays distinguishable by the capability reason the adapter
    // reports. The focus walk itself is the sibling suite's.
    renderMenu(
      createWebWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuCapabilities: () =>
          buildWebWorkspaceMenuCapabilities({
            download: workspaceMenuCapabilityError(
              WorkspaceMenuCapabilityReason.ReadFailed
            ),
          }),
        useWorkspaceMenuProjection: () => ({
          ...READY_WORKSPACE_MENU_PROJECTION,
          downloadUrl: null,
        }),
      })
    );
    openMenu();

    // Positive control, same reason as the desktop omission case.
    expect(
      screen.getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings]
      )
    ).toBeTruthy();
    const entry = screen.getByText(
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.DownloadDesktop]
    );
    expect(entry.closest('[aria-disabled="true"]')).not.toBeNull();
    expect(entry.closest("a")).toBeNull();
  });
});

describe("capability is what hides an entry", () => {
  test("an unavailable download stays absent even when a url resolved", () => {
    // Without this the desktop omission case proves nothing about the download
    // capability: desktop's fixture carries no url, so `!downloadUrl` alone
    // would hide the entry and the capability check could be deleted unnoticed.
    renderMenu(
      createWebWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuCapabilities: () =>
          buildWebWorkspaceMenuCapabilities({
            download: workspaceMenuCapabilityUnavailable(
              WorkspaceMenuCapabilityReason.NotSupportedOnHost
            ),
          }),
      })
    );
    openMenu();

    expect(
      screen.getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings]
      )
    ).toBeTruthy();
    expect(
      screen.queryByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.DownloadDesktop]
      )
    ).toBeNull();
  });

  test("an unavailable log out is absent on a signed-in menu", () => {
    // The guest case cannot pin this: a guest never reaches the signed-in
    // branch, so the Log out capability guard there was never exercised.
    renderMenu(
      createDesktopWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuCapabilities: () => ({
          ...buildDesktopWorkspaceMenuCapabilities({ isGuest: false }),
          [WorkspaceMenuEntryId.LogOut]: workspaceMenuCapabilityUnavailable(
            WorkspaceMenuCapabilityReason.SignedOut
          ),
        }),
      })
    );
    openMenu();

    expect(
      screen.getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings]
      )
    ).toBeTruthy();
    expect(
      screen.queryByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.LogOut]
      )
    ).toBeNull();
  });
});

describe("actions", () => {
  test("log out dispatches the host's own sign-out", () => {
    const signOut = vi.fn(() => Promise.resolve());
    renderMenu(createDesktopWorkspaceMenuHostAdapterFixture({ signOut }));
    openMenu();

    fireEvent.click(
      screen.getByText(WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.LogOut])
    );

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  test("the guest door requests an account", () => {
    const requestAccount = vi.fn();
    renderMenu(
      createDesktopGuestWorkspaceMenuHostAdapterFixture({ requestAccount })
    );
    openMenu();

    fireEvent.click(
      screen.getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.CreateAccount]
      )
    );

    expect(requestAccount).toHaveBeenCalledTimes(1);
  });

  test("a guest can sign in directly while account creation stays available", () => {
    const requestAccount = vi.fn();
    const requestSignIn = vi.fn();
    renderMenu(
      createDesktopGuestWorkspaceMenuHostAdapterFixture({
        requestAccount,
        requestSignIn,
      })
    );
    const menu = openMenu();

    expect(
      within(menu).getByRole("menuitem", {
        name: WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.CreateAccount],
      })
    ).toBeTruthy();
    fireEvent.click(
      within(menu).getByRole("menuitem", {
        name: WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.SignIn],
      })
    );

    expect(requestSignIn).toHaveBeenCalledTimes(1);
    expect(requestAccount).not.toHaveBeenCalled();
  });

  test("an older adapter without sign-in does not render an inert entry", () => {
    renderMenu(createDesktopGuestWorkspaceMenuHostAdapterFixture());
    const menu = openMenu();
    expect(
      within(menu).queryByRole("menuitem", {
        name: WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.SignIn],
      })
    ).toBeNull();
  });

  test("a guest keeps Settings but is offered no log out", () => {
    // Load-bearing since ISS-11400: the guest body renders `SignOutItem` now,
    // so this pins the LogOut capability gate rather than the absence of a row.
    renderMenu(createDesktopGuestWorkspaceMenuHostAdapterFixture());
    openMenu();

    expect(
      screen.getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings]
      )
    ).toBeTruthy();
    expect(
      screen.queryByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.LogOut]
      )
    ).toBeNull();
  });
});

/**
 * ISS-9889. The theme row sits in `DestinationItems`, which BOTH projections
 * render, so it reaches a signed-out viewer too. That is deliberate — the theme
 * is a client-side preference with no identity behind it — but "deliberate" and
 * "actually renders" are different claims, and only the signed-in one was
 * covered (from the shell, in apps/app). This covers the other projection.
 */
describe("theme row", () => {
  test("both projections offer it, on the host that omits most other entries", () => {
    renderMenu(createDesktopWorkspaceMenuHostAdapterFixture());
    openMenu();
    expect(screen.getByText(THEME_ROW_LABEL)).toBeTruthy();

    cleanup();

    renderMenu(createDesktopGuestWorkspaceMenuHostAdapterFixture());
    openMenu();
    expect(screen.getByText(THEME_ROW_LABEL)).toBeTruthy();
  });
});

describe("review fixes (cr-53485 follow-up)", () => {
  test("re-picking the active workspace does not switch or navigate", () => {
    // Radix fires onSelect for the already-checked radio item too, so without a
    // guard this no-ops setActive and then navigates away, losing the user's
    // place.
    const switchWorkspace = vi.fn(() => Promise.resolve());
    renderMenu(createWebWorkspaceMenuHostAdapterFixture({ switchWorkspace }));
    openMenu();

    fireEvent.click(
      screen.getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.SwitchWorkspace]
      )
    );
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: ACTIVE_WORKSPACE_NAME })
    );

    expect(switchWorkspace).not.toHaveBeenCalled();
  });

  test("a failed download reads as an outage, not as an absent feature", () => {
    // Desktop renders NOTHING for this entry. Web rendering nothing for a failed
    // lookup would make an outage indistinguishable from "unsupported here".
    renderMenu(
      createWebWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuCapabilities: () =>
          buildWebWorkspaceMenuCapabilities({
            download: workspaceMenuCapabilityError(
              WorkspaceMenuCapabilityReason.ReadFailed
            ),
          }),
        useWorkspaceMenuProjection: () => ({
          ...READY_WORKSPACE_MENU_PROJECTION,
          downloadUrl: null,
        }),
      })
    );
    openMenu();

    expect(screen.getByText(DOWNLOAD_LOOKUP_FAILED_DETAIL)).toBeTruthy();
  });

  test("a failed sign-out says so instead of closing silently", () => {
    // The worst lie this menu could tell is that you signed out when you did not.
    renderMenu(
      createDesktopWorkspaceMenuHostAdapterFixture({
        signOut: () => Promise.reject(new Error("bridge down")),
      })
    );
    openMenu();

    fireEvent.click(
      screen.getByText(WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.LogOut])
    );

    return screen.findByText(STILL_SIGNED_IN).then((node) => {
      expect(node).toBeTruthy();
    });
  });

  test("the email is stated even when the switcher submenu does not render", () => {
    // Deciding this on `adapter.switchWorkspace` while the submenu decides on
    // capabilities let a host with the method but neither capability Ready drop
    // the address from both places.
    renderMenu(
      createWebWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuCapabilities: () => ({
          ...buildWebWorkspaceMenuCapabilities({
            download: workspaceMenuCapabilityReady(),
          }),
          [WorkspaceMenuEntryId.SwitchWorkspace]:
            workspaceMenuCapabilityUnavailable(
              WorkspaceMenuCapabilityReason.NotSupportedOnHost
            ),
          [WorkspaceMenuEntryId.CreateWorkspace]:
            workspaceMenuCapabilityUnavailable(
              WorkspaceMenuCapabilityReason.NotSupportedOnHost
            ),
        }),
      })
    );
    openMenu();

    expect(screen.getByText("ada@closedloop.ai")).toBeTruthy();
  });
});

describe("degraded states", () => {
  test("says so in words when no host adapter is provided", () => {
    // Neither a crash nor an empty working-looking menu.
    renderMenu(null);

    expect(screen.getByText("Account unavailable")).toBeTruthy();
  });

  test("only the adapter-less mount is disabled — there is nothing to project", () => {
    // BEHAVIOR CHANGE (ISS-11400): this used to assert the same of a Pending
    // projection. It no longer holds there, and deliberately — a mounted host
    // projects capabilities whether or not its identity read settled, so there
    // IS a menu behind that trigger. With no adapter there is no capability
    // hook to call at all, which is the one case the disabled trigger still
    // describes truthfully.
    renderMenu(null);

    expect(
      screen.getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL })
    ).toBeDisabled();
  });

  test("a pending identity reads as loading, not as signed out", () => {
    renderMenu(
      createDesktopWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuProjection: () => ({
          status: WorkspaceMenuProjectionStatus.Pending,
          downloadUrl: null,
        }),
      })
    );

    expect(screen.getByText("Loading")).toBeTruthy();
    expect(screen.queryByText("Guest")).toBeNull();
  });
});

/**
 * ISS-11400 — a projection that is not `Ready` still opens a real menu.
 *
 * The trigger keeps the honest word ("Account unavailable", "Loading"); what
 * changed is that it is a WORKING control behind that word, because Settings,
 * Diagnostics, the theme and Log out need no settled workspace identity and are
 * a failed read's only way out. Each case below opens the menu and NAMES an
 * entry rather than merely observing that the button is enabled.
 */
const ERROR_PROJECTION = {
  status: WorkspaceMenuProjectionStatus.Error,
  reason: WorkspaceMenuCapabilityReason.ReadFailed,
  downloadUrl: null,
} as const;

describe("a failed or unsettled projection keeps its destinations (ISS-11400)", () => {
  test("desktop Error opens the menu and reaches Settings and Diagnostics", () => {
    // The reported defect: a desktop identity read that resolved to nothing.
    // The capabilities are the signed-in desktop set, so these three are Ready
    // and were unreachable only because the trigger was disabled.
    renderMenu(
      createDesktopWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuProjection: () => ERROR_PROJECTION,
      })
    );

    const menu = openMenu();
    for (const entry of [
      WorkspaceMenuEntryId.Settings,
      WorkspaceMenuEntryId.Diagnostics,
      WorkspaceMenuEntryId.LogOut,
    ]) {
      expect(
        within(menu).getByText(WORKSPACE_MENU_ENTRY_LABEL[entry])
      ).toBeTruthy();
    }
    expect(screen.getByText("Account unavailable")).toBeTruthy();
  });

  test("Log out on the Error menu dispatches the host's own sign-out", () => {
    // The recovery affordance, exercised rather than merely rendered: signing
    // out is how a user with a lapsed session gets back to the sign-in door.
    const signOut = vi.fn(() => Promise.resolve());
    renderMenu(
      createDesktopWorkspaceMenuHostAdapterFixture({
        signOut,
        useWorkspaceMenuProjection: () => ERROR_PROJECTION,
      })
    );

    fireEvent.click(
      within(openMenu()).getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.LogOut]
      )
    );

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  test("AC3 — a wedged Pending strands a user identically, so it opens too", () => {
    // Decided explicitly rather than left to fall through: a load that never
    // settles is indistinguishable, to the person looking at it, from one that
    // failed. This menu shipped exactly that once, with a lapsed desktop session
    // sitting on "Loading" forever.
    renderMenu(
      createDesktopWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuProjection: () => ({
          status: WorkspaceMenuProjectionStatus.Pending,
          downloadUrl: null,
        }),
      })
    );

    const menu = openMenu();
    expect(
      within(menu).getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings]
      )
    ).toBeTruthy();
    // Still says "Loading", not a workspace name it does not have.
    expect(screen.getByText("Loading")).toBeTruthy();
  });

  test("web Error withholds the org-scoped rows and still opens onto Log out", () => {
    // Web's Settings and Members are org-relative and `useOrgPathBuilder` emits
    // them unprefixed with no slug, so the web adapter projects them
    // `Error(ReadFailed)` in this state. The menu must honor that — a dead link
    // would be a worse lie than the disabled trigger was — and still offer the
    // recovery that does work.
    renderMenu(
      createWebWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuProjection: () => ERROR_PROJECTION,
        useWorkspaceMenuCapabilities: () => ({
          ...buildWebWorkspaceMenuCapabilities({
            download: workspaceMenuCapabilityReady(),
          }),
          [WorkspaceMenuEntryId.Settings]: workspaceMenuCapabilityError(
            WorkspaceMenuCapabilityReason.ReadFailed
          ),
          [WorkspaceMenuEntryId.Members]: workspaceMenuCapabilityError(
            WorkspaceMenuCapabilityReason.ReadFailed
          ),
        }),
      })
    );

    const menu = openMenu();
    // Presence assertion on the SAME locator the absences use, so a menu that
    // never opened cannot satisfy them.
    expect(
      within(menu).getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.LogOut]
      )
    ).toBeTruthy();
    expect(
      within(menu).queryByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings]
      )
    ).toBeNull();
    expect(
      within(menu).queryByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Members]
      )
    ).toBeNull();
  });

  test("withholding every projected entry still opens onto the theme control", () => {
    // The "do not render an empty menu" case, handled rather than assumed:
    // `DestinationItems` renders the theme block unconditionally, so there is no
    // capability combination that leaves this menu with nothing in it — which is
    // why no emptiness guard exists, and why the disabled trigger survives only
    // where there are no capabilities to ask at all.
    renderMenu(
      createDesktopWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuProjection: () => ERROR_PROJECTION,
        useWorkspaceMenuCapabilities: () =>
          Object.fromEntries(
            WORKSPACE_MENU_ENTRY_IDS.map((entry) => [
              entry,
              workspaceMenuCapabilityUnavailable(
                WorkspaceMenuCapabilityReason.ReadFailed
              ),
            ])
          ) as ReturnType<typeof buildDesktopWorkspaceMenuCapabilities>,
      })
    );

    const menu = openMenu();
    expect(within(menu).getByText(THEME_ROW_LABEL)).toBeTruthy();
    expect(
      within(menu).queryByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings]
      )
    ).toBeNull();
  });
});

/**
 * ISS-11400 AC4 — removing `disabled` must not remove the only ACCESSIBLE
 * statement of the state.
 *
 * `aria-label` replaces the button's subtree in the accessible NAME
 * computation, so the visible word never reached the tree on its own and
 * `disabled` was carrying the whole distinction for a screen-reader user. These
 * cases assert the RESOLVED accessible description rather than the
 * `aria-describedby` attribute: a describedby pointing at an id that does not
 * exist renders identically and announces nothing, which is exactly the
 * false-green this coverage has to refuse.
 */
describe("the trigger states its standing in the accessibility tree (AC4)", () => {
  test.each([
    [
      "Error",
      () =>
        createDesktopWorkspaceMenuHostAdapterFixture({
          useWorkspaceMenuProjection: () => ERROR_PROJECTION,
        }),
      "Account unavailable",
    ],
    [
      "Pending",
      () =>
        createDesktopWorkspaceMenuHostAdapterFixture({
          useWorkspaceMenuProjection: () => ({
            status: WorkspaceMenuProjectionStatus.Pending,
            downloadUrl: null,
          }),
        }),
      "Loading",
    ],
    [
      "Guest",
      () => createDesktopGuestWorkspaceMenuHostAdapterFixture(),
      "Guest",
    ],
    [
      "Ready",
      () => createWebWorkspaceMenuHostAdapterFixture(),
      READY_WORKSPACE_MENU_PROJECTION.activeWorkspace.name,
    ],
  ])(
    "%s announces one constant name and its own state as the description",
    (_standing, buildAdapter, expectedDescription) => {
      renderMenu(buildAdapter());

      // ONE query for both halves of the invariant: the name stays the same
      // constant string on every standing, and the description is what tells
      // them apart. This throws if either is wrong, and the description half
      // resolves `aria-describedby` through the real accessibility computation
      // rather than reading the attribute.
      expect(
        screen.getByRole("button", {
          description: expectedDescription,
          name: WORKSPACE_MENU_TRIGGER_LABEL,
        })
      ).toBeTruthy();
    }
  );

  test("the state never leaks into the accessible NAME", () => {
    // The other half of tamsinb's constraint, and the reason the word is a
    // description rather than appended to `aria-label`: a name that changes
    // under the user is a different control every render.
    renderMenu(
      createDesktopWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuProjection: () => ERROR_PROJECTION,
      })
    );

    const trigger = screen.getByRole("button", {
      name: WORKSPACE_MENU_TRIGGER_LABEL,
    });
    expect(trigger).toHaveAccessibleName(WORKSPACE_MENU_TRIGGER_LABEL);
    expect(trigger).toHaveAccessibleDescription("Account unavailable");
  });
});

/**
 * ISS-10362 — the invite entry, which exists on exactly one host.
 *
 * The asymmetry is the contract, not drift: desktop cannot reach Members (its
 * panel body is Clerk's `<OrganizationProfile>` and the desktop renderer mounts
 * no Clerk provider), and web's Members row already says "Invite and manage
 * members" and does strictly more. One presentation, two item sets.
 */
function menuWithFlag(
  adapter: WorkspaceMenuHostAdapter,
  enabledFlags: readonly string[]
): ReactNode {
  return wrap(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <WorkspaceMenuHostAdapterProvider adapter={adapter}>
        <WorkspaceMenu />
      </WorkspaceMenuHostAdapterProvider>
    </FeatureFlagAdapterProvider>
  );
}

function renderMenuWithFlag(
  adapter: WorkspaceMenuHostAdapter,
  enabledFlags: readonly string[]
) {
  return render(menuWithFlag(adapter, enabledFlags));
}

const INVITE_LABEL = WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Invite];

describe("the invite entry (ISS-10362)", () => {
  test("desktop offers it once the flag is on", () => {
    renderMenuWithFlag(createDesktopWorkspaceMenuHostAdapterFixture(), [
      WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY,
    ]);

    expect(within(openMenu()).getByText(INVITE_LABEL)).toBeTruthy();
  });

  test("desktop does not offer it with the flag off", () => {
    // The covering permutation: the menu itself is ungated and renders, so the
    // only thing withheld here is this entry. Turning the surface off instead
    // would prove nothing about this gate.
    renderMenuWithFlag(createDesktopWorkspaceMenuHostAdapterFixture(), []);

    const menu = openMenu();
    expect(within(menu).queryByText(INVITE_LABEL)).toBeNull();
    // Sibling positive assertion on the same menu: it rendered, it just has no
    // invite row — an empty menu would satisfy the absence on its own.
    expect(
      within(menu).getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings]
      )
    ).toBeTruthy();
  });

  test("web keeps its manage-members row and gains no second invite path", () => {
    renderMenuWithFlag(createWebWorkspaceMenuHostAdapterFixture(), [
      WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY,
    ]);

    const menu = openMenu();
    expect(within(menu).queryByText(INVITE_LABEL)).toBeNull();
    expect(
      within(menu).getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Members]
      )
    ).toBeTruthy();
  });

  test("the guest menu renders no invite row, and still offers the account door", () => {
    // RENDER-level only, deliberately narrow: `GuestWorkspaceMenu` passes no
    // invite controller at all, so this case would stay green with the guest
    // capability inverted. The capability itself is pinned where it is decided —
    // `shared/workspace-menu-host/__tests__/workspace-menu-capabilities.test.ts`.
    renderMenuWithFlag(createDesktopGuestWorkspaceMenuHostAdapterFixture(), [
      WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY,
    ]);

    const menu = openMenu();
    expect(within(menu).queryByText(INVITE_LABEL)).toBeNull();
    expect(
      within(menu).getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.CreateAccount]
      )
    ).toBeTruthy();
  });

  test("selecting the row opens the invite dialog", () => {
    renderMenuWithFlag(createDesktopWorkspaceMenuHostAdapterFixture(), [
      WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY,
    ]);

    expect(screen.queryByTestId("invite-team-dialog-open")).toBeNull();
    fireEvent.click(within(openMenu()).getByText(INVITE_LABEL));

    expect(screen.getByTestId("invite-team-dialog-open")).toBeTruthy();
  });

  test("withdrawing the entry CLOSES the dialog rather than banking it for the next assignment", () => {
    // A PostHog assignment can move under a live session. Unmounting the dialog
    // is not enough: the controller's `open` outlives the subtree it drove, so
    // left standing it brings the dialog straight back the moment the entry is
    // offered again — with nobody having touched the row that is its only
    // opener. The off transition has to clear it.
    const adapter = createDesktopWorkspaceMenuHostAdapterFixture();
    const view = render(
      menuWithFlag(adapter, [WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY])
    );
    fireEvent.click(within(openMenu()).getByText(INVITE_LABEL));
    expect(screen.getByTestId("invite-team-dialog-open")).toBeTruthy();

    // Off: the entry is withdrawn and the dialog goes with it.
    view.rerender(menuWithFlag(adapter, []));
    expect(screen.queryByTestId("invite-team-dialog-open")).toBeNull();

    // And back on — a re-render, not a remount, so any state the off transition
    // failed to clear is still here. The row is what opens this dialog, and
    // nothing has selected it since.
    view.rerender(
      menuWithFlag(adapter, [WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY])
    );
    expect(screen.queryByTestId("invite-team-dialog-open")).toBeNull();
    // The entry itself really did come back, so the assertion above is about a
    // closed dialog and not about an absent entry.
    expect(within(openMenu()).getByText(INVITE_LABEL)).toBeTruthy();
  });
});
