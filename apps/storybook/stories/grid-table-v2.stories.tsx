/**
 * The `GridTableV2` primitive's own interaction contract (ISS-8490).
 *
 * `GridTableV2` holds no selection, sort, or grouping state — it reports the
 * gesture and the host decides what it means. This harness is the reference
 * answer, so every handler here is a REAL state transition a `play` asserts:
 * a story that wires `onSort={() => undefined}` demonstrates a header that
 * cannot sort, which is worse than no example.
 *
 * The pointer and the keyboard both resolve through the shared
 * `resolveGridRowSelection` contract, which is the whole point: without
 * `onRowKeyboardNavigate` the grid falls back to synthesizing an UNMODIFIED
 * click on the destination cell, so `Shift+ArrowDown` silently replaces the
 * selection where `Shift`-click extends it.
 */
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import {
  buildGridTableV2CardFields,
  GRID_TABLE_V2_ADD_FIELD_TRACK,
  GRID_TABLE_V2_FAVORITE_TRACK,
  GridTableV2,
  GridTableV2Card,
  type GridTableV2Column,
  type GridTableV2Group,
} from "@repo/design-system/components/ui/grid-table-v2";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  TableChoiceCell,
  TableDateCell,
  TableFavoriteCell,
  TableIdentityCell,
  TableNumberCell,
  TablePersonCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import {
  COLUMN_RESIZE_KEYBOARD_STEP_PX,
  type ColumnMovePlacement,
  moveColumnPlacement,
} from "@repo/design-system/lib/column-order";
import { ColumnAlignment } from "@repo/design-system/lib/column-registry";
import {
  EMPTY_GRID_ROW_SELECTION,
  type GridRowSelection,
  type GridSelectionModifiers,
  resolveGridRowSelection,
  selectAllGridRows,
  toggleGridRowSelection,
} from "@repo/design-system/lib/grid-table-v2-selection";
import type { Meta, StoryObj } from "@storybook/react";
import { FileIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { expect, screen, userEvent, within } from "storybook/test";
import {
  clickRowCell,
  focusRowCell,
  gridTemplateTracks,
  renderedGroups,
  renderedRowIds,
  selectedRowIds,
} from "./grid-table-v2-play-helpers";
import {
  buildGroups,
  buildLongRowFixture,
  COLUMNS,
  DATA_COLUMN_WIDTH_PX,
  FIXTURE_ORDER,
  type GridStoryRow,
  LEAD_COLUMN_WIDTH_PX,
  OWNER_ASCENDING_ORDER,
  ROWS,
  sortRows,
} from "./grid-table-v2-story-model";
import { FrozenGridTableV2 } from "./support/frozen-grid-table-v2-card-list";

const meta = {
  title: "Composites v1.0/Data Display/Tables/Grid Table V2",
  tags: ["deprecated"],
  component: GridTableV2,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GridTableV2>;

export default meta;
type Story = StoryObj;

/**
 * Sorting is a state transition, not a menu that opens. The assertion is the
 * whole rendered order, so a handler that sorts by the wrong key — or reverses
 * only some rows — fails even though "Sort ascending" was clicked.
 */
export const SortingContract: Story = {
  render: () => <GridTableV2StoryHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(renderedRowIds(canvasElement)).toEqual(FIXTURE_ORDER);

    await openColumnMenu(canvas, "Owner");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Sort ascending" })
    );
    await expect(renderedRowIds(canvasElement)).toEqual(OWNER_ASCENDING_ORDER);

    await openColumnMenu(canvas, "Owner");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Sort descending" })
    );
    await expect(renderedRowIds(canvasElement)).toEqual(
      [...OWNER_ASCENDING_ORDER].reverse()
    );
  },
};

/**
 * A Shift range covers the rows the grid PAINTED, not the fixture's own order.
 * The two agree until something reorders the table, which is why this story
 * sorts first: under `OWNER_ASCENDING_ORDER` the painted span from the anchor
 * to the target holds three rows that the fixture-order span does not.
 */
export const PointerRangeFollowsPaintedOrder: Story = {
  render: () => <GridTableV2StoryHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openColumnMenu(canvas, "Owner");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Sort ascending" })
    );
    await expect(renderedRowIds(canvasElement)).toEqual(OWNER_ASCENDING_ORDER);

    clickRowCell(canvasElement, "artifact-2", "status");
    clickRowCell(canvasElement, "artifact-1", "status", { shiftKey: true });

    await expect(selectedRowIds(canvasElement)).toEqual([
      "artifact-2",
      "artifact-4",
      "artifact-1",
    ]);
  },
};

/**
 * The AC2 case: one contract, two input devices. Each assertion names the exact
 * selected set, so "some row got selected" cannot satisfy it.
 */
export const KeyboardMatchesPointerContract: Story = {
  render: () => <GridTableV2StoryHarness />,
  play: async ({ canvasElement }) => {
    // The pointer sets the anchor; the keyboard extends from it. An anchor that
    // did not cross input modes would extend from the grid's first row instead.
    clickRowCell(canvasElement, "artifact-1", "status");
    await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    await expect(selectedRowIds(canvasElement)).toEqual([
      "artifact-1",
      "artifact-2",
      "artifact-3",
    ]);

    // Bare Space is the keyboard's spelling of a Ctrl/Cmd-click: flip ONE row
    // and leave the rest of the selection standing.
    focusRowCell(canvasElement, "artifact-2", "status");
    await userEvent.keyboard("[Space]");
    await expect(selectedRowIds(canvasElement)).toEqual([
      "artifact-1",
      "artifact-3",
    ]);

    await userEvent.keyboard("{Control>}a{/Control}");
    await expect(selectedRowIds(canvasElement)).toEqual(FIXTURE_ORDER);
  },
};

