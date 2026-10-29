import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { TableGridHeaderV2 } from "@repo/design-system/components/ui/table-grid-header-v2";
import { LEADING_COLUMN_DATA_ID } from "@repo/design-system/lib/grid-table-v2-rows";
import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { expect, userEvent, within } from "storybook/test";

/**
 * The champion grid's column-header row — ISS-9290.
 *
 * Rendered inside a real `grid` ancestry with `insideAriaTable`, because that
 * flag is the whole ARIA half of this component: it turns the header into a
 * `row` of `columnheader`s carrying the `aria-colindex` of their track, which
 * is what lets a screen reader announce a body cell as "Status, Active" rather
 * than a loose "Active". Rendered standalone the roles would be invalid
 * (`aria-required-parent`), so the story would picture the violation the flag
 * exists to avoid.
 *
 * Applicable states: default, hover and focus-visible (focus half; the ramps
 * are Chromatic's), sorted ascending/descending/unsorted, the tri-state
 * select-all, keyboard/pointer interaction, and overflow (a header whose label
 * outruns its track). Not applicable: editing, dragging and drag-over belong to
 * the sibling handles module that owns the grips; loading, empty, partial and
 * error are the BODY's states — a header renders identically over zero rows and
 * over a failed fetch, which is exactly why the surface shell owns those; and
 * narrow renders no header at all.
 *
 * ## Controls (ISS-9314)
 * Every `TableGridHeaderV2Props` member, classified against the real type
 * (`table-grid-header-v2.tsx`) rather than left to Storybook's auto-inferred
 * "unknown" control. Simple/scalar props get a real widget; column
 * definitions, callbacks, and nested wiring objects are explicitly disabled
 * rather than left to render a broken "Setup controls" row.
 */
