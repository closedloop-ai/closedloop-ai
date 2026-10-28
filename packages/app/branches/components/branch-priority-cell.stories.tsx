import { Priority } from "@repo/api/src/types/common";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { BRANCH_SAMPLE_ROWS } from "../lib/branch-sample-data";
import { BranchPriorityCell } from "./branch-priority-cell";

/**
 * ISS-10332: the Branches grid's `Priority` cell in its 120px track. Tests pin
 * the words; what only a render answers is whether the glyph-plus-label fits
 * the track, whether the unset dash sits at the label's own scale, and what the
 * trigger's hover box and focus ring look like beside the row's Tags trigger.
 *
 * Controls: `readOnly` is a control; `item` is the row and its `priority` is
 * the whole matrix, so each state is its own story rather than a control that
 * would let the sandbox assemble a row the producer never emits.
 *
 * Titled where the catalog's taxonomy places it: the cell composes the shared
 * champion and its own surface's words and reaches no design-system module
 * directly, which the generator's import-count rule reads as a Primitive under
 * Data Display, the way `session-branches-row` sits (TAXONOMY.md, "The import
 * graph measures reuse, not complexity").
 */
const meta = {
  title: "Primitives v1.0/Data Display/Branch Priority Cell",
  component: BranchPriorityCell,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "padded",
    appCore: {
      apiRoutes: [
        // The write the editor commits through; the fixture transport answers
        // it so the optimistic row settles as accepted.
        {
          method: "PATCH",
          path: "/branches/*",
          respond: () => ({ id: "artifact-1", priority: Priority.High }),
        },
      ],
    },
  },
  decorators: [inTrack],
  args: {
    item: {
      ...BRANCH_SAMPLE_ROWS[0],
      artifactId: "artifact-1",
      priority: Priority.High,
    },
    readOnly: false,
  },
  argTypes: { readOnly: { control: "boolean" } },
} satisfies Meta<typeof BranchPriorityCell>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A set value: glyph and word, the trigger being the whole mark. */
export const WithValue: Story = {};

/** Unset: the grid's own empty mark, at the label's scale, still a trigger. */
export const Unset: Story = {
  args: {
    item: {
      ...BRANCH_SAMPLE_ROWS[0],
      artifactId: "artifact-1",
      priority: null,
    },
  },
};

/**
 * A producer that OMITTED the field (an older API or Desktop build): the
 * surface's own "Unavailable", as its
 * changes, repo and tags cells render it, and no control.
 */
export const Omitted: Story = {
  args: { item: { ...BRANCH_SAMPLE_ROWS[0], artifactId: "artifact-1" } },
};

/**
 * A member only a newer peer knows: the design system's fallback glyph and
 * "Unknown priority", never folded to none.
 */
export const UnknownMember: Story = {
  args: {
    item: {
      ...BRANCH_SAMPLE_ROWS[0],
      artifactId: "artifact-1",
      // The wire boundary lets a value outside this build's vocabulary through;
      // the row type is narrower than the wire, so the story spells it as one.
      priority: "CRITICAL" as Priority,
    },
  },
};

/** The host marked the row read-only (an offline desktop): mark, no control. */
export const ReadOnly: Story = {
  args: { readOnly: true },
};

/** The 120px track the column declares, so crowding is judged at width. */
function inTrack(Story: Parameters<Decorator>[0]) {
  return (
    <div className="w-[120px] border-border border-x border-dashed px-3">
      <Story />
    </div>
  );
}
