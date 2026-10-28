/**
 * ISS-5489 (PLN-1694 M2): the invite spotlight, mounted in the real shell.
 *
 * `should-show-invite-spotlight.test.ts` owns the decision table; this suite
 * owns what the predicate cannot see — WHICH control the pop-up hangs off at
 * each breakpoint, that "Maybe later" is written to disk and therefore survives
 * a relaunch, and that "Invite your team" reaches the real dialog.
 *
 * The anchor assertions are structural rather than positional: jsdom has no
 * layout, so "anchored correctly" is checked as "the anchor element actually
 * contains the control it is supposed to point at". That is the property a
 * naive port breaks — pointing at the sidebar item below 768px, where the whole
 * sidebar is an unmounted offcanvas sheet.
 */

import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import { WORKSPACE_MENU_TRIGGER_LABEL } from "@repo/api/src/types/workspace-menu";
import { WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY } from "@repo/api/src/types/workspace-menu-invite-entry-flag";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
import type { SyncConsentRecord } from "../../../../shared/sync-consent";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import { NavId } from "../../../navigation/route-table";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { resetDesktopIdentityCacheForTests } from "../../../shared-agent-sessions/use-desktop-identity";
import { inviteSpotlightDismissedStorageKey } from "../../dashboard/dashboard-storage-keys";
import { Sidebar } from "../../layout/Sidebar";
import { Topbar } from "../../layout/Topbar";
import {
  getBlockingOnboardingModalOpen,
  setBlockingOnboardingModalOpen,
} from "../blocking-onboarding-modal-store";
import {
  INVITE_SPOTLIGHT_BODY,
  INVITE_SPOTLIGHT_DISMISS_LABEL,
  INVITE_SPOTLIGHT_INVITE_LABEL,
  InviteSpotlightProvider,
} from "../invite-spotlight";

const ORG_ID = "org_acme";
const USER_ID = "user_1";
const INVITE_LABEL = "Invite your team";
const SIDEBAR_TOGGLE_LABEL = /sidebar$/i;
const ANCHOR_SELECTOR = '[data-slot="popover-anchor"]';
const POPOVER_SELECTOR = '[data-slot="popover-content"]';
const SIDEBAR_MENU_BUTTON_SELECTOR = '[data-sidebar="menu-button"]';
const DESKTOP_WIDTH = 1280;
const MOBILE_WIDTH = 500;

const CONSENTED: SyncConsentRecord = {
  bound: true,
  organizationId: ORG_ID,
  tier: "metadata",
};

/** A pre-ISS-5489 answer, honored for every org — so a second identity is nudged too. */
const UNBOUND_CONSENT: SyncConsentRecord = {
  bound: false,
  organizationId: null,
  tier: "metadata",
};

const NEXT_USER_ID = "user_2";
const NEXT_ORG_ID = "org_other";
const EMAIL_LABEL = "Email address";
const DRAFT_EMAIL = "<redacted-email>";

function emailFieldValue(scope: HTMLElement): string {
  return (
    within(scope).getByRole("textbox", {
      name: EMAIL_LABEL,
    }) as HTMLInputElement
  ).value;
}

let innerWidthDescriptor: PropertyDescriptor | undefined;

beforeAll(() => {
  innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
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

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
    writable: true,
  });
}

/**
 * Both reads are counted, not merely stubbed. They are the only settle signals
 * this shell has — an "it did not appear" assertion taken before the consent
 * record has been read proves nothing.
 */
const bridge = {
  getDesktopAuthState: vi.fn(),
  getDesktopIdentity: vi.fn(),
  getSyncConsentRecord: vi.fn(),
  onDesktopAuthStateChanged: vi.fn(),
};

/** The auth provider's push channel, captured so a test can switch identities. */
let pushAuthState: ((state: unknown) => void) | null = null;

/**
 * What `GET /desktop/identity` answers for the case being run. A case that wants
 * the UNREADABLE standing sets this to `null` before rendering; the default is a
 * readable identity, which is the `Ready` menu the ISS-10362 cases describe.
 */
let identityResult: () => {
  organizationName: string | null;
  userName: string | null;
  email: string | null;
} | null = () => ({
  organizationName: "Closedloop",
  userName: "Ada Lovelace",
  email: "ada@closedloop.ai",
});

