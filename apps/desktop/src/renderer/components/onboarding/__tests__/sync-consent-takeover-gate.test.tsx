/**
 * ISS-5489 (PLN-1694 M1): the post-auth consent takeover, mounted.
 *
 * `should-show-sync-consent-takeover.test.ts` owns the decision table; this suite
 * owns the wiring the predicate cannot see — that the consent record is actually
 * read over the bridge, that Save persists through the consolidated setter AND
 * lands the user on Sessions, and that there is genuinely no way out of the
 * dialog. The flag hook is REAL (the actual registry key through
 * `FeatureFlagAdapterProvider`); only auth, identity, navigation and the desktop
 * bridge are stubbed.
 */

import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { DataSyncLevelValue } from "@repo/app/shared/lib/data-sync-copy";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags";
import type { SyncConsentRecord } from "../../../../shared/sync-consent";
import { useSyncConsentArrival } from "../sync-consent-arrival";
import {
  SAVE_FAILED_MESSAGE,
  SyncConsentTakeoverGate,
} from "../sync-consent-takeover-gate";

const ORG_ID = "org_acme";
const ORG_NAME = "Acme Engineering";
const USER_ID = "user_1";
const TAKEOVER_TITLE = /sync permissions/i;
const SAVE = /^save$/i;
const FULL_OPTION = /full transcripts/i;
const OFF_OPTION = /^off\b/i;
const APP_BODY = "app-body";
const ARRIVAL_PROBE = "arrival-probe";
const NEXT_ORG_ID = "org_next";
const NO_ARRIVAL = "none";
const SIGNED_IN = /you're signed in/i;
const SIGNED_IN_TO_ORG = new RegExp(`signed in to ${ORG_NAME}`, "i");
/** The hole the prototype's unconditional interpolation would leave. */
const EMPTY_ORG_NAME = /signed in to\s*!/i;

const stubs = vi.hoisted(() => ({
  navigate: vi.fn(),
  // Counted, not just stubbed: the flag-off path must never REACH this hook.
  // In the real app it throws without a `DesktopAuthProvider`, which the
  // app-shell suites deliberately do not mount.
  useDesktopAuth: vi.fn(),
  authStatus: "" as string,
  organizationId: null as string | null,
  organizationName: null as string | null,
  /** The org the CACHED identity belongs to — not always the signed-in one. */
  identityOrganizationId: null as string | null,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: stubs.navigate }),
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => {
    stubs.useDesktopAuth();
    return {
      state: {
        status: stubs.authStatus,
        userId: USER_ID,
        organizationId: stubs.organizationId,
      },
    };
  },
}));

vi.mock("../../../shared-agent-sessions/use-desktop-identity", () => ({
  useDesktopIdentity: () => ({
    // A real `DesktopIdentity` always carries `organizationId`; the takeover
    // uses it to prove the cached name belongs to the org being consented to.
    identity: stubs.organizationName
      ? {
          organizationId: stubs.identityOrganizationId,
          organizationName: stubs.organizationName,
        }
      : null,
    isResolved: true,
  }),
}));

vi.mock("../../../feature-flags/desktop-feature-flag-provider", () => ({
  useDesktopFeatureFlagsResolved: () => true,
}));

function stubBridge({
  record,
  recordSyncConsent,
}: {
  record: SyncConsentRecord;
  recordSyncConsent?: ReturnType<typeof vi.fn>;
}) {
  const write = recordSyncConsent ?? vi.fn(() => Promise.resolve({}));
  const read = vi.fn(() => Promise.resolve(record));
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getSyncConsentRecord: read,
      recordSyncConsent: write,
    },
    writable: true,
  });
  return { write, read };
}

/**
 * Stands in for the Sessions banner (PLN-1694 M2), which is the only consumer
 * of the arrival. Rendered as a child so what it reports is what the real
 * banner would read — the gate publishing through a provider it wraps children
 * in, not a value handed straight to a sibling.
 */
function ArrivalProbe() {
  const arrival = useSyncConsentArrival();
  return (
    <div data-testid={ARRIVAL_PROBE}>
      {arrival ? `${arrival.level}|${arrival.workspaceName}` : NO_ARRIVAL}
    </div>
  );
}

function renderGate({ flagOn = true }: { flagOn?: boolean } = {}) {
  return render(gateTree({ flagOn }));
}

