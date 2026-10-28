import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { UnreachableApiNotice } from "@/app/(authenticated)/components/unreachable-api-notice";

// ISS-11361 Target sidebar, entry 60 of 62: API Unreachable (System state).
// The live authenticated layout returns `UnreachableApiNotice` INSTEAD of the
// shell on a per-deployment preview address (ISS-9797), so there is no
// sidebar here: the notice is the whole document. The props are the ones the
// layout derives: the request's `Host` and `NEXT_PUBLIC_APP_URL`.

/** A per-deployment preview host, the shape `isUnreachableApiPreviewHost` matches. */
const PREVIEW_HOST = "app-closedloop-ai-g7k2p9qx4-closedloop.vercel.app";
const STABLE_APP_URL = "https://app.closedloop.ai";

const meta = {
  title: "Surfaces/System States/API Unreachable",
  tags: ["stable"],
  render: (_args, { parameters }) => (
    <UnreachableApiNotice
      host={PREVIEW_HOST}
      stableAppUrl={
        (parameters.stableAppUrl as string | undefined) ?? STABLE_APP_URL
      }
    />
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** The stable address is elsewhere, so the notice links to it. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("main")).toBeVisible();
    await expect(canvas.getByRole("heading", { level: 1 })).toBeInTheDocument();
    await expect(canvas.getByRole("link")).toHaveAttribute(
      "href",
      STABLE_APP_URL
    );
  },
};

/**
 * The configured app URL is this same preview host, so there is nowhere else
 * to send the reader and the notice offers no link.
 */
export const NoStableAddress: Story = {
  parameters: { stableAppUrl: `https://${PREVIEW_HOST}` },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("main")).toBeVisible();
    await expect(canvas.queryByRole("link")).toBeNull();
  },
};