/**
 * ISS-8930's mode, MOUNTED rather than only asserted in a unit test: with it
 * open the column headers are cells of the grid, so they take focus, paint the
 * shared focus ring, and answer the arrow keys.
 *
 * The assertion walks OUT of the body and back, because that crossing is the
 * whole change — a header that merely gained an attribute would satisfy a
 * markup check and still be unreachable.
 */
export const NavigableHeaderCellsContract: Story = {
  render: () => <GridTableV2StoryHarness navigableHeaderCells />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    focusRowCell(canvasElement, "artifact-1", "status");
    await userEvent.keyboard("{ArrowUp}");

    const statusHeader = canvas.getByRole("columnheader", {
      name: STATUS_HEADER_NAME,
    });
    await expect(statusHeader).toHaveFocus();
    // Same column, not merely "a header" — a row-wise move preserves the track.
    await expect(statusHeader).toHaveAttribute("data-grid-cell", "");

    // And back down into the row it came from, so the crossing is not one-way.
    await userEvent.keyboard("{ArrowDown}");
    await expect(statusHeader).not.toHaveFocus();
  },
};

/**
 * The same mode WITH BANDS, which is the branch ISS-8930 actually added and the
 * one the ungrouped story above cannot reach (davetho review): a group-section
 * header is a chrome row of its own, and until a story mounts grouping it exists
 * only in a unit test — invisible to Storybook and to every visual-review pass.
 *
 * The walk crosses BOTH seams in one move sequence — data row → band header →
 * column header — because the transitions are the contract; a band header that
 * merely rendered focusable would satisfy a markup check and still be a stop the
 * arrows fall through.
 */
export const GroupedNavigableHeaderCellsContract: Story = {
  render: () => (
    <GridTableV2StoryHarness initialGroupBy="status" navigableHeaderCells />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bands = renderedGroups(canvasElement);
    // Grouping actually happened, so the walk below is over bands rather than a
    // flat list that would make the two ArrowUps below indistinguishable.
    await expect(bands.length).toBeGreaterThan(1);
    const firstRowId = bands[0]?.rowIds[0];
    if (firstRowId === undefined) {
      throw new Error("the first band rendered no rows");
    }
    focusRowCell(canvasElement, firstRowId, "status");

    // ONE ArrowUp is NOT enough, and that is the whole assertion. Ungrouped,
    // one step reaches the column headers (the story above); here a band header
    // sits between, so a grid that fell through it would already be on a
    // `columnheader` at this point.
    await userEvent.keyboard("{ArrowUp}");
    await expect(activeCellRole(canvasElement)).toBe("gridcell");

    // And the second step chains the two chrome rows, so the band header is a
    // stop the arrows pass THROUGH rather than a dead end they stick on.
    //
    // Which column it lands in is NOT pinned, deliberately: a band header paints
    // one cell spanning every track, so `resolveNextGridCell` has no matching
    // column to preserve and falls back to the header's first cell — the same
    // short-row path an after-row slot has taken since ISS-8219. Naming a track
    // here would pin that fallback as if it were the contract.
    await userEvent.keyboard("{ArrowUp}");
    await expect(activeCellRole(canvasElement)).toBe("columnheader");
    await expect(
      canvas
        .getAllByRole("columnheader")
        .some((cell) => cell === document.activeElement)
    ).toBe(true);
  },
};

/**
 * ISS-8747's mode, mounted for the same reason: a press-and-drag across rows
 * resolves the range through the one selection contract the click and the
 * keyboard already use.
 *
 * Driven with real pointer events rather than the story's click helper, because
 * the drag is precisely what a click cannot express.
 */
export const RowRangeDragContract: Story = {
  render: () => <GridTableV2StoryHarness enableRowRangeDrag />,
  play: async ({ canvasElement }) => {
    const rows = Array.from(
      canvasElement.querySelectorAll<HTMLElement>("[data-grid-selectable-row]")
    );
    await expect(rows.length).toBeGreaterThan(2);
    const gridBody =
      canvasElement.querySelector<HTMLElement>("[data-grid-body]");
    await expect(gridBody).not.toBeNull();

    // The drag resolves the row under the pointer from each row's box, and this
    // suite runs under jsdom, which lays nothing out — every box is 0x0, so
    // every sample would land on the press row and the drag could never reach a
    // second one. Give the rows a synthetic band ONLY when the environment
    // reported no height; a real browser keeps its own geometry.
    const rowTop = (index: number) => index * SYNTHETIC_ROW_HEIGHT_PX;
    if (rows[0]?.getBoundingClientRect().height === 0) {
      rows.forEach((row, index) => {
        row.getBoundingClientRect = () =>
          ({
            bottom: rowTop(index) + SYNTHETIC_ROW_HEIGHT_PX,
            height: SYNTHETIC_ROW_HEIGHT_PX,
            left: 0,
            right: 600,
            top: rowTop(index),
            width: 600,
            x: 0,
            y: rowTop(index),
            toJSON: () => ({}),
          }) as DOMRect;
      });
    }
    // Parenthesised, because `??` binds looser than `+`: without them the
    // fallback was `0 + SYNTHETIC_ROW_HEIGHT_PX / 2` and the half-row offset was
    // never added to a real `top` at all (tamsinb review cid 3930319802). The
    // trailing `+ 1` that used to stand in for that offset goes with it.
    const centreOf = (index: number) =>
      Math.round(
        (rows[index]?.getBoundingClientRect().top ?? 0) +
          SYNTHETIC_ROW_HEIGHT_PX / 2
      );

    await userEvent.pointer([
      {
        coords: { clientY: centreOf(0) },
        keys: "[MouseLeft>]",
        target: rows[0] as HTMLElement,
      },
      {
        coords: { clientY: centreOf(2) },
        target: gridBody as HTMLElement,
      },
      { keys: "[/MouseLeft]", target: gridBody as HTMLElement },
    ]);

    // The press row plus every row the pointer crossed, in painted order.
    await expect(selectedRowIds(canvasElement)).toEqual(
      FIXTURE_ORDER.slice(0, 3)
    );
  },
};