const meta = {
  title: "Composites v1.0/Data Display/Tables/Table Grid Header V2",
  component: TableGridHeaderV2,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    // Scalars with a real, safe-to-drive control.
    gridTemplateColumns: { control: "text" },
    // Constrained to this story's real column ids (plus "no sort"), not free
    // text — any other string can never match a column and would silently
    // render as "unsorted" no matter what was typed.
    sortBy: {
      control: "select",
      options: [null, "status", "owner", "updated"],
    },
    sortDir: { control: "select", options: ["asc", "desc"] },
    leadingLabel: { control: "text" },
    leadingTooltip: { control: "text" },
    // Same constraint as `sortBy`: only a real column id makes the leading
    // cell a working sort button.
    leadingSortKey: {
      control: "select",
      options: [undefined, "status", "owner", "updated"],
    },
    className: { control: "text" },
    showSelectAll: { control: "boolean" },
    allSelected: { control: "boolean" },
    someSelected: { control: "boolean" },
    showRankSlot: { control: "boolean" },
    pinLeadColumn: { control: "boolean" },
    insideAriaTable: { control: "boolean" },
    // Column definitions, callbacks, and nested wiring objects have no
    // meaningful generic control — each story's `render`/`args` wires them
    // directly, so the Controls table hides them instead of guessing.
    columns: { table: { disable: true } },
    onSort: { table: { disable: true } },
    leadingResize: { table: { disable: true } },
    leadingSortOptions: { table: { disable: true } },
    onClearSort: { table: { disable: true } },
    onSelectAll: { table: { disable: true } },
    leadingUtilityCell: { table: { disable: true } },
    trailingCell: { table: { disable: true } },
    reorder: { table: { disable: true } },
    resize: { table: { disable: true } },
    actions: { table: { disable: true } },
    columnTracks: { table: { disable: true } },
    navigation: { table: { disable: true } },
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TableGridHeaderV2>;

export default meta;

type Story = StoryObj<typeof meta>;

const GRID_LABEL = "Artifacts";
const LEADING_LABEL = "Name";

const COLUMNS = [
  { id: "status", label: "Status", sortable: true, filterable: true },
  { id: "owner", label: "Owner", sortable: true, groupable: true },
  { id: "updated", label: "Updated", sortable: true },
] as const;

/** Lead track plus one per column — the tracks the header and body both use. */
const GRID_TEMPLATE_COLUMNS = "280px repeat(3, 180px)";

/** Top-level per `useTopLevelRegex`; the header folds a sort glyph into each name. */
const STATUS_PATTERN = /Status/;
const OWNER_PATTERN = /Owner/;

/**
 * Sorting through the header, asserted on `aria-sort` rather than on the
 * indicator glyph: `aria-sort` is what a screen reader reports, so a sort that
 * only ever reached the icon would satisfy a visual check and fail here.
 *
 * The three-way cycle matters because exactly one column may claim the sort at
 * a time — a header that set the new column without clearing the old would
 * publish two sorted columns, which is a state the data cannot be in.
 */
export const Sorting: Story = {
  args: {
    columns: COLUMNS,
    gridTemplateColumns: GRID_TEMPLATE_COLUMNS,
    insideAriaTable: true,
    onSort: () => undefined,
    sortBy: null,
    sortDir: "asc",
  },
  render: (args) => <HeaderStory args={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Every track has a columnheader, so the header and body index alike.
    const headers = canvas.getAllByRole("columnheader");
    await expect(headers).toHaveLength(COLUMNS.length + 1);
    await expect(headers[0]).toHaveAttribute("aria-colindex", "1");

    // Unsorted: a sortable column publishes "none", never nothing at all —
    // absent `aria-sort` reads as "not sortable" rather than "not sorted".
    // Deliberate per ISS-10425; see `getAriaSort`'s docstring.
    await expect(
      canvas.getByRole("columnheader", { name: STATUS_PATTERN })
    ).toHaveAttribute("aria-sort", "none");

    // First click on an unsorted column sorts DESCENDING (`getNextSortDirection`
    // returns "desc" when the column is not already active): most-recent-first
    // is the useful default for the columns this grid sorts by.
    await userEvent.click(canvas.getByRole("button", { name: STATUS_PATTERN }));
    await expect(
      canvas.getByRole("columnheader", { name: STATUS_PATTERN })
    ).toHaveAttribute("aria-sort", "descending");

    // Clicking the same column flips direction rather than re-sorting descending.
    await userEvent.click(canvas.getByRole("button", { name: STATUS_PATTERN }));
    await expect(
      canvas.getByRole("columnheader", { name: STATUS_PATTERN })
    ).toHaveAttribute("aria-sort", "ascending");

    // Sorting a different column releases the first — exactly one sorted column,
    // because two would describe an ordering the rows are not in.
    await userEvent.click(canvas.getByRole("button", { name: OWNER_PATTERN }));
    await expect(
      canvas.getByRole("columnheader", { name: OWNER_PATTERN })
    ).toHaveAttribute("aria-sort", "descending");
    await expect(
      canvas.getByRole("columnheader", { name: STATUS_PATTERN })
    ).toHaveAttribute("aria-sort", "none");
  },
};

/**
 * The select-all checkbox's three readings. `indeterminate` is the one worth a
 * story: a partial selection rendered as plain unchecked tells the user nothing
 * is selected when rows are, and rendered as checked tells them everything is.
 * Both are the UI lying about state.
 */
export const SelectAllStates: Story = {
  args: {
    columns: COLUMNS,
    gridTemplateColumns: GRID_TEMPLATE_COLUMNS,
    insideAriaTable: true,
    onSort: () => undefined,
    showSelectAll: true,
    sortBy: null,
    sortDir: "asc",
  },
  render: (args) => <HeaderStory args={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Asserted on `aria-checked`, which is what assistive tech reports — a
    // tri-state that only ever reached `data-state` would satisfy a styling
    // check and still announce the wrong thing.
    await expect(canvas.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "false"
    );

    // Some selected announces "mixed", not either extreme: rendered unchecked
    // it claims nothing is selected while rows are, and rendered checked it
    // claims everything is. Both are the control lying about the selection.
    await userEvent.click(canvas.getByRole("button", { name: SOME_LABEL }));
    await expect(canvas.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "mixed"
    );

    await userEvent.click(canvas.getByRole("button", { name: ALL_LABEL }));
    await expect(canvas.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "true"
    );
  },
};

/**
 * A label wider than its track. As with the body cell, the assertion is that
 * the header clips VISUALLY ONLY — the full label stays in the accessibility
 * tree, so the column a screen-reader user hears is the column they get.
 */
export const Overflow: Story = {
  args: {
    columns: COLUMNS,
    gridTemplateColumns: GRID_TEMPLATE_COLUMNS,
    insideAriaTable: true,
    onSort: () => undefined,
    sortBy: null,
    sortDir: "asc",
  },
  render: (args) => <HeaderStory args={args} overflowing />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The whole label survives in the DOM: clipping is a paint decision, so a
    // JS-truncated label would look identical and silently rename the column
    // for every screen-reader user.
    await expect(canvas.getByText(OVERFLOWING_LABEL)).toBeInTheDocument();
  },
};

