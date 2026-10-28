import { z } from "zod";
import { ArtifactSubtype, ArtifactType } from "./artifact.ts";
import type { ArtifactDateWindow } from "./artifact-date-filter.ts";
import { Priority } from "./common.ts";
import { postgresStorableTextSchema } from "./postgres-text.ts";
import type { PriorityFilterValue } from "./priority-filter.ts";
import {
  type ProjectArtifactLanePolicy,
  projectArtifactLanePolicySchema,
} from "./project-artifact-lane-policy.ts";
import type { DetailedArtifact } from "./project-tree.ts";

export const ProjectArtifactBoardGroup = {
  Assignee: "assignee",
  None: "none",
  Priority: "priority",
  Status: "status",
} as const;
export type ProjectArtifactBoardGroup =
  (typeof ProjectArtifactBoardGroup)[keyof typeof ProjectArtifactBoardGroup];

/**
 * ISS-12929 (724-F5): the project table's column sorts as board orders. The
 * values are the table's own `SortKey` spellings, so the page sort passes
 * through unchanged. StackRank is the board's manual order.
 */
export const ProjectArtifactBoardSort = {
  Assignee: "assignee",
  Priority: "priority",
  Slug: "slug",
  StackRank: "stackRank",
  Status: "status",
  Title: "title",
  Type: "type",
  Updated: "updated",
} as const;
export type ProjectArtifactBoardSort =
  (typeof ProjectArtifactBoardSort)[keyof typeof ProjectArtifactBoardSort];

export const ProjectArtifactBoardSortDirection = {
  Asc: "asc",
  Desc: "desc",
} as const;
export type ProjectArtifactBoardSortDirection =
  (typeof ProjectArtifactBoardSortDirection)[keyof typeof ProjectArtifactBoardSortDirection];

export const PROJECT_ARTIFACT_BOARD_PAGE_DEFAULT_SIZE = 40;
export const PROJECT_ARTIFACT_BOARD_PAGE_MAX_SIZE = 100;

/** Existing route-boundary copy reused for malformed cursor input. */
export const PROJECT_ARTIFACT_BOARD_INVALID_CURSOR_MESSAGE =
  "Invalid project artifact board query";

export const ProjectArtifactBoardPageError = {
  InvalidCursor: "invalid_cursor",
  StaleRevision: "stale_revision",
} as const;
export type ProjectArtifactBoardPageError =
  (typeof ProjectArtifactBoardPageError)[keyof typeof ProjectArtifactBoardPageError];

export type ProjectArtifactBoardCardProjection = {
  artifact: DetailedArtifact;
  descendantCount: number;
};

export type ProjectArtifactBoardLanePage = {
  cards: ProjectArtifactBoardCardProjection[];
  complete: boolean;
  count: number;
  id: string;
  label: string;
};

export type ProjectArtifactBoardPageResponse = {
  lanePolicy?: ProjectArtifactLanePolicy;
  lanes: ProjectArtifactBoardLanePage[];
  nextCursor?: string;
  populationRevision: string;
  /** PRD-725 placement version read in the same snapshot as this page. */
  projectVersion?: string;
  /** Ordered root identities projected on this page. */
  rootIds: string[];
};

export const projectArtifactBoardPageQueryValidator = z
  .object({
    cursor: postgresStorableTextSchema(
      z.string().min(1).max(16_384)
    ).optional(),
    groupBy: z.enum(ProjectArtifactBoardGroup),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(PROJECT_ARTIFACT_BOARD_PAGE_MAX_SIZE)
      .default(PROJECT_ARTIFACT_BOARD_PAGE_DEFAULT_SIZE),
    sortBy: z.enum(ProjectArtifactBoardSort).optional(),
    sortDir: z.enum(ProjectArtifactBoardSortDirection).optional(),
  })
  .strict();

export type ProjectArtifactBoardPageQuery = z.infer<
  typeof projectArtifactBoardPageQueryValidator
