import { DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/diagnostics-complete-surface-flag";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import DiagnosticsPage from "@/app/(authenticated)/[orgSlug]/diagnostics/page";
import { DIAGNOSTICS_ROUTE_TITLE } from "@/app/(authenticated)/[orgSlug]/diagnostics/web-diagnostics-contract";
import { liveAppShellRoutes } from "./fixtures/live-app-fixtures";
import { LivePage } from "./live-page";

// ISS-11361 Target sidebar: Diagnostics (Workspace menu).
// The live route's own page (`apps/app/.../diagnostics/page.tsx`: the
// `diagnostics-complete-surface` route gate, Header and
// `WebDiagnosticsSurfaceHost`) in the app frame, with the gate open. The web
// host has no local runtime to probe, so it always hands the surface the same
// unavailable source: this one story is every state the web page reaches.
// The probe states (loading, ready, failed, per-section) exist only in the
// desktop host and are covered by the surface's own stories.

const meta = {
  title: "Surfaces/Workspace Menu/Diagnostics",
  tags: ["stable"],
  render: () => (
    <LivePage activePath="/diagnostics">
      <DiagnosticsPage />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: {
      apiRoutes: liveAppShellRoutes,
      enabledFlags: [DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY],
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      (
        await canvas.findAllByRole("heading", {
          name: DIAGNOSTICS_ROUTE_TITLE,
        })
      ).length
    ).toBeGreaterThan(0);
  },
};

/** The Gateway Logs tab, the last of the section tabs. */
export const GatewayLogsTab: Story = {
  play: async ({ canvasElement }) => {
    const tabs = await within(canvasElement).findAllByRole("tab");
    const last = tabs.at(-1);
    if (last) {
      await userEvent.click(last);
    }
  },
};
