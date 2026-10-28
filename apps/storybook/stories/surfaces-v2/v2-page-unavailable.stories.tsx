import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { LabsPageUnavailable } from "../../../desktop/src/renderer/components/labs-gate-surfaces";
import { pageTitleForNav } from "../../../desktop/src/renderer/navigation/nav-config";
import { NavId } from "../../../desktop/src/renderer/navigation/route-table";
import { DesktopPage } from "./test/desktop-page";

// ISS-11361 Target sidebar, entry 62 of 62: Page Unavailable (System state).
// Desktop only: the desktop shell answers a deep link to a Labs destination
// whose gate is closed with `LabsPageUnavailable`
// (`apps/desktop/src/renderer/components/labs-gate-surfaces.tsx`) inside its
// own frame, keeping the destination in the breadcrumb. The destination here
// is Agents, whose `agentsNav` flag is off by default, so the sidebar omits it
// while `#/agents` lands on this panel.

const meta = {
  title: "Surfaces/System States/Page Unavailable",
  tags: ["stable"],
  render: () => (
    <DesktopPage navId={NavId.Agents}>
      <LabsPageUnavailable pageId={NavId.Agents} />
    </DesktopPage>
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
    const title = pageTitleForNav(NavId.Agents);
    await expect(
      (await canvas.findAllByText(title, { exact: false })).length
    ).toBeGreaterThan(0);
    const viewport = within(canvas.getByTestId("desktop-content-viewport"));
    await expect(viewport.getByRole("link")).toBeVisible();
  },
};
