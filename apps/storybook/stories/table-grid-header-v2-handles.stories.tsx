// biome-ignore-all lint/a11y/useSemanticElements: a CSS-grid table cannot be a real <table>; `role="grid"` is the mapping the champion itself renders.
import { TableGridHeaderV2 } from "@repo/design-system/components/ui/table-grid-header-v2";
import { ColumnResizeHandle } from "@repo/design-system/components/ui/table-grid-header-v2-handles";
import {
  COLUMN_RESIZE_KEYBOARD_STEP_PX,
  MIN_COLUMN_WIDTH_PX,
} from "@repo/design-system/lib/column-order";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, fireEvent, userEvent, within } from "storybook/test";

/**
 * Direct manipulation of a champion-grid column's WIDTH and POSITION — ISS-9290.
 *
 * Both grips this module owns are here: the resize handle a data-column header
 * grows on its right edge, and the reorder drop that moves a column before
 * another. They share a story file because they share a source file and a
 * concern — a column the user is physically moving — and because a header
 * carries both at once.
 *
 * The resize control is a `button`, not an APG window splitter, and the stories
 * below are why that is defensible: a grid column has no ceiling, so there is no
 * honest `aria-valuemax` to publish, and the width is instead stated where a
 * button legitimately can state it — in its accessible name, recomputed from the
 * same width the arrow keys move.
 *
 * Applicable states: default, hover and focus-visible (focus half; the grip's
 * opacity ramp is Chromatic's), keyboard/pointer interaction, dragging and
 * drag-over, and the two boundary readings — at the floor, and on a corrupt
 * width. Not applicable: selected, editing, loading, empty, partial, disabled,
 * read-only, permission, narrow and overflow — the grips are fixed-size chrome
 * with no data of their own, and the narrow card layout renders no header.
 */
const meta = {
  title: "Composites v1.0/Data Display/Tables/Table Grid Header V2 Handles",
  component: ColumnResizeHandle,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    columnId: { control: "text" },
    label: { control: "text" },
    // The `{columnIds, getColumnWidth, onResize}` wiring bag — each story
    // builds its own stateful harness for it rather than a generic control.
    resize: { table: { disable: true } },
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ColumnResizeHandle>;

export default meta;

type Story = StoryObj<typeof meta>;

const COLUMN_ID = "status";
const COLUMN_LABEL = "Status";

/** A comfortable starting width, well clear of the floor in both directions. */
const START_WIDTH_PX = 180;

const COLUMN_TRACK_TEST_ID = "column-track";

/** The columns the reorder story lists in `columnOrder` — its drag surfaces. */
const REORDERABLE_COLUMN_IDS = ["owner", "status", "updated"];

/**
 * Rendered, but deliberately ABSENT from `columnOrder`: the header's reorder
 * gate must leave it undraggable and refuse it as a drop target, the way a
 * row-actions column stays pinned in production.
 */
const FIXED_COLUMN_ID = "actions";

const STORY_COLUMN_IDS = [...REORDERABLE_COLUMN_IDS, FIXED_COLUMN_ID];

/**
 * Satisfies each story's `args` type. Every story renders through its own
 * stateful harness, so nothing reads this at runtime.
 */
const STATIC_RESIZE = {
  columnIds: [COLUMN_ID],
  getColumnWidth: () => START_WIDTH_PX,
  onResize: () => undefined,
};

/**
 * The name a NaN width would produce if the guard were removed, written out
 * rather than derived — the duplication IS the test. Deriving it from the same
 * helper the component uses would make the assertion pass no matter what that
 * helper did.
 */
const NAN_WIDTH_NAME = `Resize ${COLUMN_LABEL} column, NaN pixels wide, use arrow keys`;

/**
 * The keyboard path a pointer user never needs and a keyboard user has nothing
 * else for (WCAG 2.1.1): each arrow moves the column one shared step, and the
 * name reports the width it moved TO, so a keypress is a measurable change
 * rather than an unmeasurable nudge.
 */
export const KeyboardResize: Story = {
  args: { columnId: COLUMN_ID, label: COLUMN_LABEL, resize: STATIC_RESIZE },
  render: (args) => (
    <ResizeStory
      columnId={args.columnId ?? COLUMN_ID}
      label={args.label ?? COLUMN_LABEL}
      startWidth={START_WIDTH_PX}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The resting name already states the operation and the current width.
    const handle = canvas.getByRole("button", {
      name: resizeName(START_WIDTH_PX),
    });
    await userEvent.tab();
    await expect(handle).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}");
    const grown = START_WIDTH_PX + COLUMN_RESIZE_KEYBOARD_STEP_PX;
    await expect(
      canvas.getByRole("button", { name: resizeName(grown) })
    ).toBeInTheDocument();

    // And back down by the same step, so the two directions agree.
    await userEvent.keyboard("{ArrowLeft}");
    await expect(
      canvas.getByRole("button", { name: resizeName(START_WIDTH_PX) })
    ).toBeInTheDocument();
  },
};

