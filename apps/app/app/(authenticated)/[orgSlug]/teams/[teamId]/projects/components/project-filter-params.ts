import { Priority } from "@repo/api/src/types/common";
import { ProjectStatus } from "@repo/api/src/types/project";
import {
  type FacetFilterParamMap,
  parseFacetFilterParams,
  writeFacetFilterParams,
} from "@repo/app/shared/lib/facet-filter-params";
import {
  type TableDateFilter,
  TableDateFilterField,
  TableDatePreset,
  type TableFiltersState,
} from "@repo/design-system/components/ui/table-filters";

/**
 * The team Projects list's filter ⇄ URL codec (ISS-9346, PRD-706 R10-06).
 *
 * A filtered view here is SHAREABLE: the operator ruled that deep-linking to
 * one is the requirement, which localStorage cannot satisfy at all. So this
 * follows Branches — `parseBranchFilterParams`/`writeBranchFilterParams` over
 * the shared `@repo/app/shared/lib/facet-filter-params` codec — rather than
 * inventing a second encoding. Multi-select facets are repeated params
 * (`?status=ACTIVE&status=PLANNING`); the two scalars are written explicitly.
 *
 * ## Disjoint from the sort params, deliberately
 *
 * `useSortParams` owns `sortBy` and `sortDir` on this same URL, and both
 * writers copy the WHOLE existing snapshot and touch only their own names —
 * so they compose, and neither can drop the other's params, only as long as
 * the name sets stay disjoint. {@link PROJECT_RESERVED_PARAMS} is what makes
 * that checkable instead of a comment, and `project-filter-params.test.ts`
 * asserts the two sets do not intersect.
 */

/** The sort param names `useSortParams` owns on this surface, unprefixed. */
export const PROJECT_SORT_PARAMS = ["sortBy", "sortDir"] as const;

/** `TableFiltersState`'s multi-select subset, the part the generic codec drives. */
type ProjectFacetFilters = {
  assigneeIds: string[];
  statuses: ProjectStatus[];
  priorities: Priority[];
};

export const PROJECT_FILTER_PARAMS = {
  assigneeIds: "assignee",
  statuses: "status",
  priorities: "priority",
} as const satisfies FacetFilterParamMap<ProjectFacetFilters>;

/** The "Assigned to me" quick toggle. */
export const PROJECT_ASSIGNED_TO_ME_PARAM = "assignedToMe";
/** The date filter's two halves — the field the user picked, and the window. */
export const PROJECT_DATE_FIELD_PARAM = "dateField";
export const PROJECT_DATE_PRESET_PARAM = "datePreset";

/** Every param name this codec writes, for the disjointness check. */
export const PROJECT_RESERVED_PARAMS = [
  ...Object.values(PROJECT_FILTER_PARAMS),
  PROJECT_ASSIGNED_TO_ME_PARAM,
  PROJECT_DATE_FIELD_PARAM,
  PROJECT_DATE_PRESET_PARAM,
] as const;

const TOGGLE_ON = "1";

const FACET_DEFAULTS: ProjectFacetFilters = {
  assigneeIds: [],
  statuses: [],
  priorities: [],
};

export const EMPTY_PROJECT_FILTERS: TableFiltersState<ProjectStatus, Priority> =
  {
    assigneeIds: [],
    assignToMe: false,
    date: null,
    favoritesOnly: false,
    hideCompletedItems: false,
    priorities: [],
    statuses: [],
    tagIds: [],
  };

const VALID_STATUSES = new Set<string>(Object.values(ProjectStatus));
const VALID_PRIORITIES = new Set<string>(Object.values(Priority));
const VALID_DATE_FIELDS = new Set<string>(Object.values(TableDateFilterField));
const VALID_DATE_PRESETS = new Set<string>(Object.values(TableDatePreset));

/**
 * The date filter a link carries, or `null`.
 *
 * BOTH halves are required: a `?dateField=` with no preset names no window and
 * a `?datePreset=` with no field does not say which column it narrows, so
 * either alone is dropped rather than completed with a guess the chip would
 * then assert. `startDate`/`endDate` are not encoded because this surface
 * cannot produce them — `FilterPopover` renders `DEFAULT_DATE_PRESETS` here,
 * which has no `Custom` entry, so its date submenu only ever sets a field and
 * a preset (see `DATE_PRESET_WINDOW_MS` in `project-filter-sort-model.ts`).
 */
function parseDateFilter(
  params: Pick<URLSearchParams, "getAll">
): TableDateFilter | null {
  const field = params.getAll(PROJECT_DATE_FIELD_PARAM).at(0);
  const preset = params.getAll(PROJECT_DATE_PRESET_PARAM).at(0);
  if (!(field && preset)) {
    return null;
  }
  if (!(VALID_DATE_FIELDS.has(field) && VALID_DATE_PRESETS.has(preset))) {
    return null;
  }
  return {
    field: field as TableDateFilterField,
    preset: preset as TableDatePreset,
  };
}

/**
 * Parses the Projects filter selections out of the list URL.
 *
 * Restore-boundary validation, the same posture Documents takes on its own
 * stored filters: an unrecognised status or priority is STRIPPED rather than
 * rejecting the whole link, so one stale value in a shared URL does not throw
 * away the four beside it that still mean something.
 */
export function parseProjectFilterParams(
  params: Pick<URLSearchParams, "getAll">
): TableFiltersState<ProjectStatus, Priority> {
  const facets = parseFacetFilterParams(
    params,
    FACET_DEFAULTS,
    PROJECT_FILTER_PARAMS
  );
  const assignToMe =
    params.getAll(PROJECT_ASSIGNED_TO_ME_PARAM).at(0) === TOGGLE_ON;
  const date = parseDateFilter(params);
  return {
    ...EMPTY_PROJECT_FILTERS,
    assigneeIds: facets.assigneeIds,
    assignToMe,
    date,
    priorities: facets.priorities.filter((priority): priority is Priority =>
      VALID_PRIORITIES.has(priority)
    ),
    statuses: facets.statuses.filter((status): status is ProjectStatus =>
      VALID_STATUSES.has(status)
    ),
  };
}

/**
 * Writes the Projects filter selections into `params`, replacing whatever was
 * there.
 *
 * The explicit reserved fields are written AFTER the generic facet pass, never
 * folded into it: the facet codec drives a `Record<string, string[]>` and a
 * scalar handed to it would be appended rather than set, so a second write
 * would leave two `?assignedToMe=` values on one URL. An empty selection
 * deletes its param, so the default state produces a clean link.
 */
export function writeProjectFilterParams(
  params: URLSearchParams,
  filters: TableFiltersState<ProjectStatus, Priority>
): void {
  writeFacetFilterParams(
    params,
    {
      assigneeIds: filters.assigneeIds,
      priorities: filters.priorities,
      statuses: filters.statuses,
    },
    PROJECT_FILTER_PARAMS
  );

  params.delete(PROJECT_ASSIGNED_TO_ME_PARAM);
  if (filters.assignToMe) {
    params.set(PROJECT_ASSIGNED_TO_ME_PARAM, TOGGLE_ON);
  }

  params.delete(PROJECT_DATE_FIELD_PARAM);
  params.delete(PROJECT_DATE_PRESET_PARAM);
  if (filters.date) {
    params.set(PROJECT_DATE_FIELD_PARAM, filters.date.field);
    params.set(PROJECT_DATE_PRESET_PARAM, filters.date.preset);
  }
}