function stubBridge(
  record: SyncConsentRecord = CONSENTED,
  readRecord: (() => Promise<SyncConsentRecord>) | null = null
) {
  bridge.getDesktopAuthState = vi.fn(() =>
    Promise.resolve({
      organizationId: ORG_ID,
      status: DesktopAuthStatus.Authenticated,
      userId: USER_ID,
    })
  );
  // ISS-11247: a THIRD settle signal, and it decides which host the nudge hangs
  // off. `useDesktopIdentity` settles an absent bridge read to
  // `{identity: null, isResolved: true}`, which the workspace menu reads as
  // `Error` — so without this the menu could never be `Ready`, the footer keeps
  // its own invite row, and every case below would silently be asserting the
  // footer-anchored shape while its name says workspace trigger.
  bridge.getDesktopIdentity = vi.fn(() => Promise.resolve(identityResult()));
  bridge.getSyncConsentRecord = vi.fn(
    readRecord ?? (() => Promise.resolve(record))
  );
  bridge.onDesktopAuthStateChanged = vi.fn((onChange: (s: unknown) => void) => {
    pushAuthState = onChange;
    return () => {
      pushAuthState = null;
    };
  });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: bridge,
    writable: true,
  });
}

beforeEach(() => {
  // Process-wide and keyed by user id, so one case's settled identity seeds the
  // next case's FIRST render synchronously and an unreadable-identity case would
  // pass or fail on run order.
  resetDesktopIdentityCacheForTests();
  identityResult = () => ({
    organizationName: "Closedloop",
    userName: "Ada Lovelace",
    email: "ada@closedloop.ai",
  });
  // The renderer test env ships no real `localStorage`, and the dismissal flag
  // is half the subject here — unbacked, `writeFlag` no-ops through its own
  // null guard and the relaunch case would pass for the wrong reason.
  stubLocalStorage();
  setViewportWidth(DESKTOP_WIDTH);
  stubBridge();
});

