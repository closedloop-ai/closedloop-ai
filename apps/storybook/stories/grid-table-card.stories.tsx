import { LabelledStates } from "@repo/app/shared/storybook/story-states";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  GridEmptyValue,
  GridTableCard,
  GridTableCardHeaderFields,
} from "@repo/design-system/components/ui/grid-table-card";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * The card a `GridTable` renders per row on narrow surfaces, and the home of
 * the shared empty-value sentinel both halves of the table read.
 *
 * The sentinel is the contract worth seeing (ISS-6385). `GridEmptyValue` is not
 * just an em-dash — it is the one em-dash `isEmptyCellValue` can recognise, and
 * that recognition is what lets the card drop a field instead of stacking a
 * blank "Model —" line under it. A surface that invents its own empty
 * affordance gets neither behaviour, so the em-dash you can see and the
 * em-dash the card can act on must be the same component.
 */
const meta = {
  title: "Composites v1.0/Data Display/Tables/Grid Table Card",
  component: GridTableCard,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof GridTableCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const HEADER = (
  <div className="flex items-center justify-between gap-2">
    <span className="font-medium text-sm">fix/iss-6386-artifact-cells</span>
    <Badge variant="secondary">Open</Badge>
  </div>
);

export const Default: Story = {
  args: {
    header: HEADER,
    fields: [
      { key: "owner", label: "Owner", value: "Ada Lovelace" },
      { key: "model", label: "Model", value: "claude-opus-5" },
      { key: "sessions", label: "Sessions", value: "4" },
      { key: "updated", label: "Updated", value: "3 days ago" },
    ],
  },
};

/**
 * The same field list, with three columns the row has no value for. The card
 * shows the two it has and drops the rest — stacked vertically, a run of
 * "Model —", "PR —", "Cost —" reads as a broken card rather than as absent
 * data, which is why the narrow surface drops what the wide one dashes.
 */
export const EmptyFieldsDropped: Story = {
  args: {
    header: HEADER,
    fields: [
      { key: "owner", label: "Owner", value: "Ada Lovelace" },
      { key: "model", label: "Model", value: <GridEmptyValue /> },
      { key: "pr", label: "PR", value: null },
      {
        key: "cost",
        label: "Cost",
        value: <GridEmptyValue alignEnd title="Not yet computed" />,
      },
      { key: "updated", label: "Updated", value: "3 days ago" },
    ],
  },
};

/**
 * A row with nothing but its header keeps its header and grows no empty body —
 * no stray divider, no blank two-column grid.
 */
export const AllFieldsEmpty: Story = {
  args: {
    header: HEADER,
    fields: [
      { key: "model", label: "Model", value: <GridEmptyValue /> },
      { key: "pr", label: "PR", value: null },
    ],
  },
};

/**
 * Satisfies the story's `args` type. The story renders through its own
 * `LabelledStates` harness, so nothing reads this at runtime.
 */
const EMPTY_VALUE_SENTINEL_ARGS = { header: HEADER, fields: [] };

/**
 * The sentinel itself, in the three shapes it ships in. All three are the same
 * component, so all three are recognised as empty; the `alignEnd` variant is
 * grid-only, where it sits under the digits of a right-aligned numeric column,
 * and the `title` variant is for a caller that knows *why* the value is
 * missing and can say so on hover.
 */
export const EmptyValueSentinel: Story = {
  args: EMPTY_VALUE_SENTINEL_ARGS,
  render: () => (
    <LabelledStates
      rows={[
        ["Plain", <GridEmptyValue key="plain" />],
        [
          "Explained",
          <GridEmptyValue
            key="explained"
            title="Cost is not computed for this provider"
          />,
        ],
        [
          "End-aligned",
          <div className="flex w-32" key="aligned">
            <GridEmptyValue alignEnd />
          </div>,
        ],
      ]}
    />
  ),
};

/**
 * A card whose header PROMOTES two attributes above the body — and names them
 * (ISS-5532).
 *
 * A card has no column header row, so a value lifted into the header arrives
 * with nothing identifying it: the Agents card opened `Tool —`, a type word and
 * a dash. `GridTableCardHeaderFields` pairs each promoted value with its own
 * column's label in the same `dt`/`dd` relationship the body already uses, so
 * the pairing is announced rather than implied by proximity, and an empty value
 * leaves with its label rather than stranding a labelled dash on the first line
 * of the card.
 */
export const NamedHeaderAttributes: Story = {
  args: {
    header: (
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="font-medium text-sm">acme/refactor-agent</span>
        <GridTableCardHeaderFields
          fields={[
            {
              key: "type",
              label: "Type",
              // Production promotes a LOW-emphasis type treatment here, not a
              // filled badge. A badge would show a term/value contrast the real
              // card does not have, which is the whole thing worth seeing.
              value: (
                <span className="font-medium text-muted-foreground text-xs">
                  Tool
                </span>
              ),
            },
            { key: "metric", label: "LOC / $", value: "2.50" },
          ]}
        />
      </div>
    ),
    fields: [
      { key: "source", label: "Source", value: "repo-a" },
      { key: "harness", label: "Harness", value: "Claude" },
    ],
  },
};