/**
 * The resting header, nothing sorted and nothing selected — the state every
 * other story here is a departure from, and the one this file had no story for
 * (ISS-9095 AC: "Storybook covers default, ... states").
 *
 * The assertion is `aria-colindex`, not the visible labels: the header's whole
 * ARIA job is to tell a body cell which column it sits under, and a header that
 * rendered the right three names against the wrong track indices announces every
 * cell beneath it under its neighbour.
 */
export const Default: Story = {
  args: {
    columns: COLUMNS,
    gridTemplateColumns: GRID_TEMPLATE_COLUMNS,
    insideAriaTable: true,
    onSort: () => undefined,
    sortBy: null,
    sortDir: "asc",
  },
  render: (args) => <HeaderStory args={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const headers = canvas.getAllByRole("columnheader");

    // The lead identity cell plus one per column, in track order, 1-indexed the
    // way `aria-colindex` is defined.
    await expect(headers).toHaveLength(COLUMNS.length + 1);
    for (const [index, header] of headers.entries()) {
      await expect(header).toHaveAttribute("aria-colindex", `${index + 1}`);
    }

    // Resting means UNSORTED, and unsorted is `aria-sort="none"` on every
    // sortable column — not an absent attribute, which announces a column that
    // cannot be sorted at all.
    for (const header of headers.slice(1)) {
      await expect(header).toHaveAttribute("aria-sort", "none");
    }
  },
};

/**
 * Sorting driven from the KEYBOARD, which this file's own docblock has claimed
 * since ISS-9290 while every `play` here used a pointer. A sort control reachable
 * only by pointer is a WCAG 2.1.1 failure, and a click-driven assertion cannot
 * see it: `userEvent.click` fires on a `<div>` with an `onClick` just as happily
 * as on a real `<button>`.
 */
export const KeyboardActiveColumn: Story = {
  args: {
    columns: COLUMNS,
    gridTemplateColumns: GRID_TEMPLATE_COLUMNS,
    insideAriaTable: true,
    onSort: () => undefined,
    sortBy: null,
    sortDir: "asc",
  },
  render: (args) => <HeaderStory args={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const status = canvas.getByRole("button", { name: STATUS_PATTERN });

    // Focus has to be REACHABLE, so it is taken by tabbing rather than by
    // calling `.focus()` — a control removed from the tab order still focuses
    // programmatically and would keep this green while stranding the keyboard.
    await userEvent.tab();
    while (document.activeElement !== status) {
      const before = document.activeElement;
      await userEvent.tab();
      if (document.activeElement === before) {
        throw new Error("tabbing never reached the Status sort control");
      }
    }
    await expect(status).toHaveFocus();

    // Descending first, which is the SAME contract `Sorting` pins for the
    // pointer (`getNextSortDirection` returns "desc" for a column that is not
    // already active). The point of this story is parity: a keyboard that
    // reached a different first direction would be a second sort policy.
    await userEvent.keyboard("{Enter}");
    await expect(
      canvas.getByRole("columnheader", { name: STATUS_PATTERN })
    ).toHaveAttribute("aria-sort", "descending");

    // And the flip, so the cycle is reachable without a pointer rather than
    // just its first step.
    await userEvent.keyboard("{Enter}");
    await expect(
      canvas.getByRole("columnheader", { name: STATUS_PATTERN })
    ).toHaveAttribute("aria-sort", "ascending");

    // Focus survives the state change. A header that re-keys its cells on sort
    // drops focus to `<body>`, and the next keypress goes nowhere.
    await expect(
      canvas.getByRole("button", { name: STATUS_PATTERN })
    ).toHaveFocus();
  },
};

