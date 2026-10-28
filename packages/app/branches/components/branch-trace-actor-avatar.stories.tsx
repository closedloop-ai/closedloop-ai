import type { TurnActor } from "@repo/api/src/types/agent-session";
import type { Meta, StoryObj } from "@storybook/react";
import { BranchTraceActorAvatar } from "./branch-trace-actor-avatar";

const namedActor: TurnActor = {
  color: "",
  human: "Kaito",
  name: "Kaito",
  sessionId: "session-review",
};

const harnessActor: TurnActor = {
  color: "",
  harness: "claude",
  human: null,
  name: null,
  sessionId: "session-build",
};

const meta = {
  title: "Composites v1.0/Branches/Branch Trace Actor Avatar",
  component: BranchTraceActorAvatar,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "centered" },
  args: {
    actor: namedActor,
  },
} satisfies Meta<typeof BranchTraceActorAvatar>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Explicit actor identity uses the actor's display name and initials. */
export const NamedActor: Story = {};

/** A nameless actor falls back to its harness identity. */
export const HarnessFallback: Story = {
  args: {
    actor: harnessActor,
  },
};