afterEach(() => {
  cleanup();
  // Module-level store: a case that leaves the takeover up would withhold the
  // nudge from every case after it, in file order only.
  setBlockingOnboardingModalOpen(false);
  Reflect.deleteProperty(window, "desktopApi");
  if (innerWidthDescriptor) {
    Object.defineProperty(window, "innerWidth", innerWidthDescriptor);
  }
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderShell({
  sidebarOpen = true,
  enabledFlags = [],
}: {
  /** `false` is the persisted collapsed-offcanvas state, not a mobile viewport. */
  sidebarOpen?: boolean;
  /**
   * Mounted INSIDE `DesktopAppCoreProvider`, whose own adapter is all-off — the
   * nearer provider wins, which is how a case turns one key on without the real
   * PostHog bridge.
   */
  enabledFlags?: readonly string[];
} = {}) {
  const memoryNav = createMemoryNavigation({ initialPath: "/sessions" });
  return render(
    <DesktopAppCoreProvider>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
      >
        <NavigationProvider adapter={memoryNav.adapter}>
          <SidebarProvider open={sidebarOpen}>
            <InviteSpotlightProvider>
              <Sidebar activeNav={NavId.Sessions} />
              <Topbar breadcrumbs={[{ label: "Sessions" }]} />
            </InviteSpotlightProvider>
          </SidebarProvider>
        </NavigationProvider>
      </FeatureFlagAdapterProvider>
    </DesktopAppCoreProvider>
  );
}

/** The element Radix is positioning the pop-up against, or null. */
function anchorElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(ANCHOR_SELECTOR);
}

/**
 * The pop-up itself. Scoped rather than queried globally because its primary
 * action carries the SAME accessible name as the sidebar item it points at — a
 * bare `getByRole("button", { name: "Invite your team" })` matches both.
 */
function spotlight(): HTMLElement {
  const content = document.querySelector<HTMLElement>(POPOVER_SELECTOR);
  if (!content) {
    throw new Error("the invite spotlight is not on screen");
  }
  return content;
}

/** The sidebar's own "Invite your team" nav item, or null when it is offcanvas. */
function sidebarInviteItem(): HTMLElement | null {
  return (
    Array.from(
      document.querySelectorAll<HTMLElement>(SIDEBAR_MENU_BUTTON_SELECTOR)
    ).find((item) => item.textContent?.includes(INVITE_LABEL)) ?? null
  );
}

describe("invite spotlight (ISS-5489)", () => {
  /**
   * ISS-11315 Defect 5. The wizard's own Continue on the sync step records
   * consent, which satisfies the last arm this predicate had — so the nudge
   * opened UNDERNEATH the guided dialog while it advanced to its own invite
   * step. Measured on the operator's 2026-09-27 recording: up at 109.875s
   * behind the dialog, gone by 110.875s, never answered.
   *
   * Driven through `setBlockingOnboardingModalOpen`, which is the production
   * signal — the guided dialog host's own `onOpenChange` — not a test-only
   * switch.
   */
  it("withholds the nudge while the guided onboarding takeover is up", async () => {
    renderShell();
    expect(await screen.findByText(INVITE_SPOTLIGHT_BODY)).toBeDefined();

    act(() => {
      setBlockingOnboardingModalOpen(true);
    });

    expect(getBlockingOnboardingModalOpen()).toBe(true);
    expect(screen.queryByText(INVITE_SPOTLIGHT_BODY)).toBeNull();
    expect(anchorElement()).toBeNull();
  });

  /**
   * The positive half, and the one that keeps the case above from being
   * satisfied by a nudge that never fires at all: the wizard closing releases
   * it, on the same mount, with nothing to re-read.
   */
  it("releases the nudge when the takeover closes", async () => {
    renderShell();
    expect(await screen.findByText(INVITE_SPOTLIGHT_BODY)).toBeDefined();

    act(() => {
      setBlockingOnboardingModalOpen(true);
    });
    expect(screen.queryByText(INVITE_SPOTLIGHT_BODY)).toBeNull();

    act(() => {
      setBlockingOnboardingModalOpen(false);
    });

    expect(await screen.findByText(INVITE_SPOTLIGHT_BODY)).toBeDefined();
  });

  /**
   * THE HALF THAT IS NOT COSMETIC.
   *
   * `open`/`onOpenChange` are wired straight to Radix's `Popover`, and
   * `onOpenChange(false)` is `answer()` — the write of
   * `inviteSpotlightDismissedStorageKey`. Radix closes a popover on a
   * focus-outside, and the wizard moves focus on every step change, so before
   * this arm the auto-close ran `answer()` and permanently consumed the arrival
   * nudge for that org: the reader never saw it, and it never returned on any
   * launch. `answer()` is the single sink for a deliberate "Maybe later" and
   * for an auto-close alike, so nothing downstream can tell them apart.
   *
   * A nudge that never OPENS cannot be auto-closed, which is why the arm is a
   * withhold and not a delay or a CSS hide.
   */
  it("spends no dismissal when the takeover takes the nudge off screen", async () => {
    renderShell();
    expect(await screen.findByText(INVITE_SPOTLIGHT_BODY)).toBeDefined();

    act(() => {
      setBlockingOnboardingModalOpen(true);
    });

    // The withhold closes the Popover, and a Popover closing is exactly the
    // event that used to run `answer()`. Nothing may be written: the reader has
    // not answered anything.
    expect(
      localStorage.getItem(inviteSpotlightDismissedStorageKey(ORG_ID))
    ).toBeNull();

    // And the proof the unspent nudge is still owed: it comes back the moment
    // the wizard is out of the way, rather than being gone for good.
    act(() => {
      setBlockingOnboardingModalOpen(false);
    });
    expect(await screen.findByText(INVITE_SPOTLIGHT_BODY)).toBeDefined();
  });

  it("anchors to the sidebar invite item on a wide window", async () => {
    renderShell();

    expect(await screen.findByText(INVITE_SPOTLIGHT_BODY)).toBeDefined();
    const anchor = anchorElement();
    expect(anchor).not.toBeNull();
    // The anchor must CONTAIN the invite control, not merely exist.
    expect(
      anchor?.querySelector(SIDEBAR_MENU_BUTTON_SELECTOR)?.textContent
    ).toContain(INVITE_LABEL);
  });

  it("anchors to the topbar toggle below 768px, where the sidebar is offcanvas", async () => {
    setViewportWidth(MOBILE_WIDTH);

    renderShell();

    expect(await screen.findByText(INVITE_SPOTLIGHT_BODY)).toBeDefined();
    // The premise: the sidebar item the desktop anchor points at is not on
    // screen at all here, so anchoring to it would point at nothing.
    expect(sidebarInviteItem()).toBeNull();
    const anchor = anchorElement();
    expect(anchor?.querySelector("button")?.getAttribute("aria-label")).toMatch(
      SIDEBAR_TOGGLE_LABEL
    );
  });

  it("anchors to the topbar when the desktop sidebar is collapsed offcanvas", async () => {
    // A collapsed offcanvas sidebar is NOT unmounted like the mobile sheet — it
    // is translated to negative x, so the invite item still exists and still
    // measures. Anchoring to it renders the pop-up off screen with the ring
    // highlighting a control nobody can see, and the collapsed state persists
    // across launches, so it is not a transient the next run clears.
    renderShell({ sidebarOpen: false });

    expect(await screen.findByText(INVITE_SPOTLIGHT_BODY)).toBeDefined();
    expect(anchorElement()?.querySelector("button")).toBe(
      screen.getByRole("button", { name: SIDEBAR_TOGGLE_LABEL })
    );
  });

  it("discards a draft invitation when the signed-in identity changes", async () => {
    // `InviteTeamDialog` keeps typed addresses across a dismissal — only a sent
    // invitation clears them — and this provider outlives a sign-out. Without an
    // identity-keyed instance, user A's draft was still sitting there for user B
    // to send into B's organization.
    stubBridge(UNBOUND_CONSENT);
    renderShell();
    await screen.findByText(INVITE_SPOTLIGHT_BODY);

    fireEvent.click(
      within(spotlight()).getByRole("button", {
        name: INVITE_SPOTLIGHT_INVITE_LABEL,
      })
    );
    const dialog = await screen.findByRole("dialog", { name: INVITE_LABEL });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: EMAIL_LABEL }),
      {
        target: { value: DRAFT_EMAIL },
      }
    );
    expect(emailFieldValue(dialog)).toBe(DRAFT_EMAIL);

    act(() =>
      pushAuthState?.({
        organizationId: NEXT_ORG_ID,
        status: DesktopAuthStatus.Authenticated,
        userId: NEXT_USER_ID,
      })
    );

    // Closed under the new identity — not merely re-keyed behind an open dialog.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: INVITE_LABEL })).toBeNull()
    );

    // And the draft is gone, not hidden: the next user opens an empty form.
    await screen.findByText(INVITE_SPOTLIGHT_BODY);
    fireEvent.click(
      within(spotlight()).getByRole("button", {
        name: INVITE_SPOTLIGHT_INVITE_LABEL,
      })
    );
    const reopened = await screen.findByRole("dialog", { name: INVITE_LABEL });
    expect(emailFieldValue(reopened)).toBe("");
  });

  it("keeps the sidebar menu's children `li` while anchored to the workspace trigger (ISS-10362)", async () => {
    // Once invite lives in the menu, the nudge points at the trigger that opens
    // it — the menu is closed at rest, so the row itself is not on screen to be
    // pointed at. `PopoverAnchor` renders a `Primitive.div`, so an anchor placed
    // AROUND the `SidebarMenuItem` commits `ul > div > li` and destroys the list
    // semantics screen readers rely on. Asserted with the pop-up OPEN, which is
    // the only state in which that wrapper exists at all.
    renderShell({ enabledFlags: [WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY] });

    await screen.findByText(INVITE_SPOTLIGHT_BODY);
    const anchor = anchorElement();
    // The premise: the anchor is on the workspace trigger, not the footer item.
    expect(anchor?.querySelector("button")?.getAttribute("aria-label")).toBe(
      WORKSPACE_MENU_TRIGGER_LABEL
    );

    // Exactly one host claims this anchor: with the menu holding the entry the
    // footer has surrendered its row, so the trigger is the only claimant.
    expect(document.querySelectorAll(ANCHOR_SELECTOR)).toHaveLength(1);

    const list = anchor?.closest("ul");
    expect(list).not.toBeNull();
    expect(
      Array.from(list?.children ?? []).map((child) => child.tagName)
    ).toEqual(["LI"]);
  });

  it("hangs the nudge off the footer row, and off nothing else, when the workspace menu cannot hold the entry (ISS-11247)", async () => {
    // The footer keeps its invite row in any standing but `Ready`, and that row
    // wraps the SAME `InviteSpotlightAnchor.Sidebar` the workspace trigger does.
    // While the header slot decided on the key alone, both claimed it: two
    // Popovers sharing one `onOpenChange`, and the nudge never rendered at all.
    // `invite-spotlight.tsx` states "exactly one is on screen at a time" as an
    // invariant and enforces it with nothing, so this case is the enforcement.
    identityResult = () => null;

    renderShell({ enabledFlags: [WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY] });

    await screen.findByText(INVITE_SPOTLIGHT_BODY);
    expect(document.querySelectorAll(ANCHOR_SELECTOR)).toHaveLength(1);
    // ...and it is the footer row, not the trigger. Since ISS-11400 the trigger
    // is NOT disabled here and does open a menu — but `ReadyWorkspaceMenu` is
    // still the only body that holds an invite row and still does not mount in
    // this standing, so an invite nudge pointing at that trigger would point at
    // a menu with nothing to invite from.
    expect(
      anchorElement()?.querySelector("button")?.getAttribute("aria-label")
    ).not.toBe(WORKSPACE_MENU_TRIGGER_LABEL);
    expect(sidebarInviteItem()).not.toBeNull();
  });

  it("keeps the workspace trigger mounted when the nudge pointing at it is answered (ISS-10362)", async () => {
    // Clicking the trigger this pop-up points at IS the outside-click that
    // answers the nudge, so the answer and the menu opening land in the SAME
    // tick. While `InviteSpotlightPopover` swapped between returning `children`
    // bare and nesting them under `Popover > PopoverAnchor`, that answer moved
    // the trigger's position in the tree, React remounted the subtree, and the
    // menu's own `open` state went with it — the first click after an arrival
    // nudge did nothing at all.
    //
    // DOM IDENTITY is the assertion because it is the thing that broke: a
    // remount produces an equal-looking button that is a different node, which
    // every by-name query would still find.
    renderShell({ enabledFlags: [WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY] });
    await screen.findByText(INVITE_SPOTLIGHT_BODY);

    const triggerWhilePointed = screen.getByRole("button", {
      name: WORKSPACE_MENU_TRIGGER_LABEL,
    });

    fireEvent.click(
      within(spotlight()).getByRole("button", {
        name: INVITE_SPOTLIGHT_DISMISS_LABEL,
      })
    );

    // The premise: the nudge really is gone, so this is the transition that
    // used to remount rather than a render where nothing changed.
    expect(screen.queryByText(INVITE_SPOTLIGHT_BODY)).toBeNull();
    expect(
      screen.getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL })
    ).toBe(triggerWhilePointed);
  });

  it("suppresses on relaunch once the user says Maybe later", async () => {
    const first = renderShell();
    await screen.findByText(INVITE_SPOTLIGHT_BODY);

    fireEvent.click(
      within(spotlight()).getByRole("button", {
        name: INVITE_SPOTLIGHT_DISMISS_LABEL,
      })
    );

    expect(screen.queryByText(INVITE_SPOTLIGHT_BODY)).toBeNull();
    // Persisted per device+org, so the next launch does not re-ask.
    expect(
      globalThis.localStorage.getItem(
        inviteSpotlightDismissedStorageKey(ORG_ID)
      )
    ).toBe("1");

    first.unmount();
    renderShell();

    await waitFor(() =>
      expect(bridge.getSyncConsentRecord).toHaveBeenCalledTimes(2)
    );
    expect(screen.queryByText(INVITE_SPOTLIGHT_BODY)).toBeNull();
  });

  it("opens the real invite dialog and answers the nudge", async () => {
    renderShell();
    await screen.findByText(INVITE_SPOTLIGHT_BODY);

    fireEvent.click(
      within(spotlight()).getByRole("button", {
        name: INVITE_SPOTLIGHT_INVITE_LABEL,
      })
    );

    expect(
      await screen.findByRole("dialog", { name: INVITE_LABEL })
    ).toBeDefined();
    // Taking the action answers it too — nobody who already opened the dialog
    // from here should be asked again next launch.
    expect(
      globalThis.localStorage.getItem(
        inviteSpotlightDismissedStorageKey(ORG_ID)
      )
    ).toBe("1");
  });
});
