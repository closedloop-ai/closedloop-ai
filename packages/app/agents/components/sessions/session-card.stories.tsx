import { sessions } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { SessionCard } from "./session-card";

/**
 * A compact card summarizing one agent session, its status, harness, cost,
 * and duration, used as an alternative to a table row when a session needs
 * more visual room.
 */
const meta = {
  title: "Composites/Sessions/Listing/Session Card",
  component: SessionCard,
  tags: ["autodocs"],
  argTypes: {
    session: { control: "object" },
    active: { control: "boolean" },
    onClick: {
      control: false,
      table: { category: "Events" },
      description:
        "Makes the whole card a button. Left unwired here so both stories render the plain, non-interactive card.",
    },
  },
  parameters: { layout: "padded" },
  args: { session: sessions[0], active: false },
} satisfies Meta<typeof SessionCard>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Active: Story = { args: { active: true } };
