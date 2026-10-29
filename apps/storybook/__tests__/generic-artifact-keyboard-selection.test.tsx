/**
 * ISS-8067: row selection from the keyboard, on the Grid Table V2 parity demo.
 *
 * Driven through the real demo and the real key events, never by calling the
 * demo's handlers — the ticket's claim is about what a keyboard user can reach,
 * and a handler test cannot tell "wired" from "reachable" apart.
 *
 * Every cell is located BY IDENTITY (a row id plus a column id, or a control's
 * accessible name) and never by position: a positional `cells[n]` silently
 * resolves to the wrong cell when the column order or the leading-utility track
 * changes, and the test then passes against a grid that never handled the key.
 *
 * PREMISE NOTE. Two of this ticket's six criteria already held on the base
 * branch and needed only coverage, not code: `Shift+Arrow` extension already
 * worked (the shift-bearing keydown reaches the host's `onRowKeyboardNavigate`,
 * which shares its anchor ref with the click path), and rows already carried
 * `aria-selected`. Those cases are pinned here so the next refactor cannot
 * quietly drop them.
 */

import { composeStory } from "@storybook/react";
import { fireEvent, userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import { GenericArtifactTableDemo } from "../../../packages/app/shared/components/generic-artifact-surface/generic-artifact-table";

const ROW_ONE = "artifact-1";
const ROW_TWO = "artifact-2";
const ROW_THREE = "artifact-3";
const ALL_ROWS = [ROW_ONE, ROW_TWO, ROW_THREE];
const ROW_ONE_TITLE = "Unified artifact experience";
const ROW_TWO_SLUG = "FEA-2477";
const STATUS_COLUMN_LABEL = "Status";
const APPROVED_OPTION = "Approved";
const COLUMN_OPTIONS_SUFFIX = " column options";
const FILTER_ITEM = "Filter";
const GROUP_ITEM = "Group";
// ISS-10750: the walk below reaches the bar in 6 presses from row three. The
// budget bounds the FAILURE path: a case that times out keeps running, and
// at 200 its Tab loop kept pressing into the next cases' documents (the
// `toHaveFocus` red on 2026-09-20). An unreachable bar still never gets hit,
// so `reached` stays false at 20 exactly as it did at 200.
const TAB_BUDGET = 20;
const FIRST_OWNER_NAME = "Ottilie Eastwick";
const SECOND_OWNER_NAME = "Pascoe Birchall";
/** Peels `TableFavoriteCell`'s label back to the artifact title it names. */
const FAVORITE_LABEL_PREFIX = /^Remove /;
const FAVORITE_LABEL_SUFFIX = / from favorites$/;

async function renderTable() {
  const Story = composeStory(
    { render: () => <GenericArtifactTableDemo initialFields={[]} /> },
    {
      title: "Test/GenericArtifactKeyboardSelection",
      component: GenericArtifactTableDemo,
    }
  );
  await Story.run();
  return within(document.body);
}

describe("Grid Table V2 parity demo — Space toggles the focused row", () => {
  it("selects the focused row and deselects it on a second press", async () => {
    await renderTable();
    focusDataCell(ROW_TWO, "status");

    await userEvent.keyboard("[Space]");
    expect(selectionOf(ALL_ROWS)).toEqual([false, true, false]);

    await userEvent.keyboard("[Space]");
    expect(selectionOf(ALL_ROWS)).toEqual([false, false, false]);
  });

  it("toggles from the LEAD cell too, not only from a data cell", async () => {
    await renderTable();
    // The identity cell is the one a user actually stops on, and it is wired
    // separately from the data cells inside `GridTableV2` — a fix applied to
    // only one of the three cell kinds passes every data-cell case above.
    focusLeadCell(ROW_ONE);

    await userEvent.keyboard("[Space]");

    expect(selectionOf(ALL_ROWS)).toEqual([true, false, false]);
  });

  it("adds to an existing selection instead of replacing it", async () => {
    await renderTable();
    focusDataCell(ROW_ONE, "status");
    await userEvent.keyboard("[Space]");
    focusDataCell(ROW_THREE, "status");
    await userEvent.keyboard("[Space]");

    // The same "toggle one, keep the rest" the Ctrl/Cmd-click branch performs.
    expect(selectionOf(ALL_ROWS)).toEqual([true, false, true]);
  });
});

describe("Grid Table V2 parity demo — Space inside an entered cell", () => {
  it("types a space into an open text editor and leaves selection alone", async () => {
    const screen = await renderTable();
    focusLeadCell(ROW_ONE);
    // Enter the cell (focus the rename control), then activate it, which swaps
    // the control for an auto-focused Input.
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Enter}");
    const editor = screen.getByRole("textbox", {
      name: "Edit artifact name for FEA-2481",
    });
    expect(editor).toHaveFocus();

    // End first: the editor selects its whole value on open, so a bare space
    // would replace the title rather than prove the key reached the field.
    await userEvent.keyboard("{End}[Space]");

    expect((editor as HTMLInputElement).value).toBe(`${ROW_ONE_TITLE} `);
    expect(selectionOf(ALL_ROWS)).toEqual([false, false, false]);
  });

  it("presses the entered star instead of toggling the row", async () => {
    const screen = await renderTable();
    const star = screen.getByRole("button", {
      name: `Remove ${ROW_ONE_TITLE} from favorites`,
    });
    focusCellOf(star);

    await userEvent.keyboard("{Enter}");
    expect(star).toHaveFocus();
    await userEvent.keyboard("[Space]");

    // The favorite flipped (the control owned the key) and the row did not.
    expect(
      screen.getByRole("button", { name: `Add ${ROW_ONE_TITLE} to favorites` })
    ).toHaveAttribute("aria-pressed", "false");
    expect(selectionOf(ALL_ROWS)).toEqual([false, false, false]);
  });

  it("still toggles the row when the same cell is only FOCUSED, not entered", async () => {
    const screen = await renderTable();
    const star = screen.getByRole("button", {
      name: `Remove ${ROW_ONE_TITLE} from favorites`,
    });
    focusCellOf(star);

    await userEvent.keyboard("[Space]");

    // Positive sibling to the case above, on the very same cell: outside the
    // entry model, Space belongs to the grid and the star is untouched.
    expect(selectionOf(ALL_ROWS)).toEqual([true, false, false]);
    expect(star).toHaveAttribute("aria-pressed", "true");
  });
});

