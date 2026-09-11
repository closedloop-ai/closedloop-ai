import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import { AuthTransitionPanel } from "./auth-transition-panel";

// Every state here is reachable in the signed-out desktop connect flow
// (PLN-1526). They are worth seeing side by side because the failure states are
// the ones a user is actually stuck on, and they are the easiest to leave
// half-designed — the flow reaches them only when something has already broken.
// Note the 400ms reveal hold: each story renders empty for that long before it
// fades in. That is the production behavior, not a loading artifact, and it is
// why on a healthy hop most users never see these screens at all.
/**
 * A brief moving you screen shown while the desktop app hands off to GitHub
 * or Google sign in, staying invisible unless the hop actually takes a
 * moment.
 */
const meta: Meta<typeof AuthTransitionPanel> = {
  args: {
    busy: false,
    title: "Taking you to GitHub",
  },
  argTypes: {
    // A recovery affordance rendered as-is. An edited node would not survive
    // the round trip through the controls panel.
    action: { control: false },
    busy: { control: "boolean" },
    description: { control: "text" },
    // Omitted deliberately from `args`: a transition that is not
    // provider-specific renders no mark, and TitleOnly is exactly that case.
    provider: {
      control: { type: "radio" },
      options: Object.values(DesktopSignInProvider),
    },
    title: { control: "text" },
  },
  component: AuthTransitionPanel,
  // Matches the `(unauthenticated)` layout, which clamps children to max-w-sm.
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-sm py-8">
        <Story />
      </div>
    ),
  ],
  tags: ["autodocs"],
  title: "Composites/Onboarding/Auth Transition Panel",
};

export default meta;

type Story = StoryObj<typeof AuthTransitionPanel>;

/** `/connect/github` while `signIn.sso()` hands the browser to GitHub. */
export const Redirecting: Story = {
  args: {
    busy: true,
    provider: DesktopSignInProvider.GitHub,
    title: "Taking you to GitHub",
  },
};

/**
 * The same hop for the other provider (ISS-5112). Same panel, same copy shape —
 * only the mark and the name change, which is the point of the provider prop.
 */
export const RedirectingToGoogle: Story = {
  args: {
    busy: true,
    provider: DesktopSignInProvider.Google,
    title: "Taking you to Google",
  },
};

/** `/sso-callback` while Clerk completes the handshake. */
export const FinishingSignIn: Story = {
  args: {
    busy: true,
    provider: DesktopSignInProvider.GitHub,
    title: "Finishing sign-in",
  },
};

/**
 * The failure state, after the 10s ceiling on either route. It keeps the GitHub
 * mark: the user pressed "Connect to GitHub" in a different app, so dropping
 * the mark here both loses the continuity cue and shifts the block upward at
 * the exact moment the copy changes.
 */
export const CouldNotOpenGitHub: Story = {
  args: {
    action: (
      <Button asChild className="w-full">
        <a href="/sign-in">Continue to sign in</a>
      </Button>
    ),
    description:
      "Your desktop app is still waiting. Sign in and pick GitHub to finish connecting.",
    provider: DesktopSignInProvider.GitHub,
    title: "We couldn't open GitHub",
  },
};

/** Copy only — no spinner, no mark, no recovery affordance. */
export const TitleOnly: Story = {
  args: { title: "Returning to desktop" },
};
