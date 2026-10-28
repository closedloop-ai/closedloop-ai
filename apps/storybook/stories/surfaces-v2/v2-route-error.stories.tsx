import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import AuthenticatedErrorBoundary from "@/app/(authenticated)/error";
import { liveAppShellRoutes } from "./fixtures/live-app-fixtures";
import { LivePage } from "./live-page";
import { expectActiveNavItem } from "./live-route";

// ISS-11361 Target sidebar, entry 59 of 62: Route Error (System state).
// The live error boundary of the authenticated segment
// (`apps/app/app/(authenticated)/error.tsx`, which renders `app/error.tsx`'s
// AppError) in the shell's content column: a page that threw keeps the
// sidebar, and the nav item of the page that threw stays active.
//
// `app/global-error.tsx` (the boundary that replaces the root layout) has no
// story: it imports `@repo/design-system/lib/fonts`, whose Geist fonts load
// through `next/font/local`, which Storybook's Vite build cannot bundle.

const ROUTE_ERROR = new Error("Dashboard render failed");

function retryNoop() {
  // A story has no route segment to re-render.
}

const meta = {
  title: "Surfaces/System States/Route Error",
  tags: ["stable"],
  render: () => (
    <LivePage activePath="/dashboard">
      <AuthenticatedErrorBoundary error={ROUTE_ERROR} reset={retryNoop} />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { apiRoutes: liveAppShellRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { level: 1 })
    ).toBeVisible();
    await expectActiveNavItem(canvas, "Dashboard");
  },
};
