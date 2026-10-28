import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { OnboardingStatusUnavailable } from "./onboarding-status-unavailable";

/**
 * The ISS-7828 recoverable state: the onboarding status could not be loaded and
 * there is no earlier answer to fall back on.
 *
 * The card has no placement of its own, so the stories render it in both of
 * its mounts: centered in the authenticated shell's content region (as the
 * onboarding guard places it, matching `WorkspaceAuthGuard`), and at the top
 * of the `/onboarding` layout column, where the wizard would start.
 *
 * The pair worth comparing is Default versus Retrying: while a retry is in
 * flight the button reads as busy and ignores clicks, so a second click cannot
 * stack a second request on a slow one, but it keeps keyboard focus.
 */
const meta: Meta<typeof OnboardingStatusUnavailable> = {
  args: {
    onRetry: () => {
      // Storybook has no status query; the control is here to be looked at.
    },
  },
  component: OnboardingStatusUnavailable,
  tags: ["deprecated", "autodocs"],
  title: "Composites v1.0/Onboarding/Onboarding Status Unavailable",
};

export default meta;

type Story = StoryObj<typeof OnboardingStatusUnavailable>;

/** Terminal failure in the shell's content region, nothing in flight. */
export const Default: Story = {
  args: {
    retrying: false,
  },
  decorators: [inShellContentRegion],
};

/** The user pressed Retry and the refetch has not settled yet. */
export const Retrying: Story = {
  args: {
    retrying: true,
  },
  decorators: [inShellContentRegion],
};

/** The same failure on `/onboarding`, placed where the wizard would render. */
export const OnOnboardingPage: Story = {
  args: {
    retrying: false,
  },
  decorators: [inOnboardingLayoutColumn],
};

/** Mirrors the onboarding guard's wrapper inside the shell's content region. */
function inShellContentRegion(
  ...[Story]: Parameters<Decorator>
): ReturnType<Decorator> {
  return (
    <div className="flex h-96 w-full flex-col">
      <div className="flex h-full flex-1 items-center justify-center p-6">
        <Story />
      </div>
    </div>
  );
}

/** Mirrors the `(onboarding)` layout column the page renders into. */
function inOnboardingLayoutColumn(
  ...[Story]: Parameters<Decorator>
): ReturnType<Decorator> {
  return (
    <div className="flex h-96 w-full flex-col items-center px-4 pt-24">
      <Story />
    </div>
  );
}
