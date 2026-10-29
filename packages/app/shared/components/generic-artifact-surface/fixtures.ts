import { DISPLAYED_SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ARTIFACT_STATUS_INLINE_COLUMN_WIDTH_PX } from "@repo/app/shared/components/artifact-status/artifact-status-layout";
import type { GridTableV2Column } from "@repo/design-system/components/ui/grid-table-v2";
import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import type { TableChoice } from "@repo/design-system/components/ui/table-cell-list-primitives";
import type { TablePerson } from "@repo/design-system/components/ui/table-cell-primitives";
import {
  TablePriority,
  type TablePriority as TablePriorityValue,
} from "@repo/design-system/components/ui/table-cell-semantic-primitives";
import {
  ColumnAlignment,
  type ColumnDefinition,
  ColumnFieldKind,
  type ColumnRegistry,
  createColumnRegistry,
} from "@repo/design-system/lib/column-registry";
import {
  FileIcon,
  HistoryIcon,
  type LucideIcon,
  PanelsTopLeftIcon,
  SquareCheckIcon,
} from "lucide-react";
import {
  GenericArtifactKind,
  type GenericArtifactKind as GenericArtifactKindType,
  GenericArtifactStatus,
  type GenericArtifactStatus as GenericArtifactStatusType,
  genericArtifactStatusOptions,
} from "./generic-artifact-status";
import type { RelatedSessionTableItem } from "./related-sessions-table-cell";

export const ArtifactStatus = GenericArtifactStatus;
export type ArtifactStatus = GenericArtifactStatusType;
const ArtifactKind = GenericArtifactKind;

export type ArtifactRow = {
  id: string;
  icon: LucideIcon;
  kind: GenericArtifactKindType;
  slug: string;
  title: string;
  owner: TablePerson;
  collaborators: TablePerson[];
  status: ArtifactStatus;
  statusRaw?: string;
  priority: TablePriorityValue;
  model: string;
  modelProvider: string;
  modelIndicatorClassName: string;
  relatedSessions: RelatedSessionTableItem[];
  comments: number;
  updated: string;
  updatedAgoMinutes: number;
  currentVersion: string;
  tags: TableChoice[];
  repository: string | null;
  creationCost: number | null;
  additions: number | null;
  deletions: number | null;
  customValues: Readonly<
    Record<string, string | number | readonly string[] | null>
  >;
};

/**
 * The artifact grid's data columns as ONE typed declaration set — ISS-9095's
 * column contract item 1, which this surface previously answered with three
 * parallel representations: a `GridTableV2Column[]`, a separate
 * `Record<string, number>` of widths, and a `gridTemplateColumns` string the
 * demo built by hand beside both.
 *
 * `kind` is the fact the old `GridTableV2Column[]` had no room for, and it is
 * what makes the set type-aware rather than merely typed: it resolves the
 * column's alignment, and `COLUMN_KIND_POLICY` refuses `groupable` on a kind
 * with no natural bands, so a `Date` column can no longer declare a grouping the
 * grid would render as one band per row.
 *
 * It does NOT yet select the cell primitive. `ArtifactCell` still dispatches on
 * `columnId` — a switch for the data columns and an id lookup for the custom
 * ones — so adding a declaration here without adding its case renders a blank
 * cell. Wiring the render through the declared kind is PRD-716 work, not a
 * property of this set today.
 *
 * `creationCost` takes the `Number` default and right-aligns: `TableNumberCell`
 * already right-aligns its value, so the header was the half that disagreed.
 *
 * TWO columns override back to `Start`, and BOTH reasons are about what the cell
 * primitive can render, never about the column.
 *
 * `lineChanges` was briefly set to `End` for parity with the cost column beside
 * it — both are `Number`, and on the fixture row where both are null the two
 * em-dashes then hug the same edge. Measured on the real render, that was the
 * wrong trade: `TableChangeCell`'s figure row is `flex items-center gap-2` with no
 * justify, so `+184 −42` stays at the start edge and an `End` header sits ~90px
 * away from the value it names, on the MAJORITY of rows, while the figures crowd
 * within ~27px of `$42.18` in the track before. Parity between two em-dashes is
 * parity between two ABSENCES — nobody scans a column of placeholders — so the
 * alignment follows the state that carries data. It also only gets better this
 * way: under ISS-9821's gate, `Start` agrees with the figures, the em-dash and
 * the header once the primitive learns to move its figure row, where `End` stays
 * half-wrong whatever the gate does.
 *
 * `comments` is not a figure you scan down at all — an icon plus a count that
 * opens a thread, so it reads as a control and leads from the start edge like
 * one. `TableCountCell` also never joins the alignment channel (it does not read
 * `useTableCellAlignEnd`), so a right-aligned header there could never be
 * followed even in principle.
 *
 * Both primitive gaps are FILED rather than papered over further, and when
 * ISS-11328 lands each override is deleted rather than adjusted.
 */
