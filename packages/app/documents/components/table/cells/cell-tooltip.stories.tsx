import { CELL_CLASSES } from "@repo/app/documents/components/table/cells/shared-cell-styles";
import { LabelledStates } from "@repo/app/shared/storybook/story-states";
import type { Meta, StoryObj } from "@storybook/react";
import { CellTooltip, TruncatedTitle } from "./cell-tooltip";

/**
 * The two truncation affordances shared by the document-table cells
 * (ISS-6386). Every cell in that layer is a fixed-width box, so any value long
 * enough to clip needs a way back to the full string — these are it.
 *
 * `CellTooltip` is the one with a decision in it: given no text, it returns its
 * child untouched rather than wrapping it. An empty cell therefore gains no
 * trigger, no focus stop, and no tooltip that opens onto nothing.
 */
const meta = {
  title: "Composites v1.0/Documents/Cell Tooltip",
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const LONG_TITLE =
  "Artifact cells: extend the eleven partially-covered types with their behaviour contract";

/** Hover each row to see which one actually reveals anything. */
export const States: Story = {
  render: () => (
    <LabelledStates
      rows={[
        [
          "With text",
          <CellTooltip key="with" text={LONG_TITLE}>
            <div className={CELL_CLASSES}>
              <span className={CELL_TEXT_CLASSES}>{LONG_TITLE}</span>
            </div>
          </CellTooltip>,
        ],
        [
          "No text",
          <CellTooltip key="without" text={null}>
            <div className={CELL_CLASSES}>
              <span className={CELL_TEXT_CLASSES}>—</span>
            </div>
          </CellTooltip>,
        ],
        [
          "Truncated title",
          <div className={CELL_CLASSES} key="title">
            <TruncatedTitle text={LONG_TITLE} />
          </div>,
        ],
      ]}
    />
  ),
};

// The truncating span every cell in this layer puts inside its CELL_CLASSES box
// (see `static-cells.tsx`). The clip point is the whole point of this story, so
// the box and the text treatment both have to be production's.
const CELL_TEXT_CLASSES = "truncate font-medium text-muted-foreground text-xs";
