import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
import type { ReactNode } from "react";
import {
  type DesktopAuthState,
  DesktopAuthStatus,
} from "../../../shared/contracts";
import { DesktopAuthProvider } from "../../shared-agent-sessions/desktop-auth-provider";
import {
  assertButtonPresent,
  assertTextAbsent,
  waitForText,
} from "../story-text-assertions";
import { SIGN_IN_AUTH_COPY } from "./desktop-onboarding-flow";
import { GuestLandingSignIn } from "./guest-landing-gate";

// Read off the constant rather than re-typed: the story asserts the copy the
// screen actually ships, so rewording SIGN_IN_AUTH_COPY can never leave this
// guard pinning a sentence no host renders any more.
const SIGN_IN_HEADING = SIGN_IN_AUTH_COPY.heading;
const SIGN_IN_BODY = SIGN_IN_AUTH_COPY.body;
const BACK_LABEL = "Back to landing";
const EMAIL_CTA = SIGN_IN_AUTH_COPY.emailCtaLabel;
const GITHUB_CTA = "Continue with GitHub";
const GOOGLE_CTA = "Continue with Google";

const SIGNED_OUT: DesktopAuthState = {
  status: DesktopAuthStatus.SignedOut,
  userId: null,
  organizationId: null,
};

/**
 * ISS-5112 (PLN-1600 Step F) — the landing's "Already have an account? Sign in"
 * door.
 *
 * This is the composition nothing else renders. `account-dialog.stories.tsx`
 * exercises `DesktopOnboardingFlow` only in its default sign-UP wording, and
 * `guest-landing-gate.test.tsx` mocks the flow out entirely (a stub that echoes
 * `authCopy.heading` and the footer), so both the copy override and the layout
 * around it were unrendered anywhere before this fixture: mark over a detached
 * card, the real auth methods, and the ghost Back inside the card rather than
 * floating under it.
 *
 * The REAL flow over a real `DesktopAuthProvider`, with only the preload bridge
 * faked — same approach as the account dialog's stories, so the canvas shows
 * what the packaged app runs rather than a lookalike. `beginDesktopSignIn`
 * never settles, which is the honest fixture: pressing a method in Storybook
 * would otherwise pretend a system-browser OAuth round-trip happened.
 */
const meta = {
  title: "Desktop App/Onboarding/Guest Landing Sign In",
  component: GuestLandingSignIn,
  tags: ["autodocs"],
  argTypes: {
    onBack: { control: false, table: { category: "Events" } },
    onComplete: { control: false, table: { category: "Events" } },
  },
  parameters: {
    layout: "fullscreen",
    /**
     * `DesktopOnboardingFlow` reads the GitHub connection through the shared
     * query hook, so the cache entry is seeded rather than letting the story
     * reach for the network. ISS-5697: the seed rides `parameters.appCore` now
     * that `.storybook/preview.tsx` mounts the app-core harness globally
     * (ISS-5665) — a story that wraps itself in a second `AppCoreStoryProviders`
     * swaps the preview's shared navigation port for a private `org-test` one.
     * Same seed the sibling `account-dialog.stories.tsx` uses, declared on the
     * meta because it does not vary per story here.
     */
    appCore: { queryData: [[githubKeys.status(), null]] },
  },
};

export default meta;

/** The step as a returning user meets it, straight off the landing hero. */
export const SigningIn = {
  render: () => renderSignIn(),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    // The heading and its body are asserted TOGETHER: the defect this override
    // exists to fix was a heading that said "Sign in to Closedloop" over a body
    // that still opened "Sign in to sync your local sessions…" — the same verb
    // twice, and the sign-up pitch underneath the sign-in door. Either one alone
    // would pass while the pair still read wrong.
    await waitForText(canvasElement, SIGN_IN_HEADING);
    await waitForText(canvasElement, SIGN_IN_BODY);
    // ISS-5112: two methods, not three. The email CTA is pinned ABSENT rather
    // than simply dropped from the list, so re-adding it here without also
    // re-adding it to the account dialog fails this story instead of quietly
    // re-splitting the two doors' method sets.
    assertButtonPresent(canvasElement, GITHUB_CTA);
    assertButtonPresent(canvasElement, GOOGLE_CTA);
    assertTextAbsent(canvasElement, EMAIL_CTA);
    // The exit that has to live INSIDE the card, because a full-window step has
    // no Escape, no overlay click and no close.
    assertButtonPresent(canvasElement, BACK_LABEL);
  },
};

function renderSignIn(): ReactNode {
  installDesktopAuthFixture();
  return (
    <DesktopAuthProvider>
      <GuestLandingSignIn
        onBack={() => undefined}
        onComplete={() => undefined}
      />
    </DesktopAuthProvider>
  );
}

function installDesktopAuthFixture(): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      // Never settles: the real one opens the system browser, and a story that
      // resolved it would advance to the setup step and stop being this step.
      beginDesktopSignIn: () => new Promise(() => undefined),
      cancelDesktopSignIn: () => Promise.resolve(),
      getDesktopAuthState: () => Promise.resolve(SIGNED_OUT),
      signOutDesktop: () => Promise.resolve(),
    },
    writable: true,
  });
}