describe("Grid Table V2 parity demo — Shift+Arrow extends from the anchor", () => {
  it("extends downward from a row set by Space", async () => {
    await renderTable();
    focusDataCell(ROW_ONE, "status");
    await userEvent.keyboard("[Space]");

    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");

    expect(selectionOf(ALL_ROWS)).toEqual([true, true, false]);
  });

  it("extends from the row a POINTER last clicked, not from the top", async () => {
    await renderTable();
    // The AC4 case: the anchor has to cross input modes. Clicking row two and
    // then extending must cover rows two and three — an anchor that reset to
    // the grid's first row would select all three.
    clickRow(ROW_TWO);
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");

    expect(selectionOf(ALL_ROWS)).toEqual([false, true, true]);
  });

  it("extends upward across the same range", async () => {
    await renderTable();
    clickRow(ROW_THREE);
    await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");

    expect(selectionOf(ALL_ROWS)).toEqual([false, true, true]);
  });

  // davetho review on PR #6005. The range used to be sliced out of the demo's
  // OWN filtered list while `Ctrl/Cmd+A` read the rows the grid painted — two
  // meanings of "visible" in one demo. They diverge exactly here: the collapsed
  // group lives in `GridTableV2`'s state, so a host list still contains the row
  // the user cannot see, and a range spanning it swept that row in.
  it("skips a row inside a COLLAPSED group the range spans", async () => {
    const screen = await renderTable();
    await groupByStatus(screen);
    const middleGroup = screen
      .getAllByRole("button", { expanded: true })
      .find((header) => rowIdsUnder(header).includes(ROW_TWO));
    if (!middleGroup) {
      throw new Error("no group header holds the middle row");
    }

    await userEvent.click(middleGroup);
    // The fixture has to put the hidden row BETWEEN the two the range covers,
    // or slicing the host's list would coincide with the rendered slice and the
    // assertion below could not fail.
    expect(renderedRowIds()).toEqual([ROW_THREE, ROW_ONE]);

    clickRow(ROW_THREE);
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");

    expect(announcedSelection()).toBe(selectionSentence(2));
    expect(selectionOf([ROW_ONE, ROW_THREE])).toEqual([true, true]);
    // Reopen to inspect the row that was hidden while the range ran.
    await userEvent.click(middleGroup);
    expect(renderedRowIds()).toEqual([ROW_THREE, ROW_ONE, ROW_TWO]);
    expect(selectionOf([ROW_TWO])).toEqual([false]);
  });
});

