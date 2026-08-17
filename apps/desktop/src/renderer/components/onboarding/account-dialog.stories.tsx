import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
import type { ReactNode } from "react";
import { useState } from "react";
import {
  type DesktopAuthState,
  DesktopAuthStatus,
} from "../../../shared/contracts";
import { DesktopAuthProvider } from "../../shared-agent-sessions/desktop-auth-provider";
import { AccountDialog } from "./account-dialog";
import { GuestSignupIntent } from "./guest-signup-provider";

/**
 * ISS-5112: the states a guest can be looking at when the first-launch tour
 * ends — the offer, the sign-in methods behind it, and both of the setup steps
 * a completed sign-in can land on.
 *
 * Every scenario mounts the actual `DesktopOnboardingFlow` over the REAL
 * `DesktopAuthProvider`, with only the preload bridge faked, so the canvas shows
 * the flow the packaged app runs rather than a lookalike.
 */
const meta = {
  title: "Desktop/Onboarding/Account Dialog",
  component: AccountDialog,
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

/** What a guest sees the moment the tour finishes. */
export const Offer = {
  parameters: githubStatusParameters(false),
  render: () =>
    renderScenario({
      caption:
        "The offer, with 'Not now' as a real answer. Reopen it from the button behind.",
    }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const primary = await waitForControl(canvasElement, SIGN_UP_LABEL);
    assertCloseControlPinned(primary);
  },
};

/**
 * After "Sign Up". ISS-5489 removed the in-dialog provider step: the web page
 * asks which provider, so pressing the primary opens the system browser and the
 * dialog holds a pending state until that round-trip resolves.
 */
export const SigningUp = {
  parameters: githubStatusParameters(false),
  render: () =>
    renderScenario({
      caption:
        "Sign Up pressed: the browser handoff is in flight and the dialog waits, still closable.",
    }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    clickControl(canvasElement, SIGN_UP_LABEL);
    // The pending primary IS the observable handoff — the story would pass
    // without this if the click did nothing at all.
    await waitForDisabledControl(canvasElement, SIGN_UP_PENDING_LABEL);
  },
};

/*
 * `SetupStep` and `SyncConsentStep` used to live here. Both drove states this
 * dialog can no longer reach: ISS-5489 stopped it mounting DesktopOnboardingFlow,
 * so the connect-GitHub grant and the sync-consent tiers are not on any
 * AccountDialog path. Their `assertCloseControlPinned` check went with them
 * because the tall content it guarded against is gone too; the surviving
 * structural assertion is `assertPanelIsSingleSurface` below.
 */

/**
 * The same dialog, asked from the invite item instead of the tour.
 *
 * The offer's copy is chosen by the intent that opened it, so this is the case
 * that proves someone who pressed "Invite your team" is not met with a generic
 * account pitch that never mentions a team. Nothing else about the dialog
 * changes.
 */
export const InviteOffer = {
  parameters: githubStatusParameters(false),
  render: () =>
    renderScenario({
      caption:
        "Asked from the invite item: the offer leads with the team, not a generic account pitch.",
      intent: GuestSignupIntent.Invite,
    }),
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => {
    assertTextPresent(canvasElement, INVITE_EYEBROW);
    assertTextPresent(canvasElement, INVITE_TITLE);
  },
};

/**
 * The organization ask, which SKIPS the offer entirely.
 *
 * The in-place gate on the dashboard already named the view, the value and the
 * price before its button was pressed, so following it with a dialog making the
 * same argument would ask the same question two screens running. This story is
 * the one that fails if `skipsOffer` stops covering this intent: the flow is on
 * screen immediately, and the offer's own decline control never rendered.
 */
export const OrganizationSkipsOffer = {
  parameters: githubStatusParameters(false),
  render: () =>
    renderScenario({
      caption:
        "Asked from the organization gate: straight to the browser, no second pitch.",
      intent: GuestSignupIntent.Organization,
    }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    // No click first — that is the whole assertion.
    await waitForText(canvasElement, OPENING_BROWSER_COPY);
    if (findControl(canvasElement, SIGN_UP_LABEL)) {
      throw new Error(
        `The offer step rendered for an intent that should skip it ("${SIGN_UP_LABEL}" is present)`
      );
    }
  },
};

const SIGN_UP_LABEL = "Sign Up";
const SIGN_UP_PENDING_LABEL = "Opening browser…";
const OPENING_BROWSER_COPY = "Opening your browser to finish signing up.";
const INVITE_EYEBROW = "Bring your team";
const INVITE_TITLE = "Invite your team";
const CONTROL_POLL_ATTEMPTS = 100;
const CONTROL_POLL_INTERVAL_MS = 10;
/**
 * The classes on the dialog's inner scroller, from `account-dialog.tsx`.
 *
 * `pt-2` is load-bearing, not padding taste: Radix's close control sits 16px
 * down and is 16px tall, and the panel's own `p-6` only accounts for 24 of the
 * 32px that clears it — without the inset, consent tiers scroll under the X.
 */
const SCROLL_CONTAINER_CLASSES = [
  "max-h-[75vh]",
  "overflow-y-auto",
  "pt-2",
] as const;

const SIGNED_OUT: DesktopAuthState = {
  status: DesktopAuthStatus.SignedOut,
  userId: null,
  organizationId: null,
};

const AUTHENTICATED: DesktopAuthState = {
  status: DesktopAuthStatus.Authenticated,
  userId: "user_story",
  organizationId: "org_story",
};

type Scenario = {
  caption: string;
  /**
   * What `beginDesktopSignIn` resolves with. Omitted, it never resolves —
   * parking a story on the in-flight state instead of flashing past it.
   */
  signInResult?: { ok: true };
  authState?: DesktopAuthState;
  /**
   * Seeded into the shared GitHub-status cache, which is what decides which of
   * the two mutually exclusive setup steps the flow renders. Defaults to false —
   * the required grant.
   */
  /**
   * Which surface is asking. Drives the offer's copy, and whether the offer is
   * shown at all. Defaults to the standing header offer, as the component does.
   */
  intent?: GuestSignupIntent;
};

function installDesktopAuthFixture(scenario: Scenario): void {
  const state = scenario.authState ?? SIGNED_OUT;
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      beginDesktopSignIn: () =>
        scenario.signInResult
          ? Promise.resolve(scenario.signInResult)
          : new Promise(() => undefined),
      cancelDesktopSignIn: () => Promise.resolve(),
      getDesktopAuthState: () => Promise.resolve(state),
      signOutDesktop: () => Promise.resolve(),
    },
    writable: true,
  });
}

