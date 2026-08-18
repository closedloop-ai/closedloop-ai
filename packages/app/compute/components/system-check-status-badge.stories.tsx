import type { Meta, StoryObj } from "@storybook/react";
import {
  SystemCheckStatusBadge,
  SystemCheckStatusTone,
} from "./system-check-status-badge";

const meta: Meta<typeof SystemCheckStatusBadge> = {
  title: "App Core/Compute/System Check Status Badge",
  component: SystemCheckStatusBadge,
};

export default meta;

type Story = StoryObj<typeof SystemCheckStatusBadge>;

export const Success: Story = {
  args: { label: "Enabled", tone: SystemCheckStatusTone.Success },
};

export const Warning: Story = {
  args: { label: "Enable timed out", tone: SystemCheckStatusTone.Warning },
};

export const Danger: Story = {
  args: { label: "Setup required", tone: SystemCheckStatusTone.Danger },
};

export const Neutral: Story = {
  args: { label: "not run", tone: SystemCheckStatusTone.Neutral },
};

/** Every tone side by side, which is how they actually appear across a card. */
export const AllTones: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <SystemCheckStatusBadge
        label="fixed"
        tone={SystemCheckStatusTone.Success}
      />
      <SystemCheckStatusBadge
        label="Update timed out"
        tone={SystemCheckStatusTone.Warning}
      />
      <SystemCheckStatusBadge
        label="failed"
        tone={SystemCheckStatusTone.Danger}
      />
      <SystemCheckStatusBadge
        label="not run"
        tone={SystemCheckStatusTone.Neutral}
      />
    </div>
  ),
};
