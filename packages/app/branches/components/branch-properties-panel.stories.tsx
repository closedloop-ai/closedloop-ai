import { BranchStatus } from "@repo/api/src/types/branch";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { makeBranchDetail } from "../__tests__/branch-fixtures";
import { BranchPropertiesPanel } from "./branch-properties-panel";

const LONG_BRANCH_NAME =
  "feature/iss-4473-comprehensive-branch-details-with-selected-pull-request-history";
const LONG_REPOSITORY_NAME =
  "closedloop-ai/customer-platform-with-an-intentionally-long-repository-name";
const PROPERTIES_RE = /Properties/;

const meta = {
  title: "Composites v1.0/Branches/Branch Properties Panel",
  component: BranchPropertiesPanel,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-sm">
        <Story />
      </div>
    ),
  ],
  args: {
    detail: makeBranchDetail({
      additions: 1842,
      branchName: LONG_BRANCH_NAME,
      deletions: 376,
      repoFullName: LONG_REPOSITORY_NAME,
      status: BranchStatus.Review,
    }),
  },
} satisfies Meta<typeof BranchPropertiesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CollapsedLongBranchPreview: Story = {
  globals: { viewport: { value: "360-720" } },
  play: async ({ canvasElement }) => {
    const toggle = within(canvasElement).getByRole("button", {
      name: PROPERTIES_RE,
    });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveTextContent(LONG_BRANCH_NAME);
  },
};

export const Expanded: Story = {
  globals: { viewport: { value: "1512-900" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole("button", { name: PROPERTIES_RE });
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText("Repository")).toBeVisible();
    await expect(canvas.getByText(LONG_REPOSITORY_NAME)).toBeVisible();
  },
};

/** Expanded detail properties with the canonical Branch status champion. */
export const UniversalArtifactStatus: Story = {
  globals: { viewport: { value: "1512-900" } },
  parameters: {
    appCore: { enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole("button", { name: PROPERTIES_RE });
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText("Review")).toBeVisible();
  },
};
