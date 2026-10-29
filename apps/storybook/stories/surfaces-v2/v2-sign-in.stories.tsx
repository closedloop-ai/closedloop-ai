import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import SignInPage from "@/app/(unauthenticated)/sign-in/[[...sign-in]]/page";
import { AuthPage, withClerkState } from "./auth-page";

// ISS-11361 Target sidebar: Sign In (Sign-in & connect flow).
// The live `/sign-in` route (`apps/app/app/(unauthenticated)/sign-in/...`):
// Clerk's `<SignIn>` embed inside the live two-pane auth layout. Storybook
// has no Clerk, so the embed is the stand-in's labelled region; everything
// around it is the live layout.

const meta = {
  title: "Surfaces/Sign In/Sign In",
  tags: ["stable"],
  render: () => (
    <AuthPage>
      <SignInPage />
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
        Boolean(element?.matches('[data-clerk-hosted="SignIn"]'))
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