/** Row band height used only where the environment lays nothing out. */
const SYNTHETIC_ROW_HEIGHT_PX = 44;

/**
 * Grouping repaints the body as collapsible sections. The assertion is each
 * section's MEMBERSHIP, so a handler that groups by the wrong column — or drops
 * a row on the floor — fails where "some sections appeared" would not.
 */
export const GroupingContract: Story = {
  render: () => <GridTableV2StoryHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(renderedGroups(canvasElement)).toEqual([]);

    await openColumnMenu(canvas, "Status");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Group" })
    );

    await expect(renderedGroups(canvasElement)).toEqual([
      { label: "In review", rowIds: ["artifact-1"] },
      { label: "Active", rowIds: ["artifact-2", "artifact-4"] },
      { label: "Draft", rowIds: ["artifact-3"] },
    ]);
  },
};

/**
 * Resizing is keyboard-operable — the handle says so in its own accessible name
 * — and the host must fold the reported width back into its own track. The
 * assertion is the rendered TRACK rather than a readout the story prints for
 * itself, so a harness that accepts the callback and never applies it fails.
 */
export const KeyboardResizeContract: Story = {
  render: () => <GridTableV2StoryHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const leadHandle = canvas.getByRole("button", {
      name: LEAD_RESIZE_HANDLE_NAME,
    });
    leadHandle.focus();

    // Two steps rather than one, so what is asserted is the STEP SIZE and not
    // the seeded width.
    await userEvent.keyboard("{ArrowRight}");
    const firstStep = leadTrackPx(canvasElement);
    await userEvent.keyboard("{ArrowRight}");
    await expect(leadTrackPx(canvasElement) - firstStep).toBe(
      COLUMN_RESIZE_KEYBOARD_STEP_PX
    );

    // The data columns resize through a separate prop, so one wired and the
    // other dropped is a state this story can actually reach.
    const ownerHandle = canvas.getByRole("button", {
      name: OWNER_RESIZE_HANDLE_NAME,
    });
    ownerHandle.focus();
    const beforeOwner = gridTemplateTracks(canvasElement);
    await userEvent.keyboard("{ArrowRight}");
    const afterOwner = gridTemplateTracks(canvasElement);
    await expect(
      trackPx(afterOwner, OWNER_TRACK_INDEX) -
        trackPx(beforeOwner, OWNER_TRACK_INDEX)
    ).toBe(COLUMN_RESIZE_KEYBOARD_STEP_PX);
  },
};

/** The favorite star is the leading utility cell's own state transition. */
export const FavoriteContract: Story = {
  render: () => <GridTableV2StoryHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const favorite = canvas.getByRole("button", {
      name: "Add Unified artifact experience to favorites",
    });
    await expect(favorite).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(favorite);
    await expect(
      canvas.getByRole("button", {
        name: "Remove Unified artifact experience from favorites",
      })
    ).toHaveAttribute("aria-pressed", "true");
  },
};

/**
 * The pinned lead REGION (ISS-9223, whitlockk cid 3937659233).
 *
 * The favourite track ahead of the identity cell is the shape `GridTable` v1
 * declines to pin, and until this story the corpus only ever rendered it
 * UNPINNED — so the one arrangement the pin actually has to get right had no
 * visual reference. The harness is narrowed to {@link PINNED_VIEWPORT_WIDTH_PX}
 * so the table genuinely overflows and a reviewer (or Chromatic) sees the
 * pinned region against columns it has to hold still in front of.
 *
 * The `play` deliberately stops at the anchors. `story-sweep.test.tsx` is the
 * only thing that executes a play in this repo and it runs under jsdom, which
 * neither lays out nor applies a stylesheet — a bounding-box assertion there
 * would be measuring nothing and would pass on a table with no sticky rule at
 * all. The under-scroll proof lives where a layout engine exists:
 * `e2e/sessions-pinned-lead-column.spec.ts`.
 */