function gateTree({ flagOn = true }: { flagOn?: boolean } = {}) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: flagOn ? [DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY] : [],
      })}
    >
      <SyncConsentTakeoverGate>
        <div data-testid={APP_BODY}>app</div>
        <ArrivalProbe />
      </SyncConsentTakeoverGate>
    </FeatureFlagAdapterProvider>
  );
}

beforeEach(() => {
  stubs.navigate.mockReset();
  stubs.useDesktopAuth.mockReset();
  stubs.authStatus = DesktopAuthStatus.Authenticated;
  stubs.organizationId = ORG_ID;
  stubs.organizationName = ORG_NAME;
  stubs.identityOrganizationId = ORG_ID;
});

afterEach(() => {
  Reflect.deleteProperty(window, "desktopApi");
  vi.restoreAllMocks();
});

describe("SyncConsentTakeoverGate", () => {
  it("reads the record over the bridge and takes over when it is unanswered", async () => {
    stubBridge({ record: { tier: null, organizationId: null, bound: false } });
    renderGate();
    expect(
      await screen.findByRole("alertdialog", { name: TAKEOVER_TITLE })
    ).toBeTruthy();
  });

  it("names the signed-in org in the context copy", async () => {
    stubBridge({ record: { tier: null, organizationId: null, bound: false } });
    renderGate();
    expect(await screen.findByText(SIGNED_IN_TO_ORG)).toBeTruthy();
  });

  it("withholds a cached name that belongs to a DIFFERENT org", async () => {
    // `useDesktopIdentity` is a process-wide cache keyed by user id alone and
    // seeds synchronously from it, so a same-user org change can hand this
    // dialog the previous org's name. Naming the wrong organization in the
    // sentence asking for the user's data is the one blip this surface cannot
    // afford, so it falls back to the unnamed copy until the two agree.
    stubs.identityOrganizationId = "org_previous";
    stubBridge({ record: { tier: null, organizationId: null, bound: false } });
    renderGate();
    const description = await screen.findByText(SIGNED_IN);
    expect(description.textContent).not.toContain(ORG_NAME);
  });

  it("stays truthful when the org name does not resolve", async () => {
    // The prototype interpolates the workspace unconditionally; doing that here
    // would render "You're signed in to !".
    stubs.organizationName = null;
    stubBridge({ record: { tier: null, organizationId: null, bound: false } });
    renderGate();
    const description = await screen.findByText(SIGNED_IN);
    expect(description.textContent).not.toMatch(EMPTY_ORG_NAME);
  });

  it("renders the app behind the takeover rather than replacing it", async () => {
    stubBridge({ record: { tier: null, organizationId: null, bound: false } });
    renderGate();
    await screen.findByRole("alertdialog", { name: TAKEOVER_TITLE });
    expect(screen.getByTestId(APP_BODY)).toBeTruthy();
  });

  it("never takes over when the device has already answered for this org", async () => {
    stubBridge({
      record: { tier: "metadata", organizationId: ORG_ID, bound: true },
    });
    renderGate();
    await waitFor(() => expect(screen.getByTestId(APP_BODY)).toBeTruthy());
    expect(
      screen.queryByRole("alertdialog", { name: TAKEOVER_TITLE })
    ).toBeNull();
  });

  it("never takes over on a signed-out device", async () => {
    stubs.authStatus = DesktopAuthStatus.SignedOut;
    stubBridge({ record: { tier: null, organizationId: null, bound: false } });
    renderGate();
    await waitFor(() => expect(screen.getByTestId(APP_BODY)).toBeTruthy());
    expect(
      screen.queryByRole("alertdialog", { name: TAKEOVER_TITLE })
    ).toBeNull();
  });

  it("pre-selects Full transcripts, not the Settings default", async () => {
    stubBridge({ record: { tier: null, organizationId: null, bound: false } });
    renderGate();
    await screen.findByRole("alertdialog", { name: TAKEOVER_TITLE });
    expect(
      (screen.getByRole("radio", { name: FULL_OPTION }) as HTMLInputElement)
        .checked
    ).toBe(true);
  });

  it("persists the chosen level with the signed-in org and lands on Sessions", async () => {
    const { write } = stubBridge({
      record: { tier: null, organizationId: null, bound: false },
    });
    renderGate();
    await screen.findByRole("alertdialog", { name: TAKEOVER_TITLE });
    fireEvent.click(screen.getByRole("radio", { name: OFF_OPTION }));
    fireEvent.click(screen.getByRole("button", { name: SAVE }));

    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({
        level: DataSyncLevelValue.Off,
        organizationId: ORG_ID,
      })
    );
    await waitFor(() =>
      expect(stubs.navigate).toHaveBeenCalledWith("/sessions")
    );
  });

  it("publishes the answer to the Sessions landing, org name and all", async () => {
    // PLN-1694 M2: the banner acknowledges what was just authorized. It reads
    // the committed answer from here rather than re-deriving it from the stored
    // tier, whose value set is a different one.
    stubBridge({ record: { tier: null, organizationId: null, bound: false } });
    renderGate();
    await screen.findByRole("alertdialog", { name: TAKEOVER_TITLE });
    expect(screen.getByTestId(ARRIVAL_PROBE).textContent).toBe(NO_ARRIVAL);

    fireEvent.click(screen.getByRole("radio", { name: OFF_OPTION }));
    fireEvent.click(screen.getByRole("button", { name: SAVE }));

    await waitFor(() =>
      expect(screen.getByTestId(ARRIVAL_PROBE).textContent).toBe(
        `${DataSyncLevelValue.Off}|${ORG_NAME}`
      )
    );
  });

  it("records the org main committed, not the one the renderer had before the write", async () => {
    // Main reads the org from the authenticated session and deliberately ignores
    // the payload's, so an identity change while the write is in flight commits
    // consent for the NEW org. Echoing back the pre-await snapshot recorded the
    // answer against the OLD one — which meant the takeover immediately re-asked
    // a question that had just been answered for the org the user is now in.
    let settle: ((result: unknown) => void) | undefined;
    stubBridge({
      record: { tier: null, organizationId: null, bound: false },
      recordSyncConsent: vi.fn(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          })
      ),
    });
    const { rerender } = renderGate();
    await screen.findByRole("alertdialog", { name: TAKEOVER_TITLE });
    fireEvent.click(screen.getByRole("button", { name: SAVE }));

    // The org moves while the write is still in flight.
    stubs.organizationId = NEXT_ORG_ID;
    rerender(gateTree());
    act(() =>
      settle?.({
        level: DataSyncLevelValue.Full,
        organizationId: NEXT_ORG_ID,
      })
    );

    // Answered for the org that was actually committed — so the takeover stays
    // shut — and published to the identity now signed in.
    await waitFor(() =>
      expect(screen.getByTestId(ARRIVAL_PROBE).textContent).toBe(
        `${DataSyncLevelValue.Full}|${ORG_NAME}`
      )
    );
    expect(
      screen.queryByRole("alertdialog", { name: TAKEOVER_TITLE })
    ).toBeNull();
  });

  it("drops the published answer when the signed-in identity changes", async () => {
    // The gate stays mounted across an in-session sign-out and sign-in, both of
    // which are reachable from Settings → Account. An arrival that outlives the
    // user who produced it greets the NEXT user with the previous one's
    // organization name and consent level on the Sessions landing.
    stubBridge({ record: { tier: null, organizationId: null, bound: false } });
    const { rerender } = renderGate();
    await screen.findByRole("alertdialog", { name: TAKEOVER_TITLE });
    fireEvent.click(screen.getByRole("button", { name: SAVE }));
    await waitFor(() =>
      expect(screen.getByTestId(ARRIVAL_PROBE).textContent).not.toBe(NO_ARRIVAL)
    );

    stubs.organizationId = NEXT_ORG_ID;
    rerender(gateTree());

    await waitFor(() =>
      expect(screen.getByTestId(ARRIVAL_PROBE).textContent).toBe(NO_ARRIVAL)
    );
  });

  it("publishes nothing when the write failed", async () => {
    // A banner reporting an upload that was never enabled is the same lie the
    // dialog's own failed-write branch exists to avoid.
    stubBridge({
      record: { tier: null, organizationId: null, bound: false },
      recordSyncConsent: vi.fn().mockRejectedValue(new Error("bridge down")),
    });
    renderGate();
    await screen.findByRole("alertdialog", { name: TAKEOVER_TITLE });
    fireEvent.click(screen.getByRole("button", { name: SAVE }));

    await screen.findByText(SAVE_FAILED_MESSAGE);
    expect(screen.getByTestId(ARRIVAL_PROBE).textContent).toBe(NO_ARRIVAL);
  });

  it("dismisses after Save so the answer is not asked twice", async () => {
    stubBridge({ record: { tier: null, organizationId: null, bound: false } });
    renderGate();
    await screen.findByRole("alertdialog", { name: TAKEOVER_TITLE });
    fireEvent.click(screen.getByRole("button", { name: SAVE }));
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: TAKEOVER_TITLE })
      ).toBeNull()
    );
  });

  it("reports a failed write and stays open to be retried", async () => {
    // Dismissing on a failed write told the user their answer was recorded when
    // nothing was, then suppressed the question for the rest of the run — the app
    // proceeding with sync silently off, behind a screen that said it was on.
    // This cannot trap anyone: an unreachable bridge resolves the record as
    // unreadable, which withholds the takeover entirely, so a dialog that is on
    // screen got a readable record and a failed write is a transient to retry.
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error("bridge down"))
      .mockResolvedValueOnce({});
    stubBridge({
      record: { tier: null, organizationId: null, bound: false },
      recordSyncConsent: write,
    });
    renderGate();
    await screen.findByRole("alertdialog", { name: TAKEOVER_TITLE });
    fireEvent.click(screen.getByRole("button", { name: SAVE }));

    await screen.findByText(SAVE_FAILED_MESSAGE);
    expect(
      screen.getByRole("alertdialog", { name: TAKEOVER_TITLE })
    ).toBeTruthy();
    expect(stubs.navigate).not.toHaveBeenCalled();

    // Save stayed live, so the banner is a retry prompt and not a dead end.
    fireEvent.click(screen.getByRole("button", { name: SAVE }));
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: TAKEOVER_TITLE })
      ).toBeNull()
    );
  });

  it("re-reads the record after a successful write", async () => {
    // The read is keyed to the USER, and an org switch is not a change of user.
    // Without this the in-memory record stays at its mount-time value while disk
    // moves on, so A → B → A suppresses the takeover for A from a record that is
    // now bound to B.
    const { read } = stubBridge({
      record: { tier: null, organizationId: null, bound: false },
    });
    renderGate();
    await screen.findByRole("alertdialog", { name: TAKEOVER_TITLE });
    expect(read).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: SAVE }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("has no escape: Escape and a backdrop click both leave it open", async () => {
    stubBridge({ record: { tier: null, organizationId: null, bound: false } });
    renderGate();
    const dialog = await screen.findByRole("alertdialog", {
      name: TAKEOVER_TITLE,
    });

    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    expect(
      screen.getByRole("alertdialog", { name: TAKEOVER_TITLE })
    ).toBeTruthy();

    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    expect(
      screen.getByRole("alertdialog", { name: TAKEOVER_TITLE })
    ).toBeTruthy();
  });

  it("offers no close or cancel control", async () => {
    stubBridge({ record: { tier: null, organizationId: null, bound: false } });
    renderGate();
    const dialog = await screen.findByRole("alertdialog", {
      name: TAKEOVER_TITLE,
    });
    // Save is the ONLY button in the dialog. Anything else here would be a way
    // past the consent question that the hard-block decision rules out.
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toMatch(SAVE);
  });
});

/**
 * The gate is mounted in the app shell, above surfaces whose own suites do not
 * mount a `DesktopAuthProvider`. With the flag off it must therefore not merely
 * render nothing — it must never REACH the auth hook, which throws without that
 * provider. Guarding this at the render level (not the predicate level) is the
 * whole reason the component is split in two.
 */
describe("SyncConsentTakeoverGate with the flag off", () => {
  it("renders the app and never reads auth", async () => {
    stubBridge({ record: { tier: null, organizationId: null, bound: false } });
    renderGate({ flagOn: false });
    await waitFor(() => expect(screen.getByTestId(APP_BODY)).toBeTruthy());
    expect(stubs.useDesktopAuth).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("alertdialog", { name: TAKEOVER_TITLE })
    ).toBeNull();
  });

  it("reads auth once the flag is on, so the guard above is load-bearing", () => {
    // Without this counterpart the assertion above would also pass if the gate
    // stopped reading auth entirely.
    stubBridge({ record: { tier: null, organizationId: null, bound: false } });
    renderGate({ flagOn: true });
    expect(stubs.useDesktopAuth).toHaveBeenCalled();
  });
});