> & {
  /** Omitted, or every member omitted, narrows nothing. */
  filters?: ProjectArtifactBoardFilters;
};

/**
 * Query parameter names for the board's server-side filters (ISS-12929,
 * 724-F5). Multi-valued members repeat once per value.
 */
export const ProjectArtifactBoardFilterParam = {
  AssigneeId: "assigneeId",
  DateField: "dateField",
  DateFrom: "dateFrom",
  DateTo: "dateTo",
  FavoritesOnly: "favoritesOnly",
  HideCompletedItems: "hideCompletedItems",
  Priority: "priority",
  Search: "search",
  Status: "status",
  TagId: "tagId",
  // ISS-12929: the portable project list's toolbar, whose facets apply to
  // every artifact kind rather than to documents only.
  AnyKindPriority: "anyKindPriority",
  AnyKindTagId: "anyKindTagId",
  CustomFieldRange: "customFieldRange",
  CustomFieldValue: "customFieldValue",
  ParentId: "parentId",
  RelatedSessionId: "relatedSessionId",
  Kind: "kind",
  KindStatus: "kindStatus",
  MineOnly: "mineOnly",
  SlugOrTitle: "slugOrTitle",
} as const;

/**
 * The portable project list's artifact kinds, spelled as its generic surface
 * spells them, so a toolbar selection passes through unchanged.
 */
export const ProjectArtifactBoardKind = {
  Branch: "Branch",
  Deployment: "Deployment",
  Document: "Document",
  Issue: "Issue",
  Session: "Session",
} as const;
export type ProjectArtifactBoardKind =
  (typeof ProjectArtifactBoardKind)[keyof typeof ProjectArtifactBoardKind];

/**
 * Which stored statuses of one kind a status selection keeps. The client
 * resolves its status keys against each kind's vocabulary, so the server only
 * tests membership: `Only` keeps the listed statuses, `Except` keeps every
 * status but the listed ones (a selection that also keeps off-vocabulary
 * statuses). A kind with no entry keeps nothing while the facet is active.
 */
export const ProjectArtifactBoardStatusMatch = {
  Except: "except",
  Only: "only",
} as const;
export type ProjectArtifactBoardStatusMatch =
  (typeof ProjectArtifactBoardStatusMatch)[keyof typeof ProjectArtifactBoardStatusMatch];

export type ProjectArtifactBoardCustomFieldValues = {
  fieldId: string;
  labels: readonly string[];
};

/** Bounds as numbers: a NUMBER value, or a DATE as epoch milliseconds. */
export type ProjectArtifactBoardCustomFieldRange = {
  fieldId: string;
  max?: number;
  min?: number;
};

export type ProjectArtifactBoardKindStatus = {
  kind: ProjectArtifactBoardKind;
  match: ProjectArtifactBoardStatusMatch;
  statuses: readonly string[];
};

/** The assignee facet's "no assignee" member, as the filter UI spells it. */
export const PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER = "__unassigned__";

/**
 * The project table's filter state as the board route reads it. The facets
 * keep the browser predicate's per-kind meaning: status, priority and tags
 * narrow documents only, and hide-completed asks each kind's own vocabulary.
 */
export type ProjectArtifactBoardFilters = {
  /** User ids, or {@link PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER}. */
  assigneeIds?: readonly string[];
  dateWindow?: ArtifactDateWindow;
  favoritesOnly?: boolean;
  hideCompletedItems?: boolean;
  priorities?: readonly PriorityFilterValue[];
  search?: string;
  /** Stored statuses, or the render-only Unknown facet value. */
  statuses?: readonly string[];
  tagIds?: readonly string[];
  /** Priorities that narrow every kind; an unset priority never matches. */
  anyKindPriorities?: readonly Priority[];
  /** Tag ids that narrow every kind; an untagged artifact never matches. */
  anyKindTagIds?: readonly string[];
  kinds?: readonly ProjectArtifactBoardKind[];
  /**
   * The status facet per kind, or undefined when inactive. An empty list is
   * an active facet that keeps nothing.
   */
  kindStatuses?: readonly ProjectArtifactBoardKindStatus[];
  /** Assigned to the viewer. */
  mineOnly?: boolean;
  /** A document custom field holding any of these display labels. */
  customFieldValues?: readonly ProjectArtifactBoardCustomFieldValues[];
  /**
   * A number or date custom field within these bounds; an artifact with no
   * value for the field passes, as it does in the list.
   */
  customFieldRanges?: readonly ProjectArtifactBoardCustomFieldRange[];
  /** Produced by one of these artifacts. */
  parentIds?: readonly string[];
  /** Related to one of these sessions, as the Related Sessions cell counts. */
  relatedSessionIds?: readonly string[];
  /** Case-insensitive substring of "<slug> <title>", for every kind. */
  slugOrTitle?: string;
};

