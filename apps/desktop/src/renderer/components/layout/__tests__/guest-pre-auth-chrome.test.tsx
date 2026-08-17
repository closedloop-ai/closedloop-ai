/**
 * ISS-5112 (PLN-1600 Step D): the app chrome a GUEST sees.
 *
 * Signed out, the sidebar footer trigger reads an organization name (falling
 * back to "Account") and the invite item opens a dialog that mints Clerk
 * invitations against an org id — both claim something a guest does not have.
 * The acceptance criterion is blunt about it: no pre-auth surface displays a
 * user name, org name, or workspace the app cannot know.
 *
 * Both flag branches are asserted. Flag off is the shipped product default, and
 * a gate that accidentally always fired would pass a guest-only suite.
 */
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
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
import { DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags";
import { NavId } from "../../../navigation/route-table";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { GuestSignupProvider } from "../../onboarding/guest-signup-provider";
import { Sidebar } from "../Sidebar";
import { Topbar } from "../Topbar";

// The desktop flag SNAPSHOT gate (ISS-5037) is separate from the flag adapter
// below: it comes from `DesktopFeatureFlagProvider`, which needs the preload
// bridge and defaults to false without it. Left alone it would read as "guest
// mode off" and pass every assertion here vacuously. Pin it resolved and let the
// adapter decide the flag itself, so the flag-off case below is still real.
vi.mock("../../../feature-flags/desktop-feature-flag-provider", async () => ({
  ...(await vi.importActual<
    typeof import("../../../feature-flags/desktop-feature-flag-provider")
  >("../../../feature-flags/desktop-feature-flag-provider")),
  useDesktopFeatureFlagsResolved: () => true,
}));

const SIGN_UP_LABEL = "Create account";
/** The dialog's primary is its own control — "Sign Up" since ISS-5489. */
const DIALOG_SIGN_UP_LABEL = "Sign Up";
const INVITE_LABEL = "Invite your team";
const ACCOUNT_MENU_TRIGGER_NAME = "Open account menu";

beforeAll(() => {
  // jsdom shims — the renderer vitest config has no global setup. Radix's popper
  // measures its trigger through `ResizeObserver`, so opening the account menu
  // throws without this and takes the whole tree down with it (same pattern as
  // agents-view-parity.test.tsx).
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    },
  });
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
  // An empty bridge: auth fails closed to signed-out, which IS the guest case.
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {},
  });
});

afterEach(() => {
  cleanup();
});

function renderChrome(guestOnboardingEnabled: boolean) {
  const memoryNav = createMemoryNavigation({ initialPath: "/sessions" });
  return render(
    <DesktopAppCoreProvider>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: guestOnboardingEnabled
            ? [DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY]
            : [],
        })}
      >
        <NavigationProvider adapter={memoryNav.adapter}>
          <GuestSignupProvider>
            <SidebarProvider>
              <Sidebar activeNav={NavId.Sessions} />
              <Topbar breadcrumbs={[{ label: "Sessions" }]} />
            </SidebarProvider>
          </GuestSignupProvider>
        </NavigationProvider>
      </FeatureFlagAdapterProvider>
    </DesktopAppCoreProvider>
  );
}

