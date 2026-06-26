import { LoopErrorCode, LoopStatus } from "@repo/api/src/types/loop";
import type { Meta, StoryObj } from "@storybook/react";
import { AppCoreStoryProviders } from "../../shared/storybook/decorators";
import { LoopStatusBadge } from "./loop-status-badge";

/**
 * Co-located story for the migrated app-core component (FEA-1510 / AC-001.4).
 * The `ghost-loop-ux` flag is enabled through the harness's injected
 * feature-flag port (no analytics SDK), so the Failed variant renders its
 * friendly error label.
 */
const meta: Meta<typeof LoopStatusBadge> = {
  title: "App Core/Loops/Loop Status Badge",
  component: LoopStatusBadge,
  decorators: [
    (Story) => (
      <AppCoreStoryProviders enabledFlags={["ghost-loop-ux"]}>
        <Story />
      </AppCoreStoryProviders>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Running: Story = {
  args: { status: LoopStatus.Running },
};

export const Completed: Story = {
  args: { status: LoopStatus.Completed },
};

export const Failed: Story = {
  args: { status: LoopStatus.Failed, errorCode: LoopErrorCode.ProcessFailed },
};
