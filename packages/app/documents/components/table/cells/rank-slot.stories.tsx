import { RankInteractionMode } from "@repo/app/documents/components/table/sort-keys";
import { LabelledStates } from "@repo/app/shared/storybook/story-states";
import type { Meta, StoryObj } from "@storybook/react";
import { GripVerticalIcon } from "lucide-react";
import { buildRankSlot, RANK_DRAG_HANDLE_CLASS } from "./rank-slot";

/**
 * The rank slot that opens a row's name cell on stack-rank surfaces
 * (PRD-421 / PLN-755). It is a builder rather than a component because it has a
 * fourth answer — *render nothing* — that a component would have to fake.
 *
 * The reserved-spacer state is the one worth seeing: a tree child on a rank
 * surface cannot be dragged, but it still has to line up with the siblings that
 * can, so it gets an `aria-hidden` box of the same width and no control. The
 * disabled-by-grouping state is a real affordance instead — a greyed grip that
 * says *why* on hover, which is the difference between an explanation and a
 * silently missing handle.
 */
const meta = {
  title: "Composites v1.0/Documents/Rank Slot",
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// The real handle's presentation, imported rather than approximated: the story
// exists to show the hover reveal, and a copy that drifts shows the wrong one.
// Only the dnd-kit drag listeners are absent, since there is nothing to drag.
const DRAG_HANDLE = (
  <button
    aria-label="Reorder row"
    className={RANK_DRAG_HANDLE_CLASS}
    type="button"
  >
    <GripVerticalIcon className="h-4 w-4" />
  </button>
);

/**
 * All four branches. Both grip states reveal on row hover, so hover a row below
 * to see them — a permanently visible handle on every row is exactly the noise
 * the `group-hover/row` reveal exists to avoid.
 */
export const States: Story = {
  render: () => (
    <LabelledStates
      rows={[
        ["Draggable", slotRow(RankInteractionMode.Enabled, false)],
        [
          "Disabled by grouping",
          slotRow(RankInteractionMode.DisabledGrouped, false),
        ],
        ["Reserved spacer", slotRow(undefined, true)],
        ["Not a rank surface", slotRow(undefined, false)],
      ]}
    />
  ),
};

function slotRow(
  mode: RankInteractionMode | undefined,
  reserveRankSlot: boolean
) {
  // Mirrors the name cell's own row box (`NAME_CELL_CLASS_NAME`) so the
  // reserved-spacer story shows the indentation it actually reserves.
  return (
    <div className="group/row flex min-h-11 items-center pr-3 pl-2">
      {buildRankSlot(mode, DRAG_HANDLE, reserveRankSlot)}
      <span className="ml-1.5 truncate font-medium text-base text-foreground">
        Artifact cell primitives
      </span>
    </div>
  );
}
