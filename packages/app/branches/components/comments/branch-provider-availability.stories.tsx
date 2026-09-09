import { BranchCommentsState } from "@repo/api/src/types/branch";
import type { Meta, StoryObj } from "@storybook/react";
import { BranchProviderAvailability } from "./branch-provider-availability";

const meta = {
  component: BranchProviderAvailability,
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-md border bg-background">
        <Story />
      </div>
    ),
  ],
  title: "App Core/Branches/Provider Availability",
  tags: ["autodocs"],
  argTypes: {
    availability: {
      control: "object",
      description:
        "Independent bounded-coverage facts. Every applicable one is disclosed, so combinations render more than one line.",
    },
  },
  args: { availability: availability() },
} satisfies Meta<typeof BranchProviderAvailability>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Clean: Story = {
  args: {
    availability: availability(),
  },
};

export const Stale: Story = {
  args: {
    availability: availability({
      stale: true,
      state: BranchCommentsState.StaleMixed,
    }),
  },
};

export const Truncated: Story = {
  args: {
    availability: availability({
      omittedComments: 3,
      providerTruncated: true,
      state: BranchCommentsState.OverLimitTruncated,
    }),
  },
};

export const StaleAndTruncated: Story = {
  args: {
    availability: availability({
      bodyTruncatedCount: 2,
      mixedProjection: true,
      omittedComments: 3,
      responseTruncated: true,
      stale: true,
      state: BranchCommentsState.StaleMixed,
    }),
  },
};

function availability(
  overrides: Partial<
    Parameters<typeof BranchProviderAvailability>[0]["availability"]
  > = {}
): Parameters<typeof BranchProviderAvailability>[0]["availability"] {
  return {
    bodyTruncatedCount: 0,
    mixedProjection: false,
    omittedComments: 0,
    providerTruncated: false,
    responseTruncated: false,
    stale: false,
    state: BranchCommentsState.Populated,
    ...overrides,
  };
}
