import { ArtifactDateField } from "@repo/api/src/types/artifact-date-filter";
import { DISPLAYED_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import { Priority } from "@repo/api/src/types/common";
import { postgresStorableTextSchema } from "@repo/api/src/types/postgres-text";
import { PRIORITY_FILTER_VALUES } from "@repo/api/src/types/priority-filter";
import {
  PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER,
  type ProjectArtifactBoardCustomFieldRange,
  type ProjectArtifactBoardCustomFieldValues,
  ProjectArtifactBoardFilterParam,
  type ProjectArtifactBoardFilters,
  ProjectArtifactBoardKind,
  type ProjectArtifactBoardKindStatus,
  type ProjectArtifactBoardPageQuery,
  ProjectArtifactBoardStatusMatch,
  projectArtifactBoardPageQueryValidator,
} from "@repo/api/src/types/project-artifact-board-page";
import {
  PRIORITY_UNSET_VALUE,
  PRIORITY_VALUES,
} from "@repo/api/src/types/search-query";
import { z } from "zod";
import { repeatedQueryArray } from "@/lib/repeated-query-array";
import {
  ANY_ARTIFACT_STATUS_COUNT,
  anyArtifactStatusEnum,
} from "@/lib/validators/artifact-status";

/** Open sets (people, tags) get a ceiling; closed vocabularies use their size. */
const MAX_BOARD_ASSIGNEE_FILTER_VALUES = 200;
const MAX_BOARD_TAG_FILTER_VALUES = 200;

/** Each kind's statuses plus its mode declaration, for every kind. */
const MAX_BOARD_KIND_STATUS_VALUES = 200;
const MAX_BOARD_KIND_STATUS_LENGTH = 100;

/** Parents, related sessions and custom-field selections. */
const MAX_BOARD_ID_FILTER_VALUES = 200;
const BOARD_LABEL_MAX_LENGTH = 1000;
const UUID_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const NUMBER_PATTERN = String.raw`-?[0-9]+(?:\.[0-9]+)?(?:e[-+]?[0-9]+)?`;
/** `<fieldId>:<label>`. */
const CUSTOM_FIELD_VALUE_PARAM = new RegExp(
  String.raw`^${UUID_PATTERN}:[\s\S]+$`
);
/** `<fieldId>:<min>:<max>`, either bound blank. */
const CUSTOM_FIELD_RANGE_PARAM = new RegExp(
  `^${UUID_PATTERN}:(?:${NUMBER_PATTERN})?:(?:${NUMBER_PATTERN})?$`
);

/** The branches list's search bound; a NUL is refused before it reaches SQL. */
const BOARD_SEARCH_MAX_LENGTH = 200;

const booleanParam = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();

const instantParam = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value))
  .optional();

/**
 * ISS-12929 (724-F5): the board page query with the project table's filters.
 * Strict, so a parameter the board cannot honor is a 400 rather than a silent
 * widening; every facet is optional and omission narrows nothing.
 */
