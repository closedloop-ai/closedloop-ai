import { ArtifactGroupByMode } from "@repo/api/src/types/artifact-group-by-mode";
import type { DisplayedArtifactStatus } from "@repo/api/src/types/artifact-status";
import { ARTIFACT_STATUS_UNKNOWN_LABEL } from "@repo/api/src/types/artifact-status-display";
import { statusDisplayRank } from "@repo/api/src/types/artifact-status-display-order";
import { artifactStatusRootRank } from "@repo/api/src/types/artifact-status-rank";
import type { Priority } from "@repo/api/src/types/common";
import type { ArtifactStatus } from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { ARTIFACT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import { groupRowEntries } from "@repo/app/shared/lib/table-grouping";
import {
  compareAssigneeNames,
  getUserDisplayName,
  UNASSIGNED_ASSIGNEE_LABEL,
} from "@repo/app/shared/lib/user-utils";
import { TableGroupOrder } from "@repo/design-system/components/ui/table-toolbar-model";
import {
  comparePriorityByRank,
  isPriorityValue,
  PRIORITY_LABEL_NONE,
  priorityLabel,
} from "@repo/design-system/lib/priority-order";

// Aliased, not re-declared: `apps/api` packs grouped pages against the same
// vocabulary, and a mode the browser could select but the query could not honor
// would page one grouping and render another (ISS-10472).
export const GroupByMode = ArtifactGroupByMode;
export type GroupByMode = ArtifactGroupByMode;

export type GroupByNonNone = Exclude<GroupByMode, typeof GroupByMode.None>;

export type GroupSectionDescriptor = {
  key: string;
  label: string;
  mode: GroupByNonNone;
  status?: string | null;
  /**
   * Artifact type of the section's representative row (DocumentType or, for
   * branch/session rows, ArtifactType). Lets a status-group header render the
   * type-correct icon — Documents and Features diverge on IN_REVIEW (PRD-495).
   */
  artifactType?: string;
  priority?: Priority | null;
  isUnknownPriority?: boolean;
  assignee?: BasicUser | null;
  /**
   * ISS-9437: the normalized artifact-status ROOT this section belongs to, over
   * the whole bucket — the lowest-ranked root any of its rows folds to, not the
   * first row's. Present only when the caller supplied
   * {@link GroupByModeOptions.sectionRoot}; absent means today's raw-rank-only
   * section order, unchanged.
   */
  root?: DisplayedArtifactStatus;
};

const NO_PRIORITY_KEY = "priority:none";
const PRIORITY_VALUE_KEY_PREFIX = "priority:value:";
const NULL_STATUS_KEY = "status:null";

/**
 * The one word the product uses for an artifact with no priority (ISS-9665),
 * imported by the group header, the priority menu and the documents filter
 * facet. Bound to the vocabulary's own spelling rather than repeating it: a
 * header rendered by `priorityLabel(null)` and a menu item rendered from this
 * name must not be able to describe one state with two words. Deliberately
 * outside `PRIORITY_LABELS` — that map is `Record<Priority, string>` and
 * "unset" is not a Priority member, so widening it would make every exhaustive
 * read of it accept a non-value.
 */
export const NO_PRIORITY_LABEL = PRIORITY_LABEL_NONE;
const UNASSIGNED_KEY = "unassigned";

function statusDescriptor(
  status: string | null,
  artifactType?: string
): GroupSectionDescriptor {
  if (status === null) {
    return {
      artifactType,
      key: NULL_STATUS_KEY,
      label: ARTIFACT_STATUS_UNKNOWN_LABEL,
      mode: GroupByMode.Status,
      status,
    };
  }
  return {
    key: status,
    // Combined Document + Feature labels (PRD-495) so headers read as title
    // case ("In Progress", not "IN_PROGRESS"). Branch/session rows carry
    // non-artifact status values (GitHubPRState, harness strings) not in the
    // map; fall back to the raw value so their headers are never blank.
    label:
      status in ARTIFACT_STATUS_LABELS
        ? ARTIFACT_STATUS_LABELS[status as ArtifactStatus]
        : status,
    mode: GroupByMode.Status,
    status,
    artifactType,
  };
}

function priorityDescriptor(priority: string | null): GroupSectionDescriptor {
  const knownPriority: Priority | null =
    priority && isPriorityValue(priority) ? priority : null;
  return {
    key: prioritySectionKey(priority),
    label: priorityLabel(priority),
    mode: GroupByMode.Priority,
    priority: knownPriority,
    isUnknownPriority: priority !== null && knownPriority === null,
  };
}

function assigneeDescriptor(
  assignee: BasicUser | null
): GroupSectionDescriptor {
  return {
    key: assignee?.id ?? UNASSIGNED_KEY,
    label: assignee ? getUserDisplayName(assignee) : UNASSIGNED_ASSIGNEE_LABEL,
    mode: GroupByMode.Assignee,
    assignee,
  };
}

function descriptorForItem(
  item: DocumentRowItem,
  mode: GroupByNonNone,
  options: GroupByModeOptions
): GroupSectionDescriptor {
  if (mode === GroupByMode.Status) {
    const artifactType = item.kind === "project" ? undefined : item.data.type;
    const retainedStatus = options.statusEvidence?.(item);
    return statusDescriptor(
      retainedStatus === undefined ? item.data.status : retainedStatus,
      artifactType
    );
  }
  if (mode === GroupByMode.Priority) {
    return priorityDescriptor(item.data.priority ?? null);
  }
  return assigneeDescriptor(item.data.assignee ?? null);
}

/**
 * ISS-9669: section order comes from {@link statusDisplayRank}, the same
 * derivation `compareStatusValues` uses to sort the Status column, so this table
 * cannot place one row two different ways. It used to call
 * `STATUS_DISPLAY_ORDER.indexOf` directly, and that `-1` on a miss hoisted every
 * unknown-status row into a header above `DRAFT` while the sort was pushing the
 * identical rows to the bottom. Branch and session rows reach this table with
 * statuses in neither artifact vocabulary (a `GitHubPRState`, a harness string),
 * so that miss is a routine input, not an edge case — and `-1` also collided
 * with the no-status sentinel, making an unknown status and a missing one
 * compare equal.
 */
function compareStatusSections(
  a: GroupSectionDescriptor,
  b: GroupSectionDescriptor
): number {
  return statusDisplayRank(a.status) - statusDisplayRank(b.status);
}

function comparePrioritySections(
  a: GroupSectionDescriptor,
  b: GroupSectionDescriptor
): number {
  const aPriority = priorityKeyValue(a.key);
  const bPriority = priorityKeyValue(b.key);
  const priorityDelta = comparePriorityByRank(aPriority, bPriority);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  if (aPriority === null || bPriority === null) {
    if (aPriority === bPriority) {
      return 0;
    }
    return aPriority === null ? 1 : -1;
  }
  return compareSectionKeys(a.key, b.key);
}

function compareAssigneeSections(
  a: GroupSectionDescriptor,
  b: GroupSectionDescriptor
): number {
  return compareAssigneeNames(a.assignee, b.assignee);
}

function compareSections(
  a: GroupSectionDescriptor,
  b: GroupSectionDescriptor,
  rootFirst: boolean
): number {
  if (a.mode !== b.mode) {
    return 0;
  }
  if (a.mode === GroupByMode.Status) {
    return rootFirst
      ? compareRootFirstStatusSections(a, b)
      : compareStatusSections(a, b);
  }
  if (a.mode === GroupByMode.Priority) {
    return comparePrioritySections(a, b);
  }
  return compareAssigneeSections(a, b);
}

/**
 * Bucket arbitrary values keyed by the section descriptor for a representative
 * row item, then return sections ordered for display. Used for both flat-item
 * and display-group grouping paths. Partition and order come from the shared
 * band builder; this table supplies only its descriptors, root merge and
 * section comparator.
 */
export function groupByMode<T>(
  values: T[],
  getRow: (value: T) => DocumentRowItem,
  mode: GroupByNonNone,
  options: GroupByModeOptions = {}
): Array<{ descriptor: GroupSectionDescriptor; values: T[] }> {
  // Root ordering is a STATUS-section concept; priority and assignee sections
  // keep their own comparators untouched.
  const sectionRoot =
    mode === GroupByMode.Status ? options.sectionRoot : undefined;
  const rootFirst = sectionRoot !== undefined;
  return groupRowEntries(
    values,
    (value): SectionContribution => {
      const row = getRow(value);
      const descriptor = descriptorForItem(row, mode, options);
      return { descriptor, key: descriptor.key, root: sectionRoot?.(row) };
    },
    ({ descriptor, root }, value): SectionBucket<T> => ({
      descriptor: root === undefined ? descriptor : { ...descriptor, root },
      items: [value],
      label: descriptor.label,
      rootRank: artifactStatusRootRank(root),
    }),
    {
      appendContribution: mergeSectionRoot,
      compare: ([, a], [, b]) =>
        compareSections(a.descriptor, b.descriptor, rootFirst),
      order: TableGroupOrder.Ascending,
    }
  ).map(([, bucket]) => ({
    descriptor: bucket.descriptor,
    values: bucket.items,
  }));
}

export const GROUP_BY_LABELS: Record<GroupByMode, string> = {
  [GroupByMode.None]: "None",
  [GroupByMode.Status]: "Status",
  [GroupByMode.Assignee]: "Assignee",
  [GroupByMode.Priority]: "Priority",
};

/**
 * ISS-9437 inputs for {@link groupByMode}. Omitted — the default — is today's
 * section order, byte for byte.
 */
export type GroupByModeOptions = {
  /**
   * The normalized artifact-status root for one row. Supplying it switches
   * STATUS sections onto the root-first order; a surface reads its flag at its
   * own site and passes this resolver or nothing, so no boolean arrives here.
   */
  sectionRoot?: (item: DocumentRowItem) => DisplayedArtifactStatus;
  /** Exact enabled-path evidence used to key and label status sections. */
  statusEvidence?: (item: DocumentRowItem) => string | null | undefined;
};

type SectionContribution = {
  descriptor: GroupSectionDescriptor;
  key: string;
  root: DisplayedArtifactStatus | undefined;
};

/** A section's descriptor carries the widened root once any row supplied one. */
type SectionBucket<T> = {
  descriptor: GroupSectionDescriptor;
  items: T[];
  label: string;
  rootRank: number;
};

/**
 * ISS-9437 section order: root band, then the raw display rank inside it, then
 * the descriptor key.
 *
 * That third level is not defensive padding, it is REQUIRED. `statusDisplayRank`
 * is defined only over Document/Issue statuses, so every branch, session and
 * project status is a miss returning the identical rank — and two such statuses
 * that also share a root tie on BOTH earlier levels. `Array#sort` is stable, so
 * the tie would fall through to Map insertion order and make the header order
 * depend on which row happened to arrive first. Real tying pairs in this table:
 * branch `MERGED` vs session `inactive` (both `done`), `COMPLETED` vs `ARCHIVED`
 * (both `done`), session `ACTIVE` vs `WAITING` (both `in_progress`).
 *
 * The key comparison is by code unit rather than `localeCompare`: it only has to
 * be TOTAL and identical on every machine, and a locale-sensitive collation is
 * neither guaranteed to be the second nor meaningful over raw enum spellings.
 */
function compareRootFirstStatusSections(
  a: GroupSectionDescriptor,
  b: GroupSectionDescriptor
): number {
  const rootDelta =
    artifactStatusRootRank(a.root) - artifactStatusRootRank(b.root);
  if (rootDelta !== 0) {
    return rootDelta;
  }
  const rawDelta = statusDisplayRank(a.status) - statusDisplayRank(b.status);
  if (rawDelta !== 0) {
    return rawDelta;
  }
  if (a.key === b.key) {
    return 0;
  }
  return compareSectionKeys(a.key, b.key);
}

function priorityKeyValue(key: string): string | null {
  if (key === NO_PRIORITY_KEY) {
    return null;
  }
  return key.startsWith(PRIORITY_VALUE_KEY_PREFIX)
    ? key.slice(PRIORITY_VALUE_KEY_PREFIX.length)
    : key;
}

function compareSectionKeys(aKey: string, bKey: string): number {
  if (aKey === bKey) {
    return 0;
  }
  return aKey < bKey ? -1 : 1;
}

function prioritySectionKey(priority: string | null): string {
  return priority === null
    ? NO_PRIORITY_KEY
    : `${PRIORITY_VALUE_KEY_PREFIX}${priority}`;
}

/**
 * Widen a section's root to the LOWEST-ranked root any of its rows folds to.
 *
 * The bucket keeps the descriptor of the first row it sees, and a bucket is
 * keyed on the RAW status, but rows sharing a raw status can fold to different
 * roots (two session rows with the same stored `status`, one of which the server
 * reports as `stale`). Taking the minimum keeps the header from sorting after a
 * row it contains.
 */
function mergeSectionRoot<T>(
  bucket: SectionBucket<T>,
  { root }: SectionContribution
): void {
  const rank = artifactStatusRootRank(root);
  if (root !== undefined && rank < bucket.rootRank) {
    bucket.descriptor = { ...bucket.descriptor, root };
    bucket.rootRank = rank;
  }
}
