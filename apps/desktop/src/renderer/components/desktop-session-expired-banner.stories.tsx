import type { ReactNode } from "react";
import {
  type DesktopAuthState,
  DesktopAuthStatus,
} from "../../shared/contracts";
import { DesktopAuthProvider } from "../shared-agent-sessions/desktop-auth-provider";
import { DesktopSessionExpiredBanner } from "./desktop-session-expired-banner";

/**
 * ISS-4841: the involuntary-sign-out recovery strip, one story per state.
 *
 * `refresh_failed` is only reachable once a first-party session existed and then
 * stopped renewing, which is not a state you can walk into on purpose. The
 * stories install the narrow auth slice of `window.desktopApi` and mount the
 * REAL `DesktopAuthProvider` over it, so the canvas exercises the same bridge
 * the packaged app does rather than a hand-faked context.
 */
const meta = {
  title: "Composites/App Shell/Desktop Session Expired Banner",
  component: DesktopSessionExpiredBanner,
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

/**
 * The session can no longer be renewed. Every cloud surface has quietly stopped
 * loading, so the strip says so and offers the one control that fixes it.
 */
export const NeedsReauth = {
  render: () =>
    renderScenario({
      caption: "Refresh failed - the recovery prompt with its sign-in action.",
      state: {
        status: DesktopAuthStatus.RefreshFailed,
        userId: null,
        organizationId: null,
      },
    }),
};

/** Signed in and healthy. No strip. */
export const Authenticated = {
  render: () =>
    renderScenario({
      caption: "Authenticated - no banner.",
      state: {
        status: DesktopAuthStatus.Authenticated,
        userId: "user_story",
        organizationId: "org_story",
      },
    }),
};

/**
 * Signed out on purpose. The user chose this, so the recovery prompt would be
 * noise; sign-in lives in Settings instead.
 */
export const SignedOut = {
  render: () =>
    renderScenario({
      caption: "Signed out deliberately - no banner.",
      state: {
        status: DesktopAuthStatus.SignedOut,
        userId: null,
        organizationId: null,
      },
    }),
};

/** Before the first bridge pull resolves. Nothing is known yet, so nothing is claimed. */
export const Loading = {
  render: () =>
    renderScenario({
      caption: "Auth state still loading - no banner.",
      state: {
        status: DesktopAuthStatus.Loading,
        userId: null,
        organizationId: null,
      },
    }),
};

type SessionExpiredScenario = {
  /** What this story is showing, for the reader of the canvas. */
  caption: string;
  /**
   * The main-process auth snapshot the bridge resolves — the REAL contract, not
   * a widened local copy (wongk review). A local `{ status: string }` let a typo
   * or a renamed status compile and silently exercise the hidden no-banner
   * branch; `DesktopAuthState` closes `status` to `DesktopAuthStatus`, so an
   * invalid state fails typecheck at the story instead.
   */
  state: DesktopAuthState;
};

function installDesktopAuthFixture(state: SessionExpiredScenario["state"]) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      beginDesktopSignIn: () =>
        // Never resolves: parks the story on the in-flight "signing in" view so
        // the pending copy and its Cancel control are inspectable from the
        // NeedsReauth story instead of flashing past.
        new Promise(() => undefined),
      cancelDesktopSignIn: () => Promise.resolve(),
      getDesktopAuthState: () => Promise.resolve(state),
      signOutDesktop: () => Promise.resolve(),
    },
    writable: true,
  });
}

function renderScenario({ caption, state }: SessionExpiredScenario): ReactNode {
  installDesktopAuthFixture(state);
  return (
    <DesktopAuthProvider>
      <div className="flex flex-col">
        <DesktopSessionExpiredBanner />
        <p className="px-4 py-3 text-muted-foreground text-sm">{caption}</p>
      </div>
    </DesktopAuthProvider>
  );
}
