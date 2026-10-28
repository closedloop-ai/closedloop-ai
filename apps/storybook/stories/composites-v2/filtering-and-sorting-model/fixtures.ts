import {
  SESSION_STATUS,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import type { TableFilterOption } from "@repo/design-system/components/ui/table-filters";
import type {
  TableFieldOption,
  TableSavedView,
  TableToggleOption,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { TableSavedViewScope } from "@repo/design-system/components/ui/table-toolbar-model";
import type { TableDateRangeOption } from "@repo/design-system/components/ui/table-toolbar-toggles-v2";
import {
  type ColumnDefinition,
  ColumnFieldKind,
} from "@repo/design-system/lib/column-registry";

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
  model: string | null;
  cost: number;
  duration: string;
  updated: string;
  updatedAt: string;
};

export const SESSION_ROWS: SessionRow[] = [
  {
    id: "ses_7b91",
    name: "agent/refactor-auth-guard",
    slug: "SES-7B91",
    owner: "Ottilie Eastwick",
    status: SESSION_STATUS.ACTIVE,
    repository: "closedloop-ai/closedloop-ai",
    model: "Opus 5",
    cost: 4.12,
    duration: "18m",
    updated: "2 hours ago",
    updatedAt: "2026-08-19T22:00:00.000Z",
  },
  {
    id: "ses_7b74",
    name: "fix/token-rounding",
    slug: "SES-7B74",
    owner: "Pascoe Birchall",
    status: SESSION_STATUS.ERROR,
    repository: "closedloop-ai/closedloop-ai",
    model: "Sonnet 5",
    cost: 0.24,
    duration: "41m",
    updated: "Yesterday",
    updatedAt: "2026-08-19T00:00:00.000Z",
  },
  {
    id: "ses_7b58",
    name: "agent/seed-generator",
    slug: "SES-7B58",
    owner: "Marisol Ashgrove",
    status: SESSION_STATUS.INACTIVE,
    repository: "closedloop-ai/closedloop-electron",
    model: "Opus 5",
    cost: 1.08,
    duration: "3m",
    updated: "2 days ago",
    updatedAt: "2026-08-18T00:00:00.000Z",
  },
  {
    id: "ses_7b40",
    name: "feat/grid-table-toolbar",
    slug: "SES-7B40",
    owner: "Ottilie Eastwick",
    status: SESSION_STATUS.ACTIVE,
    repository: "closedloop-ai/closedloop-ai",
    model: "Opus 5",
    cost: 9.87,
    duration: "1h 12m",
    updated: "3 days ago",
    updatedAt: "2026-08-17T00:00:00.000Z",
  },
  {
    id: "ses_7b12",
    name: "chore/upgrade-prisma",
    slug: "SES-7B12",
    owner: "Pascoe Birchall",
    status: SESSION_STATUS.ERROR,
    repository: "closedloop-ai/closedloop-electron",
    model: null,
    cost: 0.24,
    duration: "7m",
    updated: "5 days ago",
    updatedAt: "2026-08-15T00:00:00.000Z",
  },
  {
    id: "ses_7a98",
    name: "agent/backfill-telemetry",
    slug: "SES-7A98",
    owner: "Marisol Ashgrove",
    status: SESSION_STATUS.INACTIVE,
    repository: "closedloop-ai/closedloop-ai",
    model: "Sonnet 5",
    cost: 2.45,
    duration: "22m",
    updated: "1 week ago",
    updatedAt: "2026-08-12T00:00:00.000Z",
  },
];

/** One declaration set for the table, toolbar, capabilities, and layout. */
export const SESSION_COLUMN_DEFINITIONS = [
  {
    filterable: true,
    id: "owner",
    kind: ColumnFieldKind.Person,
    label: "Owner",
    groupable: true,
    sortable: true,
    width: { default: 150 },
  },
  {
    id: "status",
    kind: ColumnFieldKind.Choice,
    label: "Status",
    filterable: true,
    groupable: true,
    sortable: true,
    width: { default: 120 },
  },
  {
    id: "repository",
    kind: ColumnFieldKind.Reference,
    label: "Repository",
    groupable: true,
    width: { default: 220 },
  },
  {
    id: "model",
    kind: ColumnFieldKind.Choice,
    label: "Model",
    groupable: true,
    width: { default: 120 },
  },
  {
    id: "cost",
    kind: ColumnFieldKind.Number,
    label: "Cost",
    sortable: true,
    width: { default: 100 },
  },
  {
    id: "duration",
    kind: ColumnFieldKind.Number,
    label: "Duration",
    width: { default: 110 },
  },
  {
    id: "updated",
    kind: ColumnFieldKind.Date,
    label: "Updated",
    sortable: true,
    width: { default: 140 },
  },
] as const satisfies readonly ColumnDefinition[];

/** Column id and label options derived from the layout declaration. */
export const SESSION_COLUMNS: readonly TableToggleOption[] =
  SESSION_COLUMN_DEFINITIONS.map(({ id, label }) => ({ key: id, label }));

export const SessionSortKind = {
  Date: "date",
  Number: "number",
  Status: "status",
  String: "string",
} as const;
export type SessionSortKind =
  (typeof SessionSortKind)[keyof typeof SessionSortKind];

export const SESSION_SORT_FIELDS = [
  { id: "name", key: "name", kind: SessionSortKind.String, label: "Session" },
  { id: "owner", key: "owner", kind: SessionSortKind.String, label: "Owner" },
  {
    id: "status",
    key: "status",
    kind: SessionSortKind.Status,
    label: "Status",
  },
  { id: "cost", key: "cost", kind: SessionSortKind.Number, label: "Cost" },
  {
    id: "updated",
    key: "updatedAt",
    kind: SessionSortKind.Date,
    label: "Updated",
  },
] as const satisfies readonly SessionSortFieldDefinition[];

export type SessionSortFieldId = (typeof SESSION_SORT_FIELDS)[number]["id"];

export const SESSION_SORT_OPTIONS: readonly TableFieldOption[] =
  SESSION_SORT_FIELDS.map(({ id, label }) => ({ id, label }));

/**
 * Only the low-cardinality columns are groupable. Grouping by `cost` would
 * produce one group per row, which is why the list is not just every column.
 */
export const SESSION_GROUP_OPTIONS: readonly TableFieldOption[] =
  SESSION_COLUMN_DEFINITIONS.filter(
    (definition) => definition.groupable === true
  ).map(({ id, label }) => ({ id, label }));

export const SESSION_METRICS: readonly TableToggleOption[] = [
  { key: "sessions", label: "Sessions" },
  { key: "spend", label: "Token spend" },
  { key: "active", label: "Active now" },
  { key: "failures", label: "Failures" },
];

export const SessionDateRange = {
  Last7Days: "7d",
  Last30Days: "30d",
  Last90Days: "90d",
  All: "all",
} as const;
export type SessionDateRange =
  (typeof SessionDateRange)[keyof typeof SessionDateRange];

export const SESSION_DATE_RANGE_DEFINITIONS = [
  { value: SessionDateRange.Last7Days, label: "Last 7 days", days: 7 },
  { value: SessionDateRange.Last30Days, label: "Last 30 days", days: 30 },
  { value: SessionDateRange.Last90Days, label: "Last 90 days", days: 90 },
  {
    value: SessionDateRange.All,
    label: "All time",
    shortLabel: "All",
    days: null,
  },
] as const satisfies readonly SessionDateRangeDefinition[];

export const SESSION_DATE_RANGES: readonly TableDateRangeOption[] =
  SESSION_DATE_RANGE_DEFINITIONS.map(({ value, label, ...definition }) => ({
    value,
    label,
    ...(definition.shortLabel ? { shortLabel: definition.shortLabel } : {}),
  }));

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

export const SESSION_STATUS_OPTIONS: readonly TableFilterOption[] =
  Object.values(SESSION_STATUS).map((status) => ({
    id: status,
    label: SESSION_STATUS_LABELS[status],
  }));

export const SESSION_OWNER_OPTIONS: readonly TableFilterOption[] = [
  { id: "Ottilie Eastwick", label: "Ottilie Eastwick" },
  { id: "Pascoe Birchall", label: "Pascoe Birchall" },
  { id: "Marisol Ashgrove", label: "Marisol Ashgrove" },
];

/** Every column visible, which is the default a fresh view starts from. */
export const DEFAULT_VISIBLE_COLUMN_IDS: readonly string[] =
  SESSION_COLUMN_DEFINITIONS.map((column) => column.id);

/** Two of the four metric cards, so the options menu has something to reveal. */
export const DEFAULT_VISIBLE_METRIC_KEYS: readonly string[] = [
  "sessions",
  "spend",
];

type SessionSortFieldDefinition = {
  readonly id: string;
  readonly key: keyof SessionRow;
  readonly kind: SessionSortKind;
  readonly label: string;
};

type SessionDateRangeDefinition = {
  readonly value: SessionDateRange;
  readonly label: string;
  readonly shortLabel?: string;
  readonly days: number | null;
};