export const PinnedLeadRegionContract: Story = {
  render: () => (
    <GridTableV2StoryHarness
      pinLeadColumn
      viewportWidthPx={PINNED_VIEWPORT_WIDTH_PX}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Both halves of the region, and the ANCHORS that make it one region: the
    // star holds the left edge, the identity cell clears the declared 36px
    // track. A pin that regressed to `left: 0` on the identity cell would park
    // the name on top of the star and still look "pinned" to a sticky check.
    const favoriteCell = closestGridCell(
      canvas.getByRole("button", {
        name: `Add ${PINNED_ROW_TITLE} to favorites`,
      })
    );
    const identityCell = closestGridCell(canvas.getByText(PINNED_ROW_TITLE));

    await expect(favoriteCell).toHaveClass(PINNED_STICKY_CLASS);
    await expect(favoriteCell).toHaveClass(PINNED_LEFT_EDGE_CLASS);
    await expect(identityCell).toHaveClass(PINNED_STICKY_CLASS);
    await expect(identityCell).not.toHaveClass(PINNED_LEFT_EDGE_CLASS);
    await expect(identityCell.style.left).toBe(GRID_TABLE_V2_FAVORITE_TRACK);
  },
};

/**
 * ISS-10535. The one press two gestures compete for: `onGroupDrop` makes every
 * row a native HTML drag source, and `dragstart` fires at the browser's own
 * few-pixel threshold, so only an `Alt`-modified press can still start a range.
 *
 * No `play`. The only thing that resolves this is a real compositor firing
 * `dragstart`, which jsdom never does — `e2e/grid-table-v2-row-drag-race.local-trusted.spec.ts`
 * drives both presses against this story in a browser.
 */
export const RowRangeDragWithGroupDropContract: Story = {
  render: () => (
    <GridTableV2StoryHarness
      enableRowRangeDrag
      groupDrop
      initialGroupBy="status"
    />
  ),
};

/**
 * ISS-10535's control: the same table with nothing else claiming the press, so
 * an UNMODIFIED press still starts a range. Paired with the story above, it is
 * what stops that one's "the range did not start" reading as "the harness never
 * mounted".
 */
export const RowRangeDragWithoutGroupDropContract: Story = {
  render: () => (
    <GridTableV2StoryHarness enableRowRangeDrag initialGroupBy="status" />
  ),
};

