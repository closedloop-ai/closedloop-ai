import { CostAvailability } from "@repo/app/agents/lib/cost-availability";
import { SessionGroupBy } from "@repo/app/agents/lib/session-grouping";
import { SessionRepositoryDisplayKind } from "@repo/app/agents/lib/session-repository-label";
import type { Meta, StoryObj } from "@storybook/react";
import { createSessionTableRowFixture } from "./session-list-fixtures";
import { SessionsTable, type SessionTableRow } from "./sessions-table";

/**
 * Presentational sessions table. Callers map their own records to
 * `SessionTableRow` and supply `renderName` to wrap the name in their platform's
 * navigation element (a `<Link>` on the web, a `<button>` on desktop).
 */
const meta = {
  title: "App Core/Agents/Sessions Table",
  component: SessionsTable,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <main className="h-[400px] overflow-auto">
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof SessionsTable>;

export default meta;

type Story = StoryObj<typeof meta>;

const ROWS: SessionTableRow[] = [
  createSessionTableRowFixture({
    autonomy: 88,
    branch: "fea-2036",
    durationLabel: "12m 04s",
    id: "ses_1",
    lastActivityLabel: "2h ago",
    mergeStatusLabel: "Not merged",
    model: "opus-4.8",
    pullRequestSummaryLabel: "#42 open",
    pullRequests: [
      {
        label: "#42 open",
        numberLabel: "#42",
        statusLabel: "open",
        title: "Add session PR columns",
      },
    ],
    repo: "closedloop/symphony-alpha",
    user: { avatarUrl: null, name: "Parker Byrd" },
  }),
  createSessionTableRowFixture({
    autonomy: 42,
    branch: "main",
    costAvailability: CostAvailability.Subscription,
    costLabel: "$1.08",
    costTooltip: "Billed through your subscription",
    durationLabel: "3m 41s",
    harness: "codex",
    id: "ses_2",
    lastActivityLabel: "5h ago",
    mergeStatusLabel: "Merged",
    model: "sonnet-4.6",
    name: "agent/seed-generator",
    pullRequestSummaryLabel: "#84 merged",
    pullRequests: [
      {
        label: "#84 merged",
        numberLabel: "#84",
        statusLabel: "merged",
        title: "Merge session sync",
      },
    ],
    repo: "closedloop/closedloop-web",
    startedLabel: "5h ago",
    status: "completed",
    user: { avatarUrl: null, name: "Alex Rivera" },
  }),
  createSessionTableRowFixture({
    branch: null,
    costLabel: "$0.24",
    durationLabel: "0m 52s",
    harness: "cursor",
    id: "ses_3",
    lastActivityLabel: "yesterday",
    model: null,
    name: "fix/token-rounding",
    repo: null,
    // ISS-4996: a repository value WAS stored but carries no identity. This is
    // the one Repository state that keeps a word instead of the em dash,
    // because it is a data-quality signal that should stay visible.
    repositoryDisplay: { kind: SessionRepositoryDisplayKind.Malformed },
    startedLabel: "yesterday",
    status: "failed",
    // No local user identity (desktop-style row).
    user: null,
  }),
  createSessionTableRowFixture({
    branch: "feat/schema-explore",
    costAvailability: CostAvailability.Unavailable,
    costLabel: "$0.00",
    costTooltip: "No pricing data for this model",
    durationLabel: "4m 18s",
    id: "ses_4",
    lastActivityLabel: "3h ago",
    model: "unknown-model-2026",
    name: "agent/explore-schema",
    repo: "closedloop/symphony-alpha",
    startedLabel: "3h ago",
    status: "completed",
    user: { avatarUrl: null, name: "Dana Kim" },
  }),
  createSessionTableRowFixture({
    branch: null,
    costAvailability: CostAvailability.NoUsage,
    costLabel: "",
    durationLabel: "0m 01s",
    id: "ses_5",
    lastActivityLabel: "1d ago",
    model: "sonnet-4.6",
    name: "bot/health-check",
    repo: null,
    // ISS-4996: no Git remote was ever resolved — the ordinary case, and the
    // same fact as this row's null branch, so it gets the same empty glyph.
    repositoryDisplay: { kind: SessionRepositoryDisplayKind.Absent },
    startedLabel: "1d ago",
    status: "completed",
    user: null,
  }),
];

/** Web-style: name wrapped in a link. */
export const WithLinks: Story = {
  args: {
    items: ROWS,
    renderName: (row, className) => (
      <a className={className} href={`#/sessions/${row.id}`}>
        {row.name}
      </a>
    ),
  },
};

/** Desktop-style: name wrapped in a button that triggers a drill-down. */
export const WithButtons: Story = {
  args: {
    items: ROWS,
    renderName: (row, className) => (
      <button
        className={`${className} text-left`}
        onClick={() => {
          /* openSession(row.id) */
        }}
        type="button"
      >
        {row.name}
      </button>
    ),
  },
};

/**
 * #4480 review: banding by Status. One section header per band carries the band
 * icon and label, and the banded Status column is dropped from every row — the
 * header already states that value, so repeating it down the rows is noise.
 * `showGroupCount` defaults to false, so no band prints a number.
 */
export const GroupedByStatus: Story = {
  args: {
    items: ROWS,
    groupBy: SessionGroupBy.Status,
    renderName: (row, className) => (
      <a className={className} href={`#/sessions/${row.id}`}>
        {row.name}
      </a>
    ),
  },
};

/**
 * #4480 review: banding by Harness with `showGroupCount` ON. Contrast with
 * {@link GroupedByStatus}, which leaves it at its default OFF — a bare number
 * beside a band label reads as the population, and the Sessions list is
 * server-paginated, so only a caller holding the whole set should turn it on.
 */
export const GroupedByHarnessWithCounts: Story = {
  args: {
    items: ROWS,
    groupBy: SessionGroupBy.Harness,
    showGroupCount: true,
    renderName: (row, className) => (
      <a className={className} href={`#/sessions/${row.id}`}>
        {row.name}
      </a>
    ),
  },
};

/**
 * #4480 review: banding by Owner, including the rows with no local user
 * identity — those fall into their own band rather than disappearing.
 */
export const GroupedByOwner: Story = {
  args: {
    items: ROWS,
    groupBy: SessionGroupBy.Owner,
    renderName: (row, className) => (
      <a className={className} href={`#/sessions/${row.id}`}>
        {row.name}
      </a>
    ),
  },
};
