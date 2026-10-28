import { artifactStatusRootRankOrNull } from "@repo/api/src/types/artifact-status-rank";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import type {
  GridTableV2Column,
  GridTableV2Group,
} from "@repo/design-system/components/ui/grid-table-v2";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  comparePriorityByRank,
  PRIORITY_VALUES_HIGHEST_FIRST,
  priorityRank,
} from "@repo/design-system/lib/priority-order";
import { compareNullableNumber } from "@repo/lib/sort-comparators";
import type { ArtifactRow } from "./fixtures";
import {
  genericArtifactFilterKeys,
  genericArtifactStatusFacet,
  genericArtifactStatusKey,
  genericArtifactStatusMatchesAny,
  genericArtifactStatusRank,
  genericArtifactStatusRawRank,
  genericArtifactStatusRoot,
} from "./generic-artifact-status";

const FIELD_ID_PATTERN = /[^a-z0-9]+/g;
const FIELD_EDGE_DASH_PATTERN = /^-|-$/g;

export function filterArtifacts(
  artifacts: readonly ArtifactRow[],
  filters: Readonly<Record<string, readonly string[]>>
): ArtifactRow[] {
  return artifacts.filter((artifact) =>
    Object.entries(filters).every(([columnId, selectedValues]) => {
      if (selectedValues.length === 0) {
        return true;
      }
      if (columnId === "status") {
        return genericArtifactStatusMatchesAny(artifact, selectedValues);
      }
      return cellValues(artifact, columnId).some((value) =>
        selectedValues.includes(value)
      );
    })
  );
}

export function sortArtifacts(
  artifacts: readonly ArtifactRow[],
  sortBy: string | null,
  sortDir: SortDirection
): ArtifactRow[] {
  if (!sortBy) {
    return [...artifacts];
  }
  return [...artifacts].sort((left, right) => {
    if (sortBy === "status") {
      const rootComparison = compareNullableNumber(
        genericArtifactStatusRank(left),
        genericArtifactStatusRank(right),
        sortDir
      );
      if (rootComparison !== 0) {
        return rootComparison;
      }
      return compareNullableNumber(
        genericArtifactStatusRawRank(left),
        genericArtifactStatusRawRank(right),
        sortDir
      );
    }
    const leftValue = sortValue(left, sortBy);
    const rightValue = sortValue(right, sortBy);
    const comparison =
      typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue));
    return comparison * (sortDir === "asc" ? 1 : -1);
  });
}

export function buildGroups(
  artifacts: readonly ArtifactRow[],
  groupBy: string | null
): GridTableV2Group<ArtifactRow>[] | undefined {
  if (
    !(groupBy === "owner" || groupBy === "priority" || groupBy === "status")
  ) {
    return undefined;
  }
  const values = [
    ...new Set(
      artifacts.flatMap((artifact) =>
        groupBy === "status"
          ? [genericArtifactStatusRoot(artifact)]
          : cellValues(artifact, groupBy)
      )
    ),
  ];
  if (groupBy === "priority") {
    values.sort(comparePriorityByRank);
  } else if (groupBy === "status") {
    values.sort((left, right) =>
      compareNullableNumber(
        artifactStatusRootRankOrNull(left),
        artifactStatusRootRankOrNull(right),
        "asc"
      )
    );
  }
  return values.map((value) => ({
    key: value,
    label: groupBy === "status" ? statusGroupLabel(artifacts, value) : value,
    items: artifacts.filter((artifact) =>
      groupBy === "status"
        ? genericArtifactStatusRoot(artifact) === value
        : cellValues(artifact, groupBy).includes(value)
    ),
  }));
}

export function filterOptions(
  columnId: string,
  artifacts: readonly ArtifactRow[]
): string[] {
  if (columnId === "status") {
    return genericArtifactFilterKeys(
      [...new Set(artifacts.map((artifact) => artifact.kind))],
      artifacts.some((artifact) => genericArtifactStatusRank(artifact) === null)
    );
  }
  // The full ranked vocabulary, not just the values these rows happen to
  // carry, so the option list neither reorders nor loses a value as rows load.
  if (columnId === "priority") {
    return [...PRIORITY_VALUES_HIGHEST_FIRST];
  }
  return [
    ...new Set(artifacts.flatMap((artifact) => cellValues(artifact, columnId))),
  ];
}