/**
 * The pinned lead region. `pinLeadColumn` has been a live Control on this story
 * file since ISS-9314 with no story setting it, so the one state the flag exists
 * to produce was the one state nobody could see.
 *
 * Pinning is what keeps the identity column readable while the data columns
 * scroll horizontally, and the failure it guards against is overlap: a lead cell
 * that scrolls away leaves every row anonymous, and one pinned without a
 * stacking context is painted over by the cells passing under it.
 */
export const PinnedLeadColumn: Story = {
  args: {
    columns: COLUMNS,
    gridTemplateColumns: GRID_TEMPLATE_COLUMNS,
    insideAriaTable: true,
    onSort: () => undefined,
    pinLeadColumn: true,
    sortBy: null,
    sortDir: "asc",
  },
  render: (args) => <HeaderStory args={args} scrollable />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const lead = canvas.getAllByRole("columnheader")[0];
    if (!lead) {
      throw new Error("the lead columnheader was not rendered");
    }

    // The precondition, asserted rather than assumed. Pinning is only OBSERVABLE
    // against a frame that scrolls, and this story used to render inside an
    // `overflow-hidden` frame whose tracks fit — measured in a browser at
    // scrollWidth 1134 / clientWidth 1134 — so it documented nothing while its
    // class assertions stayed green.
    //
    // Asserted as the frame's CSS contract, not as a measured overflow: this lane
    // runs in jsdom, which performs no layout, so `scrollWidth` and `clientWidth`
    // are both 0 here and a measurement would compare 0 to 0 and pass on a frame
    // that cannot scroll. Reverting the frame to `overflow-hidden` reddens this.
    const grid = canvas.getByRole("grid");
    await expect(grid).toHaveClass("overflow-x-auto");
    await expect(grid).toHaveClass("max-w-md");

    // Written out as literals, not split from `PINNED_LEAD_CELL_CLASS`, and not
    // read from a computed style. Reading the constant would make this agree with
    // whatever that module currently says, which is the one thing it is here to
    // police — drop `sticky` from `PINNED_CELL_BASE_CLASS` and a split-the-constant
    // loop stays green on an unpinned header. A computed-style assertion is out
    // too: this lane disables PostCSS (`apps/storybook/vitest.config.ts`), so
    // jsdom computes `static` for every Tailwind class. Same reasoning, and the
    // same literals, as `packages/design-system/__tests__/grid-table-v2-pinned-lead.test.tsx`.
    await expect(lead).toHaveClass("sticky");
    // ISS-11582: the header tier clears covered resize handles while the
    // sticky row keeps the lower pinned-column tier.
    await expect(lead).toHaveClass("z-[var(--z-pinned-header)]");
    await expect(lead).toHaveClass("left-0");

    // Pinned or not, it is still the first track's header — pinning is a paint
    // decision and must not renumber the columns underneath it.
    await expect(lead).toHaveAttribute("aria-colindex", "1");
    await expect(lead).toHaveAttribute(
      "data-column-id",
      LEADING_COLUMN_DATA_ID
    );
  },
};

const SOME_LABEL = "Select some";
const ALL_LABEL = "Select all rows";

/**
 * Long enough to clip at any viewport. Built rather than written out so the
 * story states the LENGTH it needs, not a phrase a later edit could shorten
 * past the point of overflowing.
 */
const OVERFLOWING_LABEL = "Reconciliation disposition ".repeat(4).trim();

/**
 * The subset of `TableGridHeaderV2Props` this demo forwards live from
 * Controls. `columns`/`gridTemplateColumns`/`onSort` are always supplied by
 * each story's own `args`; the rest are optional so a Controls edit that
 * leaves them unset falls through to the real component's own defaults.
 */
type HeaderStoryArgs = {
  columns: readonly { id: string; label: string; sortable?: boolean }[];
  gridTemplateColumns: string;
  sortBy: string | null;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
  leadingLabel?: string;
  leadingTooltip?: string;
  leadingSortKey?: string;
  className?: string;
  showSelectAll?: boolean;
  allSelected?: boolean;
  someSelected?: boolean;
  showRankSlot?: boolean;
  pinLeadColumn?: boolean;
  insideAriaTable?: boolean;
};

