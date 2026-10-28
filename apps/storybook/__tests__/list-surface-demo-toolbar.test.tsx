/**
 * Behavior tests for the list-surface demo's toolbar: sorting, facet filtering,
 * and the metric/column visibility options.
 *
 * Expected row orders and metric values are written out literally rather than
 * recomputed from the fixture, so a test cannot agree with a broken comparator
 * by making the same mistake twice. `PAGE_SIZE` is 4, so each ordering
 * assertion pins the first page.
 */
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import { SessionStatus } from "../stories/grid-table-toolbar-demo/fixtures";
import { ListSurfaceDemo } from "../stories/grid-table-toolbar-demo/list-surface-demo";

const SORT_MENU = "Sort";
const FILTER_MENU = "Filter";
const OPTIONS_MENU = "Options";
const COST_COLUMN = "Cost";
const OWNER_COLUMN = "Owner";
const STATUS_COLUMN = "Status";
const SESSIONS_METRIC = "Sessions";
const SPEND_METRIC = "Token spend";
const ACTIVE_METRIC = "Active now";
const FAILURES_METRIC = "Failures";
const OTTILIE = "Ottilie Eastwick";
const SESSION_COLUMN = "Session";
const CASE_TIMEOUT_MS = 20_000;
const REMOVE_FILTER_PATTERN = /^Remove .* filter$/i;

/** First page in fixture order, before any sort is applied. */
const UNSORTED_FIRST_PAGE = ["ses_7b91", "ses_7b74", "ses_7b58", "ses_7b40"];
/** Costs ascending: 0.24, 0.61, 1.08, 2.45 (then 4.12, 9.87 on page two). */
const COST_ASCENDING_FIRST_PAGE = [
  "ses_7b74",
  "ses_7b12",
  "ses_7b58",
  "ses_7a98",
];
/** Costs descending: 9.87, 4.12, 2.45, 1.08. */
const COST_DESCENDING_FIRST_PAGE = [
  "ses_7b40",
  "ses_7b91",
  "ses_7a98",
  "ses_7b58",
];
/** Session names ascending: agent/backfill-telemetry, agent/refactor-auth-guard,
 * agent/seed-generator, chore/upgrade-prisma. */
const NAME_ASCENDING_FIRST_PAGE = [
  "ses_7a98",
  "ses_7b91",
  "ses_7b58",
  "ses_7b12",
];
/** Owners ascending; the two Ottilie Eastwick rows keep their fixture order. */
const OWNER_ASCENDING_FIRST_PAGE = [
  "ses_7b91",
  "ses_7b40",
  "ses_7b58",
  "ses_7a98",
];

async function renderDemo() {
  const Story = composeStory(
    { render: () => <ListSurfaceDemo /> },
    { title: "Test/ListSurfaceDemoToolbar", component: ListSurfaceDemo }
  );
  await Story.run();
  return within(document.body);
}

function renderedRowIds() {
  return Array.from(document.querySelectorAll("[data-grid-row-id]")).map(
    (row) => row.getAttribute("data-grid-row-id")
  );
}

function metricValueText(label: string) {
  const description = Array.from(
    document.querySelectorAll('[data-slot="card-description"]')
  ).find((element) => element.textContent === label);
  const card = description?.closest('[data-slot="card"]');
  return card?.querySelector('[data-slot="card-title"]')?.textContent ?? null;
}

function menuItemNamed(text: string) {
  const item = within(document.body)
    .queryAllByRole("menuitem")
    .find((candidate) => candidate.textContent?.trim().startsWith(text));
  if (!item) {
    throw new Error(`no menu item named "${text}"`);
  }
  return item;
}

/**
 * The toolbar triggers relabel themselves once a facet is applied ("Sort"
 * becomes "Sort Cost"), so they are matched on prefix rather than exact name.
 */
async function openToolbarMenu(name: string) {
  const trigger = within(document.body).getAllByRole("button", {
    name: new RegExp(`^${name}`),
  })[0];
  await userEvent.click(trigger);
}

/** Picks the sort FIELD from the toolbar menu; direction stays ascending. */
async function sortBy(column: string) {
  await openToolbarMenu(SORT_MENU);
  await userEvent.click(menuItemNamed(column));
  await userEvent.keyboard("{Escape}");
}

/** Clicking the column's own header flips the direction of the active sort. */
async function toggleSortDirection(column: string) {
  await userEvent.click(
    within(document.body).getByRole("button", { name: column })
  );
}

