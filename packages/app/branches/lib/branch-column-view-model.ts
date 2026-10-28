import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import {
  BranchListFilterFacet,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { ARTIFACT_PROJECT_FIELD_LABEL } from "@repo/app/projects/lib/project-field-labels";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { artifactStatusFacet } from "@repo/app/shared/lib/artifact-status-adapter";
import { groupRowEntries } from "@repo/app/shared/lib/table-grouping";
import type {
  TableGroupingState,
  TableGroupOrder,
  TableSortRule,
} from "@repo/design-system/components/ui/table-toolbar-model";
import type { GridTableV2Group } from "@repo/design-system/lib/grid-table-v2-types";
import type { ColumnViewModel } from "../../shared/lib/column-view-model";
import { PRIORITY_COLUMN_LABEL } from "../../shared/lib/priority-constants";
import { repositoryDisplayLabels } from "./branch-repository-display-labels";
import {
  BRANCH_STATUS_CONFIG,
  type BranchRow,
  branchStatusEvidence,
  RENDER_MISSING,
  RENDER_UNATTRIBUTED,
} from "./branch-row";

/**
 * ISS-9676 — the Branches list's column view model: what each column may be
 * sorted, filtered, and grouped by, declared once.
 *
 * Branches had every ingredient and no declaration. `BranchListSortKey` named
 * eight orderings and `sortBranchRows` implemented them; nine facets existed;
 * and the v2 toolbar still omitted `sortGrouping` entirely, because the surface
 * had no way to state which columns those capabilities belonged to. PR #6680's
 * stated blocker — "no branch sort vocabulary yet" — was never true. The missing
 * piece was participation in the shared contract, which is this file.
 *
 * The grouping vocabulary is the operator's (2026-09-07): Author, Repository,
 * and PR / review state. Those three words are the DIMENSION names in the group
 * menu and are deliberately not the column headers beside them — "Owner" names
 * what the cell holds, "Author" names what the bands are cut by.
 */

/** The lead (branch name) column, which is a sort key but not a data column. */
export const BRANCH_NAME_COLUMN_ID = "name";

/** The canonical Linked sessions membership column. */
export const BRANCH_SESSIONS_COLUMN_ID = "sessions";

/** ISS-10332: the Priority column, offered only by a mount that opts in. */
export const BRANCH_PRIORITY_COLUMN_ID = "priority";

/** ISS-12456: the Tags column, offered only by a mount whose source serves it. */
export const BRANCH_TAGS_COLUMN_ID = "tags";

/** ISS-12453: the Project column. */
export const BRANCH_PROJECT_COLUMN_ID = "project";

export const BRANCH_COLUMN_VIEW_MODEL = [
  {
    id: BRANCH_NAME_COLUMN_ID,
    label: "Name",
    isSortable: true,
    isFilterable: true,
    filterFacetId: BranchListFilterFacet.Name,
    isGroupable: false,
    groupLabel: null,
  },
  {
    id: "owner",
    label: "Owner",
    isSortable: true,
    isFilterable: true,
    filterFacetId: BranchListFilterFacet.Owner,
    isGroupable: true,
    groupLabel: "Author",
  },
  // Collaborators is filterable but NOT sortable: a row holds a list of people,
  // so an ordering over it would have to pick one, and `BranchListSortKey` has
  // never carried a key for it.
  {
    id: "collaborators",
    label: "Collaborators",
    isSortable: false,
    isFilterable: true,
    filterFacetId: BranchListFilterFacet.Collaborators,
    isGroupable: false,
    groupLabel: null,
  },
  // Linked sessions is the mirror case: a real sort key with no facet. The
  // approved filter set never grew one, and declaring the column filterable
  // would offer a popover entry that narrows nothing.
  {
    id: BRANCH_SESSIONS_COLUMN_ID,
    label: "Linked sessions",
    isSortable: true,
    isFilterable: false,
    filterFacetId: null,
    isGroupable: false,
    groupLabel: null,
  },
  {
    id: "changes",
    label: "Changes",
    isSortable: true,
    isFilterable: true,
    filterFacetId: BranchListFilterFacet.Changes,
    isGroupable: false,
    groupLabel: null,
  },
  {
    id: "status",
    label: "Status",
    isSortable: true,
    isFilterable: true,
    filterFacetId: BranchListFilterFacet.Status,
    isGroupable: true,
    groupLabel: "PR / review state",
  },
  {
    id: "pr",
    label: "Pull request",
    isSortable: true,
    isFilterable: true,
    filterFacetId: BranchListFilterFacet.PullRequest,
    isGroupable: false,
    groupLabel: null,
  },
  {
    id: "lastActivity",
    label: "Last active",
    isSortable: true,
    isFilterable: true,
    filterFacetId: BranchListFilterFacet.LastActive,
    isGroupable: false,
    groupLabel: null,
  },
  {
    id: "repo",
    label: "Repository",
    isSortable: true,
    isFilterable: true,
    filterFacetId: BranchListFilterFacet.Repository,
    isGroupable: true,
    groupLabel: "Repository",
  },
  {
    id: BRANCH_TAGS_COLUMN_ID,
    label: "Tags",
    isSortable: false,
    isFilterable: true,
    filterFacetId: BranchListFilterFacet.Tags,
    isGroupable: false,
    groupLabel: null,
  },
  // ISS-10332 / PLN-2086 Milestone 2: the branch artifact's priority. Sortable
  // (the producer's `priority` key, Milestone 1) and filterable (the server
  // facet, same milestone); NOT groupable — the grouping vocabulary is the
  // operator's three dimensions and this change adds none. The header is the
  // approved word the Documents grid renders, never re-spelled here.
  {
    id: BRANCH_PRIORITY_COLUMN_ID,
    label: PRIORITY_COLUMN_LABEL,
    isSortable: true,
    isFilterable: true,
    filterFacetId: BranchListFilterFacet.Priority,
    isGroupable: false,
    groupLabel: null,
  },
  // ISS-12453 (operator ruling): the branch artifact's project, editable via
  // the canonical `POST /artifact-links/batch-move` writer. No sort key or
  // filter facet exists for it yet, and it adds no grouping dimension.
  {
    id: BRANCH_PROJECT_COLUMN_ID,
    label: ARTIFACT_PROJECT_FIELD_LABEL,
    isSortable: false,
    isFilterable: false,
    filterFacetId: null,
    isGroupable: false,
    groupLabel: null,
  },
] as const satisfies readonly ColumnViewModel[];

type BranchColumnViewModelEntry = (typeof BRANCH_COLUMN_VIEW_MODEL)[number];

export type BranchColumnViewModelId = BranchColumnViewModelEntry["id"];

/** The subset the sort controls may offer, as a literal union. */
export type BranchSortableColumnId = Extract<
  BranchColumnViewModelEntry,
  { isSortable: true }
>["id"];

/** The subset the group controls may offer, as a literal union. */
export type BranchGroupableColumnId = Extract<
  BranchColumnViewModelEntry,
  { isGroupable: true }
>["id"];

/**
 * Which wire sort key each sortable column orders by.
 *
 * `satisfies Record<BranchSortableColumnId, …>` is the forcing function in one
 * direction: a column newly declared `isSortable: true` fails `tsc` here until
 * someone names the ordering it actually asks the producer for.
 */
export const BRANCH_COLUMN_SORT_KEYS = {
  [BRANCH_NAME_COLUMN_ID]: BranchListSortKey.Name,
  owner: BranchListSortKey.Owner,
  sessions: BranchListSortKey.Sessions,
  changes: BranchListSortKey.Changes,
  status: BranchListSortKey.Status,
  pr: BranchListSortKey.PullRequest,
  lastActivity: BranchListSortKey.LastActivity,
  repo: BranchListSortKey.Repo,
  priority: BranchListSortKey.Priority,
} as const satisfies Record<BranchSortableColumnId, BranchListSortKey>;

/**
 * And the reverse, which closes the other direction: a sort key the producer
 * gains with no column declaring it fails `tsc` here, so the vocabulary cannot
 * grow an ordering the toolbar silently never offers.
 */
export const BRANCH_SORT_KEY_COLUMN_IDS = {
  [BranchListSortKey.Name]: BRANCH_NAME_COLUMN_ID,
  [BranchListSortKey.Owner]: "owner",
  [BranchListSortKey.Sessions]: BRANCH_SESSIONS_COLUMN_ID,
  [BranchListSortKey.Changes]: "changes",
  [BranchListSortKey.Status]: "status",
  [BranchListSortKey.PullRequest]: "pr",
  [BranchListSortKey.LastActivity]: "lastActivity",
  [BranchListSortKey.Repo]: "repo",
  [BranchListSortKey.Priority]: "priority",
} as const satisfies Record<BranchListSortKey, BranchSortableColumnId>;

/**
 * A band's IDENTITY and the word it renders, which are deliberately two fields.
 *
 * Keying a band on its label merges rows the label happens to collapse: two
 * people who share a display name, and two repositories whose short names
 * collide (`acme/web` and `other/web` both read "web"). The grid's own
 * `GridTableV2Group` already separates `key` from `label` for exactly this
 * reason; this type is what carries both out of the resolver.
 */
export type BranchGroupBand = { key: string; label: string };

/**
 * One grouping dimension, resolved against the row set it is about to band.
 *
 * Curried over the rows rather than taking one row, because a band's LABEL can
 * be a property of the set: `Repository` disambiguates a colliding short name
 * to the full `owner/repo` only when another repository in view shares it,
 * which no per-row function can know.
 */
type BranchGroupDimension = (
  rows: readonly BranchRow[]
) => (row: BranchRow) => BranchGroupBand;

/**
 * The band a row falls in, for each grouping dimension.
 *
 * Exhaustive over {@link BranchGroupableColumnId}, so declaring a fourth
 * groupable column is a compile error here until someone decides how its bands
 * are cut — the same reason `SESSIONS_GROUP_FIELDS` and
 * `CUSTOM_FIELD_CAPABILITIES` are `Record`s rather than `switch`es.
 *
 * Every band renders the word the corresponding CELL renders — the repository's
 * disambiguated display label, the status label map, "Unattributed",
 * "Unavailable" — so a band and the rows under it never state the same fact two
 * ways. Reading the status label map also means an unrecognized status from a
 * version-skewed producer falls to a named band instead of throwing.
 */
export const BRANCH_GROUP_FIELDS = {
  owner: () => ownerBand,
  repo: (rows: readonly BranchRow[]) => {
    // The SAME map the repository cell renders from, so a band and its rows
    // cannot disagree about which "web" this is.
    const labels = repositoryDisplayLabels(rows);
    return (row: BranchRow) => repositoryBand(row, labels);
  },
  status: () => statusBand,
} as const satisfies Record<BranchGroupableColumnId, BranchGroupDimension>;

const UNIVERSAL_BRANCH_GROUP_FIELDS = {
  ...BRANCH_GROUP_FIELDS,
  status: () => universalStatusBand,
} as const satisfies Record<BranchGroupableColumnId, BranchGroupDimension>;

/**
 * Partition rows into the bands the grid renders.
 *
 * Returns `[]` when nothing is grouped, which is what `GridTableV2` reads as
 * "render a flat list" — so an ungrouped table is the same code path it has
 * always been rather than one band holding everything.
 *
 * A field the view model does not declare groupable yields no bands either. The
 * menu can only offer declared dimensions, but the grouping state is also
 * restored from a persisted view, and a stored field a later build stopped
 * grouping by must degrade to a flat list rather than to a crash.
 *
 * `labelRows` is the row context band LABELS are resolved against, and is
 * DELIBERATELY separate from the rows being partitioned (ISS-9676, whitlockk
 * review): the repository cell disambiguates its short name against the whole
 * filtered corpus, so a band that resolved its label against the current page
 * alone would render "web" over rows whose own cells read "acme/web" whenever
 * the colliding `other/web` sits on another page. Partition the page; name the
 * bands with the same context the cells use.
 */
export function groupBranchRows(
  rows: readonly BranchRow[],
  grouping: TableGroupingState,
  labelRows: readonly BranchRow[]
): GridTableV2Group<BranchRow>[] {
  return groupBranchRowsWithFields(
    rows,
    grouping,
    labelRows,
    BRANCH_GROUP_FIELDS
  );
}

/** Partition status bands from preserved producer evidence for the champion. */
export function groupUniversalBranchRows(
  rows: readonly BranchRow[],
  grouping: TableGroupingState,
  labelRows: readonly BranchRow[]
): GridTableV2Group<BranchRow>[] {
  return groupBranchRowsWithFields(
    rows,
    grouping,
    labelRows,
    UNIVERSAL_BRANCH_GROUP_FIELDS
  );
}

function groupBranchRowsWithFields(
  rows: readonly BranchRow[],
  grouping: TableGroupingState,
  labelRows: readonly BranchRow[],
  fields: Readonly<Record<BranchGroupableColumnId, BranchGroupDimension>>
): GridTableV2Group<BranchRow>[] {
  const primary = resolveBranchGroupDimension(
    grouping.primary.fieldId,
    labelRows,
    fields
  );
  if (!primary) {
    return [];
  }
  // Resolved against the same label context, not the band's subset: a
  // repository label that disambiguated at the top level must read the same
  // inside every band.
  const secondary = resolveBranchGroupDimension(
    grouping.secondary.fieldId,
    labelRows,
    fields
  );
  return partitionBranchRows(rows, primary, grouping.primary.order).map(
    (band) => ({
      ...band,
      subgroups: secondary
        ? partitionBranchRows(band.items, secondary, grouping.secondary.order)
        : undefined,
    })
  );
}

/**
 * The sort rules the shared menus render, from the single persisted ordering the
 * Branches view state holds.
 *
 * One rule, never zero: the list is always ordered by something, so an empty
 * array would report "unsorted" over rows the producer had already ordered. A
 * sort key with no declared column yields nothing, for the same version-skew
 * reason {@link groupBranchRows} tolerates an unknown grouping field.
 */
export function branchSortRules(
  sortKey: string,
  sortDir: "asc" | "desc"
): readonly TableSortRule[] {
  const fieldId = resolveBranchSortColumnId(sortKey);
  return fieldId ? [{ direction: sortDir, fieldId }] : [];
}

/**
 * The header a Branches column renders.
 *
 * The view model OWNS the wording, so the table's geometry declaration and the
 * sort menu cannot come to spell one column two ways — the shape review-soul
 * calls SSOT drift by copy, and the shape this whole module exists to remove
 * one level up for capabilities.
 */
export function branchColumnLabel(columnId: BranchColumnViewModelId): string {
  return COLUMN_LABELS_BY_ID[columnId];
}

/** The wire sort key a sort-menu selection asks for, or `null` for an unknown field. */
export function branchSortKeyForColumn(
  columnId: string
): BranchListSortKey | null {
  return SORT_KEYS_BY_COLUMN_ID[columnId as BranchSortableColumnId] ?? null;
}

/** The column a stored sort key belongs to, or `null` when this build has none. */
export function resolveBranchSortColumnId(
  sortKey: string
): BranchSortableColumnId | null {
  return COLUMN_IDS_BY_SORT_KEY[sortKey as BranchListSortKey] ?? null;
}

const UNATTRIBUTED_BAND_LABEL = "Unattributed";
/** The word the repository CELL renders for a row with no repository. */
const UNAVAILABLE_REPOSITORY_BAND_LABEL = "Unavailable";
const UNKNOWN_STATUS_BAND_LABEL = "Unknown";
/** The band every unattributed row shares — an identity, never a display name. */
const UNATTRIBUTED_BAND_KEY = RENDER_UNATTRIBUTED;
const UNAVAILABLE_REPOSITORY_BAND_KEY = "";

/**
 * The author band, keyed on the row's stable owner identity.
 *
 * `ownerKey` and not `owner`: the row documents `owner` as a display name, so
 * two different people sharing one would land in a single band, and the branch
 * FACET already narrows on the key for exactly that reason.
 */
function ownerBand(row: BranchRow): BranchGroupBand {
  if (row.owner === RENDER_UNATTRIBUTED || row.owner === "") {
    return { key: UNATTRIBUTED_BAND_KEY, label: UNATTRIBUTED_BAND_LABEL };
  }
  return { key: row.ownerKey ?? row.owner, label: row.owner };
}

/**
 * The repository band, keyed on the FULL `owner/repo` identity.
 *
 * Keying on the short name merged `acme/web` and `other/web` into one band — a
 * partition that silently reports two repositories as one.
 */
function repositoryBand(
  row: BranchRow,
  labels: ReadonlyMap<string, string>
): BranchGroupBand {
  if (!row.repo || row.repo === RENDER_MISSING) {
    return {
      key: UNAVAILABLE_REPOSITORY_BAND_KEY,
      label: UNAVAILABLE_REPOSITORY_BAND_LABEL,
    };
  }
  return { key: row.repo, label: labels.get(row.repo) ?? row.repo };
}

function statusBand(row: BranchRow): BranchGroupBand {
  const label = BRANCH_STATUS_CONFIG[row.status]?.label;
  return label
    ? { key: row.status, label }
    : { key: row.status, label: UNKNOWN_STATUS_BAND_LABEL };
}

function universalStatusBand(row: BranchRow): BranchGroupBand {
  const facet = artifactStatusFacet(
    ArtifactStatusVocabulary.Branch,
    branchStatusEvidence(row)
  );
  return {
    key: facet.normalized.detail ?? facet.normalized.root,
    label: artifactStatusLabel(facet),
  };
}

const COLUMN_LABELS_BY_ID: Record<BranchColumnViewModelId, string> =
  Object.fromEntries(
    BRANCH_COLUMN_VIEW_MODEL.map((column) => [column.id, column.label])
  ) as Record<BranchColumnViewModelId, string>;

// Null-prototype lookups: both keys arrive as bare `string` from a menu
// selection or a persisted view, so `"constructor"` off a plain object literal
// would be a truthy non-answer.
const SORT_KEYS_BY_COLUMN_ID: Record<string, BranchListSortKey | undefined> =
  Object.assign(Object.create(null), BRANCH_COLUMN_SORT_KEYS);
const COLUMN_IDS_BY_SORT_KEY: Record<
  string,
  BranchSortableColumnId | undefined
> = Object.assign(Object.create(null), BRANCH_SORT_KEY_COLUMN_IDS);
function resolveBranchGroupDimension(
  fieldId: string | null,
  rows: readonly BranchRow[],
  fields: Readonly<
    Record<BranchGroupableColumnId, BranchGroupDimension>
  > = BRANCH_GROUP_FIELDS
): ((row: BranchRow) => BranchGroupBand) | null {
  if (fieldId === null) {
    return null;
  }
  if (!Object.hasOwn(fields, fieldId)) {
    return null;
  }
  const dimension = fields[fieldId as BranchGroupableColumnId];
  return dimension(rows);
}

function partitionBranchRows(
  rows: readonly BranchRow[],
  bandOf: (row: BranchRow) => BranchGroupBand,
  order: TableGroupOrder
): GridTableV2Group<BranchRow>[] {
  return groupRowEntries(
    rows,
    bandOf,
    ({ key, label }, row): GridTableV2Group<BranchRow> => ({
      items: [row],
      key,
      label,
    }),
    {
      order,
      compare: ([, left], [, right]) => left.label.localeCompare(right.label),
      reverseDescending: true,
    }
  ).map(([, band]) => band);
}

/**
 * ISS-10332 (#7762 review): `columns` without the Priority entry, for a mount
 * whose source cannot write a `priority` (an older Desktop build's local
 * store). Filtered by id so the priority-less set is still the canonical
 * declaration rather than a second hand-listed one.
 */
export function withoutBranchPriorityColumn<T extends { id: string }>(
  columns: readonly T[]
): readonly T[] {
  return columns.filter((column) => column.id !== BRANCH_PRIORITY_COLUMN_ID);
}

/**
 * ISS-12456: `columns` without the Tags entry, for a mount whose source
 * cannot serve `tags` (the desktop local store — tags are a cloud Artifact
 * concept and local rows carry no Artifact identity to look one up by).
 */
export function withoutBranchTagsColumn<T extends { id: string }>(
  columns: readonly T[]
): readonly T[] {
  return columns.filter((column) => column.id !== BRANCH_TAGS_COLUMN_ID);
}

/**
 * ISS-12456: `columns` without the Project entry, for a mount whose source
 * cannot serve `project` (the desktop local store — like Tags, a cloud
 * Artifact concept local rows carry no identity to look one up by).
 */
export function withoutBranchProjectColumn<T extends { id: string }>(
  columns: readonly T[]
): readonly T[] {
  return columns.filter((column) => column.id !== BRANCH_PROJECT_COLUMN_ID);
}
