import { sessions } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { SessionCard } from "./session-card";

const meta = {
  title: "App Core/Agents/Session Card",
  component: SessionCard,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { session: sessions[0] },
} satisfies Meta<typeof SessionCard>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Active: Story = { args: { active: true } };