describe("ListSurfaceDemo toolbar sorting", () => {
  it(
    "starts in fixture order",
    async () => {
      await renderDemo();
      expect(renderedRowIds()).toEqual(UNSORTED_FIRST_PAGE);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "orders numerically when sorting by Cost",
    async () => {
      await renderDemo();
      await sortBy(COST_COLUMN);
      expect(renderedRowIds()).toEqual(COST_ASCENDING_FIRST_PAGE);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "reverses the numeric order when the Cost header is toggled",
    async () => {
      await renderDemo();
      await sortBy(COST_COLUMN);
      expect(renderedRowIds()).toEqual(COST_ASCENDING_FIRST_PAGE);

      await toggleSortDirection(COST_COLUMN);
      expect(renderedRowIds()).toEqual(COST_DESCENDING_FIRST_PAGE);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "orders by name when sorting on the leading Session column",
    async () => {
      await renderDemo();
      await sortBy(SESSION_COLUMN);
      expect(renderedRowIds()).toEqual(NAME_ASCENDING_FIRST_PAGE);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "orders lexically when sorting by a text column",
    async () => {
      await renderDemo();
      await sortBy(OWNER_COLUMN);
      expect(renderedRowIds()).toEqual(OWNER_ASCENDING_FIRST_PAGE);
    },
    CASE_TIMEOUT_MS
  );
});

describe("ListSurfaceDemo toolbar filtering", () => {
  it(
    "narrows to the selected status and back",
    async () => {
      const screen = await renderDemo();
      expect(metricValueText(SESSIONS_METRIC)).toBe("6");

      await openToolbarMenu(FILTER_MENU);
      await userEvent.click(menuItemNamed(STATUS_COLUMN));
      await userEvent.click(menuItemNamed(SessionStatus.Active));
      expect(metricValueText(SESSIONS_METRIC)).toBe("2");
      expect(renderedRowIds()).toEqual(["ses_7b91", "ses_7b40"]);

      await userEvent.click(menuItemNamed(SessionStatus.Active));
      expect(metricValueText(SESSIONS_METRIC)).toBe("6");
      expect(screen).toBeTruthy();
    },
    CASE_TIMEOUT_MS
  );

  it(
    "clears an applied status facet from its chip",
    async () => {
      const screen = await renderDemo();

      await openToolbarMenu(FILTER_MENU);
      await userEvent.click(menuItemNamed(STATUS_COLUMN));
      await userEvent.click(menuItemNamed(SessionStatus.Active));
      await userEvent.keyboard("{Escape}");
      await userEvent.keyboard("{Escape}");
      expect(metricValueText(SESSIONS_METRIC)).toBe("2");

      const remove = screen.getAllByLabelText(REMOVE_FILTER_PATTERN)[0];
      await userEvent.click(remove);

      expect(metricValueText(SESSIONS_METRIC)).toBe("6");
      expect(screen.queryAllByLabelText(REMOVE_FILTER_PATTERN).length).toBe(0);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "narrows to the selected owner",
    async () => {
      await renderDemo();

      await openToolbarMenu(FILTER_MENU);
      await userEvent.click(menuItemNamed(OWNER_COLUMN));
      await userEvent.click(menuItemNamed(OTTILIE));

      expect(metricValueText(SESSIONS_METRIC)).toBe("2");
      expect(renderedRowIds()).toEqual(["ses_7b91", "ses_7b40"]);
    },
    CASE_TIMEOUT_MS
  );
});

describe("ListSurfaceDemo toolbar options", () => {
  it(
    "reveals the hidden metric cards and computes their values",
    async () => {
      await renderDemo();
      expect(metricValueText(ACTIVE_METRIC)).toBeNull();
      expect(metricValueText(FAILURES_METRIC)).toBeNull();

      await openToolbarMenu(OPTIONS_MENU);
      await userEvent.click(menuItemNamed(ACTIVE_METRIC));
      await userEvent.click(menuItemNamed(FAILURES_METRIC));

      expect(metricValueText(ACTIVE_METRIC)).toBe("2");
      expect(metricValueText(FAILURES_METRIC)).toBe("1");
    },
    CASE_TIMEOUT_MS
  );

  it(
    "drops the whole metric strip once every card is hidden",
    async () => {
      await renderDemo();
      expect(metricValueText(SESSIONS_METRIC)).toBe("6");

      await openToolbarMenu(OPTIONS_MENU);
      await userEvent.click(menuItemNamed(SESSIONS_METRIC));
      await userEvent.click(menuItemNamed(SPEND_METRIC));

      expect(metricValueText(SESSIONS_METRIC)).toBeNull();
      expect(metricValueText(SPEND_METRIC)).toBeNull();
      expect(
        document.querySelectorAll('[data-slot="card-description"]').length
      ).toBe(0);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "hides a column and drops its header",
    async () => {
      const screen = await renderDemo();
      expect(screen.getByRole("button", { name: COST_COLUMN })).toBeTruthy();

      await openToolbarMenu(OPTIONS_MENU);
      await userEvent.click(menuItemNamed(COST_COLUMN));
      await userEvent.keyboard("{Escape}");

      expect(screen.queryByRole("button", { name: COST_COLUMN })).toBeNull();
    },
    CASE_TIMEOUT_MS
  );
});