/**
 * Controlled the way the dashboard controls it, so "Not now", Escape, and the
 * close control all really close — and the canvas has a way back.
 */
function AccountDialogHarness({
  caption,
  intent,
}: {
  caption: string;
  intent?: GuestSignupIntent;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col gap-3 p-6">
      <Button onClick={() => setOpen(true)} variant="outline">
        Open account dialog
      </Button>
      <p className="text-muted-foreground text-sm">{caption}</p>
      <AccountDialog intent={intent} onOpenChange={setOpen} open={open} />
    </div>
  );
}

function renderScenario(scenario: Scenario): ReactNode {
  installDesktopAuthFixture(scenario);
  return (
    <DesktopAuthProvider>
      <AccountDialogHarness
        caption={scenario.caption}
        intent={scenario.intent}
      />
    </DesktopAuthProvider>
  );
}

/**
 * The setup step reads the GitHub connection through the shared query hook, so
 * the story seeds that cache entry rather than letting the story reach for the
 * network. ISS-5697: the seed rides `parameters.appCore` now that
 * `.storybook/preview.tsx` mounts the app-core harness globally (ISS-5665); the
 * harness still holds the query client at `staleTime: Infinity`, so a seeded
 * entry is never refetched. Built here rather than spelled out per story so the
 * cache key has one source.
 */