describe("guest pre-auth chrome (ISS-5112)", () => {
  it("reads the footer trigger as Guest, naming no account the guest does not have", async () => {
    renderChrome(true);

    const trigger = await screen.findByRole("button", {
      name: ACCOUNT_MENU_TRIGGER_NAME,
    });
    expect(trigger.textContent).toContain("Guest");
    // The signed-in trigger reads an organization name and falls back to the
    // generic "Account" — both claim something this device cannot know.
    expect(screen.queryByText("Account")).toBeNull();
  });

  it("keeps Settings and Diagnostics reachable in guest mode", async () => {
    // Regression guard (cr-44060). Settings and Diagnostics have no other link
    // site in the renderer and no Electron app-menu entry, and Settings hosts
    // the Labs tab that owns the `guest-onboarding` flag itself. A guest branch
    // that replaced the whole dropdown with a bare button stranded a signed-out
    // user with no route to either — and no way to switch this flag back off.
    renderChrome(true);

    const trigger = await screen.findByRole("button", {
      name: ACCOUNT_MENU_TRIGGER_NAME,
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });

    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getByRole("menuitem", { name: "Settings" })
        .getAttribute("href")
    ).toBe("/settings");
    expect(
      within(menu)
        .getByRole("menuitem", { name: "Diagnostics" })
        .getAttribute("href")
    ).toBe("/diagnostics");
    expect(within(menu).getByRole("menuitem", { name: "Theme" })).toBeDefined();
  });

  it("offers the account from inside that same menu", async () => {
    renderChrome(true);

    const trigger = await screen.findByRole("button", {
      name: ACCOUNT_MENU_TRIGGER_NAME,
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });

    const menu = await screen.findByRole("menu");
    // "Create account", not "Sign In": desktop auth is one loopback OAuth door,
    // so a second name here promises a path that does not exist — and this item
    // opens a dialog headed "Create your account".
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: SIGN_UP_LABEL })
    );

    expect(
      await screen.findByRole("dialog", { name: "Create your account" })
    ).toBeDefined();
  });

  it("keeps the standing offer OFF the window chrome", async () => {
    renderChrome(true);

    // The offer used to live in the Topbar, which follows the guest onto
    // Sessions, Branches, Agents and Settings — screens an account changes
    // nothing about, where a filled primary was the loudest thing present. It
    // belongs on the dashboard's own title row beside Tour and the scope
    // toggle; `guest-tour-account-dialog.test.tsx` asserts it there. Waited on
    // via the sidebar's guest trigger so this proves the button is absent from
    // rendered guest chrome, not merely absent before the flag resolves.
    await screen.findByRole("button", { name: ACCOUNT_MENU_TRIGGER_NAME });
    expect(screen.queryByRole("button", { name: SIGN_UP_LABEL })).toBeNull();
  });

  it("keeps the invite item as an ASK, not a dialog with no org to invite into", async () => {
    renderChrome(true);

    const invite = await screen.findByRole("button", { name: INVITE_LABEL });
    invite.click();

    // The ask, not the invite form: a guest has no organization id to mint
    // invitations against.
    //
    // The two dialogs now share an accessible name — the ask answers the
    // question that was asked, so it is titled "Invite your team" too — which
    // means the NAME can no longer tell them apart. Discriminate on content:
    // the ask offers an account, the real form collects email addresses.
    const dialog = await screen.findByRole("dialog", { name: INVITE_LABEL });
    expect(
      within(dialog).getByRole("button", { name: DIALOG_SIGN_UP_LABEL })
    ).toBeDefined();
    expect(
      within(dialog).getByRole("button", { name: "Not now" })
    ).toBeDefined();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
  });

  it("answers the question the guest actually asked", async () => {
    // The intent is already carried through sign-up so the resume lands right;
    // this is the same intent reaching the COPY, so someone who pressed "Invite
    // your team" is not met with a generic account pitch that never mentions a
    // team.
    renderChrome(true);

    (await screen.findByRole("button", { name: INVITE_LABEL })).click();

    const dialog = await screen.findByRole("dialog", { name: INVITE_LABEL });
    expect(within(dialog).getByText("Bring your team")).toBeDefined();
    expect(
      within(dialog).queryByText(
        "Sign up to see how your team uses AI and invite collaborators. Your agent session logs stay on this Mac."
      )
    ).toBeNull();
  });

  it("leaves the signed-out chrome exactly as it shipped with the flag off", async () => {
    renderChrome(false);

    // The pre-ISS-5112 contract: the account trigger is present (reading its
    // generic fallback) and neither guest affordance exists.
    const trigger = await screen.findByRole("button", {
      name: ACCOUNT_MENU_TRIGGER_NAME,
    });
    expect(trigger.textContent).toContain("Account");
    expect(trigger.textContent).not.toContain("Guest");
    expect(screen.queryByRole("button", { name: SIGN_UP_LABEL })).toBeNull();

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).queryByRole("menuitem", { name: SIGN_UP_LABEL })
    ).toBeNull();
  });
});
