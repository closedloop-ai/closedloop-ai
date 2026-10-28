import { Priority } from "@repo/api/src/types/common";
import type { Meta, StoryObj } from "@storybook/react";
import type { ProjectSummaryRow } from "../lib/project-summary-row";
import { ProjectList } from "./project-list";

/**
 * The portable Projects surface (ISS-10476). Everything it renders comes from
 * props, so the states below are the whole prop-driven matrix a host can put it
 * in: populated, empty, read-only, and with the host's own row menu.
 *
 * `nowMs` is pinned on every story — the "Updated" window measures against it,
 * and a story that let it fall back to the wall clock would render differently
 * on every snapshot.
 */

const FIXED_NOW_MS = Date.parse("2026-09-25T12:00:00.000Z");
const DAY_MS = 86_400_000;

const ADA = { id: "u-ada", initials: "AL", name: "Ada Lovelace" };
const GRACE = { id: "u-grace", initials: "GH", name: "Grace Hopper" };

function row(
  overrides: Partial<ProjectSummaryRow> & Pick<ProjectSummaryRow, "id" | "name">
): ProjectSummaryRow {
  return {
    childTaskCount: null,
    code: null,
    completionPercentage: null,
    dueDateLabel: null,
    dueDateMs: null,
    owner: null,
    priority: null,
    updatedAtMs: FIXED_NOW_MS - DAY_MS,
    updatedLabel: "1 day ago",
    ...overrides,
  };
}

const ROWS: ProjectSummaryRow[] = [
  row({
    childTaskCount: 12,
    code: "PRO-1",
    completionPercentage: 64,
    dueDateLabel: "Oct 3, 2026",
    dueDateMs: Date.parse("2026-10-03T00:00:00.000Z"),
    id: "1",
    name: "Apollo",
    owner: ADA,
    priority: Priority.Urgent,
  }),
  row({
    childTaskCount: 4,
    code: "PRO-2",
    completionPercentage: 25,
    id: "2",
    name: "Borealis",
    owner: GRACE,
    priority: Priority.Medium,
  }),
  // No owner, no priority, no due date: the row that proves the surface renders
  // its unavailable treatments rather than a confident zero.
  row({ code: "PRO-3", id: "3", name: "Cassini" }),
];

const meta = {
  title: "Composites v1.0/Projects/Project List",
  component: ProjectList,
  tags: ["deprecated", "autodocs"],
  args: {
    nowMs: FIXED_NOW_MS,
    rows: ROWS,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ProjectList>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A host that can navigate but owns no mutations — board drag stays disabled. */
export const ReadOnly: Story = {
  args: {
    getRowHref: (candidate) => `/projects/${candidate.id}`,
  },
};

/**
 * A host that owns the project mutations: a row menu, inline editors in the
 * three writable columns, a Create action for the empty state, and a persisted
 * board drop. The editors here are stand-ins for the host's real pickers —
 * what the story documents is the seam, which is the whole of this prop.
 */
export const WithHostActions: Story = {
  args: {
    cellEditors: {
      dueDate: (candidate) => (
        <button type="button">{candidate.dueDateLabel ?? "—"}</button>
      ),
      owner: (candidate) => (
        <button type="button">{candidate.owner?.name ?? "No owner"}</button>
      ),
      priority: (candidate) => (
        <button type="button">{candidate.priority ?? "No priority"}</button>
      ),
    },
    emptyStateAction: <button type="button">Create Project</button>,
    getRowHref: (candidate) => `/projects/${candidate.id}`,
    onProjectGroupChange: () => undefined,
    rowActions: () => (
      <button aria-label="Open menu" type="button">
        …
      </button>
    ),
  },
};

/**
 * No projects at all. The host's Create action is the only thing standing
 * between a new team and a dead end, and it reaches every layout — the board
 * has no rows of its own to hang an empty state off.
 */
export const Empty: Story = {
  args: {
    emptyStateAction: <button type="button">Create Project</button>,
    rows: [],
  },
};
