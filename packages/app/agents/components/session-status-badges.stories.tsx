import {
  AgentStatusBadge,
  HarnessBadge,
  SessionStatusBadge,
} from "@repo/app/agents/components/session-status-badges";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import type { Meta, StoryObj } from "@storybook/react";

const SessionStatusBadgesGallery = () => (
  <div className="space-y-6">
    <div className="flex flex-wrap gap-2">
      <SessionStatusBadge status="active" />
      <SessionStatusBadge status="waiting" />
      <SessionStatusBadge status="completed" />
      <SessionStatusBadge status="error" />
      <SessionStatusBadge status="abandoned" />
    </div>
    <div className="flex flex-wrap gap-2">
      <AgentStatusBadge status="working" />
      <AgentStatusBadge status="waiting" />
      <AgentStatusBadge status="completed" />
      <AgentStatusBadge status="error" />
      <AgentStatusBadge status="idle" />
    </div>
    <div className="flex flex-wrap gap-2">
      <HarnessBadge harness="claude" />
      <HarnessBadge harness="codex" />
      <HarnessBadge harness="cursor" />
      <HarnessBadge harness="copilot" />
      <HarnessBadge harness="opencode" />
    </div>
    <div className="flex flex-wrap gap-2">
      <ToneBadge label="Security" tone="danger" />
    </div>
  </div>
);

const meta = {
  title: "App Core/Agents/Session Status Badges",
  component: SessionStatusBadgesGallery,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof SessionStatusBadgesGallery>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