function GridTableV2StoryHarness({
  alignValuesToColumn = false,
  columns = COLUMNS,
  enableRowRangeDrag = false,
  groupDrop = false,
  initialGroupBy = null,
  initialRows = ROWS,
  navigableHeaderCells = false,
  pinLeadColumn = false,
  viewportWidthPx,
  virtualizeRows = false,
}: {
  /** ISS-9821's table-level gate, paired with an aligned column below. */
  alignValuesToColumn?: boolean;
  /**
   * The column set to mount. Defaults to {@link COLUMNS}; a visual mode that
   * lives in a column DECLARATION (alignment) has no other way into the
   * corpus, since every other knob here is a table-level flag.
   */
  columns?: readonly GridTableV2Column[];
  enableRowRangeDrag?: boolean;
  /**
   * Wires `onGroupDrop`, which is what makes every row a native HTML drag
   * source — the other half of the ISS-10535 collision. Paired with
   * `initialGroupBy` so the drop has a section to land in and moves the row for
   * real. A drop empties the band it was the last row of, and this harness
   * holds no undo, so that band is gone until the story is reloaded.
   */
  groupDrop?: boolean;
  /**
   * Seeds the grouping the harness would otherwise only reach through a column
   * menu. A visual mode that needs bands has to MOUNT with them (davetho
   * review): a story that opens `navigableHeaderCells` while `groupBy` is still
   * null never paints a group-section header, so the branch the flag added is
   * absent from Storybook and from every visual-review pass over it.
   */
  initialGroupBy?: string | null;
  /**
   * The population to mount. Defaults to {@link ROWS}; only the windowed body
   * needs more, and it needs enough that the window is a visible fraction of
   * the whole.
   */
  initialRows?: readonly GridStoryRow[];
  navigableHeaderCells?: boolean;
  pinLeadColumn?: boolean;
  /**
   * Narrows the scroll container so the ~1,076px track set overflows it
   * whatever width the Storybook canvas happens to be. Only the pinning story
   * needs it: a table that fits has nothing to scroll and would assert nothing.
   */
  viewportWidthPx?: number;
  /** ISS-12288's windowed body. */
  virtualizeRows?: boolean;
} = {}) {
  const [selection, setSelection] = useState<GridRowSelection>(
    EMPTY_GRID_ROW_SELECTION
  );
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [columnOrder, setColumnOrder] = useState(columns.map(({ id }) => id));
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() =>
    Object.fromEntries(columns.map(({ id }) => [id, DATA_COLUMN_WIDTH_PX]))
  );
  const [leadColumnWidth, setLeadColumnWidth] = useState(LEAD_COLUMN_WIDTH_PX);
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [groupBy, setGroupBy] = useState<string | null>(initialGroupBy);
  // Stateful so a group drop is a REAL move rather than a handler that reports
  // nothing; the seed is `ROWS` itself, so every other story is unchanged.
  const [rows, setRows] = useState<readonly GridStoryRow[]>(initialRows);

  const visibleRows = useMemo(
    () => sortRows(rows, sortBy, sortDir),
    [rows, sortBy, sortDir]
  );
  const groups = useMemo(
    () => buildGroups(visibleRows, groupBy),
    [groupBy, visibleRows]
  );
  const gridTemplateColumns = [
    GRID_TABLE_V2_FAVORITE_TRACK,
    `${leadColumnWidth}px`,
    ...columnOrder.map((id) => `${columnWidths[id]}px`),
    GRID_TABLE_V2_ADD_FIELD_TRACK,
  ].join(" ");

  const applyGroupDrop = (
    row: GridStoryRow,
    group: GridTableV2Group<GridStoryRow>
  ) =>
    setRows((current) =>
      current.map((candidate) =>
        // The field the table is GROUPED BY, never a fixed one. `groupBy` is
        // state and both groupable columns are reachable from the header menu,
        // so writing `status` unconditionally would stamp an Owner band's key
        // into the Status cell — a move the table did not make.
        candidate.id === row.id && groupBy !== null
          ? { ...candidate, [groupBy]: group.key }
          : candidate
      )
    );

  /** Pointer click and keyboard navigation, resolved by the one contract. */
  const selectRow = (
    row: GridStoryRow,
    event: GridSelectionModifiers,
    renderedRows: readonly GridStoryRow[]
  ) =>
    setSelection((current) =>
      resolveGridRowSelection(
        current,
        row.id,
        event,
        renderedRows.map(({ id }) => id)
      )
    );

  return (
    <div
      className="h-screen overflow-auto bg-background"
      style={
        viewportWidthPx === undefined ? undefined : { width: viewportWidthPx }
      }
    >
      <GridTableV2
        alignValuesToColumn={alignValuesToColumn}
        columnOrder={columnOrder}
        columns={columns}
        columnWidths={columnWidths}
        enableRowRangeDrag={enableRowRangeDrag}
        getRowId={(row) => row.id}
        gridTemplateColumns={gridTemplateColumns}
        groups={groups}
        headerActions={{
          getFilterContent: () => <p className="p-3 text-sm">Filter values</p>,
          onGroup: setGroupBy,
          onMove: (id, placement: ColumnMovePlacement) =>
            setColumnOrder((current) =>
              moveColumnPlacement(current, id, placement)
            ),
        }}
        isRowSelected={(row) => selection.selectedIds.has(row.id)}
        items={visibleRows}
        leadingColumnWidth={leadColumnWidth}
        leadingLabel="Artifact"
        leadingSortKey="name"
        leadingUtilityLabel="Favorite"
        navigableHeaderCells={navigableHeaderCells}
        onColumnOrderChange={setColumnOrder}
        onColumnWidthChange={(id, width) =>
          setColumnWidths((current) => ({ ...current, [id]: width }))
        }
        onGroupDrop={groupDrop ? applyGroupDrop : undefined}
        onLeadingColumnWidthChange={setLeadColumnWidth}
        onRowClick={selectRow}
        onRowKeyboardNavigate={selectRow}
        onRowRangeDrag={selectRow}
        onRowSelectionToggle={(row) =>
          setSelection((current) => toggleGridRowSelection(current, row.id))
        }
        onSelectAllRows={(rows) =>
          setSelection(selectAllGridRows(rows.map(({ id }) => id)))
        }
        onSort={(columnId, direction) => {
          setSortBy(columnId);
          setSortDir(direction);
        }}
        pinLeadColumn={pinLeadColumn}
        renderCell={renderCell}
        renderLead={(row) => (
          <TableIdentityCell
            icon={FileIcon}
            slug={row.slug}
            title={row.title}
          />
        )}
        renderLeadingUtility={(row) => (
          <TableFavoriteCell
            favorited={favoriteIds.has(row.id)}
            itemLabel={row.title}
            onFavoriteChange={(favorited) =>
              setFavoriteIds((current) => {
                const next = new Set(current);
                if (favorited) {
                  next.add(row.id);
                } else {
                  next.delete(row.id);
                }
                return next;
              })
            }
          />
        )}
        sortBy={sortBy}
        sortDir={sortDir}
        virtualizeRows={virtualizeRows}
      />
    </div>
  );
}

async function openColumnMenu(
  canvas: ReturnType<typeof within>,
  label: string
): Promise<void> {
  await userEvent.click(
    canvas.getByRole("button", { name: `${label} column options` })
  );
}

/** The lead column's track: after the favorite track, before the data columns. */
function leadTrackPx(canvasElement: HTMLElement): number {
  return trackPx(gridTemplateTracks(canvasElement), LEAD_TRACK_INDEX);
}

function trackPx(tracks: readonly string[], index: number): number {
  const track = tracks[index];
  if (track === undefined) {
    throw new Error(`grid rendered no track at index ${index}`);
  }
  return Number.parseInt(track, 10);
}

/**
 * One canonical cell per data shape, per the table-cell contract in
 * `apps/storybook/AGENTS.md`. `type` is a categorical value like `status`, so it
 * is a `TableChoiceCell` too — rendering it as text here would show two answers
 * for one shape in the story a builder copies from. An unrecognised column
 * renders the absent-value primitive rather than falling through to some other
 * column's value.
 */
