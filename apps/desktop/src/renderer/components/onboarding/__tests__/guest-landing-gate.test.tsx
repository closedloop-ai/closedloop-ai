/**
 * ISS-5112 (PLN-1600 Step F): the first-run landing, mounted.
 *
 * `should-show-guest-landing.test.ts` owns the decision table; this suite owns
 * the wiring the predicate cannot see — that the storage flags are actually read
 * and written, that Get Started really routes to the Dashboard, and that a
 * sign-in started here cancels the in-flight browser run when it is backed out
 * of. The flag hook is REAL (`FeatureFlagAdapterProvider` over the actual
 * registry key); only auth, navigation and the OAuth flow are stubbed.
 */

import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import {
  dashboardOnboardedStorageKey,
  desktopLandingSeenStorageKey,
} from "../../dashboard/dashboard-storage-keys";
import { SIGN_IN_AUTH_COPY } from "../desktop-onboarding-flow";
import { GuestLandingGate } from "../guest-landing-gate";

const stubs = vi.hoisted(() => ({
  navigate: vi.fn(),
  cancelSignIn: vi.fn(() => Promise.resolve()),
  flagsResolved: true,
  // Seeded in `beforeEach`, not here: `vi.hoisted` runs before the imports, so
  // touching `DesktopAuthStatus` in this factory is a TDZ error.
  authStatus: "" as string,
  onFlowComplete: undefined as (() => void) | undefined,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: stubs.navigate }),
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: stubs.authStatus },
    cancelSignIn: stubs.cancelSignIn,
  }),
}));

vi.mock("../../../feature-flags/desktop-feature-flag-provider", () => ({
  useDesktopFeatureFlagsResolved: () => stubs.flagsResolved,
}));

// The real flow opens a system browser over IPC. Partial rather than wholesale:
// the gate also imports `SIGN_IN_AUTH_COPY` from here, and that copy is the
// subject of one assertion below — a hand-written stand-in could drift from the
// real thing and the test would still pass.
vi.mock("../desktop-onboarding-flow", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../desktop-onboarding-flow")>();
  return {
    ...actual,
    DesktopOnboardingFlow: ({
      onComplete,
      authCopy,
      footer,
    }: {
      onComplete?: () => void;
      authCopy?: { heading: string };
      footer?: React.ReactNode;
    }) => {
      stubs.onFlowComplete = onComplete;
      return (
        <div data-testid="onboarding-flow">
          <h1>{authCopy?.heading}</h1>
          {footer}
        </div>
      );
    },
  };
});

const HEADLINE = /Stop\s+burning\s+tokens\./;
const APP_SHELL = "app-shell";
const BACK_TO_LANDING = "Back to landing";

function renderGate({ flagOn = true }: { flagOn?: boolean } = {}): void {
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: flagOn ? [DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY] : [],
      })}
    >
      <GuestLandingGate>
        <div data-testid={APP_SHELL} />
      </GuestLandingGate>
    </FeatureFlagAdapterProvider>
  );
}

function shellNode(): HTMLElement | null {
  return screen.queryByTestId(APP_SHELL);
}