/** Canonical client path for a deterministic Project Artifact Board page. */
export function projectArtifactBoardPagePath(
  projectId: string,
  query: ProjectArtifactBoardPageQuery
) {
  const params = new URLSearchParams({
    groupBy: query.groupBy,
    pageSize: String(query.pageSize),
  });
  if (query.cursor) {
    params.set("cursor", query.cursor);
  }
  if (query.sortBy && query.sortBy !== ProjectArtifactBoardSort.StackRank) {
    params.set("sortBy", query.sortBy);
    params.set(
      "sortDir",
      query.sortDir ?? ProjectArtifactBoardSortDirection.Asc
    );
  }
  appendBoardFilterParams(params, query.filters);
  return `/projects/${projectId}/artifacts/board?${params.toString()}`;
}

function appendBoardFilterParams(
  params: URLSearchParams,
  filters: ProjectArtifactBoardFilters | undefined
) {
  if (!filters) {
    return;
  }
  const repeated: [string, readonly string[] | undefined][] = [
    [ProjectArtifactBoardFilterParam.AssigneeId, filters.assigneeIds],
    [ProjectArtifactBoardFilterParam.Priority, filters.priorities],
    [ProjectArtifactBoardFilterParam.Status, filters.statuses],
    [ProjectArtifactBoardFilterParam.TagId, filters.tagIds],
  ];
  for (const [key, values] of repeated) {
    for (const value of values ?? []) {
      params.append(key, value);
    }
  }
  const search = filters.search?.trim();
  if (search) {
    params.set(ProjectArtifactBoardFilterParam.Search, search);
  }
  appendListToolbarParams(params, filters);
  appendListRelationParams(params, filters);
  if (filters.favoritesOnly) {
    params.set(ProjectArtifactBoardFilterParam.FavoritesOnly, "true");
  }
  if (filters.hideCompletedItems) {
    params.set(ProjectArtifactBoardFilterParam.HideCompletedItems, "true");
  }
  if (filters.dateWindow) {
    params.set(
      ProjectArtifactBoardFilterParam.DateField,
      filters.dateWindow.field
    );
    params.set(
      ProjectArtifactBoardFilterParam.DateFrom,
      filters.dateWindow.from.toISOString()
    );
    params.set(
      ProjectArtifactBoardFilterParam.DateTo,
      filters.dateWindow.to.toISOString()
    );
  }
}

function appendListToolbarParams(
  params: URLSearchParams,
  filters: ProjectArtifactBoardFilters
) {
  for (const priority of filters.anyKindPriorities ?? []) {
    params.append(ProjectArtifactBoardFilterParam.AnyKindPriority, priority);
  }
  for (const tagId of filters.anyKindTagIds ?? []) {
    params.append(ProjectArtifactBoardFilterParam.AnyKindTagId, tagId);
  }
  for (const kind of filters.kinds ?? []) {
    params.append(ProjectArtifactBoardFilterParam.Kind, kind);
  }
  if (filters.kindStatuses) {
    // An active facet that keeps nothing still has to reach the server.
    params.append(ProjectArtifactBoardFilterParam.KindStatus, "");
    for (const entry of filters.kindStatuses) {
      params.append(
        ProjectArtifactBoardFilterParam.KindStatus,
        projectArtifactBoardKindStatusParam(entry.kind, entry.match, null)
      );
      for (const status of entry.statuses) {
        params.append(
          ProjectArtifactBoardFilterParam.KindStatus,
          projectArtifactBoardKindStatusParam(entry.kind, entry.match, status)
        );
      }
    }
  }
  if (filters.mineOnly) {
    params.set(ProjectArtifactBoardFilterParam.MineOnly, "true");
  }
  const slugOrTitle = filters.slugOrTitle?.trim();
  if (slugOrTitle) {
    params.set(ProjectArtifactBoardFilterParam.SlugOrTitle, slugOrTitle);
  }
}