function renderCell(columnId: string, row: GridStoryRow) {
  if (columnId === "type") {
    return <TableChoiceCell label={row.type} />;
  }
  if (columnId === "status") {
    return <TableChoiceCell label={row.status} />;
  }
  if (columnId === "owner") {
    return <TablePersonCell person={{ name: row.owner }} />;
  }
  if (columnId === "updated") {
    return <TableDateCell fullValue={row.updatedAt} value={row.updated} />;
  }
  if (columnId === RUN_COLUMN_ID) {
    return <TableNumberCell value={row.runNumber} />;
  }
  if (columnId === COST_COLUMN_ID) {
    return <TableNumberCell value={row.cost} />;
  }
  return <GridEmptyValue />;
}

/** Track order is favorite, lead, then the data columns in `COLUMNS` order. */
const LEAD_TRACK_INDEX = 1;
const OWNER_TRACK_INDEX = 4;
/**
 * The handle announces its current width once it has one, so these tolerate both
 * the seeded "Resize X column, use arrow keys" and the resized
 * "Resize X column, N pixels wide, use arrow keys".
 */
const LEAD_RESIZE_HANDLE_NAME = /^Resize Artifact column,.*use arrow keys$/;
const OWNER_RESIZE_HANDLE_NAME = /^Resize Owner column,.*use arrow keys$/;

/**
 * Parent/child row lineage (ISS-8921). The rows form ONE table, not a tree
 * beside a table: a child is a row of the same grid, at the same tracks, with
 * `aria-level` saying how deep it sits.
 *
 * The play drives the disclosure and asserts the PAINTED rows plus the ARIA the
 * row publishes, because those are the two halves a reader and a screen reader
 * respectively depend on — a story that only opened the row would pass against
 * a grid that indented the label and told assistive tech nothing.
 */
export const NestedRowsContract: Story = {
  render: () => <GridTableV2NestedHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(renderedRowIds(canvasElement)).toEqual(NESTED_ROOT_ORDER);

    await userEvent.click(canvas.getByRole("button", { name: "Expand row" }));
    await expect(renderedRowIds(canvasElement)).toEqual(NESTED_EXPANDED_ORDER);
    await expect(nestedRow(canvasElement, "spec-parent")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await expect(nestedRow(canvasElement, "spec-child-a")).toHaveAttribute(
      "aria-level",
      "2"
    );
    // A leaf owns no disclosure, so it must not claim one in the a11y tree.
    await expect(nestedRow(canvasElement, "spec-child-b")).not.toHaveAttribute(
      "aria-expanded"
    );

    // Third level: the depth at which the indent is worth looking at, and the
    // one a two-level fixture would never render.
    await userEvent.click(
      within(nestedRow(canvasElement, "spec-child-a")).getByRole("button", {
        name: "Expand row",
      })
    );
    await expect(renderedRowIds(canvasElement)).toEqual(NESTED_DEEP_ORDER);
    await expect(nestedRow(canvasElement, "spec-grandchild")).toHaveAttribute(
      "aria-level",
      "3"
    );

    await userEvent.click(
      within(nestedRow(canvasElement, "spec-parent")).getByRole("button", {
        name: "Collapse row",
      })
    );
    await expect(renderedRowIds(canvasElement)).toEqual(NESTED_ROOT_ORDER);
  },
};

type NestedStoryRow = GridStoryRow & { children?: NestedStoryRow[] };

function buildNestedRow(
  id: string,
  title: string,
  children?: NestedStoryRow[]
): NestedStoryRow {
  return {
    children,
    id,
    owner: "Ada Lovelace",
    slug: id,
    status: "In review",
    title,
    type: "Document",
    updated: "Mar 3",
    updatedAt: "2026-03-03",
  };
}

/**
 * Three levels deep, because level 3 is where the indent actually costs the
 * identity column something a reviewer should look at: a two-level fixture
 * cannot show whether a grandchild's label still has room beside its indent.
 */
const NESTED_ROWS: readonly NestedStoryRow[] = [
  buildNestedRow("spec-parent", "Payments spec", [
    buildNestedRow("spec-child-a", "Checkout flow", [
      buildNestedRow("spec-grandchild", "3DS step-up"),
    ]),
    buildNestedRow("spec-child-b", "Refund flow"),
  ]),
  buildNestedRow("spec-standalone", "Billing runbook"),
];

const NESTED_ROOT_ORDER = ["spec-parent", "spec-standalone"];
const NESTED_EXPANDED_ORDER = [
  "spec-parent",
  "spec-child-a",
  "spec-child-b",
  "spec-standalone",
];
const NESTED_DEEP_ORDER = [
  "spec-parent",
  "spec-child-a",
  "spec-grandchild",
  "spec-child-b",
  "spec-standalone",
];

const NESTED_GRID_TEMPLATE = [
  `${LEAD_COLUMN_WIDTH_PX}px`,
  ...COLUMNS.map(() => `${DATA_COLUMN_WIDTH_PX}px`),
].join(" ");

function nestedRow(canvasElement: HTMLElement, rowId: string): HTMLElement {
  const row = canvasElement.querySelector<HTMLElement>(
    `[data-grid-row-id="${rowId}"]`
  );
  if (!row) {
    throw new Error(`grid painted no row for ${rowId}`);
  }
  return row;
}

function GridTableV2NestedHarness() {
  return (
    <GridTableV2<NestedStoryRow>
      columns={COLUMNS}
      getChildren={(row) => row.children}
      getRowId={(row) => row.id}
      gridTemplateColumns={NESTED_GRID_TEMPLATE}
      items={[...NESTED_ROWS]}
      leadingLabel="Artifact"
      renderCell={renderCell}
      renderLead={(row) => (
        <TableIdentityCell icon={FileIcon} slug={row.slug} title={row.title} />
      )}
    />
  );
}

