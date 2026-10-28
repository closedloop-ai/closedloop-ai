import { expect, type Locator } from "@playwright/test";
import { DETAILS_TAB_FIELD_GROUPS_SELECTOR } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import { PRIORITY_COLUMN_LABEL } from "@repo/app/shared/lib/priority-constants";

/**
 * ISS-12197's Branch Details rows in the Details tab's sections (ISS-12412),
 * typed here on purpose: the web and desktop shell specs police the shipped
 * order against the tickets, not against the host that draws it. A row the
 * fixture leaves empty is not drawn (the empty-row rule), so each section
 * shows a subsequence of its list.
 */
const BRANCH_DETAILS_SECTIONS = [
  {
    title: "Artifact details",
    order: [
      "Name",
      "Slug",
      "Owner",
      "Collaborators",
      "Status",
      "Priority",
      "Due date",
      "Created at",
      "Created by",
      "Updated at",
      "Project",
      "Parent",
      "Tags",
    ],
  },
  {
    title: "Branch details",
    order: [
      "Repository",
      "Changes",
      "Commit count",
      "Pull Request",
      "Checks status",
      "Estimated cost",
      "LOC / $",
    ],
  },
] as const;

/** Served by the comprehensive Branch fixture on both hosts, so drawn. */
const DRAWN_ROWS = [
  "Name",
  "Status",
  PRIORITY_COLUMN_LABEL,
  "Repository",
  "Pull Request",
  "Checks status",
  "Changes",
  "Commit count",
  "Estimated cost",
  "LOC / $",
];

/**
 * The fixture serves no slug, assignee, creator, lifecycle timestamps or
 * parent, so those rows are left out under the empty-row rule.
 * Priority is explicitly null in the complete fixture, so its editable row
 * is drawn. An omitted priority still stays hidden under ISS-10995. The
 * sessions that worked the branch are on the Sessions tab, not a row
 * (ISS-12412); the last three rows are unlisted. Project is NOT here: it is per
 * host, and {@link BranchDetailsProjectRow} says why.
 */
const ABSENT_ROWS = [
  "Slug",
  "Owner",
  "Due date",
  "Created at",
  "Created by",
  "Updated at",
  "Parent",
  "Sessions",
  "Linked sessions",
  "Last active",
  "Checks",
];

/**
 * Whether the host's producer carries a project at all. This is the one row
 * web and desktop DISAGREE on, so each call site states its own.
 *
 * Not the empty-row rule: `branchProjectRow` omits the row only for
 * `projectId === undefined` and otherwise reports `empty: false`, because an
 * unfiled branch is what the control exists to file (ISS-10995). The cloud read
 * always serves the key; desktop single-user mode (`shared-branches-api.ts`)
 * carries no project field at all.
 */
export const BranchDetailsProjectRow = {
  Drawn: "drawn",
  AbsentFromProducer: "absent-from-producer",
} as const;
export type BranchDetailsProjectRow =
  (typeof BranchDetailsProjectRow)[keyof typeof BranchDetailsProjectRow];

/**
 * `details` (the shell's Details tab panel) has exactly two field sections,
 * Artifact details then Branch details (a row no section names would add a
 * third, "More"), each a subsequence of its order, with the fixture's rows
 * drawn and the empty and unlisted ones absent.
 */
export async function expectBranchDetailsOrder(
  details: Locator,
  projectRow: BranchDetailsProjectRow
): Promise<void> {
  const sections = details.locator(DETAILS_TAB_FIELD_GROUPS_SELECTOR);
  await expect(sections.locator("h2")).toHaveText(
    BRANCH_DETAILS_SECTIONS.map((section) => section.title)
  );
  const drawn: string[] = [];
  for (const [index, section] of BRANCH_DETAILS_SECTIONS.entries()) {
    const labels = await sections
      .nth(index)
      .locator('[role="group"] > :first-child')
      .allTextContents();
    const order: readonly string[] = section.order;
    const positions = labels.map((label) => order.indexOf(label));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(positions.length);
    drawn.push(...labels);
  }
  expect(drawn[0]).toBe("Name");
  const projectDrawn = projectRow === BranchDetailsProjectRow.Drawn;
  expect(drawn).toEqual(
    expect.arrayContaining(
      projectDrawn ? [...DRAWN_ROWS, "Project"] : DRAWN_ROWS
    )
  );
  const absentRows = projectDrawn ? ABSENT_ROWS : [...ABSENT_ROWS, "Project"];
  for (const absent of absentRows) {
    expect(drawn).not.toContain(absent);
  }
}