export const artifactColumnDefinitions: readonly ColumnDefinition[] = [
  {
    filterable: true,
    groupable: true,
    id: "owner",
    kind: ColumnFieldKind.Person,
    label: "Owner",
    sortable: true,
    tooltip:
      "The single accountable owner. Distinct from collaborators and contributors.",
    width: { default: 130 },
  },
  {
    filterable: true,
    groupable: true,
    id: "priority",
    kind: ColumnFieldKind.Choice,
    label: "Priority",
    sortable: true,
    width: { default: 120 },
  },
  {
    id: "collaborators",
    kind: ColumnFieldKind.PersonList,
    label: "Collaborators",
    width: { default: 130 },
  },
  {
    filterable: true,
    groupable: true,
    id: "status",
    kind: ColumnFieldKind.Choice,
    label: "Status",
    sortable: true,
    width: { default: ARTIFACT_STATUS_INLINE_COLUMN_WIDTH_PX },
  },
  {
    filterable: true,
    id: "relatedSessions",
    kind: ColumnFieldKind.Reference,
    label: "Related Sessions",
    tooltip:
      "Read-only sessions that wrote to this artifact or commented on it. Select a session to open its latest interaction in the Sessions trace.",
    width: { default: 220 },
  },
  {
    align: ColumnAlignment.Start,
    id: "comments",
    kind: ColumnFieldKind.Number,
    label: "Comments",
    sortable: true,
    width: { default: 100 },
  },
  {
    filterable: true,
    id: "updated",
    kind: ColumnFieldKind.Date,
    label: "Updated",
    sortable: true,
    width: { default: 100 },
  },
  {
    id: "currentVersion",
    kind: ColumnFieldKind.Text,
    label: "Current version",
    sortable: true,
    width: { default: 140 },
  },
  {
    filterable: true,
    id: "tags",
    kind: ColumnFieldKind.ChoiceList,
    label: "Tags",
    width: { default: 160 },
  },
  {
    filterable: true,
    id: "repository",
    kind: ColumnFieldKind.Reference,
    label: "Repository",
    sortable: true,
    width: { default: 180 },
  },
  {
    filterable: true,
    id: "model",
    kind: ColumnFieldKind.Choice,
    label: "Model",
    sortable: true,
    width: { default: 180 },
  },
  {
    id: "creationCost",
    kind: ColumnFieldKind.Number,
    label: "Creation cost",
    sortable: true,
    width: { default: 120 },
  },
  {
    align: ColumnAlignment.Start,
    id: "lineChanges",
    kind: ColumnFieldKind.Number,
    label: "Changes",
    sortable: true,
    tooltip: "Lines added and deleted for branch-backed artifacts.",
    width: { default: 140 },
  },
];

/**
 * The validated registry behind {@link artifactColumnDefinitions}.
 *
 * Built at module scope on purpose: a refused declaration is a programming error
 * in a fixture, and `createColumnRegistry` throwing at import surfaces it in the
 * author's own test run rather than as a column silently missing from a story.
 * This is the opposite of the Branches adapter's first-use construction, whose
 * throw would otherwise travel with the import and take down the very arm its
 * rollback flag exists to fall back to — nothing gates this demo.
 */
export const ARTIFACT_COLUMN_REGISTRY: ColumnRegistry = createColumnRegistry(
  artifactColumnDefinitions
);

/**
 * The render prop, DERIVED from the one declaration rather than authored beside
 * it. Kept as an export because `columnLabel` and `uniqueFieldId` read a
 * column's id and label and nothing else.
 */
export const artifactColumns: readonly GridTableV2Column[] =
  ARTIFACT_COLUMN_REGISTRY.toGridColumns();

export const artifactPeople: readonly TablePerson[] = [
  { initials: "AE", name: "Ottilie Eastwick" },
  { initials: "PB", name: "Pascoe Birchall" },
  { initials: "SC", name: "Sam Chen" },
  { initials: "JL", name: "Jordan Lee" },
];

/**
 * The width a custom column takes when its declaration does not name one. A
 * runtime-created field has no width to declare, so this is what it gets.
 */
export const DEFAULT_CUSTOM_COLUMN_WIDTH_PX = 180;

/**
 * A custom field declaration plus the one fact the add-field dialog's shape has
 * no room for: the track width the bridged {@link ColumnDefinition} takes. The
 * dialog authors fields a reader invents at runtime and cannot know how wide
 * their values run, but a FIXTURE field can, and one of these holds three
 * references at once.
 */
