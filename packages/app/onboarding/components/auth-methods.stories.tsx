import type { Meta, StoryObj } from "@storybook/react";
import { AuthMethods } from "./auth-methods";

/**
 * The sign-in method chooser itself, shared by desktop onboarding and web
 * sign-in. Every surface that asks "how do you want to sign in?"
 * renders this one component, so its hierarchy is a cross-surface contract:
 * GitHub is the single filled primary, Google is de-emphasized to outline, and
 * email is a secondary Continue (PRD-532 §5.2).
 *
 * ISS-5954: the method set is FIXED — GitHub, Google, and email, always. The
 * per-host `showEmail` opt-out is retired, so the states below differ only by
 * copy and in-flight method, never by which controls exist.
 */
const meta: Meta<typeof AuthMethods> = {
  args: {
    onSelect: () => {
      // Storybook has no auth client; the controls are here to be looked at.
      // A story that resolved a pick would pretend an OAuth round trip happened.
    },
  },
  component: AuthMethods,
  // Matches the hosts, which all clamp this panel to a narrow column.
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-sm py-8">
        <Story />
      </div>
    ),
  ],
  tags: ["deprecated", "autodocs"],
  title: "Composites v1.0/Onboarding/Auth Methods",
};

export default meta;

type Story = StoryObj<typeof AuthMethods>;

/**
 * The full set — the one state every desktop host ships (ISS-5954): the
 * blocking first-launch overlay and the landing's sign-in step both render
 * exactly this.
 */
export const AllThreeMethods: Story = {
  args: {
    emailCtaLabel: "Create account with email",
  },
};

/**
 * A pick in flight. The host owns this via `pendingMethod`: the chosen button
 * spins and EVERY action disables, because the real flow has already handed the
 * user to a system browser and a second pick would race the first.
 */
export const GitHubPending: Story = {
  args: {
    emailCtaLabel: "Create account with email",
    pendingMethod: "github",
  },
};

/** Google's pick in flight — the same disable-everything contract as GitHub. */
export const GooglePending: Story = {
  args: {
    emailCtaLabel: "Create account with email",
    pendingMethod: "google",
  },
};

/** Email's pick in flight, after a real address was typed and submitted. */
export const EmailPending: Story = {
  args: {
    emailCtaLabel: "Create account with email",
    pendingMethod: "email",
  },
};
