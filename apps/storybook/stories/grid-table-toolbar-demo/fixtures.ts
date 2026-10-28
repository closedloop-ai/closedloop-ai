import type { TableFilterOption } from "@repo/design-system/components/ui/table-filters-v2";
import type {
  TableFieldOption,
  TableSavedView,
  TableToggleOption,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { TableSavedViewScope } from "@repo/design-system/components/ui/table-toolbar-model";
import type { TableDateRangeOption } from "@repo/design-system/components/ui/table-toolbar-toggles-v2";

/**
 * Session-shaped fixtures for the `GridTableToolbar` composite.
 *
 * Deliberately sessions rather than artifacts: the toolbar was lifted from the
 * Generic Artifact prototype, and the point of the promotion is that it is NOT
 * artifact-shaped. Driving it with a different domain is the cheapest proof
 * that nothing artifact-specific survived the extraction, and it is the shape
 * ISS-7052 needs for the Sessions listing parity work.
 */

export type SessionRow = {
  id: string;
  name: string;
  slug: string;
  owner: string;
  status: SessionStatus;
  repository: string;
  model: string;
  cost: number;
  duration: string;
  updated: string;
};

export const SessionStatus = {
  Active: "Active",
  Blocked: "Blocked",
  Done: "Done",
  Failed: "Failed",
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export const SESSION_ROWS: SessionRow[] = [
  {
    id: "ses_7b91",
    name: "agent/refactor-auth-guard",
    slug: "SES-7B91",
    owner: "Ottilie Eastwick",
    status: SessionStatus.Active,
    repository: "closedloop-ai/closedloop-ai",
    model: "Opus 5",
    cost: 4.12,
    duration: "18m",
    updated: "2 hours ago",
  },
  {
    id: "ses_7b74",
    name: "fix/token-rounding",
    slug: "SES-7B74",
    owner: "Pascoe Birchall",
    status: SessionStatus.Failed,
    repository: "closedloop-ai/closedloop-ai",
    model: "Sonnet 5",
    cost: 0.24,
    duration: "41m",
    updated: "Yesterday",
  },
  {
    id: "ses_7b58",
    name: "agent/seed-generator",
    slug: "SES-7B58",
    owner: "Marisol Ashgrove",
    status: SessionStatus.Done,
    repository: "closedloop-ai/closedloop-electron",
    model: "Opus 5",
    cost: 1.08,
    duration: "3m",
    updated: "2 days ago",
  },
  {
    id: "ses_7b40",
    name: "feat/grid-table-toolbar",
    slug: "SES-7B40",
    owner: "Ottilie Eastwick",
    status: SessionStatus.Active,
    repository: "closedloop-ai/closedloop-ai",
    model: "Opus 5",
    cost: 9.87,
    duration: "1h 12m",
    updated: "3 days ago",
  },
  {
    id: "ses_7b12",
    name: "chore/upgrade-prisma",
    slug: "SES-7B12",
    owner: "Pascoe Birchall",
    status: SessionStatus.Blocked,
    repository: "closedloop-ai/closedloop-electron",
    model: "Haiku 4.5",
    cost: 0.61,
    duration: "7m",
    updated: "5 days ago",
  },
  {
    id: "ses_7a98",
    name: "agent/backfill-telemetry",
    slug: "SES-7A98",
    owner: "Marisol Ashgrove",
    status: SessionStatus.Done,
    repository: "closedloop-ai/closedloop-ai",
    model: "Sonnet 5",
    cost: 2.45,
    duration: "22m",
    updated: "1 week ago",
  },
];

/** Column id → header label. The single source both the table and the menus read. */
export const SESSION_COLUMNS: readonly TableToggleOption[] = [
  { key: "owner", label: "Owner" },
  { key: "status", label: "Status" },
  { key: "repository", label: "Repository" },
  { key: "model", label: "Model" },
  { key: "cost", label: "Cost" },
  { key: "duration", label: "Duration" },
  { key: "updated", label: "Updated" },
];

/** Rendered pixel width per column, paired with `SESSION_COLUMNS` by key. */
export const SESSION_COLUMN_WIDTHS: Readonly<Record<string, number>> = {
  owner: 150,
  status: 120,
  repository: 220,
  model: 120,
  cost: 100,
  duration: 110,
  updated: 140,
};

export const SESSION_SORT_OPTIONS: readonly TableFieldOption[] = [
  { id: "name", label: "Session" },
  { id: "owner", label: "Owner" },
  { id: "status", label: "Status" },
  { id: "cost", label: "Cost" },
  { id: "updated", label: "Updated" },
];

/**
 * Only the low-cardinality columns are groupable. Grouping by `cost` would
 * produce one group per row, which is why the list is not just every column.
 */
export const SESSION_GROUP_OPTIONS: readonly TableFieldOption[] = [
  { id: "status", label: "Status" },
  { id: "owner", label: "Owner" },
  { id: "repository", label: "Repository" },
  { id: "model", label: "Model" },
];

export const SESSION_METRICS: readonly TableToggleOption[] = [
  { key: "sessions", label: "Sessions" },
  { key: "spend", label: "Token spend" },
  { key: "active", label: "Active now" },
  { key: "failures", label: "Failures" },
];

export const SESSION_DATE_RANGES: readonly TableDateRangeOption[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time", shortLabel: "All" },
];

export const SESSION_SAVED_VIEWS: readonly TableSavedView[] = [
  { id: "view_mine", name: "My sessions", scope: TableSavedViewScope.Personal },
  {
    id: "view_failures",
    name: "Needs attention",
    scope: TableSavedViewScope.Personal,
  },
  {
    id: "view_team",
    name: "Platform team",
    scope: TableSavedViewScope.Team,
  },
  {
    id: "view_release",
    name: "Release blockers",
    scope: TableSavedViewScope.Project,
  },
];

export const SESSION_STATUS_OPTIONS: readonly TableFilterOption[] = [
  { id: SessionStatus.Active, label: "Active" },
  { id: SessionStatus.Blocked, label: "Blocked" },
  { id: SessionStatus.Done, label: "Done" },
  { id: SessionStatus.Failed, label: "Failed" },
];

export const SESSION_OWNER_OPTIONS: readonly TableFilterOption[] = [
  { id: "Ottilie Eastwick", label: "Ottilie Eastwick" },
  { id: "Pascoe Birchall", label: "Pascoe Birchall" },
  { id: "Marisol Ashgrove", label: "Marisol Ashgrove" },
];

/** Every column visible, which is the default a fresh view starts from. */
export const DEFAULT_VISIBLE_COLUMN_IDS: readonly string[] =
  SESSION_COLUMNS.map((column) => column.key);

/** Two of the four metric cards, so the options menu has something to reveal. */
export const DEFAULT_VISIBLE_METRIC_KEYS: readonly string[] = [
  "sessions",
  "spend",
];
