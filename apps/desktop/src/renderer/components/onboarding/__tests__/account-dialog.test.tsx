/**
 * ISS-5112 (PLN-1600 Step C): the account dialog a guest meets when the
 * first-launch tour ends.
 *
 * The sign-up path is asserted through the REAL chain — `AccountDialog` →
 * `DesktopOnboardingFlow` → `AuthMethods` → `DesktopAuthProvider.beginSignIn` →
 * `window.desktopApi.beginDesktopSignIn` — with only the preload bridge faked, so
 * a "Sign Up" that stopped reaching the desktop sign-in IPC fails here rather
 * than passing against a stubbed callback.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DesktopAuthState,
  DesktopAuthStatus,
} from "../../../../shared/contracts";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import type { DesktopBrowserSignInResult } from "../../../types/desktop-api";
import { AccountDialog } from "../account-dialog";

const SIGNED_OUT: DesktopAuthState = {
  status: DesktopAuthStatus.SignedOut,
  userId: null,
  organizationId: null,
};

/** The onboarding flow's own heading, behind the dialog's single auth door. */
const FLOW_HEADING = "Create your Closedloop account";
/**
 * One verb for the whole funnel. The tour's last button, this one, and the
 * heading behind it all say the same thing; four renames across four
 * consecutive screens read as four destinations.
 */
const SIGN_UP_LABEL = "Sign Up";
/** What the primary renames itself to while the browser handoff is in flight. */
const SIGN_UP_PENDING_LABEL = "Opening browser…";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

/**
 * Never resolves by default: the click leaves the dialog in its in-flight state,
 * which is what the packaged app does while the system browser is open.
 * Individual cases override with a settled result. Typed to the real bridge
 * return so an override cannot drift from the shape production receives.
 */
const beginDesktopSignIn = vi.fn(
  (): Promise<DesktopBrowserSignInResult> =>
    new Promise<DesktopBrowserSignInResult>(() => undefined)
);
const cancelDesktopSignIn = vi.fn(() => Promise.resolve());

function installAuthBridge(): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      beginDesktopSignIn,
      cancelDesktopSignIn,
      getDesktopAuthState: () => Promise.resolve(SIGNED_OUT),
      signOutDesktop: () => Promise.resolve(),
    },
    writable: true,
  });
}

function renderDialog(onOpenChange = vi.fn()) {
  const result = render(<AccountDialog onOpenChange={onOpenChange} open />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <DesktopAuthProvider>{children}</DesktopAuthProvider>
    ),
  });
  return { ...result, onOpenChange };
}

