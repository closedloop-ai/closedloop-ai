import type { Meta, StoryObj } from "@storybook/react";
import { PacksWorkspaceSkeleton } from "./packs-workspace-skeleton";

/**
 * A loading placeholder for the Packs workspace that mirrors the real layout
 * before any data arrives: placeholder cards in the same grid, with a filter
 * bar shaped like the real one above them. Use it while a pack catalog is
 * still loading, instead of a spinner or a blank screen, so nothing jumps or
 * reflows once the real cards and rail arrive in the same spots. Turn on the
 * two column team layout for surfaces that show a team rail alongside the
 * grid, or turn it off for a single column surface where cards fill the full
 * width. You can also pass in the surface's real heading to render above the
 * skeleton, so the page has a title from the very first paint.
 */
const meta = {
  title: "Composites/Packs/Packs Workspace Skeleton",
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
