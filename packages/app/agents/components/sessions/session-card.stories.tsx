import { sessions } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { SessionCard } from "./session-card";

/**
 * This is a compact card summarizing one agent session: its name, ID, status
 * and harness badges, repository, agent count, model, cost, duration, and
 * how long ago it was last active. Use it in a card-based list view, as an
 * alternative to a table row when a session needs more visual room than a
 * single line gives it. It can render as a plain, non-interactive block or,
 * once given a click handler, as a full clickable button, and it highlights
 * with a tinted background and ring when marked active.
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
