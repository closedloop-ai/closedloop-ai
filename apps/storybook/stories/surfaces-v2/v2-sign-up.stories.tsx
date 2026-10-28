import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { SignUpPageContent } from "@/app/(unauthenticated)/sign-up/sign-up-page-content";
import { AuthPage, withClerkState } from "./auth-page";

// ISS-11361 Target sidebar: Sign Up (Sign-in & connect flow).
// The live `/sign-up` route's synchronous content (cookie loading stays server-side),
// where a signed-out visitor lands by default (FEA-632): Clerk's `<SignUp>` embed inside the live two-pane auth layout. Storybook
// has no Clerk, so the embed is the stand-in's labelled region; everything
// around it is the live layout.

const meta = {
  title: "Surfaces/Sign In/Sign Up",
  tags: ["stable"],
  render: () => (
    <AuthPage>
      <SignUpPageContent browserRun={null} />
    </AuthPage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("main")).toBeVisible();
    await expect(
      await canvas.findByText((_, element) =>
        Boolean(element?.matches('[data-clerk-hosted="SignUp"]'))
      )
    ).toBeInTheDocument();
  },
};

/** Clerk failed to load: the layout's notice replaces the embed. */
export const ClerkLoadFailed: Story = {
  decorators: [withClerkState({ status: "error" })],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toBeVisible();
  },
};

/** Below the `lg` breakpoint the showcase pane drops away. */
export const Narrow: Story = {
  globals: { viewport: { value: "tablet", isRotated: false } },
};