/**
 * The SAME lineage in the narrow layout, which is a card LIST and not a grid.
 *
 * whitlockk review: `NestedRowsContract` above mounts only the grid path, and the
 * compact branch is not a restyling of it. It moves the disclosure to the card's
 * leading edge, and — because a list paints no `row` to hang the state on — it
 * moves `aria-expanded` onto the CONTROL. Neither the layout nor that attribute
 * placement had anything on screen for a reviewer to look at until this story,
 * which is the layout a phone actually gets.
 *
 * Asserting `aria-expanded` on the button is also what pins this story to the
 * compact branch: the grid deliberately leaves that attribute OFF this control,
 * so a `mode` that stopped forcing cards reddens the play here rather than
 * quietly re-running the grid story under a second name.
 *
 * Two levels, not the grid story's three: depth is the grid's contract, carried
 * by `aria-level`. What a list has instead is the indent and the disclosure, and
 * one nested set shows both.
 */
export const NestedRowsCompactContract: Story = {
  render: () => <GridTableV2NestedCardHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(renderedCardIds(canvasElement)).toEqual(NESTED_ROOT_ORDER);

    const disclosure = canvas.getByRole("button", { name: "Expand row" });
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(disclosure);
    await expect(renderedCardIds(canvasElement)).toEqual(NESTED_EXPANDED_ORDER);
    await expect(
      canvas.getByRole("button", { name: "Collapse row" })
    ).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(canvas.getByRole("button", { name: "Collapse row" }));
    await expect(renderedCardIds(canvasElement)).toEqual(NESTED_ROOT_ORDER);
  },
};

/** The cards this render painted, in visible order — a list has no grid rows. */
function renderedCardIds(canvasElement: HTMLElement): string[] {
  return Array.from(
    canvasElement.querySelectorAll<HTMLElement>("[data-nested-card-id]")
  ).map((card) => card.dataset.nestedCardId ?? "");
}

/**
 * The card header carries the identity, which is not one of `COLUMNS` — so no
 * data column duplicates it and none is held back from the field list.
 */
const NESTED_CARD_HEADER_COLUMN_IDS: ReadonlySet<string> = new Set<string>();

function GridTableV2NestedCardHarness() {
  return (
    <FrozenGridTableV2<NestedStoryRow>
      cardRender={(row, cardColumns) => (
        <div data-nested-card-id={row.id}>
          <GridTableV2Card
            fields={buildGridTableV2CardFields(
              cardColumns,
              NESTED_CARD_HEADER_COLUMN_IDS,
              renderCell,
              row
            )}
            header={
              <TableIdentityCell
                icon={FileIcon}
                slug={row.slug}
                title={row.title}
              />
            }
          />
        </div>
      )}
      columns={COLUMNS}
      getChildren={(row) => row.children}
      getRowId={(row) => row.id}
      gridTemplateColumns={NESTED_GRID_TEMPLATE}
      items={[...NESTED_ROWS]}
      leadingLabel="Artifact"
      mode="compact"
      renderCell={renderCell}
      renderLead={(row) => (
        <TableIdentityCell icon={FileIcon} slug={row.slug} title={row.title} />
      )}
    />
  );
}

/**
 * Narrow enough that the harness's ~1,076px of tracks (36px favourite + 280px
 * lead + four 180px data columns + the 40px add-field track) overflow it by
 * ~356px, whatever width the Storybook canvas is.
 */
const PINNED_VIEWPORT_WIDTH_PX = 720;
/** The fixture row {@link PinnedLeadRegionContract} follows through the scroll. */
const PINNED_ROW_TITLE = "Unified artifact experience";

/** The two anchor classes the pinned region's halves must NOT share. */
const PINNED_STICKY_CLASS = "sticky";
const PINNED_LEFT_EDGE_CLASS = "left-0";

/**
 * End-aligned column headers (ISS-9313, whitlockk cid 3961205954).
 *
 * `align` is a new visual mode and every other story mounts start-aligned
 * columns only, so without this one the geometry it changes — the label sized
 * to its content rather than eating the row, the sort caret and options chevron
 * LEADING the label instead of trailing it, the cell's `pr-3` — never reaches a
 * visual pass.
 *
 * `Updated` is the end-aligned one because a right-aligned column next to
 * start-aligned neighbours is the arrangement the inset bug (ISS-5333) shows up
 * in: a caret that trails the label right-aligns the CARET and leaves the word
 * inset by its width, which only reads as wrong beside a column that is not.
 *
 * No `play`: the geometry is a layout fact, and `story-sweep.test.tsx` runs
 * plays under jsdom, which applies no stylesheet — an assertion there would
 * measure nothing and pass against a header that never moved. The class-level
 * contract is pinned in
 * `packages/design-system/__tests__/grid-table-v2-column-declarations.test.tsx`.
 */
export const EndAlignedColumnsContract: Story = {
  render: () => <GridTableV2StoryHarness columns={END_ALIGNED_COLUMNS} />,
};

