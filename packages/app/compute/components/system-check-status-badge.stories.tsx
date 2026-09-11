import type { Meta, StoryObj } from "@storybook/react";
import {
  SystemCheckStatusBadge,
  SystemCheckStatusTone,
} from "./system-check-status-badge";

/**
 * A small pill-shaped badge with custom text, used at the end of a system
 * check row or a repair step to show its outcome, such as "Enabled" or
 * "Setup required". It is shared between the system check list and the
 * repair panel specifically so the same outcome never gets two different
 * looks in the two places it appears. The label text and the tone (success,
 * warning, danger or neutral) are set independently, so you write the exact
 * wording yourself instead of picking from a fixed list of states.
 */
const meta: Meta<typeof SystemCheckStatusBadge> = {
  title: "Primitives/Feedback & Status/System Check Status Badge",
  component: SystemCheckStatusBadge,
  tags: ["autodocs"],
  argTypes: {
    tone: {
      control: { type: "radio" },
      options: Object.values(SystemCheckStatusTone),
    },
  },
  args: {
    label: "Enabled",
    tone: SystemCheckStatusTone.Success,
  },
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
