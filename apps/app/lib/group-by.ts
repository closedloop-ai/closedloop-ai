import type { Priority } from "@repo/api/src/types/common";
import type { DocumentStatus } from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import type { DocumentRowItem } from "@/components/document-table/document-row";
import { comparePriorityValues } from "@/lib/priority-sort";
import {
  DOCUMENT_STATUS_LABELS,
  PRIORITY_LABELS,
} from "@/lib/project-constants";
import { STATUS_DISPLAY_ORDER } from "@/lib/status-grouping";
import { compareAssigneeNames, getUserDisplayName } from "@/lib/user-utils";

export const GroupByMode = {
  None: "none",
  Status: "status",
  Assignee: "assignee",
  Priority: "priority",
} as const;
export type GroupByMode = (typeof GroupByMode)[keyof typeof GroupByMode];

export type GroupByNonNone = Exclude<GroupByMode, typeof GroupByMode.None>;

export type GroupSectionDescriptor = {
  key: string;
  label: string;
  mode: GroupByNonNone;
  status?: DocumentStatus;
  priority?: Priority | null;
  assignee?: BasicUser | null;
};

const NO_PRIORITY_KEY = "no-priority";
const UNASSIGNED_KEY = "unassigned";

function statusDescriptor(status: DocumentStatus): GroupSectionDescriptor {
  return {
    key: status,
    label: DOCUMENT_STATUS_LABELS[status],
    mode: GroupByMode.Status,
    status,
  };
}

function priorityDescriptor(priority: Priority | null): GroupSectionDescriptor {
  return {
    key: priority ?? NO_PRIORITY_KEY,
    label: priority ? PRIORITY_LABELS[priority] : "No priority",
    mode: GroupByMode.Priority,
    priority,
  };
}

function assigneeDescriptor(
  assignee: BasicUser | null
): GroupSectionDescriptor {
  return {
    key: assignee?.id ?? UNASSIGNED_KEY,
    label: assignee ? getUserDisplayName(assignee) : "Unassigned",
    mode: GroupByMode.Assignee,
    assignee,
  };
}

function descriptorForItem(
  item: DocumentRowItem,
  mode: GroupByNonNone
): GroupSectionDescriptor {
  if (mode === GroupByMode.Status) {
    return statusDescriptor(item.data.status as DocumentStatus);
  }
  if (mode === GroupByMode.Priority) {
    return priorityDescriptor(item.data.priority ?? null);
  }
  return assigneeDescriptor(item.data.assignee ?? null);
}

function compareStatusSections(
  a: GroupSectionDescriptor,
  b: GroupSectionDescriptor
): number {
  const aIdx = a.status ? STATUS_DISPLAY_ORDER.indexOf(a.status) : -1;
  const bIdx = b.status ? STATUS_DISPLAY_ORDER.indexOf(b.status) : -1;
  return aIdx - bIdx;
}

function comparePrioritySections(
  a: GroupSectionDescriptor,
  b: GroupSectionDescriptor
): number {
  return comparePriorityValues(a.priority ?? null, b.priority ?? null);
}

function compareAssigneeSections(
  a: GroupSectionDescriptor,
  b: GroupSectionDescriptor
): number {
  return compareAssigneeNames(a.assignee, b.assignee);
}

function compareSections(
  a: GroupSectionDescriptor,
  b: GroupSectionDescriptor
): number {
  if (a.mode !== b.mode) {
    return 0;
  }
  if (a.mode === GroupByMode.Status) {
    return compareStatusSections(a, b);
  }
  if (a.mode === GroupByMode.Priority) {
    return comparePrioritySections(a, b);
  }
  return compareAssigneeSections(a, b);
}

/**
 * Bucket arbitrary values keyed by the section descriptor for a representative
 * row item, then return sections ordered for display. Used for both flat-item
 * and display-group grouping paths.
 */
export function groupByMode<T>(
  values: T[],
  getRow: (value: T) => DocumentRowItem,
  mode: GroupByNonNone
): Array<{ descriptor: GroupSectionDescriptor; values: T[] }> {
  const buckets = new Map<
    string,
    { descriptor: GroupSectionDescriptor; values: T[] }
  >();

  for (const value of values) {
    const descriptor = descriptorForItem(getRow(value), mode);
    const bucket = buckets.get(descriptor.key);
    if (bucket) {
      bucket.values.push(value);
    } else {
      buckets.set(descriptor.key, { descriptor, values: [value] });
    }
  }

  return [...buckets.values()].sort((a, b) =>
    compareSections(a.descriptor, b.descriptor)
  );
}

export const GROUP_BY_LABELS: Record<GroupByMode, string> = {
  [GroupByMode.None]: "None",
  [GroupByMode.Status]: "Status",
  [GroupByMode.Assignee]: "Assignee",
  [GroupByMode.Priority]: "Priority",
};