export function uniqueFieldId(
  label: string,
  columns: readonly GridTableV2Column[]
): string {
  const baseId =
    label
      .toLowerCase()
      .replace(FIELD_ID_PATTERN, "-")
      .replace(FIELD_EDGE_DASH_PATTERN, "") || "field";
  const ids = new Set(columns.map((column) => column.id));
  let id = baseId;
  let suffix = 2;
  while (ids.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return id;
}

export function setMembership(
  current: ReadonlySet<string>,
  value: string,
  included: boolean
): Set<string> {
  const next = new Set(current);
  if (included) {
    next.add(value);
  } else {
    next.delete(value);
  }
  return next;
}

export function toggleSetValue(
  current: ReadonlySet<string>,
  value: string
): Set<string> {
  return setMembership(current, value, !current.has(value));
}

export function toggleArrayValue(
  values: readonly string[],
  value: string
): string[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

export function columnLabel(
  columnId: string,
  columns: readonly GridTableV2Column[]
): string {
  return columns.find((column) => column.id === columnId)?.label ?? columnId;
}

export function cloneArtifact(artifact: ArtifactRow): ArtifactRow {
  return {
    ...artifact,
    collaborators: artifact.collaborators.map((person) => ({ ...person })),
    customValues: { ...artifact.customValues },
    owner: { ...artifact.owner },
    relatedSessions: artifact.relatedSessions.map((reference) => ({
      ...reference,
    })),
    tags: artifact.tags.map((tag) => ({ ...tag })),
  };
}

function sortValue(artifact: ArtifactRow, columnId: string): string | number {
  switch (columnId) {
    case "owner":
      return artifact.owner.name;
    case "collaborators":
      return artifact.collaborators.map((person) => person.name).join(" ");
    // Rank, not the value spelling: `localeCompare` on the raw enum orders
    // HIGH < LOW < MEDIUM < URGENT and files the most urgent rows last.
    case "priority":
      return priorityRank(artifact.priority);
    case "model":
      return artifact.model;
    case "comments":
      return artifact.comments;
    case "updated":
      return -artifact.updatedAgoMinutes;
    case "currentVersion":
      return Number(artifact.currentVersion.replace(/\D/g, ""));
    case "tags":
      return artifact.tags.map((tag) => tag.label).join(" ");
    case "repository":
      return artifact.repository ?? "";
    case "creationCost":
      return artifact.creationCost ?? "";
    case "lineChanges":
      return (artifact.additions ?? 0) + (artifact.deletions ?? 0);
    case "name":
      return artifact.title;
    default: {
      const customValue = artifact.customValues[columnId];
      return isReadonlyStringArray(customValue)
        ? customValue.join(" ")
        : (customValue ?? artifact.title);
    }
  }
}

function isReadonlyStringArray(
  value: string | number | readonly string[] | null | undefined
): value is readonly string[] {
  return Array.isArray(value);
}

function statusGroupLabel(
  artifacts: readonly ArtifactRow[],
  root: string
): string {
  const source = artifacts.find(
    (artifact) => genericArtifactStatusRoot(artifact) === root
  );
  if (!source) {
    return root;
  }
  const facet = genericArtifactStatusFacet(source);
  return artifactStatusLabel({
    normalized: { root: facet.normalized.root },
    raw: null,
    vocabulary: facet.vocabulary,
  });
}

function cellValues(artifact: ArtifactRow, columnId: string): string[] {
  switch (columnId) {
    case "owner":
      return [artifact.owner.name];
    case "collaborators":
      return artifact.collaborators.map((person) => person.name);
    case "status":
      return [genericArtifactStatusKey(artifact)];
    case "priority":
      return [artifact.priority];
    case "model":
      return [artifact.model];
    case "relatedSessions":
      return artifact.relatedSessions.map((session) => session.sessionSlug);
    case "updated":
      return [artifact.updated];
    case "tags":
      return artifact.tags.map((tag) => tag.label);
    case "repository":
      return artifact.repository ? [artifact.repository] : [];
    case "creationCost":
      return artifact.creationCost == null
        ? []
        : [String(artifact.creationCost)];
    case "lineChanges":
      return artifact.additions == null && artifact.deletions == null
        ? []
        : [String((artifact.additions ?? 0) + (artifact.deletions ?? 0))];
    default: {
      const customValue = artifact.customValues[columnId];
      if (Array.isArray(customValue)) {
        return [...customValue];
      }
      return customValue == null ? [] : [String(customValue)];
    }
  }
}
