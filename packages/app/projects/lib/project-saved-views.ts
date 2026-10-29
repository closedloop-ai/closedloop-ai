/**
 * The persisted shape behind the portable Projects surface's saved views
 * (ISS-10476 review — codex P2, tamsinb).
 *
 * `ProjectList` held its whole arrangement, the saved-view collection included,
 * in `useState`. In the prototype sandbox that was the right answer; on the
 * product route it made a control labelled "Save current view" append a row that
 * was gone on the next navigation — a UI reporting a capability it does not
 * provide. The collection and its `localStorage` object are owned by the shared
 * `usePersistedSavedViews` store; this module supplies the two things that store
 * asks a feature to own: the arrangement schema, and the fail-soft parser that
 * degrades an unknown or malformed blob to an empty collection rather than
 * throwing.
 *
 * The arrangement is stored, not derived, so every field is validated on the way
 * back in: a build that drops a group order, a hand-edited blob, and a view
 * written by a newer build all have to reach the table as something it can
 * render. A view that fails validation is dropped rather than repaired — a
 * half-restored arrangement is a view claiming to be the one the reader saved.
 */

import {
  TableDateFilterField,
  TableDatePreset,
} from "@repo/design-system/components/ui/filter-popover";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  emptySavedViewCollection,
  type SavedViewCollection,
} from "@repo/design-system/lib/table-saved-views";
import { z } from "zod";
import {
  PERSISTED_COLUMN_WIDTHS_SCHEMA,
  PERSISTED_STRING_ARRAY_SCHEMA,
} from "../../shared/lib/view-state-axes";
import type {
  ProjectGroupOrder,
  ProjectLayout,
  ProjectSummaryFilters,
} from "./project-summary-view";

/** Everything a saved Projects view restores. */
export type ProjectViewState = {
  columnOrder: string[];
  columnWidths: Record<string, number>;
  filters: ProjectSummaryFilters;
  groupBy: string;
  groupOrder: ProjectGroupOrder;
  layout: ProjectLayout;
  leadingColumnWidth: number;
  secondaryGroupBy: string;
  secondaryGroupOrder: ProjectGroupOrder;
  showEmptyGroups: boolean;
  showEmptySubgroups: boolean;
  sortActive: boolean;
  sortBy: string;
  sortDir: SortDirection;
  visibleColumnIds: string[];
};

/**
 * `localStorage` namespace for the collection, mirroring the Branches spelling
 * (`branches:saved-views:`). The surface half of the key is the host's, because
 * only the host knows whose views these are.
 */
export const PROJECT_SAVED_VIEWS_KEY_PREFIX = "projects:saved-views:";

/**
 * Durable column preferences — visibility, order, widths, and the leading
 * column's width — held apart from the named collection above under the host's
 * own key. Separate because they are two different promises: a saved view is a
 * named arrangement the reader chose to keep, and these are the live table's own
 * columns, which ISS-9726 already persists per identity on the surface this one
 * replaces.
 */
export type ProjectColumnPreferences = {
  columnOrder: string[];
  columnWidths: Record<string, number>;
  hiddenColumnIds: string[];
  leadingColumnWidth: number;
};

const GROUP_ORDER_SCHEMA = z.enum(["asc", "custom", "desc"]);
const SORT_DIRECTION_SCHEMA = z.enum(["asc", "desc"]);
const POSITIVE_WIDTH_SCHEMA = z.number().int().positive();

const DATE_FILTER_SCHEMA = z
  .object({
    field: z.enum([
      TableDateFilterField.CreatedAt,
      TableDateFilterField.UpdatedAt,
    ]),
    preset: z.enum([
      TableDatePreset.Last24h,
      TableDatePreset.Last7d,
      TableDatePreset.Last30d,
      TableDatePreset.Last3m,
      TableDatePreset.Custom,
    ]),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
  })
  .nullable();

const FILTERS_SCHEMA = z.object({
  assigneeIds: PERSISTED_STRING_ARRAY_SCHEMA,
  assignToMe: z.boolean(),
  date: DATE_FILTER_SCHEMA,
  favoritesOnly: z.boolean(),
  hideCompletedItems: z.boolean(),
  priorities: PERSISTED_STRING_ARRAY_SCHEMA,
  statuses: PERSISTED_STRING_ARRAY_SCHEMA,
  tagIds: PERSISTED_STRING_ARRAY_SCHEMA,
});

const ARRANGEMENT_SCHEMA = z.object({
  columnOrder: PERSISTED_STRING_ARRAY_SCHEMA,
  columnWidths: PERSISTED_COLUMN_WIDTHS_SCHEMA,
  filters: FILTERS_SCHEMA,
  groupBy: z.string(),
  groupOrder: GROUP_ORDER_SCHEMA,
  layout: z.enum(["board", "list"]),
  leadingColumnWidth: POSITIVE_WIDTH_SCHEMA,
  secondaryGroupBy: z.string(),
  secondaryGroupOrder: GROUP_ORDER_SCHEMA,
  showEmptyGroups: z.boolean(),
  showEmptySubgroups: z.boolean(),
  sortActive: z.boolean(),
  sortBy: z.string(),
  sortDir: SORT_DIRECTION_SCHEMA,
  visibleColumnIds: PERSISTED_STRING_ARRAY_SCHEMA,
});

const COLLECTION_SCHEMA = z.object({
  activeViewId: z.string().nullable().catch(null),
  views: z
    .array(
      z.object({
        arrangement: ARRANGEMENT_SCHEMA,
        id: z.string(),
        name: z.string(),
      })
    )
    .catch([]),
});

const COLUMN_PREFERENCES_SCHEMA = z.object({
  columnOrder: PERSISTED_STRING_ARRAY_SCHEMA,
  columnWidths: PERSISTED_COLUMN_WIDTHS_SCHEMA,
  hiddenColumnIds: PERSISTED_STRING_ARRAY_SCHEMA,
  leadingColumnWidth: POSITIVE_WIDTH_SCHEMA,
});

/**
 * Validate a `localStorage` blob into a saved-view collection. Anything this
 * build cannot render — a missing field, a group order it does not know, a
 * hand-edited blob — degrades to an EMPTY collection rather than throwing, so a
 * corrupt store costs the reader their named views and never the page.
 */
export function parseProjectSavedViews(
  input: unknown
): SavedViewCollection<ProjectViewState> | null {
  const result = COLLECTION_SCHEMA.safeParse(input);
  if (!result.success) {
    return emptySavedViewCollection<ProjectViewState>();
  }
  const views = result.data
    .views as SavedViewCollection<ProjectViewState>["views"];
  // An active id whose view failed validation and was dropped would leave the
  // trigger naming a view that is not in the menu.
  const activeViewId = result.data.activeViewId;
  const activeExists =
    activeViewId !== null && views.some((view) => view.id === activeViewId);
  return { activeViewId: activeExists ? activeViewId : null, views };
}

/**
 * Validate a stored column-preference blob, falling back to `fallback` whole.
 * The signature is `useOptionalPersistedState`'s validator contract.
 */
export function parseProjectColumnPreferences(
  value: unknown,
  fallback: ProjectColumnPreferences
): ProjectColumnPreferences {
  const result = COLUMN_PREFERENCES_SCHEMA.safeParse(value);
  return result.success ? (result.data as ProjectColumnPreferences) : fallback;
}
