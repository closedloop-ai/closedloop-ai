import type { Meta, StoryObj } from "@storybook/react";
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
  {
    id: "ses_1",
    name: "agent/refactor-auth-guard",
    user: { name: "Parker Byrd", avatarUrl: null },
    status: "active",
    harness: "claude",
    branch: "fea-2036",
    repo: "closedloop/symphony-alpha",
    model: "opus-4.8",
    autonomy: 88,
    durationLabel: "12m 04s",
    costLabel: "$4.12",
    startedLabel: "2h ago",
    lastActivityLabel: "2h ago",
  },
  {
    id: "ses_2",
    name: "agent/seed-generator",
    user: { name: "Alex Rivera", avatarUrl: null },
    status: "completed",
    harness: "codex",
    branch: "main",
    repo: "closedloop/closedloop-web",
    model: "sonnet-4.6",
    autonomy: 42,
    durationLabel: "3m 41s",
    costLabel: "$1.08",
    startedLabel: "5h ago",
    lastActivityLabel: "5h ago",
  },
  {
    id: "ses_3",
    name: "fix/token-rounding",
    // No local user identity (desktop-style row).
    user: null,
    status: "failed",
    harness: "cursor",
    branch: null,
    repo: null,
    model: null,
    durationLabel: "0m 52s",
    costLabel: "$0.24",
    startedLabel: "yesterday",
    lastActivityLabel: "yesterday",
  },
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
