import { assertButtonPresent, waitForText } from "../story-text-assertions";
import { GuestLanding } from "./guest-landing";

const HEADLINE_TEXT = "Stop burning tokens.";
const GET_STARTED_LABEL = "Get Started";
const SIGN_IN_LABEL = "Sign in";

/**
 * ISS-5112 (PLN-1600 Step F): the first screen a new install shows.
 *
 * One state, because the screen has one — a hero with two actions and no data
 * behind it. The fixture exists for what a decision table cannot carry: whether
 * the headline reads as a headline at the window sizes the desktop app actually
 * runs at, and whether the accent lands on one word rather than washing the
 * line.
 *
 * `GuestLandingGate` owns everything conditional — the flag, the first-run
 * storage keys, auth, the sign-in step — and has its own suites. This component
 * takes two callbacks and nothing else, which is what makes it storyable at all.
 */
const meta = {
  title: "Desktop App/Onboarding/Guest Landing",
  component: GuestLanding,
  tags: ["autodocs"],
  argTypes: {
    onGetStarted: { control: false, table: { category: "Events" } },
    onSignIn: { control: false, table: { category: "Events" } },
  },
  parameters: { layout: "fullscreen" },
};

export default meta;

/** First launch, guest mode on, no account yet. */
export const FirstLaunch = {
  args: {
    onGetStarted: () => undefined,
    onSignIn: () => undefined,
  },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitForText(canvasElement, HEADLINE_TEXT);
    assertButtonPresent(canvasElement, GET_STARTED_LABEL);
    // The sign-in link is the one worth pinning. It is the only place in the
    // desktop funnel where signing in is a genuinely different action from the
    // primary CTA, and the note in `account-dialog.tsx` about cutting a sign-in
    // path reads, out of context, like an argument for removing it here too.
    assertButtonPresent(canvasElement, SIGN_IN_LABEL);
  },
};