describe("AccountDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAuthBridge();
  });

  afterEach(() => {
    if (originalDesktopApi) {
      Object.defineProperty(window, "desktopApi", originalDesktopApi);
      return;
    }
    Reflect.deleteProperty(window, "desktopApi");
  });

  it("makes the offer, names what an account buys, and says where the logs stay", () => {
    renderDialog();

    expect(
      screen.getByRole("dialog", { name: "Create your account" })
    ).toBeDefined();
    expect(
      screen.getByText(
        "Sign up to see how your team uses AI and invite collaborators. Your agent session logs stay on this Mac."
      )
    ).toBeDefined();
    expect(screen.getByRole("button", { name: SIGN_UP_LABEL })).toBeDefined();
    expect(screen.getByRole("button", { name: "Not now" })).toBeDefined();
  });

  it("offers a returning-user door alongside the primary, per the prototype", () => {
    renderDialog();

    // Both open the SAME web page — desktop auth is a single loopback OAuth
    // door. An earlier revision removed this line for that reason; the
    // prototype is the spec, and the two labels answer different questions the
    // person is asking themselves, which the page they land on can honour.
    expect(screen.getByText("Already have an account?")).toBeDefined();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
    expect(
      screen
        .getByRole("dialog")
        .querySelectorAll("button:not([data-slot='dialog-close'])")
    ).toHaveLength(3);
  });

  it("sends the returning-user door to the same web page as the primary", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(beginDesktopSignIn).toHaveBeenCalledTimes(1));
    expect(beginDesktopSignIn).toHaveBeenCalledWith(undefined);
  });

  it("renders nothing at all when closed", () => {
    render(<AccountDialog onOpenChange={vi.fn()} open={false} />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <DesktopAuthProvider>{children}</DesktopAuthProvider>
      ),
    });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on 'Not now' — declining is a real answer, not a detour", () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on Escape so a guest is never trapped", () => {
    const { onOpenChange } = renderDialog();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("opens the web sign-up page directly, with no second dialog", async () => {
    // ISS-5489 product decision: the provider chooser that used to open inside
    // this dialog is gone. The web page asks that question, so the middle step
    // added a click and no information.
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: SIGN_UP_LABEL }));

    await waitFor(() => expect(beginDesktopSignIn).toHaveBeenCalledTimes(1));
    // No provider is pre-selected: the web page owns that choice now.
    expect(beginDesktopSignIn).toHaveBeenCalledWith(undefined);
    expect(
      screen.queryByRole("button", { name: "Continue with GitHub" })
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: FLOW_HEADING })).toBeNull();
  });

  it("reports completion before closing, so the resume intent survives", async () => {
    // The resume-after-signup marker used to be fired by the inner flow. With
    // that flow gone, `beginSignIn` resolving IS the completion signal — without
    // this the invite dialog someone was asking for would never reopen.
    beginDesktopSignIn.mockImplementationOnce(() =>
      Promise.resolve({ ok: true })
    );
    const onSignedUp = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <AccountDialog
        onOpenChange={onOpenChange}
        onSignedUp={onSignedUp}
        open
      />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <DesktopAuthProvider>{children}</DesktopAuthProvider>
        ),
      }
    );

    fireEvent.click(screen.getByRole("button", { name: SIGN_UP_LABEL }));
    await waitFor(() => expect(onSignedUp).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces a sign-in failure and stays open to retry", async () => {
    beginDesktopSignIn.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, reason: "already_in_progress" })
    );
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: SIGN_UP_LABEL }));
    await screen.findByText("A sign-in is already in progress.");
    // Still open: a failed sign-in must not look like a completed one.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: SIGN_UP_LABEL })).toBeDefined();
  });

  it("cancels the in-flight browser sign-in when a guest backs out", async () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: SIGN_UP_LABEL }));
    await waitFor(() => expect(beginDesktopSignIn).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(cancelDesktopSignIn).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not cancel anything when the offer itself is declined", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(cancelDesktopSignIn).not.toHaveBeenCalled();
  });

  it("ignores a backed-out run that settles after a newer one started", async () => {
    // `cancelSignIn` releases the main-process slot; it does not un-await this
    // side's promise. A cancelled run still settles HERE, and settling `ok` used
    // to fire `onSignedUp` and close a dialog the guest had already left — or, as
    // below, hijack the newer attempt they had just started.
    let settleFirstRun: (result: DesktopBrowserSignInResult) => void = () =>
      undefined;
    beginDesktopSignIn.mockImplementationOnce(
      () =>
        new Promise<DesktopBrowserSignInResult>((resolve) => {
          settleFirstRun = resolve;
        })
    );
    const onSignedUp = vi.fn();
    render(
      <AccountDialog onOpenChange={vi.fn()} onSignedUp={onSignedUp} open />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <DesktopAuthProvider>{children}</DesktopAuthProvider>
        ),
      }
    );

    fireEvent.click(screen.getByRole("button", { name: SIGN_UP_LABEL }));
    await waitFor(() => expect(beginDesktopSignIn).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(cancelDesktopSignIn).toHaveBeenCalledTimes(1));

    // A second attempt, which now owns the dialog's state.
    fireEvent.click(screen.getByRole("button", { name: SIGN_UP_LABEL }));
    await waitFor(() => expect(beginDesktopSignIn).toHaveBeenCalledTimes(2));

    // The abandoned run comes back a success. Awaiting the pending SECOND run's
    // own state is what proves the first one's continuation has already been
    // dropped — no sleep, and nothing that would pass by simply not waiting.
    settleFirstRun({ ok: true });
    await screen.findByText(SIGN_UP_PENDING_LABEL);
    expect(onSignedUp).not.toHaveBeenCalled();
  });
});