export type ArtifactCustomFieldDefinition = CustomFieldDefinition & {
  readonly defaultWidthPx?: number;
};

export const initialCustomFields: readonly ArtifactCustomFieldDefinition[] = [
  {
    id: "custom-stage",
    label: "Stage",
    optionColors: ["bg-warning", "bg-primary", "bg-success"],
    options: ["Discovery", "Build", "Validate"],
    type: "Single-select",
  },
  {
    id: "custom-capabilities",
    label: "Capabilities",
    optionColors: ["bg-primary", "bg-success", "bg-warning"],
    options: ["Grid", "Editing", "Governance"],
    type: "Multi-select",
  },
  { id: "custom-due-date", label: "Due date", type: "Date" },
  { id: "custom-reviewer", label: "Reviewer", type: "People" },
  {
    id: "custom-parent-artifact",
    label: "Parent artifact",
    sources: ["Issues"],
    type: "Reference",
  },
  {
    // Wider than the custom default: the demo rows put THREE references in this
    // one cell, so it carried its own 220px before the registry bridged these
    // fields and it keeps it now as a declaration rather than a width-map entry.
    defaultWidthPx: 220,
    id: "custom-is-implemented-by",
    label: "Is Implemented By",
    sources: ["Artifacts"],
    type: "Reference",
  },
  {
    id: "custom-cycle-time",
    label: "Cycle time",
    timeFormat: "duration",
    type: "Time",
  },
  { id: "custom-summary", label: "Summary", type: "Text" },
  { id: "custom-revision-count", label: "Revision count", type: "Number" },
];

export const tagOptions: readonly TableChoice[] = [
  choice(
    "Brief",
    "border-red-500/25 bg-red-500/15 text-red-700 dark:text-red-300"
  ),
  choice(
    "Design",
    "border-orange-500/25 bg-orange-500/15 text-orange-700 dark:text-orange-300"
  ),
  choice(
    "Design system",
    "border-amber-500/25 bg-amber-500/15 text-amber-700 dark:text-amber-300"
  ),
  choice(
    "Documents",
    "border-yellow-500/25 bg-yellow-500/15 text-yellow-700 dark:text-yellow-300"
  ),
  choice(
    "Foundations",
    "border-lime-500/25 bg-lime-500/15 text-lime-700 dark:text-lime-300"
  ),
  choice(
    "Governance",
    "border-green-500/25 bg-green-500/15 text-green-700 dark:text-green-300"
  ),
  choice(
    "Platform",
    "border-emerald-500/25 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
  ),
  choice(
    "Principles",
    "border-cyan-500/25 bg-cyan-500/15 text-cyan-700 dark:text-cyan-300"
  ),
  choice(
    "Product",
    "border-blue-500/25 bg-blue-500/15 text-blue-700 dark:text-blue-300"
  ),
  choice(
    "Prototype",
    "border-indigo-500/25 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
  ),
  choice(
    "Research",
    "border-purple-500/25 bg-purple-500/15 text-purple-700 dark:text-purple-300"
  ),
  choice(
    "Sessions",
    "border-fuchsia-500/25 bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300"
  ),
  choice(
    "UX",
    "border-rose-500/25 bg-rose-500/15 text-rose-700 dark:text-rose-300"
  ),
];