/**
 * A column's alignment reaching the VALUE, not only the header (ISS-9821).
 *
 * `EndAlignedColumnsContract` above mounts the header half, and the value half
 * is not a restyling of it: `TableNumberCell` right-aligns ITSELF with
 * `ml-auto`, so with `alignValuesToColumn` closed a column asking for the
 * leading edge paints a start-aligned header over a right-aligned figure. This
 * is the branch where the figure actually moves, and no other story mounts a
 * `TableNumberCell` inside this grid at all.
 *
 * The two figure columns sit side by side ON PURPOSE. A figure at the leading
 * edge only reads as deliberate beside one that is not, and the pair also shows
 * WHICH numbers earn the move: `Run` is an ordinal that reads as a label, `Cost`
 * is a magnitude whose decimals have to line up.
 *
 * No `play`: the geometry is a layout fact and `story-sweep.test.tsx` runs plays
 * under jsdom, which applies no stylesheet — an assertion there would measure
 * nothing. The class-level contract is pinned in
 * `packages/design-system/__tests__/grid-table-v2-column-declarations.test.tsx`.
 */
export const ValueFollowsColumnAlignmentContract: Story = {
  render: () => (
    <GridTableV2StoryHarness alignValuesToColumn columns={FIGURE_COLUMNS} />
  ),
};

/**
 * ISS-12288's windowed body, at the 500-row page the Sessions list can reach.
 *
 * The harness's own `h-screen overflow-auto` wrapper is the scroller the window
 * is measured against, which is also what makes this the branch the production
 * code runs on: `GridTableV2` finds its scroller rather than being handed one,
 * so a story that mounted the grid with nothing scrolling above it would paint
 * all 500 rows and demonstrate the opt-out.
 *
 * It mounts `pinLeadColumn` and the narrowed viewport too, matching
 * `PinnedLeadRegionContract` (visual-QA review). Both are UNCONDITIONAL on
 * Sessions, so a story that windowed the body without them would be the one
 * place to look at the windowed grid and would not show the combination that
 * ships — and the sticky lead cells are the part a reader would most expect a
 * window to disturb.
 *
 * No controls: this is a fixture story, and the window is a measured layout fact
 * rather than a prop a reader toggles.
 *
 * No `play` either, for the reason the alignment stories above give — plays run
 * under jsdom in `story-sweep.test.tsx`, which has no layout engine, so the
 * scroller reports no height and the grid correctly paints every row there. An
 * assertion about the window would be trivially true in the only environment it
 * runs in. The windowing contract is pinned in
 * `packages/design-system/__tests__/grid-table-v2-virtualized-rows.test.tsx`,
 * which supplies the viewport jsdom cannot.
 */
export const VirtualizedRowsContract: Story = {
  render: () => (
    <GridTableV2StoryHarness
      initialRows={LONG_ROWS}
      navigableHeaderCells
      pinLeadColumn
      viewportWidthPx={PINNED_VIEWPORT_WIDTH_PX}
      virtualizeRows
    />
  ),
};

/** A page at `TABLE_PAGE_SIZE_MAX`, the largest the Sessions list can request. */
const LONG_ROWS = buildLongRowFixture(500);

const RUN_COLUMN_ID = "run";
const COST_COLUMN_ID = "cost";
/**
 * {@link COLUMNS} plus the two figure columns that make the mode legible, and
 * the pairing is the point rather than a convenience.
 *
 * `Run` is an ORDINAL — `#1042` beside `#5` is a name, not a magnitude — so the
 * leading edge is where it belongs and it is the column that declares `Start`.
 * `Cost` is the control: currency, no declaration, so it keeps the trailing edge
 * its decimals need. Left-aligning the MONEY column instead would have made the
 * story a worked example of breaking a money column, which is what people copy
 * (visual-QA review).
 */
const FIGURE_COLUMNS: readonly GridTableV2Column[] = [
  ...COLUMNS,
  { id: RUN_COLUMN_ID, label: "Run", align: ColumnAlignment.Start },
  { id: COST_COLUMN_ID, label: "Cost" },
];

/** {@link COLUMNS} with the trailing column end-aligned. */
const END_ALIGNED_COLUMNS: readonly GridTableV2Column[] = COLUMNS.map(
  (column) =>
    column.id === "updated" ? { ...column, align: ColumnAlignment.End } : column
);

/** The grid cell a rendered control or label sits inside. */
function closestGridCell(element: HTMLElement): HTMLElement {
  const cell = element.closest('[role="gridcell"], [role="cell"]');
  if (!(cell instanceof HTMLElement)) {
    throw new Error("element is not inside a grid cell");
  }
  return cell;
}

/**
 * The Status column header by accessible name. A module-level constant because
 * a regex literal built inside a `play` body is recompiled on every run
 * (`lint/performance/useTopLevelRegex`), and because both header stories must
 * name the same header or "moved to a header" and "moved to THAT header" stop
 * being the same assertion.
 */
const STATUS_HEADER_NAME = /Status/;

/**
 * The ARIA role of the grid cell holding focus — `gridcell` for a data or band
 * header cell, `columnheader` for one of the header row's.
 *
 * Reads the CELL rather than the focused element so a story asserts which kind
 * of row the roving focus reached, which is what a chrome-row crossing is.
 */
function activeCellRole(canvasElement: HTMLElement): string | null {
  const active = canvasElement.ownerDocument.activeElement;
  if (!(active instanceof HTMLElement)) {
    return null;
  }
  return active.closest("[data-grid-cell]")?.getAttribute("role") ?? null;
}
