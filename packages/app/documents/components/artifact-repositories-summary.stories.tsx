import type { ArtifactRepositorySnapshot } from "@repo/api/src/types/document";
import { ArtifactRepositoriesSummary } from "@repo/app/documents/components/artifact-repositories-summary";
import type { Meta, StoryObj } from "@storybook/react";

const snapshotWithPrimary: ArtifactRepositorySnapshot = {
  source: "loop_selection",
  repositories: [
    {
      fullName: "closedloop-ai/symphony-alpha",
      role: "primary",
      position: 1,
      branch: "codex/design-system-adoption-audit",
    },
    {
      fullName: "closedloop-ai/symphony-alpha",
      role: "additional",
      position: 2,
      ref: "main",
    },
    {
      fullName: "closedloop-ai/claude-plugins",
      role: "additional",
      position: 3,
    },
  ],
};

const emptySnapshot: ArtifactRepositorySnapshot = {
  source: "none",
  repositories: [],
};

const meta = {
  title: "App Core/Documents/Artifact Repositories Summary",
  component: ArtifactRepositoriesSummary,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
  args: {
    snapshot: snapshotWithPrimary,
  },
} satisfies Meta<typeof ArtifactRepositoriesSummary>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {};

export const Vertical: Story = {
  args: {
    layout: "vertical",
    separator: true,
    title: "Repositories",
  },
  render: (args) => (
    <div className="max-w-sm rounded-lg border bg-background p-4">
      <ArtifactRepositoriesSummary {...args} />
    </div>
  ),
};

export const EmptyHorizontal: Story = {
  args: {
    snapshot: emptySnapshot,
  },
};

export const EmptyVertical: Story = {
  args: {
    layout: "vertical",
    separator: true,
    snapshot: emptySnapshot,
    title: "Repositories",
  },
  render: (args) => (
    <div className="max-w-sm rounded-lg border bg-background p-4">
      <ArtifactRepositoriesSummary {...args} />
    </div>
  ),
};