/**
 * At the floor the control would otherwise go silent: ArrowLeft emits the width
 * the column already has, the host writes back the same state, nothing
 * re-renders, and a screen-reader user cannot tell "at minimum" from "control
 * broken". Naming the floor is the one thing this button pattern does better
 * than a splitter carrying only an `aria-valuemin`.
 */
export const AtMinimumWidth: Story = {
  args: { columnId: COLUMN_ID, label: COLUMN_LABEL, resize: STATIC_RESIZE },
  render: (args) => (
    <ResizeStory
      columnId={args.columnId ?? COLUMN_ID}
      label={args.label ?? COLUMN_LABEL}
      startWidth={MIN_COLUMN_WIDTH_PX}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // "minimum" is present at the floor...
    const handle = canvas.getByRole("button", {
      name: minimumResizeName(MIN_COLUMN_WIDTH_PX),
    });
    handle.focus();

    // ...and pressing further does not fall through it.
    await userEvent.keyboard("{ArrowLeft}");
    await expect(
      canvas.getByRole("button", {
        name: minimumResizeName(MIN_COLUMN_WIDTH_PX),
      })
    ).toBeInTheDocument();

    // Growing away from the floor drops the marker, so it describes the state
    // rather than being permanently welded to the control.
    await userEvent.keyboard("{ArrowRight}");
    await expect(
      canvas.getByRole("button", {
        name: resizeName(MIN_COLUMN_WIDTH_PX + COLUMN_RESIZE_KEYBOARD_STEP_PX),
      })
    ).toBeInTheDocument();
  },
};

/**
 * A corrupt persisted width, which is reachable: `getColumnWidth` is
 * caller-owned and typed `number`, and a restored saved view can hand this a
 * `NaN`. Interpolating it would announce "NaN pixels wide" — a confident
 * measurement that is simply false, which this repo's bad-data rule forbids
 * emitting.
 *
 * The fallback states the OPERATION and no width at all. The negative sibling
 * of the two stories above: same control, same name lookup, and the assertion
 * is that the width phrase they both depend on is absent here.
 */
export const CorruptPersistedWidth: Story = {
  args: { columnId: COLUMN_ID, label: COLUMN_LABEL, resize: STATIC_RESIZE },
  render: (args) => (
    <ResizeStory
      columnId={args.columnId ?? COLUMN_ID}
      label={args.label ?? COLUMN_LABEL}
      startWidth={Number.NaN}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Names the operation, so the keys are still discoverable...
    await expect(
      canvas.getByRole("button", {
        name: `Resize ${COLUMN_LABEL} column, use arrow keys`,
      })
    ).toBeInTheDocument();

    // ...and says nothing about a width it does not have.
    await expect(
      canvas.queryByRole("button", { name: NAN_WIDTH_NAME })
    ).toBeNull();
  },
};

/**
 * Column reorder by drag, driven THROUGH `TableGridHeaderV2`.
 *
 * The whole gesture is the header's: one `dataTransfer` crosses `dragstart` and
 * `drop`, and the story never writes the dragged id into it — the header's own
 * `onDragStart` does, and its own `onDrop` reads it back and moves the column
 * BEFORE the target. A header that stopped wiring either handler, or stopped
 * gating them on `canReorder`, leaves the order unchanged and fails here.
 *
 * The two refusals are asserted alongside the move because each is a real branch
 * a reorder can take wrongly: a drop carrying no id, and a drop of a column onto
 * itself, must both leave the order exactly as it was rather than reordering to
 * something arbitrary. The fixed column is the gate's negative case — rendered,
 * but not draggable and not a drop target, because it is absent from
 * `columnOrder`.
 */
export const ColumnReorderDrop: Story = {
  // `columnId`/`label`/`resize` are declared in `argTypes` for the resize
  // stories above but genuinely do not apply here: this story demonstrates
  // reorder across FOUR fixed, named columns at once, so a single
  // columnId/label control has nowhere sensible to attach. Kept in `args`
  // only to satisfy this story's required-args shape.
  args: { columnId: COLUMN_ID, label: COLUMN_LABEL, resize: STATIC_RESIZE },
  render: () => <ReorderStory />,
  play: async ({ canvasElement }) => {
    await expect(renderedOrder(canvasElement)).toEqual([
      "owner",
      "status",
      "updated",
      FIXED_COLUMN_ID,
    ]);

    // Dragging "updated" onto "owner" moves it before "owner".
    dragColumn(canvasElement, "updated", "owner");
    await expect(renderedOrder(canvasElement)).toEqual([
      "updated",
      "owner",
      "status",
      FIXED_COLUMN_ID,
    ]);

    // A drop carrying no dragged id changes nothing. Fired without the
    // preceding `dragstart`, so the transfer is genuinely empty.
    fireEvent.drop(headerCell(canvasElement, "owner"), {
      dataTransfer: createColumnDataTransfer(),
    });
    await expect(renderedOrder(canvasElement)).toEqual([
      "updated",
      "owner",
      "status",
      FIXED_COLUMN_ID,
    ]);

    // Neither does a column dropped on itself.
    dragColumn(canvasElement, "owner", "owner");
    await expect(renderedOrder(canvasElement)).toEqual([
      "updated",
      "owner",
      "status",
      FIXED_COLUMN_ID,
    ]);

    // The reorder GATE: a column the caller left out of `columnOrder` is not a
    // drag source and not a drop target, so dropping onto it moves nothing.
    await expect(headerCell(canvasElement, FIXED_COLUMN_ID)).toHaveAttribute(
      "draggable",
      "false"
    );
    dragColumn(canvasElement, "owner", FIXED_COLUMN_ID);
    await expect(renderedOrder(canvasElement)).toEqual([
      "updated",
      "owner",
      "status",
      FIXED_COLUMN_ID,
    ]);
  },
};

