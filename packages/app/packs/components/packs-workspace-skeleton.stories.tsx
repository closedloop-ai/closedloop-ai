import type { Meta, StoryObj } from "@storybook/react";
import { PacksWorkspaceSkeleton } from "./packs-workspace-skeleton";

const meta = {
  title: "App Core/Packs/Packs Workspace Skeleton",
  component: PacksWorkspaceSkeleton,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  argTypes: {
    cardCount: { control: { type: "number", min: 0, max: 24, step: 1 } },
    header: { control: false },
    showTeamLayout: { control: "boolean" },
  },
  args: {
    cardCount: 6,
    showTeamLayout: true,
  },
} satisfies Meta<typeof PacksWorkspaceSkeleton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Single-column surface (e.g. DesktopSolo): no team rail, cards fill the width. */
export const SingleColumn: Story = {
  args: { showTeamLayout: false },
};

/** With the surface's known-ahead-of-fetch heading rendered for real above the
 *  placeholders, matching the loaded workspace's toolbar slot. */
export const WithHeader: Story = {
  args: {
    header: (
      <div>
        <h2 className="font-semibold text-lg">Plugins</h2>
        <p className="text-muted-foreground text-sm">
          Browse the Packs available to your organization.
        </p>
      </div>
    ),
  },
};
