import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  createViewStateCodec,
  type SerializedViewState,
  type ViewStateAxisSpecs,
} from "@repo/design-system/lib/view-state-codec";
import { z } from "zod";
import { DATE_RANGES } from "../../../shared/lib/format-utils";
import { TABLE_GROUPING_SCHEMA } from "../../../shared/lib/table-grouping-serialization";
import type { SessionFacetFilters } from "../../lib/session-filter-adapter";
import type {
  SessionsCustomFieldOptionFilter,
  SessionsCustomFieldRangeFilter,
} from "./sessions-list-custom-fields";
import type {
  SessionsListSortField,
  SessionsListViewState,
} from "./sessions-list-view-state";

type SessionsViewStateAxisSpecs = ViewStateAxisSpecs<SessionsListViewState>;

/** Multi-select facet selections. One shape per key, so a new facet fails `tsc`. */
const SESSION_FACET_SCHEMA_SHAPE = {
  autonomyTiers: z.array(z.string()),
  changePresence: z.array(z.string()),
  costBuckets: z.array(z.string()),
  harnesses: z.array(z.string()),
  models: z.array(z.string()),
  prAssociation: z.array(z.string()),
  projectIds: z.array(z.string()),
  repositories: z.array(z.string()),
  statuses: z.array(z.string()),
  userIds: z.array(z.string()),
} satisfies Record<keyof SessionFacetFilters, z.ZodType<string[]>>;

/**
 * Objects are LOOSE, deliberately: an unknown key is carried across for the
 * same reason an unknown axis is (web and desktop ship on different cadences),
 * so restoring a view on the older build must not strip the facet or grouping
 * field only the newer one names.
 */
const FACETS_SCHEMA = z.object(SESSION_FACET_SCHEMA_SHAPE).loose();

/**
 * ISS-8216's custom-field facet selections, keyed by custom-field column id.
 *
 * A DISCRIMINATED union rather than a permissive object, because the two
 * branches are read differently and neither tolerates the other's shape:
 * `filterSessionsByCustomFields` reaches `filter.selectedValues.includes(...)`
 * on the `options` branch and `filter.min`/`filter.max` on the `range` one, so
 * a stored `{"kind":"options"}` with no `selectedValues` would throw in a
 * render rather than be refused here.
 */
const CUSTOM_FIELD_OPTION_FILTER_SCHEMA = z
  .object({
    kind: z.literal("options"),
    selectedValues: z.array(z.string()).readonly(),
  } satisfies Record<keyof SessionsCustomFieldOptionFilter, z.ZodTypeAny>)
  .loose();

const CUSTOM_FIELD_RANGE_FILTER_SCHEMA = z
  .object({
    kind: z.literal("range"),
    max: z.number().optional(),
    min: z.number().optional(),
  } satisfies Record<keyof SessionsCustomFieldRangeFilter, z.ZodTypeAny>)
  .loose();

const CUSTOM_FIELD_FILTERS_SCHEMA = z.map(
  z.string(),
  z.discriminatedUnion("kind", [
    CUSTOM_FIELD_OPTION_FILTER_SCHEMA,
    CUSTOM_FIELD_RANGE_FILTER_SCHEMA,
  ])
);

const SORT_DIRECTION_SCHEMA = z.enum([
  "asc",
  "desc",
] as const satisfies readonly SortDirection[]);

/**
 * A sort field id, checked as a string rather than against the closed
 * {@link SessionsListSortField} union.
 *
 * The union is an ADAPTER-time discipline — it stops a host passing a
 * `SessionSortKey` where a column id belongs — and enforcing it HERE would
 * discard a reader's ENTIRE saved view the first time an older build met a
 * column the newer one had added. An id this build cannot resolve costs the
 * sort (`sessionCellValue` has no reader, so the list comes back in its
 * original order); refusing costs every axis, which is the worse trade.
 */
const SORT_FIELD_SCHEMA = z.custom<SessionsListSortField>(
  (value) => typeof value === "string"
);