describe("Grid Table V2 parity demo — Ctrl/Cmd+A selects the visible rows", () => {
  it("selects every row under Ctrl+A", async () => {
    await renderTable();
    focusDataCell(ROW_TWO, "status");

    await userEvent.keyboard("{Control>}a{/Control}");

    expect(selectionOf(ALL_ROWS)).toEqual([true, true, true]);
  });

  it("selects every row under Cmd+A", async () => {
    await renderTable();
    focusDataCell(ROW_TWO, "status");

    await userEvent.keyboard("{Meta>}a{/Meta}");

    expect(selectionOf(ALL_ROWS)).toEqual([true, true, true]);
  });

  it("selects only the FILTERED rows, and leaves the hidden ones unselected", async () => {
    const screen = await renderTable();
    await filterStatusToApproved(screen);
    const visible = renderedRowIds();
    const hidden = ALL_ROWS.filter((id) => !visible.includes(id));
    // Guard the fixture, or a filter that stopped narrowing would make the
    // "hidden stayed unselected" assertion below vacuously true.
    expect(hidden.length).toBeGreaterThan(0);

    focusDataCell(visible[0] as string, "status");
    await userEvent.keyboard("{Control>}a{/Control}");
    expect(selectionOf(visible)).toEqual(visible.map(() => true));
    expect(announcedSelection()).toBe(selectionSentence(visible.length));

    // Drop the filter: had select-all run over the whole dataset rather than
    // the rendered rows, these would come back already selected.
    await clearStatusFilter(screen);
    expect(renderedRowIds()).toEqual(ALL_ROWS);
    expect(selectionOf(hidden)).toEqual(hidden.map(() => false));
  });

  it("skips rows hidden inside a COLLAPSED group", async () => {
    const screen = await renderTable();
    await groupByStatus(screen);
    const firstGroup = screen.getAllByRole("button", { expanded: true })[0];
    const collapsedRowIds = rowIdsUnder(firstGroup as HTMLElement);
    expect(collapsedRowIds.length).toBeGreaterThan(0);

    await userEvent.click(firstGroup as HTMLElement);
    const stillVisible = renderedRowIds();
    // "Visible" is the stricter of the two readings: a pointer user cannot
    // click a row inside a closed group either, so select-all must not reach
    // one. This is the assertion that separates it from "everything filtered".
    expect(stillVisible).not.toContain(collapsedRowIds[0]);

    focusDataCell(stillVisible[0] as string, "status");
    await userEvent.keyboard("{Control>}a{/Control}");

    expect(announcedSelection()).toBe(selectionSentence(stillVisible.length));
    expect(selectionOf(stillVisible)).toEqual(stillVisible.map(() => true));
  });

  it("leaves the chord to an entered text editor", async () => {
    const screen = await renderTable();
    focusLeadCell(ROW_ONE);
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Enter}");
    expect(
      screen.getByRole("textbox", { name: "Edit artifact name for FEA-2481" })
    ).toHaveFocus();

    await userEvent.keyboard("{Control>}a{/Control}");

    expect(selectionOf(ALL_ROWS)).toEqual([false, false, false]);
  });
});