beforeEach(() => {
  // No real localStorage in this env, and the first-run flags are the whole
  // subject here — an unbacked store would silently no-op through `readFlag`'s
  // own null guard and every case below would pass for the wrong reason.
  stubLocalStorage();
  stubs.navigate.mockClear();
  stubs.cancelSignIn.mockClear();
  stubs.flagsResolved = true;
  stubs.authStatus = DesktopAuthStatus.SignedOut;
  stubs.onFlowComplete = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GuestLandingGate", () => {
  it("takes over a fresh install when the flag is on", () => {
    renderGate();

    expect(screen.getByRole("heading", { name: HEADLINE })).toBeTruthy();
    // Replacing the shell, not covering it, is the point — an obscured-but-
    // mounted dashboard would arm and burn the one-shot guided tour behind it.
    expect(shellNode()).toBeNull();
  });

  it("holds on the background while the flag snapshot is still in flight", () => {
    // The window is revealed on React mount, but `getAllFlags` is an async IPC
    // round-trip — so the gate used to paint the real shell and then yank it away
    // when the flag landed, making a brand-new user's first frame of the product
    // the app they had not been introduced to yet.
    stubs.flagsResolved = false;

    renderGate();

    expect(shellNode()).toBeNull();
    expect(screen.queryByRole("heading", { name: HEADLINE })).toBeNull();
  });

  it("does not hold an install that has already launched once", () => {
    // The hold is scoped to `firstRun` so it costs exactly one launch per
    // install. Without that scoping every launch would wait on the flag IPC —
    // including every flag-OFF launch, which must stay as it was.
    stubs.flagsResolved = false;
    localStorage.setItem(dashboardOnboardedStorageKey, "1");

    renderGate();

    expect(shellNode()).toBeTruthy();
  });

  it("leaves a fresh install alone when the flag is off", () => {
    renderGate({ flagOn: false });

    expect(shellNode()).toBeTruthy();
    expect(screen.queryByRole("heading", { name: HEADLINE })).toBeNull();
  });

  it("never greets an install that has already completed a first launch", () => {
    // The upgrade case: every existing user carries this key, and none of them
    // should meet a first-run pitch the day the flag is switched on. Nothing in
    // the landing's OWN key would prevent that — they have never written it.
    localStorage.setItem(dashboardOnboardedStorageKey, "1");

    renderGate();

    expect(shellNode()).toBeTruthy();
    expect(screen.queryByRole("heading", { name: HEADLINE })).toBeNull();
  });

  it("routes Get Started to the Dashboard once and then stands aside", () => {
    renderGate();

    fireEvent.click(screen.getByRole("button", { name: "Get Started" }));

    // DEFAULT_NAV_ID is Sessions, so without this the Dashboard — and the guest
    // tour that lives on it — is unreachable on a real first launch.
    expect(stubs.navigate).toHaveBeenCalledWith("/dashboard");
    expect(localStorage.getItem(desktopLandingSeenStorageKey)).toBe("1");
    expect(shellNode()).toBeTruthy();
    expect(screen.queryByRole("heading", { name: HEADLINE })).toBeNull();
  });

  it("runs the real onboarding flow for Sign in and holds the takeover", () => {
    renderGate();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByTestId("onboarding-flow")).toBeTruthy();
    // The framing has to match the door. A returning user who pressed "Already
    // have an account? Sign in" must not be met with an instruction to create
    // the account they already have — which is exactly what the flow's DEFAULT
    // heading says, because its other two hosts really are signing people up.
    expect(
      screen.getByRole("heading", { name: SIGN_IN_AUTH_COPY.heading })
    ).toBeTruthy();
    // The takeover holds: auth leaves `signed_out` the instant the browser
    // opens, and dropping the person into an app they had not chosen to enter
    // while their browser is still mid-OAuth is the failure this guards.
    // `should-show-guest-landing.test.ts` pins that across every in-flight state.
    expect(shellNode()).toBeNull();
  });

  it("cancels the in-flight browser run when the sign-in is backed out of", () => {
    renderGate();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    fireEvent.click(screen.getByRole("button", { name: BACK_TO_LANDING }));

    // Single-flight in the main process: leaving the run open makes the NEXT
    // sign-in fail with "A sign-in is already in progress." and nothing on
    // screen to clear it.
    expect(stubs.cancelSignIn).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: HEADLINE })).toBeTruthy();
  });

  it("stands aside once the sign-in completes, without forcing a route", () => {
    renderGate();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // The real flow fires this from inside React; driving it from the test body
    // needs the same wrapper or the state update never flushes.
    act(() => stubs.onFlowComplete?.());

    expect(shellNode()).toBeTruthy();
    expect(localStorage.getItem(desktopLandingSeenStorageKey)).toBe("1");
    // Only Get Started forces the Dashboard. A signed-in user gets no auto-tour,
    // so there is nothing there for them that DEFAULT_NAV_ID does not already do
    // better.
    expect(stubs.navigate).not.toHaveBeenCalled();
  });
});
