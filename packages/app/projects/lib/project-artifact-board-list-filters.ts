"use client";

import { ArtifactDateField } from "@repo/api/src/types/artifact-date-filter";
import { BranchStatus } from "@repo/api/src/types/branch";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import {
  PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER,
  type ProjectArtifactBoardCustomFieldRange,
  type ProjectArtifactBoardCustomFieldValues,
  type ProjectArtifactBoardFilters,
  ProjectArtifactBoardKind,
  type ProjectArtifactBoardKindStatus,
  ProjectArtifactBoardStatusMatch,
} from "@repo/api/src/types/project-artifact-board-page";
import {
  LEGACY_WAITING_WIRE_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { documentCustomFieldIdFromColumnId } from "@repo/app/documents/components/documents-prototype-custom-fields";
import {
  GenericArtifactKind,
  GenericArtifactStatus,
  genericArtifactStatusFromRaw,
  genericArtifactStatusMatchesAny,
} from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import {
  type ArtifactDateDimension,
  withinArtifactDateDimension,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-date-dimension";
import {
  type ArtifactFilters,
  type CustomFieldFilter,
  RELATED_SESSIONS_COLUMN_ID,
  updatedPresetMinutes,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import { UNASSIGNED_ASSIGNEE_LABEL } from "@repo/app/shared/lib/user-utils";
import { useRef } from "react";

/** The portable project list's toolbar state the board reads. */
export type ProjectBoardListToolbar = {
  /** Custom-field columns the list filters by range rather than by label. */
  customFieldRangeColumnIds: ReadonlySet<string>;
  dateDimension: ArtifactDateDimension;
  extensionFilters: Readonly<Record<string, CustomFieldFilter>>;
  filters: ArtifactFilters;
  search: string;
};

/** The list's priority column id, whose filter the board applies. */
export const PROJECT_LIST_PRIORITY_COLUMN_ID = "priority";

/** The list's Parent column id. */
export const PROJECT_LIST_PARENT_COLUMN_ID = "parent";

/**
 * ISS-12929: the portable project list's toolbar filters and search as the
 * board route's filters, so its board shows what its list shows. Each facet
 * keeps the list predicate's meaning (`useArtifactListShellDerived`).
 * Undefined when nothing narrows.
 */
export function projectBoardListFilters(
  toolbar: ProjectBoardListToolbar,
  now: Date
): ProjectArtifactBoardFilters | undefined {
  const { filters } = toolbar;
  const dateWindow = updatedWindow(toolbar, now);
  const priorities = selectedPriorities(toolbar.extensionFilters);
  const kinds = filters.kinds.flatMap((kind) => {
    const boardKind = BOARD_KIND_BY_GENERIC_KIND[kind];
    return boardKind ? [boardKind] : [];
  });
  const search = toolbar.search.trim();
  // A kind selection the board cannot express keeps nothing, as it does in
  // the list, rather than narrowing nothing.
  let kindStatuses: ProjectArtifactBoardKindStatus[] | undefined;
  if (filters.kinds.length > 0 && kinds.length === 0) {
    kindStatuses = [];
  } else if (filters.statuses.length > 0) {
    kindStatuses = boardKindStatuses(filters.statuses);
  }
  const board: ProjectArtifactBoardFilters = {
    ...(filters.owners.length > 0
      ? {
          assigneeIds: filters.owners.map((owner) =>
            owner === UNASSIGNED_ASSIGNEE_LABEL
              ? PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER
              : owner
          ),
        }
      : {}),
    ...(dateWindow ? { dateWindow } : {}),
    ...(filters.favoritesOnly ? { favoritesOnly: true } : {}),
    ...(priorities.length > 0 ? { anyKindPriorities: priorities } : {}),
    ...(filters.tags.length > 0 ? { anyKindTagIds: filters.tags } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(kindStatuses ? { kindStatuses } : {}),
    ...(filters.mineOnly ? { mineOnly: true } : {}),
    ...(search ? { slugOrTitle: search } : {}),
    ...columnFilters(toolbar),
  };
  return Object.keys(board).length > 0 ? board : undefined;
}

/** {@link projectBoardListFilters} resolved once per toolbar selection. */
export function useProjectBoardListFilters(
  toolbar: ProjectBoardListToolbar | undefined
): ProjectArtifactBoardFilters | undefined {
  const key = toolbar
    ? JSON.stringify([
        [...toolbar.customFieldRangeColumnIds].sort(),
        toolbar.filters,
        toolbar.extensionFilters,
        toolbar.dateDimension.present ? toolbar.dateDimension.range : null,
        toolbar.search.trim(),
      ])
    : "";
  const resolved = useRef<{
    key: string;
    value: ProjectArtifactBoardFilters | undefined;
  } | null>(null);
  if (resolved.current?.key !== key) {
    resolved.current = {
      key,
      value: toolbar ? projectBoardListFilters(toolbar, new Date()) : undefined,
    };
  }
  return resolved.current.value;
}

/**
 * The selected status keys as stored statuses per kind, decided by the list's
 * own matcher over each kind's vocabulary. An off-vocabulary status is tested
 * through a sentinel no row stores: when it matches, the kind keeps every
 * status except the known ones that do not.
 */
export function boardKindStatuses(
  keys: readonly string[]
): ProjectArtifactBoardKindStatus[] {
  return BOARD_STATUS_VOCABULARIES.flatMap(
    ({
      boardKind,
      genericKind,
      statuses,
    }): ProjectArtifactBoardKindStatus[] => {
      const matches = (raw: string) =>
        genericArtifactStatusMatchesAny(
          {
            kind: genericKind,
            status:
              genericArtifactStatusFromRaw(genericKind, raw) ??
              GenericArtifactStatus.Todo,
            statusRaw: raw,
          },
          keys
        );
      if (matches(OFF_VOCABULARY_STATUS)) {
        return [
          {
            kind: boardKind,
            match: ProjectArtifactBoardStatusMatch.Except,
            statuses: statuses.filter((status) => !matches(status)),
          },
        ];
      }
      const kept = statuses.filter(matches);
      return kept.length > 0
        ? [
            {
              kind: boardKind,
              match: ProjectArtifactBoardStatusMatch.Only,
              statuses: kept,
            },
          ]
        : [];
    }
  );
}

/**
 * The Parent, Related Sessions and custom-field column filters, each as
 * `matchesExtensionFilters` reads it: a range column by its bounds only, any
 * other column by its selected values.
 */
function columnFilters(
  toolbar: ProjectBoardListToolbar
): Pick<
  ProjectArtifactBoardFilters,
  "customFieldRanges" | "customFieldValues" | "parentIds" | "relatedSessionIds"
> {
  const { extensionFilters } = toolbar;
  const parentIds =
    extensionFilters[PROJECT_LIST_PARENT_COLUMN_ID]?.selectedValues ?? [];
  const relatedSessionIds =
    extensionFilters[RELATED_SESSIONS_COLUMN_ID]?.selectedValues ?? [];
  const ranges: ProjectArtifactBoardCustomFieldRange[] = [];
  const values: ProjectArtifactBoardCustomFieldValues[] = [];
  for (const [columnId, filter] of Object.entries(extensionFilters)) {
    const fieldId = documentCustomFieldIdFromColumnId(columnId);
    if (!fieldId) {
      continue;
    }
    if (toolbar.customFieldRangeColumnIds.has(columnId)) {
      const range = customFieldRange(fieldId, filter);
      if (range) {
        ranges.push(range);
      }
    } else if (filter.selectedValues?.length) {
      values.push({ fieldId, labels: filter.selectedValues });
    }
  }
  return {
    ...(ranges.length > 0 ? { customFieldRanges: ranges } : {}),
    ...(values.length > 0 ? { customFieldValues: values } : {}),
    ...(parentIds.length > 0 ? { parentIds } : {}),
    ...(relatedSessionIds.length > 0 ? { relatedSessionIds } : {}),
  };
}

/** A range column's bounds, or null when neither is set. */
function customFieldRange(
  fieldId: string,
  filter: CustomFieldFilter
): ProjectArtifactBoardCustomFieldRange | null {
  if (filter.min === undefined && filter.max === undefined) {
    return null;
  }
  return {
    fieldId,
    ...(filter.min === undefined ? {} : { min: filter.min }),
    ...(filter.max === undefined ? {} : { max: filter.max }),
  };
}

/** The stricter of the Updated filter and the date range control. */
function updatedWindow(toolbar: ProjectBoardListToolbar, now: Date) {
  const windows = [
    updatedPresetMinutes(toolbar.filters.updatedPreset),
    dateDimensionMinutes(toolbar.dateDimension),
  ].filter((minutes): minutes is number => minutes !== null);
  if (windows.length === 0) {
    return null;
  }
  return {
    field: ArtifactDateField.UpdatedAt,
    from: new Date(now.getTime() - Math.min(...windows) * 60_000),
    to: now,
  };
}

/** The range control's window in minutes, or null when it narrows nothing. */
function dateDimensionMinutes(dimension: ArtifactDateDimension): number | null {
  if (
    !dimension.present ||
    withinArtifactDateDimension(dimension, Number.POSITIVE_INFINITY)
  ) {
    return null;
  }
  return Number(dimension.range.slice(0, -1)) * 24 * 60;
}

function selectedPriorities(
  extensionFilters: Readonly<Record<string, CustomFieldFilter>>
): Priority[] {
  const values =
    extensionFilters[PROJECT_LIST_PRIORITY_COLUMN_ID]?.selectedValues ?? [];
  return Object.values(Priority).filter((priority) =>
    values.includes(priority)
  );
}

/** Never a stored status: stands in for every off-vocabulary value. */
const OFF_VOCABULARY_STATUS = "\u0000off-vocabulary";

const BOARD_KIND_BY_GENERIC_KIND: Record<
  GenericArtifactKind,
  ProjectArtifactBoardKind | null
> = {
  [GenericArtifactKind.Agent]: null,
  [GenericArtifactKind.Branch]: ProjectArtifactBoardKind.Branch,
  [GenericArtifactKind.Deployment]: ProjectArtifactBoardKind.Deployment,
  [GenericArtifactKind.Document]: ProjectArtifactBoardKind.Document,
  [GenericArtifactKind.Issue]: ProjectArtifactBoardKind.Issue,
  [GenericArtifactKind.Prototype]: null,
  [GenericArtifactKind.Session]: ProjectArtifactBoardKind.Session,
};

const BOARD_STATUS_VOCABULARIES: readonly {
  boardKind: ProjectArtifactBoardKind;
  genericKind: GenericArtifactKind;
  statuses: readonly string[];
}[] = [
  {
    boardKind: ProjectArtifactBoardKind.Issue,
    genericKind: GenericArtifactKind.Issue,
    statuses: Object.values(IssueStatus),
  },
  {
    boardKind: ProjectArtifactBoardKind.Document,
    genericKind: GenericArtifactKind.Document,
    statuses: Object.values(DocumentStatus),
  },
  {
    boardKind: ProjectArtifactBoardKind.Branch,
    genericKind: GenericArtifactKind.Branch,
    statuses: Object.values(BranchStatus),
  },
  {
    boardKind: ProjectArtifactBoardKind.Session,
    genericKind: GenericArtifactKind.Session,
    statuses: [...Object.values(SESSION_STATUS), LEGACY_WAITING_WIRE_STATUS],
  },
  {
    boardKind: ProjectArtifactBoardKind.Deployment,
    genericKind: GenericArtifactKind.Deployment,
    statuses: [],
  },
];