/** `allSelected`/`someSelected` collapse to one 0..TOTAL_ROWS count this demo tracks locally. */
function resolveInitialSelectedCount(
  allSelected: boolean | undefined,
  someSelected: boolean | undefined
): number {
  if (allSelected) {
    return TOTAL_ROWS;
  }
  if (someSelected) {
    return 1;
  }
  return 0;
}

function HeaderStory({
  args,
  overflowing = false,
  scrollable = false,
}: {
  args: HeaderStoryArgs;
  overflowing?: boolean;
  /**
   * Narrows the frame and lets it scroll horizontally, which `pinLeadColumn` needs
   * in order to DO anything: in the default `overflow-hidden` frame the tracks fit,
   * nothing scrolls, and a pinned lead column renders pixel-identical to an
   * unpinned one — a story that asserts the class and shows the reader nothing.
   */
  scrollable?: boolean;
}) {
  // `sortBy`/`sortDir` and the select-all count are LOCAL state, not a
  // straight passthrough, because `Sorting`'s and `SelectAllStates`' `play`
  // functions click through real state transitions this component owns
  // (sort cycling, select-all/some). A Controls edit still has to reach that
  // state, though — the `useEffect`s below sync it in on every arg change,
  // exactly the way a real container syncing to upstream props would.
  const [sortBy, setSortBy] = useState<string | null>(args.sortBy);
  const [sortDir, setSortDir] = useState<SortDirection>(args.sortDir);
  const [selectedCount, setSelectedCount] = useState(() =>
    resolveInitialSelectedCount(args.allSelected, args.someSelected)
  );

  useEffect(() => {
    setSortBy(args.sortBy);
  }, [args.sortBy]);
  useEffect(() => {
    setSortDir(args.sortDir);
  }, [args.sortDir]);
  useEffect(() => {
    setSelectedCount(
      resolveInitialSelectedCount(args.allSelected, args.someSelected)
    );
  }, [args.allSelected, args.someSelected]);

  const columns = overflowing
    ? [
        { id: "status", label: OVERFLOWING_LABEL, sortable: true },
        ...COLUMNS.slice(1),
      ]
    : [...COLUMNS];

  return (
    <main className="min-h-screen bg-background p-8">
      {/* biome-ignore lint/a11y/useSemanticElements: a CSS-grid table cannot be a real <table>; role="grid" is the mapping GridTableV2 renders. */}
      <div
        aria-colcount={columns.length + 1}
        aria-label={GRID_LABEL}
        className={
          scrollable
            ? "max-w-md overflow-x-auto rounded-md border"
            : "overflow-hidden rounded-md border"
        }
        role="grid"
      >
        <TableGridHeaderV2
          allSelected={selectedCount === TOTAL_ROWS}
          className={args.className}
          columns={columns}
          gridTemplateColumns={
            args.gridTemplateColumns || GRID_TEMPLATE_COLUMNS
          }
          insideAriaTable={args.insideAriaTable}
          leadingLabel={args.leadingLabel || LEADING_LABEL}
          leadingSortKey={args.leadingSortKey}
          leadingTooltip={args.leadingTooltip}
          onSelectAll={(checked) => setSelectedCount(checked ? TOTAL_ROWS : 0)}
          onSort={(column, direction) => {
            setSortBy(column);
            setSortDir(direction);
          }}
          pinLeadColumn={args.pinLeadColumn}
          showRankSlot={args.showRankSlot}
          showSelectAll={args.showSelectAll}
          someSelected={selectedCount > 0 && selectedCount < TOTAL_ROWS}
          sortBy={sortBy}
          sortDir={sortDir}
        />
      </div>
      {args.showSelectAll ? (
        <div className="mt-4 flex gap-2">
          <button
            className="rounded-md border px-3 py-1.5 text-sm"
            onClick={() => setSelectedCount(1)}
            type="button"
          >
            {SOME_LABEL}
          </button>
          <button
            className="rounded-md border px-3 py-1.5 text-sm"
            onClick={() => setSelectedCount(TOTAL_ROWS)}
            type="button"
          >
            {ALL_LABEL}
          </button>
        </div>
      ) : null}
    </main>
  );
}

/** The population the select-all checkbox reasons about. */
const TOTAL_ROWS = 3;