export const projectArtifactBoardRouteQueryValidator =
  projectArtifactBoardPageQueryValidator
    .extend({
      [ProjectArtifactBoardFilterParam.AssigneeId]: repeatedQueryArray(
        z.union([
          z.uuid(),
          z.literal(PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER),
        ]),
        MAX_BOARD_ASSIGNEE_FILTER_VALUES
      ),
      [ProjectArtifactBoardFilterParam.DateField]: z
        .enum(ArtifactDateField)
        .optional(),
      [ProjectArtifactBoardFilterParam.DateFrom]: instantParam,
      [ProjectArtifactBoardFilterParam.DateTo]: instantParam,
      [ProjectArtifactBoardFilterParam.FavoritesOnly]: booleanParam,
      [ProjectArtifactBoardFilterParam.HideCompletedItems]: booleanParam,
      [ProjectArtifactBoardFilterParam.Priority]: repeatedQueryArray(
        z.enum([PRIORITY_UNSET_VALUE, ...PRIORITY_VALUES]),
        PRIORITY_FILTER_VALUES.length
      ),
      [ProjectArtifactBoardFilterParam.Search]: postgresStorableTextSchema(
        z.string().trim().max(BOARD_SEARCH_MAX_LENGTH)
      )
        .transform((value) => (value === "" ? undefined : value))
        .optional(),
      [ProjectArtifactBoardFilterParam.Status]: repeatedQueryArray(
        z.union([
          anyArtifactStatusEnum,
          z.literal(DISPLAYED_ARTIFACT_STATUS.Unknown),
        ]),
        ANY_ARTIFACT_STATUS_COUNT + 1
      ),
      [ProjectArtifactBoardFilterParam.TagId]: repeatedQueryArray(
        z.uuid(),
        MAX_BOARD_TAG_FILTER_VALUES
      ),
      [ProjectArtifactBoardFilterParam.AnyKindPriority]: repeatedQueryArray(
        z.enum(Priority),
        PRIORITY_VALUES.length
      ),
      [ProjectArtifactBoardFilterParam.AnyKindTagId]: repeatedQueryArray(
        z.uuid(),
        MAX_BOARD_TAG_FILTER_VALUES
      ),
      [ProjectArtifactBoardFilterParam.Kind]: repeatedQueryArray(
        z.enum(ProjectArtifactBoardKind),
        Object.keys(ProjectArtifactBoardKind).length
      ),
      [ProjectArtifactBoardFilterParam.KindStatus]: repeatedQueryArray(
        z.string().max(MAX_BOARD_KIND_STATUS_LENGTH),
        MAX_BOARD_KIND_STATUS_VALUES
      ),
      [ProjectArtifactBoardFilterParam.MineOnly]: booleanParam,
      [ProjectArtifactBoardFilterParam.ParentId]: repeatedQueryArray(
        z.uuid(),
        MAX_BOARD_ID_FILTER_VALUES
      ),
      [ProjectArtifactBoardFilterParam.RelatedSessionId]: repeatedQueryArray(
        z.uuid(),
        MAX_BOARD_ID_FILTER_VALUES
      ),
      [ProjectArtifactBoardFilterParam.CustomFieldValue]: repeatedQueryArray(
        postgresStorableTextSchema(
          z.string().regex(CUSTOM_FIELD_VALUE_PARAM).max(BOARD_LABEL_MAX_LENGTH)
        ),
        MAX_BOARD_ID_FILTER_VALUES
      ),
      [ProjectArtifactBoardFilterParam.CustomFieldRange]: repeatedQueryArray(
        z.string().regex(CUSTOM_FIELD_RANGE_PARAM),
        MAX_BOARD_ID_FILTER_VALUES
      ),
      [ProjectArtifactBoardFilterParam.SlugOrTitle]: postgresStorableTextSchema(
        z.string().trim().max(BOARD_SEARCH_MAX_LENGTH)
      )
        .transform((value) => (value === "" ? undefined : value))
        .optional(),
    })
    .strict()
    .superRefine((query, ctx) => {
      const parts = [query.dateField, query.dateFrom, query.dateTo];
      const present = parts.filter((part) => part !== undefined).length;
      if (present !== 0 && present !== parts.length) {
        ctx.addIssue({
          code: "custom",
          message: "dateField, dateFrom and dateTo are sent together",
          path: [ProjectArtifactBoardFilterParam.DateField],
        });
      }
      if (
        query.kindStatus &&
        parseBoardKindStatuses(query.kindStatus) === null
      ) {
        ctx.addIssue({
          code: "custom",
          message: "kindStatus is malformed or names a kind twice",
          path: [ProjectArtifactBoardFilterParam.KindStatus],
        });
      }
      if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
        ctx.addIssue({
          code: "custom",
          message: "dateFrom must not be after dateTo",
          path: [ProjectArtifactBoardFilterParam.DateFrom],
        });
      }
    })
    .transform(
      (query): ProjectArtifactBoardPageQuery => ({
        groupBy: query.groupBy,
        pageSize: query.pageSize,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.sortBy ? { sortBy: query.sortBy } : {}),
        ...(query.sortDir ? { sortDir: query.sortDir } : {}),
        filters: boardFilters(query),
      })
    );