describe("Grid Table V2 parity demo — bulk actions from the keyboard", () => {
  it("has no bulk action bar until a selection exists", async () => {
    const screen = await renderTable();
    expect(screen.queryByRole("toolbar")).toBeNull();

    focusDataCell(ROW_ONE, "status");
    await userEvent.keyboard("[Space]");

    expect(screen.getByRole("toolbar")).toBeTruthy();
  });

  // ISS-10750: the walk starts on the LAST row. The bar sits after the grid in
  // DOM order and every cell control before it is a Tab stop, so starting on
  // row one cost 30 presses (2.4s under test:coverage, past the 5s budget on a
  // slow runner) to prove what the 6 from row three prove: the bar is in the
  // Tab sequence at all. `userEvent.tab()` wraps past the end of the document,
  // so the walk never pinned the bar's position, only its reachability, and a
  // missing or extra stop in rows one and two only changed the press count.
  it("is reachable by Tab from the grid once a selection exists", async () => {
    const screen = await renderTable();
    focusDataCell(ROW_THREE, "status");
    await userEvent.keyboard("[Space]");
    const toolbar = screen.getByRole("toolbar");

    let reached = false;
    for (let step = 0; step < TAB_BUDGET; step += 1) {
      await userEvent.tab();
      if (toolbar.contains(document.activeElement)) {
        reached = true;
        break;
      }
    }

    expect(reached).toBe(true);
  });

  it("favorites every selected row from the keyboard", async () => {
    const screen = await renderTable();
    selectRowsByClick(ROW_TWO, ROW_THREE);
    const favorite = screen.getByRole("button", {
      name: `Favorite ${selectionSentence(2)}`,
    });

    favorite.focus();
    await userEvent.keyboard("{Enter}");

    // Row two and row three start unfavorited; the demo seeds only row one.
    expect(favoritedTitles()).toContain("Artifact interaction principles");
    expect(favoritedTitles()).toContain("Prototype generic artifact shells");
  });

  it("assigns an owner to every selected row through the keyboard menu", async () => {
    const screen = await renderTable();
    selectRowsByClick(ROW_TWO, ROW_THREE);
    const assign = screen.getByRole("button", {
      name: `Assign owner of ${selectionSentence(2)}`,
    });

    assign.focus();
    await userEvent.keyboard("{Enter}");
    // Opening focuses the first item, so one ArrowDown lands on the second —
    // proving the menu is walked with the keyboard rather than merely opened.
    await userEvent.keyboard("{ArrowDown}{Enter}");

    const ownerCells = [ROW_TWO, ROW_THREE].map((rowId) =>
      dataCell(rowId, "owner").textContent?.trim()
    );
    // Both selected rows moved to the SAME owner, and it is the one the second
    // menu item names — not whichever owner either row already had.
    expect(new Set(ownerCells).size).toBe(1);
    expect(ownerCells[0]).toContain(SECOND_OWNER_NAME);
    expect(ownerCells[0]).not.toContain(FIRST_OWNER_NAME);
  });

  it("clears the selection from the keyboard and retires the bar", async () => {
    const screen = await renderTable();
    selectRowsByClick(ROW_TWO, ROW_THREE);
    expect(selectionOf(ALL_ROWS)).toEqual([false, true, true]);

    screen.getByRole("button", { name: "Clear selection" }).focus();
    await userEvent.keyboard("{Enter}");

    expect(selectionOf(ALL_ROWS)).toEqual([false, false, false]);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  // Codex review on PR #6005. Clearing removes the bar that holds the button
  // the user just pressed, and the browser drops focus on `<body>` when the
  // focused node is removed — so without the handoff the keyboard user loses
  // their place in the grid entirely and has to Tab in from the top of the
  // document. Asserting the cell rather than "not body": landing anywhere is
  // not the contract, landing back where they were is.
  it("returns focus to the grid cell the user came from on clear", async () => {
    const screen = await renderTable();
    focusDataCell(ROW_TWO, "status");
    await userEvent.keyboard("[Space]");

    screen.getByRole("button", { name: "Clear selection" }).focus();
    await userEvent.keyboard("{Enter}");

    expect(dataCell(ROW_TWO, "status")).toHaveFocus();
  });
});

describe("Grid Table V2 parity demo — selection reaches assistive tech", () => {
  it("reports aria-selected per row in both states", async () => {
    await renderTable();
    expect(rowElement(ROW_TWO).getAttribute("aria-selected")).toBe("false");

    focusDataCell(ROW_TWO, "status");
    await userEvent.keyboard("[Space]");

    expect(rowElement(ROW_TWO).getAttribute("aria-selected")).toBe("true");
    expect(rowElement(ROW_ONE).getAttribute("aria-selected")).toBe("false");
  });

  it("announces the selected count as a polite status region", async () => {
    const screen = await renderTable();
    // Asserted through the accessibility tree by ROLE and accessible name — the
    // region is `sr-only`, and `toBeVisible` would accept a clipped element as
    // proof of nothing.
    const status = screen.getByRole("status", {
      name: "No artifacts selected",
    });
    expect(status).toHaveTextContent("No artifacts selected");

    focusDataCell(ROW_ONE, "status");
    await userEvent.keyboard("[Space]");
    expect(status).toHaveTextContent(selectionSentence(1));

    focusDataCell(ROW_TWO, "status");
    await userEvent.keyboard("[Space]");
    expect(status).toHaveTextContent(selectionSentence(2));
  });

  it("announces the count falling back to zero when the selection clears", async () => {
    const screen = await renderTable();
    selectRowsByClick(ROW_TWO);
    const status = screen.getByRole("status", {
      name: selectionSentence(1),
    });

    screen.getByRole("button", { name: "Clear selection" }).focus();
    await userEvent.keyboard("{Enter}");

    // The announcer outlives the bar on purpose: a live region that unmounts
    // cannot tell anyone the selection went away.
    expect(status).toHaveTextContent("No artifacts selected");
  });
});

function selectionSentence(count: number): string {
  return `${count} ${count === 1 ? "artifact" : "artifacts"} selected`;
}

function rowElement(rowId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-grid-row-id="${rowId}"]`
  );
  if (!row) {
    throw new Error(`no rendered row for ${rowId}`);
  }
  return row;
}

function renderedRowIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-grid-row-id]")
  ).map((row) => row.dataset.gridRowId ?? "");
}

function selectionOf(rowIds: readonly string[]): boolean[] {
  return rowIds.map(
    (rowId) => rowElement(rowId).getAttribute("aria-selected") === "true"
  );
}

/** A row's cell for a named COLUMN — never an index into the rendered cells. */
function dataCell(rowId: string, columnId: string): HTMLElement {
  const cell = rowElement(rowId).querySelector<HTMLElement>(
    `[data-column-id="${columnId}"]`
  );
  if (!cell) {
    throw new Error(`no ${columnId} cell in ${rowId}`);
  }
  return cell;
}

function focusDataCell(rowId: string, columnId: string): void {
  dataCell(rowId, columnId).focus();
}

/** The cell holding a given control, identified through the control itself. */
function focusCellOf(control: HTMLElement): void {
  const cell = control.closest<HTMLElement>("[data-grid-cell]");
  if (!cell) {
    throw new Error("control is not inside a navigable grid cell");
  }
  cell.focus();
}

function focusLeadCell(rowId: string): void {
  const slug = rowId === ROW_TWO ? ROW_TWO_SLUG : "FEA-2481";
  const rename = within(rowElement(rowId)).getByRole("button", {
    name: `Edit artifact name for ${slug}`,
  });
  focusCellOf(rename);
}

function announcedSelection(): string {
  const status = document.querySelector<HTMLElement>('[aria-live="polite"]');
  return status?.textContent?.trim() ?? "";
}

function favoritedTitles(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[aria-pressed="true"]')
  ).map((button) =>
    (button.getAttribute("aria-label") ?? "")
      .replace(FAVORITE_LABEL_PREFIX, "")
      .replace(FAVORITE_LABEL_SUFFIX, "")
  );
}

/**
 * Modifier-bearing clicks go through `fireEvent`, matching the sibling demo
 * suite: user-event v14 drops a `{ ctrlKey }` passed to `click()`, so the
 * toggle branch would silently never be taken.
 *
 * Dispatched on the row's SELECTION SURFACE rather than the row element, which
 * is where a real pointer lands: the row's handler focuses
 * `target.closest('[data-grid-cell]')`, and a click synthesized on the row
 * itself has no cell ancestor, so it would select the row while leaving focus
 * on `<body>` — and the very handoff these anchor cases exist to prove would
 * never be exercised.
 */
function clickRow(
  rowId: string,
  modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {}
): void {
  const surface = rowElement(rowId).querySelector<HTMLElement>(
    "[data-row-selection-surface]"
  );
  if (!surface) {
    throw new Error(`no row selection surface in ${rowId}`);
  }
  fireEvent.click(surface, modifiers);
}

function selectRowsByClick(...rowIds: readonly string[]): void {
  const [first, ...rest] = rowIds;
  clickRow(first as string);
  for (const rowId of rest) {
    clickRow(rowId, { ctrlKey: true });
  }
}

/** Rows painted under one group header, before it is collapsed. */
function rowIdsUnder(groupHeader: HTMLElement): string[] {
  const section = groupHeader.closest<HTMLElement>('[role="rowgroup"]');
  if (!section) {
    throw new Error("group header is not inside a rowgroup");
  }
  return Array.from(
    section.querySelectorAll<HTMLElement>("[data-grid-row-id]")
  ).map((row) => row.dataset.gridRowId ?? "");
}

async function groupByStatus(screen: ReturnType<typeof within>): Promise<void> {
  await userEvent.click(
    screen.getByRole("button", {
      name: `${STATUS_COLUMN_LABEL}${COLUMN_OPTIONS_SUFFIX}`,
    })
  );
  await userEvent.click(
    within(document.body).getByRole("menuitem", { name: GROUP_ITEM })
  );
}

async function openStatusFilterMenu(
  screen: ReturnType<typeof within>
): Promise<void> {
  await userEvent.click(
    screen.getByRole("button", {
      name: `${STATUS_COLUMN_LABEL}${COLUMN_OPTIONS_SUFFIX}`,
    })
  );
  await userEvent.click(
    within(document.body).getByRole("menuitem", { name: FILTER_ITEM })
  );
}

function approvedFilterOption(): HTMLElement {
  const option = within(document.body)
    .getAllByRole("menuitemcheckbox")
    .find((candidate) => candidate.textContent?.trim() === APPROVED_OPTION);
  if (!option) {
    throw new Error("no Approved status filter option");
  }
  return option;
}

async function filterStatusToApproved(
  screen: ReturnType<typeof within>
): Promise<void> {
  await openStatusFilterMenu(screen);
  await userEvent.click(approvedFilterOption());
  await userEvent.keyboard("{Escape}");
}

async function clearStatusFilter(
  screen: ReturnType<typeof within>
): Promise<void> {
  await openStatusFilterMenu(screen);
  await userEvent.click(approvedFilterOption());
  await userEvent.keyboard("{Escape}");
}
