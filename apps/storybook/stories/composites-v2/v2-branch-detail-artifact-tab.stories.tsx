import type { Meta, StoryObj } from "@storybook/react";
import { BranchArtifactTabDemo } from "./v2-branch-detail-tabs";

// The Branch Detail page's Artifact tab body (PRD-751): the pull request
// selector and the evidence for the chosen pull request, on the framed canvas
// (ISS-12403; the branch's properties are its Details tab).
// The finished page is Surfaces/Artifacts/Branches/Branch Detail.
//
// Controls are disabled: the body reads the page's fixture branch.

const meta = {
  title: "Composites/Artifacts/Branches/Branch Detail/Artifact Tab",
  tags: ["stable"],
  render: () => <BranchArtifactTabDemo />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = { globals: { theme: "dark" } };
