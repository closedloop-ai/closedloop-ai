/**
 * One row as a card — ISS-9296.
 *
 * The unit of the champion grid's narrow-surface layout, and therefore part of
 * how the same list surface renders across web and a Desktop window a user has
 * dragged narrow. A card is not a second design for the list; it is the same
 * row's data laid out for a track that cannot hold columns.
 *
 * The default card drops an absent value. A host whose selected-field contract
 * requires every field to remain available can opt into the shared empty-value
 * treatment instead, without changing existing consumers.
 *
 * Applicable states: default, partial (some fields absent), and empty (every
 * field absent). Not applicable: hover, focus-visible, selected, editing,
 * dragging, drag-over, loading, disabled, read-only and permission — this
 * component renders no control and holds no state; the card LIST above it owns
 * selection and disclosure, and loading/error are the surface shell's. OVERFLOW
 * is not applicable either, and that is a deliberate omission rather than a gap:
 * the value `dd` carries no `truncate`, `line-clamp` or `overflow-hidden`, so a
 * long value WRAPS here instead of clipping. A story asserting a clipping
 * contract this component does not implement would guard nothing.
 */
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import {
  buildGridTableV2CardFields,
  GridTableV2Card,
} from "@repo/design-system/components/ui/grid-table-v2-card";
import {
  TableChoiceCell,
  TableDateCell,
  TablePersonCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { expect, within } from "storybook/test";

const meta = {
  title: "Composites v1.0/Data Display/Tables/Grid Table V2 Card",
  tags: ["deprecated"],
  component: GridTableV2Card,
  argTypes: {
    fields: { control: false },
    header: { control: false },
    preserveEmptyFields: { control: "boolean" },
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GridTableV2Card>;

export default meta;

type Story = StoryObj<typeof meta>;

const HEADER_LABEL = "Canonical table controls";

/**
 * The LEAD column is present so the exclusion below is actually exercised. An
 * earlier draft excluded `"name"` from a column set that contained no `name`
 * column, so `buildGridTableV2CardFields`' filter never removed anything and
 * deleting it outright left every story green.
 */
const LEAD_COLUMN = { id: "name", label: "Name" } as const;

const COLUMNS = [
  LEAD_COLUMN,
  { id: "status", label: "Status" },
  { id: "owner", label: "Owner" },
  { id: "updated", label: "Updated" },
] as const;

/** The lead column is the card's HEADER, so the body must not repeat it. */
const EXCLUDED_COLUMN_IDS = new Set([LEAD_COLUMN.id]);

/** Body fields = every column except the excluded lead. */
const BODY_COLUMN_COUNT = COLUMNS.length - EXCLUDED_COLUMN_IDS.size;

/** Every field populated. */
export const Default: Story = {
  args: {
    fields: buildFields({
      owner: "Assigned",
      status: "Active",
      updated: "Today",
    }),
    header: <CardHeader />,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText(HEADER_LABEL)).toBeInTheDocument();

    // A description list, not a stack of divs: the label/value pairing is what
    // replaces the column header a narrow surface cannot show, so it has to
    // reach the accessibility tree as a pairing.
    for (const column of COLUMNS) {
      if (EXCLUDED_COLUMN_IDS.has(column.id)) {
        continue;
      }
      await expect(canvas.getByText(column.label)).toBeInTheDocument();
    }
    await expect(canvasElement.querySelectorAll("dt")).toHaveLength(
      BODY_COLUMN_COUNT
    );

    // The excluded lead column is absent from the BODY while its value still
    // heads the card. Dropping the helper's `excludeIds` filter re-renders the
    // row's identity a second time under its own label, and fails here.
    await expect(canvas.queryByText(LEAD_COLUMN.label)).toBeNull();
  },
};

/**
 * Some values absent. The absent fields are DROPPED — label and all — rather
 * than rendered as an empty line, so the card shows what the row has instead of
 * a column of blanks.
 *
 * Both readings of "absent" are covered, because they arrive by different
 * routes: `null` from a renderer with nothing to draw, and a `GridEmptyValue`
 * element from one that explicitly drew "no value".
 */
export const PartialValues: Story = {
  args: {
    fields: buildFields({
      owner: null,
      status: "Active",
      updated: <GridEmptyValue />,
    }),
    header: <CardHeader />,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The populated field survives...
    await expect(canvas.getByText("Status")).toBeInTheDocument();
    await expect(canvas.getByText("Active")).toBeInTheDocument();

    // ...and neither absent field left its label behind.
    await expect(canvas.queryByText("Owner")).toBeNull();
    await expect(canvas.queryByText("Updated")).toBeNull();
    await expect(canvasElement.querySelectorAll("dt")).toHaveLength(1);
  },
};

/**
 * Every selected field remains present even when its row value is absent.
 * Branches uses this policy because Option A promises that choosing cards never
 * makes a selected column unavailable.
 */
export const PreserveEmptyFields: Story = {
  args: {
    fields: buildFields({
      owner: null,
      status: "Active",
      updated: <GridEmptyValue />,
    }),
    header: <CardHeader />,
    preserveEmptyFields: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    for (const label of ["Status", "Owner", "Updated"]) {
      await expect(canvas.getByText(label)).toBeInTheDocument();
    }
    await expect(
      canvasElement.querySelectorAll('[data-slot="grid-empty-value"]')
    ).toHaveLength(2);
    await expect(canvasElement.querySelectorAll("dt")).toHaveLength(
      BODY_COLUMN_COUNT
    );
  },
};

/**
 * Every value absent. The card renders its header and NO BODY AT ALL — not an
 * empty `<dl>`, whose padding would read as a card that failed to load rather
 * than as a row with nothing else to say.
 *
 * The end of the same ladder `Default` and `PartialValues` start: three fields,
 * one field, none.
 */
export const AllValuesAbsent: Story = {
  args: {
    fields: buildFields({ owner: null, status: null, updated: null }),
    header: <CardHeader />,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The row is still identifiable — dropping the body must not drop the row.
    await expect(canvas.getByText(HEADER_LABEL)).toBeInTheDocument();
    await expect(canvasElement.querySelectorAll("dl")).toHaveLength(0);
  },
};

/**
 * Fields built through the shipped helper rather than hand-assembled, so the
 * story exercises the same `columns → fields` mapping a real card list uses.
 */
function buildFields(values: Record<string, ReactNode>) {
  return buildGridTableV2CardFields(
    COLUMNS,
    EXCLUDED_COLUMN_IDS,
    (columnId) => renderValue(columnId, values[columnId]),
    null
  );
}

/**
 * One canonical cell per data shape, per the table-cell contract in
 * `apps/storybook/AGENTS.md` and matching `grid-table-v2.stories.tsx`.
 *
 * An ABSENT value stays a bare `null` / `GridEmptyValue` and is deliberately NOT
 * wrapped: `isEmptyCellValue` tests the UNRENDERED element's `type`, so a
 * `<TableChoiceCell label={null}/>` would read as a populated field and the
 * card's empty-field filter would silently stop working — even though that cell
 * renders a `GridEmptyValue` of its own.
 */
function renderValue(columnId: string, value: ReactNode): ReactNode {
  // Only a RAW value gets wrapped. An already-rendered node (a `GridEmptyValue`
  // the caller drew itself) passes through untouched: wrapping it would both
  // stringify the element and hide it from `isEmptyCellValue`, which tests the
  // element's own `type`.
  if (typeof value !== "string") {
    return value;
  }
  if (columnId === "owner") {
    return <TablePersonCell person={{ name: String(value) }} />;
  }
  if (columnId === "updated") {
    return <TableDateCell value={String(value)} />;
  }
  if (columnId === "status") {
    return <TableChoiceCell label={String(value)} />;
  }
  return value;
}

function CardHeader() {
  return <span className="font-medium text-sm">{HEADER_LABEL}</span>;
}
