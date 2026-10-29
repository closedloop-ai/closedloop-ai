/**
 * ISS-9574 — the artifact-surface half of "a selection contains only rows the
 * user can still see".
 *
 * This host held NO reconciliation at all before this ticket: selection lived in
 * `useState` with no effect watching the filtered row set, so filtering a
 * selected row away left it selected and invisible, and the next bulk action
 * reached it. The Sessions grid had a hand-rolled answer and this one had none,
 * which is exactly the shape a tested-but-unwired contract takes.
 *
 * Driven through the real demo and the real Radix filter menu rather than the
 * demo's handlers: what is claimed is that a reader's filter prunes the
 * selection, and a handler call cannot tell wired from reachable apart. The
 * RULE itself is unit-tested in
 * `packages/design-system/__tests__/grid-table-v2-selection.test.ts`.
 */

import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import {
  artifactColumnDefinitions,
  initialArtifactRows,
} from "../../../packages/app/shared/components/generic-artifact-surface/fixtures";
import { GenericArtifactTableDemo } from "../../../packages/app/shared/components/generic-artifact-surface/generic-artifact-table";

const ROW_ONE = "artifact-1";
const ROW_TWO = "artifact-2";
const ROW_THREE = "artifact-3";
const ALL_ROWS = [ROW_ONE, ROW_TWO, ROW_THREE];
const STATUS_COLUMN_LABEL = "Status";
const FILTER_ITEM = "Filter";
const APPROVED_OPTION = "Approved";
const NOTHING_SELECTED = "No artifacts selected";
const ONE_SELECTED = "1 artifact selected";
const TWO_SELECTED = "2 artifacts selected";
const FIRST_OWNER = initialArtifactRows[0]?.owner.name ?? "";
const OWNER_COLUMN_LABEL = artifactColumnDefinitions.find(
  ({ id }) => id === "owner"
)?.label;
if (!OWNER_COLUMN_LABEL) {
  throw new Error("Expected the canonical artifact Owner column definition");
}
// ISS-10750: both cases drive three pointer clicks through the real Radix
// filter menu, plus one or two Space toggles, and each one re-renders the
// whole table; the first case also pays the file's cold mount. Measured under
// `test:coverage` on a 16-core box: 1.5s and 0.8s. On a green CI runner the
// first was 1.8s; on the 2026-09-20 one it was 5.4s — past Vitest's 5s
// default, and the 3.6x that took is the same slope the second case sits on.
// No step here waits on anything external, so the budget only buys headroom;
// it cannot hide a hang.
const RECONCILIATION_CASE_TIMEOUT_MS = 15_000;

async function renderTable() {
  const Story = composeStory(
    { render: () => <GenericArtifactTableDemo initialFields={[]} /> },
    {
      title: "Test/GenericArtifactSelectionReconciliation",
      component: GenericArtifactTableDemo,
    }
  );
  await Story.run();
  return within(document.body);
}

function rowElement(rowId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-grid-row-id="${rowId}"]`
  );
  if (!row) {
    throw new Error(`no row ${rowId}`);
  }
  return row;
}

function selectionOf(rowIds: readonly string[]): boolean[] {
  return rowIds.map(
    (rowId) => rowElement(rowId).getAttribute("aria-selected") === "true"
  );
}

function dataCell(rowId: string, columnId: string): HTMLElement {
  const cell = rowElement(rowId).querySelector<HTMLElement>(
    `[data-column-id="${columnId}"]`
  );
  if (!cell) {
    throw new Error(`no ${columnId} cell in ${rowId}`);
  }
  return cell;
}

/** `Space` on a focused cell — the toggle both the pointer and keyboard reach. */
async function toggleRow(rowId: string): Promise<void> {
  dataCell(rowId, "status").focus();
  await userEvent.keyboard("[Space]");
}

/** The always-mounted live region, read through its announced sentence. */
function announcement(): string {
  const region = document.querySelector<HTMLElement>("output[aria-live]");
  if (!region) {
    throw new Error("no selection announcer in the document");
  }
  return region.textContent ?? "";
}

async function filterStatusToApproved(): Promise<void> {
  const trigger = within(document.body).getByLabelText(
    `${STATUS_COLUMN_LABEL} column options`
  );
  await userEvent.click(trigger);
  await userEvent.click(
    within(document.body).getByRole("menuitem", { name: FILTER_ITEM })
  );
  const option = within(document.body)
    .getAllByRole("menuitemcheckbox")
    .find((candidate) => candidate.textContent?.trim() === APPROVED_OPTION);
  if (!option) {
    throw new Error(`no ${APPROVED_OPTION} filter option`);
  }
  await userEvent.click(option);
}

async function groupByOwner(): Promise<void> {
  await userEvent.click(
    within(document.body).getByLabelText(`${OWNER_COLUMN_LABEL} column options`)
  );
  await userEvent.click(
    within(document.body).getByRole("menuitem", { name: "Group" })
  );
}

function ownerGroupToggle(): HTMLElement {
  const toggle = within(document.body)
    .getAllByRole("button")
    .find((candidate) => candidate.textContent?.includes(FIRST_OWNER));
  if (!toggle) {
    throw new Error(`no ${FIRST_OWNER} group toggle`);
  }
  return toggle;
}

describe("Grid Table V2 parity demo — selection reconciliation", () => {
  it(
    "drops rows a filter takes away, and announces the smaller count",
    async () => {
      await renderTable();
      await toggleRow(ROW_ONE);
      await toggleRow(ROW_THREE);
      expect(selectionOf(ALL_ROWS)).toEqual([true, false, true]);
      expect(announcement()).toBe(TWO_SELECTED);

      // Narrows to `artifact-2` alone — neither selected row survives.
      await filterStatusToApproved();

      // The surviving row is the one the reader can see, and it was never
      // selected. Without reconciliation the two filtered-out ids stay in the
      // set, invisible, and the next bulk action reaches all three.
      expect(selectionOf([ROW_TWO])).toEqual([false]);
      expect(announcement()).toBe(NOTHING_SELECTED);
    },
    RECONCILIATION_CASE_TIMEOUT_MS
  );

  it(
    "keeps a selected row the filter does not take",
    async () => {
      await renderTable();
      await toggleRow(ROW_TWO);
      expect(announcement()).toBe(ONE_SELECTED);

      // The positive control for the case above: `artifact-2` IS Approved, so
      // a rule that cleared the whole selection on any filter change — rather
      // than pruning to what survives — would fail here and pass there.
      await filterStatusToApproved();

      expect(selectionOf([ROW_TWO])).toEqual([true]);
      expect(announcement()).toBe(ONE_SELECTED);
    },
    RECONCILIATION_CASE_TIMEOUT_MS
  );

  it(
    "drops a selected row when its internally owned group collapses",
    async () => {
      await renderTable();
      await groupByOwner();
      await toggleRow(ROW_ONE);
      await toggleRow(ROW_TWO);
      expect(announcement()).toBe(TWO_SELECTED);

      const toggle = ownerGroupToggle();
      await userEvent.click(toggle);
      expect(
        document.querySelector(`[data-grid-row-id="${ROW_ONE}"]`)
      ).toBeNull();
      await userEvent.click(toggle);

      expect(selectionOf([ROW_ONE, ROW_TWO])).toEqual([false, true]);
      expect(announcement()).toBe(ONE_SELECTED);
    },
    RECONCILIATION_CASE_TIMEOUT_MS
  );
});
