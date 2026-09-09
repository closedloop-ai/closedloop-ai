import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { AuthMethods } from "./auth-methods";

/**
 * The three methods the panel can offer, plus `null` for "nothing in flight".
 * Copied from the `AuthMethod` union in `./auth-methods`, which ships no
 * companion array to import.
 */
const PENDING_METHOD_OPTIONS = [null, "github", "google", "email"] as const;

/** The native `method` values a host adapter can hand the email form. */
const NATIVE_METHOD_OPTIONS = ["get", "post", "dialog"] as const;

/**
 * The sign-in method chooser itself, shared by desktop onboarding, web sign-in,
 * and Settings → Account. Every surface that asks "how do you want to sign in?"
 * renders this one component, so its hierarchy is a cross-surface contract:
 * GitHub is the single filled primary, Google is de-emphasized to outline, and
 * email is a secondary Continue (PRD-532 §5.2).
 *
 * Worth seeing as a matrix because the states differ by which controls EXIST,
 * not by copy, and each one is owned by a different host. Nothing else renders
 * the two-method form in isolation: the composed stories that mount it
 * (`account-dialog`, `guest-landing-sign-in`) both go through
 * `DesktopOnboardingFlow` with `showEmail={false}`, so before this file the
 * default three-method state — the one `desktop-account-tab` and the
 * first-launch overlay actually ship — appeared in no story at all.
 */
const meta: Meta<typeof AuthMethods> = {
  args: {
    emailCtaLabel: "Continue with email",
    // Storybook has no auth client; the controls are here to be looked at.
    // A story that resolved a pick would pretend an OAuth round trip happened.
    onSelect: fn(),
    pendingMethod: null,
    showEmail: true,
  },
  argTypes: {
    emailCtaLabel: { control: "text" },
    nativeMethod: {
      control: { type: "radio" },
      options: NATIVE_METHOD_OPTIONS,
    },
    onSelect: { control: false, table: { category: "Events" } },
    pendingMethod: {
      control: { type: "radio" },
      options: PENDING_METHOD_OPTIONS,
    },
    showEmail: { control: "boolean" },
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
  tags: ["autodocs"],
  title: "App Core/Onboarding/Auth Methods",
};

export default meta;

type Story = StoryObj<typeof AuthMethods>;

/**
 * The full set, and the default every host gets unless it opts out. This is
 * what `desktop-account-tab` renders to a signed-out user and what the blocking
 * first-launch overlay still offers.
 */
export const AllThreeMethods: Story = {
  args: {
    emailCtaLabel: "Create account with email",
    showEmail: true,
  },
};

/**
 * ISS-5112: the two doors into the loopback OAuth flow — the landing's sign-in
 * step and the post-tour account dialog — offer GitHub and Google only, matching
 * the `pre-auth-desktop-onboarding` prototype.
 *
 * Paired with {@link AllThreeMethods} on purpose. Hiding the email form removes
 * a real capability from those screens, so the difference is a host decision to
 * look at deliberately, not a default to drift into.
 */
export const TwoMethodsNoEmail: Story = {
  args: {
    showEmail: false,
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
    showEmail: true,
  },
};

/** The same in-flight rule on the trimmed set: no second door while one is open. */
export const GooglePendingWithoutEmail: Story = {
  args: {
    pendingMethod: "google",
    showEmail: false,
  },
};
