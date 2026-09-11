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

/**
 * A read-only list of the code repositories an artifact was built against,
 * with the primary repository marked and always listed first. It renders two
 * ways: a row of small pills for a compact metadata bar, or a stacked list
 * with a heading for a sidebar or detail panel. Each entry can show a branch
 * or ref name as secondary text next to the repository name, and if there
 * are no repositories at all, it just says so.
 */
const meta = {
  title: "Composites/Documents/Artifact Repositories Summary",
  component: ArtifactRepositoriesSummary,
  tags: ["autodocs"],
  argTypes: {
    snapshot: { control: "object" },
    layout: {
      control: { type: "radio" },
      options: ["horizontal", "vertical"],
    },
  },
  parameters: {
    layout: "padded",
  },
  args: {
    snapshot: snapshotWithPrimary,
    layout: "horizontal",
    separator: false,
    title: "",
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