function resizeName(widthPx: number): string {
  return `Resize ${COLUMN_LABEL} column, ${widthPx} pixels wide, use arrow keys`;
}

function minimumResizeName(widthPx: number): string {
  return `Resize ${COLUMN_LABEL} column, ${widthPx} pixels wide, minimum, use arrow keys`;
}

function headerCell(canvasElement: HTMLElement, columnId: string): HTMLElement {
  const cell = canvasElement.querySelector<HTMLElement>(
    `[data-column-id="${columnId}"]`
  );
  if (!cell) {
    throw new Error(`No header cell rendered for column "${columnId}"`);
  }
  return cell;
}

/**
 * One drag, start to finish, through the header's own handlers.
 *
 * The transfer object is shared across both events exactly as the browser
 * shares it, so the dragged id reaching the drop is whatever `onDragStart`
 * wrote — never something the story put there.
 */
function dragColumn(
  canvasElement: HTMLElement,
  fromColumnId: string,
  toColumnId: string
): void {
  const dataTransfer = createColumnDataTransfer();
  fireEvent.dragStart(headerCell(canvasElement, fromColumnId), {
    dataTransfer,
  });
  fireEvent.drop(headerCell(canvasElement, toColumnId), { dataTransfer });
}

/** The `dataTransfer` surface the header writes on drag and reads on drop. */
function createColumnDataTransfer() {
  const entries = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "none",
    types: [] as string[],
    setData(type: string, value: string) {
      entries.set(type, value);
      this.types = Array.from(entries.keys());
    },
    getData: (type: string) => entries.get(type) ?? "",
  };
}

/**
 * This story's columns in render order. The header's leading identity cell
 * carries a `data-column-id` too and is not part of the reorderable order, so
 * the list is narrowed to the ids this story declared rather than to the
 * header's private literal for that cell.
 */
function renderedOrder(canvasElement: HTMLElement): string[] {
  return Array.from(
    canvasElement.querySelectorAll<HTMLElement>("[data-column-id]")
  )
    .map((header) => header.dataset.columnId ?? "")
    .filter((columnId) => STORY_COLUMN_IDS.includes(columnId));
}

function ResizeStory({
  columnId,
  label,
  startWidth,
}: {
  columnId: string;
  label: string;
  startWidth: number;
}) {
  const [width, setWidth] = useState(startWidth);

  return (
    <main className="min-h-screen bg-background p-8">
      <div
        className="relative flex h-9 items-center border-b px-3 font-medium text-sm"
        data-testid={COLUMN_TRACK_TEST_ID}
        style={{ width: Number.isFinite(width) ? `${width}px` : undefined }}
      >
        <span className="truncate">{label}</span>
        <ColumnResizeHandle
          columnId={columnId}
          label={label}
          resize={{
            columnIds: [columnId],
            getColumnWidth: () => width,
            onResize: (_columnId, widthPx) => setWidth(widthPx),
          }}
        />
      </div>
    </main>
  );
}

/**
 * The REAL header, wired for reorder exactly as `GridTableV2` wires it.
 *
 * Not a local drop target calling `handleColumnDrop` itself: that arrangement
 * re-implements the wiring under test, so it stays green through a header that
 * has stopped setting the dragged id, stopped taking the drop, or stopped gating
 * either on `canReorder`. `FIXED_COLUMN_ID` is rendered but deliberately left
 * OUT of `columnOrder`, which is the gate's own negative case.
 */
function ReorderStory() {
  const [columnOrder, setColumnOrder] = useState(REORDERABLE_COLUMN_IDS);
  const columns = [
    ...columnOrder.map((id) => ({ id, label: id, sortable: true })),
    { id: FIXED_COLUMN_ID, label: "Actions" },
  ];

  return (
    <main className="min-h-screen bg-background p-8">
      <div
        aria-colcount={columns.length + 1}
        aria-label="Artifacts"
        className="overflow-hidden rounded-md border"
        role="grid"
      >
        <TableGridHeaderV2
          columns={columns}
          gridTemplateColumns={`200px repeat(${columns.length}, 160px)`}
          insideAriaTable
          onSort={() => undefined}
          reorder={{ columnOrder, onReorder: setColumnOrder }}
          sortBy={null}
          sortDir="asc"
        />
      </div>
    </main>
  );
}
