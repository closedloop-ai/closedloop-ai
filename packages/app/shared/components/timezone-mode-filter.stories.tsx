import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { TimezoneMode } from "../lib/date-window-timezone-mode";
import { TimezoneModeFilter } from "./timezone-mode-filter";

/**
 * ISS-9619 — the `Local | UTC` day-boundary control, isolated.
 *
 * Both states are rendered rather than only asserted: which pill is selected is
 * the whole of what this control says, and a test that queries a role cannot
 * show that the selected and unselected pills are actually distinguishable
 * without relying on hue (WCAG 1.4.1) — the words carry it, and a story is what
 * makes that visible to review.
 */
const meta: Meta<typeof TimezoneModeFilter> = {
  title: "Composites v1.0/App Shell/Timezone Mode Filter",
  tags: ["deprecated"],
  component: TimezoneModeFilter,
  decorators: [
    (Story) => (
      <div className="p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof TimezoneModeFilter>;

/** The shipped default: UTC, which is every window's boundary today. */
export const UTCSelected: Story = {
  args: { onChange: () => undefined, value: TimezoneMode.Utc },
};

/** What a reader who has opted in sees. */
export const LocalSelected: Story = {
  args: { onChange: () => undefined, value: TimezoneMode.Local },
};

/** Driven, so the selected pill actually moves under a click. */
export const Interactive: Story = {
  render: () => {
    const [mode, setMode] = useState<TimezoneMode>(TimezoneMode.Utc);
    return <TimezoneModeFilter onChange={setMode} value={mode} />;
  },
};