function boardFilters(query: {
  assigneeId?: readonly string[];
  dateField?: ArtifactDateField;
  dateFrom?: Date;
  dateTo?: Date;
  favoritesOnly?: boolean;
  hideCompletedItems?: boolean;
  priority?: ProjectArtifactBoardFilters["priorities"];
  search?: string;
  status?: readonly string[];
  tagId?: readonly string[];
  anyKindPriority?: ProjectArtifactBoardFilters["anyKindPriorities"];
  anyKindTagId?: readonly string[];
  kind?: ProjectArtifactBoardFilters["kinds"];
  kindStatus?: readonly string[];
  mineOnly?: boolean;
  slugOrTitle?: string;
  parentId?: readonly string[];
  relatedSessionId?: readonly string[];
  customFieldValue?: readonly string[];
  customFieldRange?: readonly string[];
}): ProjectArtifactBoardFilters {
  const kindStatuses = query.kindStatus
    ? parseBoardKindStatuses(query.kindStatus)
    : null;
  return {
    ...(query.assigneeId ? { assigneeIds: query.assigneeId } : {}),
    ...(query.dateField && query.dateFrom && query.dateTo
      ? {
          dateWindow: {
            field: query.dateField,
            from: query.dateFrom,
            to: query.dateTo,
          },
        }
      : {}),
    ...(query.favoritesOnly ? { favoritesOnly: true } : {}),
    ...(query.hideCompletedItems ? { hideCompletedItems: true } : {}),
    ...(query.priority ? { priorities: query.priority } : {}),
    ...(query.search ? { search: query.search } : {}),
    ...(query.status ? { statuses: query.status } : {}),
    ...(query.tagId ? { tagIds: query.tagId } : {}),
    ...(query.anyKindPriority
      ? { anyKindPriorities: query.anyKindPriority }
      : {}),
    ...(query.anyKindTagId ? { anyKindTagIds: query.anyKindTagId } : {}),
    ...(query.kind ? { kinds: query.kind } : {}),
    ...(kindStatuses ? { kindStatuses } : {}),
    ...(query.mineOnly ? { mineOnly: true } : {}),
    ...(query.slugOrTitle ? { slugOrTitle: query.slugOrTitle } : {}),
    ...(query.parentId ? { parentIds: query.parentId } : {}),
    ...(query.relatedSessionId
      ? { relatedSessionIds: query.relatedSessionId }
      : {}),
    ...(query.customFieldValue
      ? { customFieldValues: customFieldValues(query.customFieldValue) }
      : {}),
    ...(query.customFieldRange
      ? { customFieldRanges: query.customFieldRange.map(customFieldRange) }
      : {}),
  };
}

/** `<fieldId>:<label>` values grouped by field; the label may hold colons. */
function customFieldValues(
  values: readonly string[]
): ProjectArtifactBoardCustomFieldValues[] {
  const labelsByField = new Map<string, string[]>();
  for (const value of values) {
    const separator = value.indexOf(":");
    const fieldId = value.slice(0, separator).toLowerCase();
    const labels = labelsByField.get(fieldId) ?? [];
    labels.push(value.slice(separator + 1));
    labelsByField.set(fieldId, labels);
  }
  return [...labelsByField].map(([fieldId, labels]) => ({ fieldId, labels }));
}

function customFieldRange(value: string): ProjectArtifactBoardCustomFieldRange {
  const [fieldId = "", min = "", max = ""] = value.split(":");
  return {
    fieldId: fieldId.toLowerCase(),
    ...(min === "" ? {} : { min: Number(min) }),
    ...(max === "" ? {} : { max: Number(max) }),
  };
}

/**
 * `kindStatus` values back into per-kind matches (see
 * `projectArtifactBoardKindStatusParam`): the empty value marks the facet
 * active, `<kind>:<match>` declares a kind, `<kind>:<match>:<status>` lists a
 * status. Null when a value is malformed or a kind carries two modes.
 */
function parseBoardKindStatuses(
  values: readonly string[]
): ProjectArtifactBoardKindStatus[] | null {
  const entries = new Map<
    ProjectArtifactBoardKind,
    { match: ProjectArtifactBoardStatusMatch; statuses: string[] }
  >();
  for (const value of values) {
    if (value === "") {
      continue;
    }
    const [kindPart, matchPart, ...rest] = value.split(":");
    const kind = boardKind.safeParse(kindPart);
    const match = boardStatusMatch.safeParse(matchPart);
    if (!(kind.success && match.success)) {
      return null;
    }
    const entry = entries.get(kind.data) ?? {
      match: match.data,
      statuses: [],
    };
    if (entry.match !== match.data) {
      return null;
    }
    if (rest.length > 0) {
      entry.statuses.push(rest.join(":"));
    }
    entries.set(kind.data, entry);
  }
  return [...entries].map(([kind, entry]) => ({ kind, ...entry }));
}

const boardKind = z.enum(ProjectArtifactBoardKind);
const boardStatusMatch = z.enum(ProjectArtifactBoardStatusMatch);
