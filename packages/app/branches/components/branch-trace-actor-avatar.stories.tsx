import type { TurnActor } from "@repo/api/src/types/agent-session";
import { buildActorColorDomain } from "@repo/app/branches/lib/branch-actor-domain";
import type { Meta, StoryObj } from "@storybook/react";
import { BranchTraceActorAvatar } from "./branch-trace-actor-avatar";

const namedActor: TurnActor = {
  color: "",
  human: "Kaiti",
  name: "Kaiti",
  sessionId: "session-review",
};

const harnessActor: TurnActor = {
  color: "",
  harness: "claude",
  human: null,
  name: null,
  sessionId: "session-build",
};

const actorDomain = buildActorColorDomain(["Kaiti", "claude"]);

const meta = {
  title: "App Core/Branches/Trace Actor Avatar",
  component: BranchTraceActorAvatar,
  tags: ["autodocs"],
  argTypes: {
    actor: { control: "object" },
    actorDomain: {
      control: false,
      description: "Shared color domain built by buildActorColorDomain.",
    },
  },
  parameters: { layout: "centered" },
  args: {
    actor: namedActor,
    actorDomain,
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
