import { BranchProvenance } from "@repo/api/src/types/branch";
import type { Meta, StoryObj } from "@storybook/react";
import { SessionProvenanceChip } from "./session-provenance-chip";

// ISS-5451: the session provenance marker, isolated.
// FEA-3575: a quiet, informational marker for automated runs, mirroring the
// Branches provenance chip so the two surfaces label origin identically. The
// point of the set is that {@link Human} and {@link Unknown} render NOTHING —
// the chip marks the exception, not every row, so a human-authored session
// carries no badge at all. That absence is the design, and without a story for
// it a reader has to guess whether a missing chip is intentional or a bug.
/**
 * A small muted chip that marks a session as automated: Agent for one an AI
 * agent started, Bot for one an automated process like a dependency bot
 * started. It mirrors the same chip used on the Branches list, so a session
 * and the branch it produced label their origin the same way. A human
 * started session, or one with no known origin, renders no chip at all; the
 * absence is deliberate, not a missing state.
 */
const meta = {
  title: "Primitives/Data Display/Session Provenance Chip",
  component: SessionProvenanceChip,
  tags: ["autodocs"],
  argTypes: {
    provenance: {
      control: { type: "radio" },
      options: [...Object.values(BranchProvenance), null],
      description:
        "Origin of the session. Human and null are real values that render nothing at all.",
    },
  },
  parameters: { layout: "centered" },
  args: { provenance: BranchProvenance.Agent },
} satisfies Meta<typeof SessionProvenanceChip>;

export default meta;

type Story = StoryObj<typeof meta>;

/** An agent-minted worktree session. */
export const Agent: Story = {};

/** An automated dependency/bot run. */
export const Bot: Story = {
  args: { provenance: BranchProvenance.Bot },
};

/** A human-authored session renders no chip. The empty frame is correct. */
export const Human: Story = {
  args: { provenance: BranchProvenance.Human },
};

/** Unclassified provenance also renders nothing rather than guessing. */
export const Unknown: Story = {
  args: { provenance: null },
};
