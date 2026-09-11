import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { SessionsSignInIndicator } from "./sessions-sign-in-indicator";

// ISS-5451: the signed-out affordance for cloud-only Sessions KPI cards.
// FEA-3574. The CTA is surface-injected: the desktop shell passes its browser
// OAuth `beginSignIn` IPC, and a surface with no sign-in action omits the
// handler — so {@link InformationalOnly} is a real production state, not a
// degenerate one, and it needs to still read as an explanation rather than a
// broken button.
// {@link WithSignInError} is the state FEA-3574's review added: a failed
// `beginSignIn` must not leave the card silently unchanged, so the error renders
// in the destructive tone and the CTA stands as the retry.
// FEA-4037 added {@link Banner} — one horizontal ask above the whole KPI row
// instead of a per-card caption. Its copy is deliberately different (it names
// the ask once and lets the card labels below do the naming), so the two
// variants are shown together to keep that distinction visible.
/**
 * The card shown in place of a metric when you are not signed in to a cloud
 * session, explaining why the number is missing and offering a sign in
 * button.
 */
const meta = {
  title: "Primitives/Feedback & Status/Sessions Sign In Indicator",
  component: SessionsSignInIndicator,
  tags: ["autodocs"],
  argTypes: {
    banner: {
      control: "boolean",
      description:
        "Render the one horizontal ask above the whole KPI row instead of the per-card caption.",
    },
    signInError: {
      control: "text",
      description:
        "Copy from the last failed attempt. Renders in the destructive tone with the CTA as the retry.",
    },
    onSignIn: {
      control: false,
      table: { category: "Events" },
      description:
        "Surface-injected sign-in action. Omit it and the affordance degrades to informational copy.",
    },
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-full max-w-xl">
        <Story />
      </div>
    ),
  ],
  args: { banner: false, onSignIn: fn(), signInError: null },
} satisfies Meta<typeof SessionsSignInIndicator>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The compact per-card affordance with a live CTA. */
export const Default: Story = {};

/**
 * A surface with no sign-in action (the web Sessions page is already
 * authenticated). The affordance degrades to informational copy only.
 */
export const InformationalOnly: Story = {
  args: { onSignIn: undefined },
};

/** A failed sign-in attempt. The CTA stands as the retry. */
export const WithSignInError: Story = {
  args: { signInError: "Couldn't reach the sign-in service. Try again." },
};

/** FEA-4037: the single banner ask above the delivery KPI row. */
export const Banner: Story = {
  args: { banner: true },
};

/** The banner carrying a retryable error. */
export const BannerWithError: Story = {
  args: { banner: true, signInError: "Sign-in was cancelled." },
};