/**
 * ISS-8693: every axis of {@link SessionsListViewState}, how it survives JSON,
 * and what a restored value has to look like. `Set` and `Map` both
 * `JSON.stringify` to `{}` with no error, so a state persisted raw round-trips
 * as "no filters" and silently shows everything.
 *
 * The `satisfies` is the guard, not documentation. A new axis with no entry
 * here fails `tsc` on the missing property; an axis whose type the shared
 * engine cannot round-trip — a `Date`, a class instance, an object with a
 * nested `Set` — resolves the axis-kind mapping in {@link ViewStateAxisSpecs}
 * to `never`, so no `kind` is assignable and it fails `tsc` too; and a `schema`
 * looser than the axis it guards fails `tsc` on the value type. None can reach
 * the wire unnoticed.
 */
export const SESSIONS_VIEW_STATE_AXES = {
  customFieldFilters: {
    kind: "map",
    required: false,
    schema: CUSTOM_FIELD_FILTERS_SCHEMA,
  },
  dateRange: { kind: "json", required: true, schema: z.enum(DATE_RANGES) },
  facets: { kind: "json", required: true, schema: FACETS_SCHEMA },
  grouping: { kind: "json", required: true, schema: TABLE_GROUPING_SCHEMA },
  hiddenSummaryCardIds: {
    kind: "set",
    required: false,
    schema: z.set(z.string()),
  },
  page: { kind: "json", required: true, schema: z.number().int().min(0) },
  scopeUserId: {
    kind: "json",
    required: true,
    schema: z.string().nullable(),
  },
  /**
   * ISS-8966: NOT required, and that is the compatibility half of the axis. A
   * view stored before this axis existed carries no `search` key, and a missing
   * REQUIRED axis makes {@link deserializeSessionsListViewState} return `null` —
   * so requiring it would discard every previously-saved view outright rather
   * than restore it with nothing searched, which is what its absence means.
   */
  search: { kind: "json", required: false, schema: z.string() },
  sortBy: {
    kind: "json",
    required: true,
    schema: SORT_FIELD_SCHEMA.nullable(),
  },
  sortDir: { kind: "json", required: true, schema: SORT_DIRECTION_SCHEMA },
  sorts: {
    kind: "json",
    required: false,
    schema: z
      .array(
        z
          .object({
            direction: SORT_DIRECTION_SCHEMA,
            fieldId: SORT_FIELD_SCHEMA,
          })
          .loose()
      )
      .readonly(),
  },
  visibleColumnIds: { kind: "set", required: true, schema: z.set(z.string()) },
} as const satisfies SessionsViewStateAxisSpecs;

/** A view state in its JSON-native form. Opaque: read it only through this module. */
export type SerializedSessionsListViewState = SerializedViewState;

/**
 * The ONE transform between a live {@link SessionsListViewState} and JSON
 * (ISS-8693). A host persists what `serialize` returns and restores through
 * `deserialize`; a second `JSON.stringify` call site with its own replacer is
 * the drift this exists to prevent.
 *
 * ISS-9447 M1 moved the domain-free engine to
 * `@repo/design-system/lib/view-state-codec` — the tagging, the decode-against-
 * declared-kind rule, the prototype-key refusal and the `satisfies` machinery
 * are shared now. What stays here is the half that is Sessions: which axes
 * exist and what each one is allowed to hold. `TState` is passed EXPLICITLY
 * below because inferring it from the axis table is what would throw the
 * compile-time completeness guarantee away.
 */
const SESSIONS_VIEW_STATE_CODEC = createViewStateCodec<SessionsListViewState>(
  SESSIONS_VIEW_STATE_AXES
);

export function serializeSessionsListViewState(
  view: SessionsListViewState
): SerializedSessionsListViewState {
  return SESSIONS_VIEW_STATE_CODEC.serialize(view);
}

export function deserializeSessionsListViewState(
  raw: unknown
): SessionsListViewState | null {
  return SESSIONS_VIEW_STATE_CODEC.deserialize(raw);
}