function githubStatusParameters(connected: boolean) {
  return {
    appCore: { queryData: [[githubKeys.status(), { connected }]] },
  };
}

/**
 * The dialog renders through a portal, so its controls are siblings of the story
 * canvas rather than descendants — hence the document-wide lookup.
 *
 * Driven with native clicks and a bounded poll instead of `storybook/test`:
 * `apps/desktop` does not depend on the Storybook packages (none of its stories
 * import them), and adding one for a story would be the wrong trade.
 */
function findControl(root: HTMLElement, label: string): HTMLElement | null {
  const buttons =
    root.ownerDocument.body.querySelectorAll<HTMLElement>("button");
  for (const button of buttons) {
    if (button.textContent?.trim() === label) {
      return button;
    }
  }
  return null;
}

function clickControl(root: HTMLElement, label: string): void {
  const control = findControl(root, label);
  if (!control) {
    throw new Error(`Expected a "${label}" control in the account dialog`);
  }
  control.click();
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
  throw new Error(`"${label}" never appeared in the account dialog`);
}

/** Poll until a control with `label` is present AND disabled. */
async function waitForDisabledControl(
  root: HTMLElement,
  label: string
): Promise<HTMLElement> {
  for (let attempt = 0; attempt < CONTROL_POLL_ATTEMPTS; attempt++) {
    const control = findControl(root, label);
    if (control?.hasAttribute("disabled")) {
      return control;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, CONTROL_POLL_INTERVAL_MS);
    });
  }
  throw new Error(`"${label}" never became a pending control`);
}

/** Poll until `text` appears anywhere in the portalled dialog. */
async function waitForText(root: HTMLElement, text: string): Promise<void> {
  for (let attempt = 0; attempt < CONTROL_POLL_ATTEMPTS; attempt++) {
    if (root.ownerDocument.body.textContent?.includes(text)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, CONTROL_POLL_INTERVAL_MS);
    });
  }
  throw new Error(`"${text}" never appeared in the account dialog`);
}

/**
 * The dialog portals outside the canvas, so this scans the document the same
 * way {@link findControl} does.
 */
function assertTextPresent(root: HTMLElement, text: string): void {
  if (!root.ownerDocument.body.textContent?.includes(text)) {
    throw new Error(`Expected "${text}" in the account dialog`);
  }
}

function findScrollContainer(panel: HTMLElement): HTMLElement | null {
  const candidates = panel.querySelectorAll<HTMLElement>("div");
  for (const candidate of candidates) {
    if (
      SCROLL_CONTAINER_CLASSES.every((name) =>
        candidate.classList.contains(name)
      )
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * The panel scrolls; its close control does not.
 *
 * The canvas is where you SEE that — the tiers overflow, the X stays put. What
 * this adds is the structure underneath it, because the sweep that plays this
 * story runs in jsdom, which lays nothing out and would report every height as
 * zero. So it pins the arrangement that makes the visible behavior true: the
 * overflow container sits INSIDE the dialog panel and holds the tall content,
 * and Radix's absolutely-positioned close control sits outside it. Putting the
 * scroll back on `DialogContent` — the regression the design review caught —
 * makes that control a scrolling child again, and fails here.
 */
function assertCloseControlPinned(content: HTMLElement): void {
  const panel = content.closest<HTMLElement>('[data-slot="dialog-content"]');
  if (!panel) {
    throw new Error("The dialog content is not inside a dialog panel");
  }
  const close = panel.querySelector<HTMLElement>('[data-slot="dialog-close"]');
  if (!close) {
    throw new Error("The dialog panel has no close control");
  }
  const scroller = findScrollContainer(panel);
  if (!scroller) {
    throw new Error(
      `No ${SCROLL_CONTAINER_CLASSES.join(" ")} container inside the dialog panel`
    );
  }
  if (!scroller.contains(content)) {
    throw new Error("The dialog content is outside the panel's scroll region");
  }
  if (scroller.contains(close)) {
    throw new Error(
      "The dialog's close control scrolls away with the panel content"
    );
  }
}
