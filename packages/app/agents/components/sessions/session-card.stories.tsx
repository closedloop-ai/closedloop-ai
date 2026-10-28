import { sessions } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { SessionCard } from "./session-card";

const meta = {
  title: "Composites v1.0/Sessions/Session Card",
  component: SessionCard,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
  args: { session: sessions[0] },
} satisfies Meta<typeof SessionCard>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Active: Story = { args: { active: true } };

/**
 * A session awaiting input — the warning-toned left border
 * (`statusBorderClass`), distinct from `Default`'s success/running border and
 * unrelated to the `active` prop's selected tint above.
 */
export const Waiting: Story = { args: { session: sessions[1] } };
