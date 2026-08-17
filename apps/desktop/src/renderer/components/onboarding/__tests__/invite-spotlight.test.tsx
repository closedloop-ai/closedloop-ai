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
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { DataSyncLevelValue } from "@repo/app/shared/lib/data-sync-copy";
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
import { DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags";
import type { SyncConsentRecord } from "../../../../shared/sync-consent";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import { NavId } from "../../../navigation/route-table";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { inviteSpotlightDismissedStorageKey } from "../../dashboard/dashboard-storage-keys";
import { Sidebar } from "../../layout/Sidebar";
import { Topbar } from "../../layout/Topbar";
import {
  INVITE_SPOTLIGHT_BODY,
  INVITE_SPOTLIGHT_DISMISS_LABEL,
  INVITE_SPOTLIGHT_INVITE_LABEL,
  InviteSpotlightProvider,
} from "../invite-spotlight";
import {
  type SyncConsentArrival,
  SyncConsentArrivalProvider,
} from "../sync-consent-arrival";

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

function arrivalForCurrentIdentity(): SyncConsentArrival {
  return {
    level: DataSyncLevelValue.Full,
    organizationId: ORG_ID,
    userId: USER_ID,
    workspaceName: "Acme Engineering",
  };
}

function emailFieldValue(scope: HTMLElement): string {
  return (
    within(scope).getByRole("textbox", {
      name: EMAIL_LABEL,
    }) as HTMLInputElement
  ).value;
}

vi.mock("../../../feature-flags/desktop-feature-flag-provider", () => ({
  useDesktopFeatureFlagsResolved: () => true,
}));

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
 * record has been read proves nothing — and the consent read doubles as proof of
 * which half of the provider mounted: the flag-off path must never reach it.
 */
const bridge = {
  getDesktopAuthState: vi.fn(),
  getSyncConsentRecord: vi.fn(),
  onDesktopAuthStateChanged: vi.fn(),
};

/** The auth provider's push channel, captured so a test can switch identities. */
let pushAuthState: ((state: unknown) => void) | null = null;

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
  // The renderer test env ships no real `localStorage`, and the dismissal flag
  // is half the subject here — unbacked, `writeFlag` no-ops through its own
  // null guard and the relaunch case would pass for the wrong reason.
  stubLocalStorage();
  setViewportWidth(DESKTOP_WIDTH);
  stubBridge();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "desktopApi");
  if (innerWidthDescriptor) {
    Object.defineProperty(window, "innerWidth", innerWidthDescriptor);
  }
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderShell({
  arrival = null,
  flagOn = true,
  sidebarOpen = true,
}: {
  arrival?: SyncConsentArrival | null;
  flagOn?: boolean;
  /** `false` is the persisted collapsed-offcanvas state, not a mobile viewport. */
  sidebarOpen?: boolean;
} = {}) {
  const memoryNav = createMemoryNavigation({ initialPath: "/sessions" });
  return render(
    <DesktopAppCoreProvider>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: flagOn
            ? [DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY]
            : [],
        })}
      >
        <NavigationProvider adapter={memoryNav.adapter}>
          <SyncConsentArrivalProvider arrival={arrival}>
            <SidebarProvider open={sidebarOpen}>
              <InviteSpotlightProvider>
                <Sidebar activeNav={NavId.Sessions} />
                <Topbar breadcrumbs={[{ label: "Sessions" }]} />
              </InviteSpotlightProvider>
            </SidebarProvider>
          </SyncConsentArrivalProvider>
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

  it("fires on the run the takeover was answered, not only after a relaunch", async () => {
    // This provider mounts its OWN `useSyncConsentRecord`, which re-reads only
    // on a user change — so the takeover's post-save `refresh()` never reaches
    // it and the record stays unanswered for the rest of the run. The arrival is
    // the takeover publishing what it committed; without it the arrival nudge
    // could only ever appear on some later launch.
    stubBridge({ bound: false, organizationId: null, tier: null });

    renderShell({ arrival: arrivalForCurrentIdentity() });

    expect(await screen.findByText(INVITE_SPOTLIGHT_BODY)).toBeDefined();
  });

  it("still fires when the consent record cannot be read at all", async () => {
    // The arrival already proves consent was committed. Gating on the record
    // first put the whole fix behind the very read it exists to bypass, so a
    // rejected IPC call silently cost the nudge to a user who had just finished
    // the consent flow.
    stubBridge(CONSENTED, () => Promise.reject(new Error("bridge down")));

    renderShell({ arrival: arrivalForCurrentIdentity() });

    expect(await screen.findByText(INVITE_SPOTLIGHT_BODY)).toBeDefined();
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

  it("ignores an arrival that belongs to a different identity", async () => {
    stubBridge({ bound: false, organizationId: null, tier: null });

    renderShell({
      arrival: {
        level: DataSyncLevelValue.Full,
        organizationId: "org_previous",
        userId: "user_previous",
        workspaceName: "Previous Org",
      },
    });

    await waitFor(() => expect(bridge.getSyncConsentRecord).toHaveBeenCalled());
    expect(screen.queryByText(INVITE_SPOTLIGHT_BODY)).toBeNull();
  });

  it("stays dark while the guest-onboarding flag is off", async () => {
    renderShell({ flagOn: false });

    // Settle on the auth read, then assert the armed half never ran at all —
    // that is the structural guarantee, not just an absent pop-up: reading auth
    // and consent behind an off flag is what breaks the provider-less suites.
    await waitFor(() => expect(bridge.getDesktopAuthState).toHaveBeenCalled());
    expect(bridge.getSyncConsentRecord).not.toHaveBeenCalled();
    expect(screen.queryByText(INVITE_SPOTLIGHT_BODY)).toBeNull();
  });

  it("never fires while the consent takeover still owns the screen", async () => {
    stubBridge({ bound: false, organizationId: null, tier: null });

    renderShell();

    await waitFor(() => expect(bridge.getSyncConsentRecord).toHaveBeenCalled());
    expect(screen.queryByText(INVITE_SPOTLIGHT_BODY)).toBeNull();
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