export const initialArtifactRows: readonly ArtifactRow[] = [
  {
    id: "artifact-1",
    icon: SquareCheckIcon,
    kind: ArtifactKind.Issue,
    slug: "FEA-2481",
    title: "Unified artifact experience",
    owner: person("Ottilie Eastwick"),
    collaborators: people("Pascoe Birchall", "Sam Chen", "Jordan Lee"),
    status: ArtifactStatus.InReview,
    priority: TablePriority.High,
    model: "claude-opus-4-6",
    modelProvider: "Anthropic",
    modelIndicatorClassName: "text-primary",
    relatedSessions: relatedSessions("/p/web-master/issues/FEA-2481", "2481"),
    comments: 14,
    updated: "just now",
    updatedAgoMinutes: 1,
    currentVersion: "4",
    tags: tags("Foundations", "UX"),
    repository: "closedloop-ai/closedloop-ai",
    creationCost: 42.18,
    additions: 184,
    deletions: 42,
    customValues: {
      "custom-capabilities": ["Grid", "Editing", "Governance"],
      "custom-cycle-time": "02:14",
      "custom-due-date": "2026-08-20",
      "custom-is-implemented-by": ["ISS-4382", "BRN-grid-table-v2", "SES-7B91"],
      "custom-parent-artifact": "ISS-4382",
      "custom-revision-count": 98,
      "custom-reviewer": "Pascoe Birchall",
      "custom-stage": "Build",
      "custom-summary": "Prototype parity",
    },
  },
  {
    id: "artifact-2",
    icon: FileIcon,
    kind: ArtifactKind.Document,
    slug: "DOC-184",
    title: "Artifact interaction principles",
    owner: person("Pascoe Birchall"),
    collaborators: people("Ottilie Eastwick", "Jordan Lee"),
    status: ArtifactStatus.Approved,
    priority: TablePriority.Medium,
    model: "gpt-5.6-sol",
    modelProvider: "OpenAI",
    modelIndicatorClassName: "text-success",
    relatedSessions: relatedSessions("/p/web-master/documents/DOC-184", "184"),
    comments: 8,
    updated: "12d ago",
    updatedAgoMinutes: 12 * 24 * 60,
    currentVersion: "3",
    tags: tags(
      "Principles",
      "Product",
      "Design system",
      "Research",
      "Governance"
    ),
    repository: "closedloop-ai/closedloop-ai",
    creationCost: 18.4,
    additions: 76,
    deletions: 18,
    customValues: {
      "custom-capabilities": ["Governance"],
      "custom-cycle-time": "00:48",
      "custom-due-date": "2026-08-27",
      "custom-is-implemented-by": ["ISS-4382", "BRN-grid-table-v2"],
      "custom-parent-artifact": "FEA-2481",
      "custom-revision-count": 91,
      "custom-reviewer": "Ottilie Eastwick",
      "custom-stage": "Validate",
      "custom-summary": "Promotion contract",
    },
  },
  {
    id: "artifact-3",
    icon: HistoryIcon,
    kind: ArtifactKind.Session,
    slug: "SES-7B91",
    title: "Prototype generic artifact shells",
    owner: person("Ottilie Eastwick"),
    collaborators: people("Pascoe Birchall", "Sam Chen"),
    status: ArtifactStatus.Active,
    priority: TablePriority.Low,
    model: "claude-opus-4-6",
    modelProvider: "Anthropic",
    modelIndicatorClassName: "text-primary",
    relatedSessions: [],
    comments: 23,
    updated: "29d ago",
    updatedAgoMinutes: 29 * 24 * 60,
    currentVersion: "1",
    tags: tags("Prototype", "Design"),
    repository: null,
    creationCost: null,
    additions: null,
    deletions: null,
    customValues: {},
  },
];

export const statusOptions = [
  ...new Set(
    initialArtifactRows.flatMap((artifact) =>
      genericArtifactStatusOptions(artifact.kind)
    )
  ),
];

export function tagChoice(label: string): TableChoice {
  return (
    tagOptions.find((option) => option.label === label) ??
    choice(label, "border-border bg-muted text-muted-foreground")
  );
}

function choice(label: string, className: string): TableChoice {
  return { className, id: label.toLowerCase().replaceAll(" ", "-"), label };
}

function person(name: string): TablePerson {
  const match = artifactPeople.find((candidate) => candidate.name === name);
  if (!match) {
    throw new Error(`Missing fixture person: ${name}`);
  }
  return { ...match };
}

function people(...names: string[]): TablePerson[] {
  return names.map(person);
}

function tags(...labels: string[]): TableChoice[] {
  return labels.map(tagChoice);
}

function relatedSessions(
  artifactHref: string,
  artifactKey: string
): RelatedSessionTableItem[] {
  return [
    {
      href: `${artifactHref}?tab=sessions&traceRow=102`,
      id: `session-finalize-${artifactKey}`,
      occurredAt: "2026-07-31T09:02:00-05:00",
      ownerName: "Avery Example",
      relationshipLabel: "Wrote to artifact",
      sessionSlug: `SES-${artifactKey}-3`,
      status: DISPLAYED_SESSION_STATUS.ACTIVE,
    },
    {
      href: `${artifactHref}?tab=sessions&traceRow=86`,
      id: `session-revision-${artifactKey}`,
      occurredAt: "2026-07-26T17:54:00-05:00",
      ownerName: "Morgan Sample",
      relationshipLabel: "Commented on artifact",
      sessionSlug: `SES-${artifactKey}-2`,
      status: DISPLAYED_SESSION_STATUS.INACTIVE,
    },
    {
      href: `${artifactHref}?tab=sessions&traceRow=46`,
      id: `session-discovery-${artifactKey}`,
      occurredAt: "2026-07-22T00:35:00-05:00",
      ownerName: "Riley Demo",
      relationshipLabel: "Wrote to artifact",
      sessionSlug: `SES-${artifactKey}-1`,
      status: DISPLAYED_SESSION_STATUS.INACTIVE,
    },
  ];
}

export const prototypeIcon = PanelsTopLeftIcon;
