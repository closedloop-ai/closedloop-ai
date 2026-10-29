import type { ReactNode } from "react";
import {
  type DesktopAuthState,
  DesktopAuthStatus,
} from "../../shared/contracts";
import { DesktopAuthProvider } from "../shared-agent-sessions/desktop-auth-provider";
import type { DesktopExistingUserResolution } from "../types/desktop-api";
import { DesktopSyncPrompt } from "./desktop-sync-prompt";

/**
 * FEA-2219 / PRD-532 §8 (M6): the non-blocking, one-time "Sign in with GitHub
 * to sync" prompt for an existing user — an `sk_live_*` API key with no
 * first-party desktop session yet.
 *
 * The main process derives `{ kind, dismissed }` from live auth status +
 * API-key presence, so the stories install the narrow `window.desktopApi`
 * slice that resolution rides on and mount the REAL `DesktopAuthProvider`
 * over it, matching `desktop-session-expired-banner.stories.tsx`'s fixture
 * pattern in this directory.
 */
const meta = {
  title: "Composites v1.0/Desktop Shell/Desktop Sync Prompt",
  tags: ["deprecated"],
  component: DesktopSyncPrompt,
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

const SIGN_IN_LABEL = "Sign in with GitHub";
const SIGNING_IN_COPY = "Opening your browser to sign in…";
const CONTROL_POLL_ATTEMPTS = 100;
const CONTROL_POLL_INTERVAL_MS = 10;

/** No API key with no session, or the main-process bridge is absent. Nothing renders. */
export const Hidden = {
  render: () =>
    renderScenario({
      caption: "Resolution is `none` - no prompt.",
      resolution: { kind: "none", dismissed: false },
    }),
};

/**
 * An `sk_live_*` API key with no first-party session — the one state this
 * prompt exists for. Local access already works either way; this only offers
 * to sync the device to the account.
 */
export const SignInPrompt = {
  render: () =>
    renderScenario({
      caption:
        "Resolution is `prompt`, not dismissed - the sync offer with its Sign in and Not now controls.",
      resolution: { kind: "prompt", dismissed: false },
    }),
};

/**
 * "Sign in with GitHub" pressed: the system-browser handoff is in flight.
 * `beginDesktopSignIn` never resolves in this story, which is what parks the
 * canvas on the pending copy instead of it flashing past.
 */
export const SigningIn = {
  render: () =>
    renderScenario({
      caption: "Mid sign-in: the browser handoff copy, controls disabled.",
      resolution: { kind: "prompt", dismissed: false },
    }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const control = await waitForControl(canvasElement, SIGN_IN_LABEL);
    control.click();
    await waitForText(canvasElement, SIGNING_IN_COPY);
  },
};

type SyncPromptScenario = {
  /** What this story is showing, for the reader of the canvas. */
  caption: string;
  resolution: DesktopExistingUserResolution;
};

/**
 * The resolution prompt is reachable whether the desktop auth session is
 * signed out (a bare API key, no session) or authenticated (a session that
 * predates this device's key). Either way `beginSignIn` is what the prompt's
 * button calls, so a fixed signed-out state is enough to exercise it here.
 */
const SIGNED_OUT: DesktopAuthState = {
  status: DesktopAuthStatus.SignedOut,
  userId: null,
  organizationId: null,
};

function installDesktopApiFixture(
  resolution: DesktopExistingUserResolution
): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      beginDesktopSignIn: () =>
        // Never resolves: keeps the story parked on the "Opening your
        // browser…" pending view instead of flashing past it.
        new Promise(() => undefined),
      cancelDesktopSignIn: () => Promise.resolve(),
      dismissExistingUserPrompt: () => Promise.resolve(),
      getDesktopAuthState: () => Promise.resolve(SIGNED_OUT),
      getExistingUserResolution: () => Promise.resolve(resolution),
      // No live push in these stories: the resolution is fixed for the
      // scenario's lifetime, so the store's initial pull is all it needs.
      onExistingUserResolutionChanged: () => () => undefined,
      signOutDesktop: () => Promise.resolve(),
    },
    writable: true,
  });
}

function renderScenario({
  caption,
  resolution,
}: SyncPromptScenario): ReactNode {
  installDesktopApiFixture(resolution);
  return (
    <DesktopAuthProvider>
      <div className="flex flex-col">
        <DesktopSyncPrompt />
        <p className="px-4 py-3 text-muted-foreground text-sm">{caption}</p>
      </div>
    </DesktopAuthProvider>
  );
}

function findControl(root: HTMLElement, label: string): HTMLElement | null {
  const buttons = root.querySelectorAll<HTMLElement>("button");
  for (const button of buttons) {
    if (button.textContent?.trim() === label) {
      return button;
    }
  }
  return null;
}

async function waitForControl(
  root: HTMLElement,
  label: string
): Promise<HTMLElement> {
  for (let attempt = 0; attempt < CONTROL_POLL_ATTEMPTS; attempt++) {
    const control = findControl(root, label);
    if (control) {
      return control;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, CONTROL_POLL_INTERVAL_MS);
    });
  }
  throw new Error(`"${label}" never appeared in the sync prompt`);
}

async function waitForText(root: HTMLElement, text: string): Promise<void> {
  for (let attempt = 0; attempt < CONTROL_POLL_ATTEMPTS; attempt++) {
    if (root.textContent?.includes(text)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, CONTROL_POLL_INTERVAL_MS);
    });
  }
  throw new Error(`"${text}" never appeared in the sync prompt`);
}