/** The list's Parent, Related Sessions and custom-field column filters. */
function appendListRelationParams(
  params: URLSearchParams,
  filters: ProjectArtifactBoardFilters
) {
  for (const parentId of filters.parentIds ?? []) {
    params.append(ProjectArtifactBoardFilterParam.ParentId, parentId);
  }
  for (const sessionId of filters.relatedSessionIds ?? []) {
    params.append(ProjectArtifactBoardFilterParam.RelatedSessionId, sessionId);
  }
  for (const field of filters.customFieldValues ?? []) {
    for (const label of field.labels) {
      params.append(
        ProjectArtifactBoardFilterParam.CustomFieldValue,
        `${field.fieldId}:${label}`
      );
    }
  }
  for (const range of filters.customFieldRanges ?? []) {
    params.append(
      ProjectArtifactBoardFilterParam.CustomFieldRange,
      `${range.fieldId}:${range.min ?? ""}:${range.max ?? ""}`
    );
  }
}

/**
 * One `kindStatus` value: `<kind>:<match>` names the kind's match mode, and
 * `<kind>:<match>:<status>` lists one status under it.
 */
export function projectArtifactBoardKindStatusParam(
  kind: ProjectArtifactBoardKind,
  match: ProjectArtifactBoardStatusMatch,
  status: string | null
): string {
  return status === null ? `${kind}:${match}` : `${kind}:${match}:${status}`;
}

const basicUserSchema = z
  .object({
    avatarUrl: z.string().nullable(),
    email: z.email(),
    firstName: z.string().nullable(),
    id: z.uuid(),
    lastName: z.string().nullable(),
  })
  .strict();

const boardArtifactSchema = z
  .object({
    assignee: basicUserSchema.nullable(),
    assigneeId: z.uuid().nullable(),
    createdAt: z.coerce.date(),
    createdById: z.uuid().nullable(),
    currentVersion: z.number().int().min(1).optional(),
    dueDate: z.coerce.date().nullable(),
    externalUrl: z.string().nullable(),
    id: z.uuid(),
    name: z.string(),
    organizationId: z.uuid(),
    priority: z.enum(Priority).nullable(),
    projectId: z.uuid().nullable(),
    slug: z.string().nullable(),
    sortOrder: z.number().int().nullable(),
    status: z.string(),
    subtype: z.enum(ArtifactSubtype).nullable(),
    type: z.enum(ArtifactType),
    updatedAt: z.coerce.date(),
  })
  .loose();

export const projectArtifactBoardPageResponseValidator: z.ZodType<ProjectArtifactBoardPageResponse> =
  z
    .object({
      lanes: z.array(
        z
          .object({
            cards: z.array(
              z
                .object({
                  artifact: boardArtifactSchema,
                  descendantCount: z.number().int().min(0),
                })
                .loose()
            ),
            complete: z.boolean(),
            count: z.number().int().min(0),
            id: z.string().min(1),
            label: z.string(),
          })
          .loose()
      ),
      lanePolicy: projectArtifactLanePolicySchema.optional(),
      nextCursor: z.string().min(1).optional(),
      populationRevision: z.string().length(64),
      projectVersion: z.string().min(1).optional(),
      rootIds: z.array(z.uuid()),
    })
    .loose();
