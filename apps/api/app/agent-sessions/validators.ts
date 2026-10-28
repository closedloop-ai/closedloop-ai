import { SESSION_QUALITY_VALUES } from "@repo/api/src/agent-session-filters";
import { decodeAgentComponentInvocationSessionTreeCursor } from "@repo/api/src/types/agent-component-invocation-session-tree";
import {
  AGENT_SESSION_VIEWER_SCOPE_OPTIONS,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { decodeSessionEventCursor } from "@repo/api/src/types/agent-session-event-cursor";
import {
  SESSION_LIST_MAX_FILTER_VALUES,
  SESSION_LIST_MAX_LIMIT,
  SESSION_LIST_MAX_OFFSET,
} from "@repo/api/src/types/agent-session-list-limits";
import { AGENT_SESSION_NAME_MAX_CHARS } from "@repo/api/src/types/agent-session-rename";
import { parseSessionSortRule } from "@repo/api/src/types/agent-session-sort";
import { AGENT_SESSION_USAGE_ATTRIBUTION_OPTIONS } from "@repo/api/src/types/agent-session-usage-attribution";
import { AGENT_SESSION_COMPARISON_MODES } from "@repo/api/src/types/agent-session-usage-comparison";
import { Priority } from "@repo/api/src/types/common";
import { LIST_QUERY_EXPRESSION_PARAM } from "@repo/api/src/types/list-query-expression";
import { isBelowPgTimestampFloor } from "@repo/api/src/types/pg-timestamp-floor";
import { containsNulCharacter } from "@repo/api/src/types/postgres-text";
import { PRIORITY_FILTER_VALUES } from "@repo/api/src/types/priority-filter";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { z } from "zod";
import { isStorableInt4Count } from "@/lib/int4-column-bounds";
import { isUuid } from "@/lib/is-uuid";
import { repeatedQueryArray } from "@/lib/repeated-query-array";
import {
  sanitizedTextFields,
  sanitizeTextFields,
} from "@/lib/sanitize-text-fields";
import { optionalSingleArtifactEditSurface } from "@/lib/single-artifact-edit-surface";
import { pageBoundValidator } from "@/lib/validators/pagination";
import {
  createListQueryPreprocess,
  type ListQueryRequestTarget,
} from "./list-query-param";
import {
  AGENT_SESSION_BULK_ASSIGN_MAX_IDS,
  AgentSessionBulkAssignField,
  type AgentSessionBulkAssignRequest,
  type AgentSessionCreateRequest,
  type AgentSessionUpdateRequest,
} from "./write-contract";

const isoDateQuerySchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid date")
  .refine(
    (value) => !isBelowPgTimestampFloor(Date.parse(value)),
    "Date is before the earliest instant a timestamp column can hold"
  );

const optionalNonEmptyStringSchema = z.string().trim().min(1).optional();
const optionalUuidSchema = z.string().uuid("Must be a valid UUID").optional();

// Every schema `queryArray` builds, recorded at construction so the repeatable
// facet set below cannot drift from the facets that actually exist.
const repeatableQuerySchemas = new Set<z.core.$ZodType>();

// Every repeatable facet: normalized, de-duplicated and bounded by the shared
// helper (ISS-9073 — each distinct value is one bind parameter, and past the
// driver ceiling Prisma refuses the whole list read). The cap lives INSIDE the
// helper so the object registered here is the one placed in the shape; a
// `.refine`/`.transform` applied at a field site would be a new object and
// silently drop that facet from the registry above.
function queryArray<T extends z.ZodTypeAny>(element: T) {
  const schema = repeatedQueryArray(element, SESSION_LIST_MAX_FILTER_VALUES);
  repeatableQuerySchemas.add(schema);
  return schema;
}

const stringArrayQuerySchema = queryArray(z.string().trim().min(1));
const uuidArrayQuerySchema = queryArray(
  z.string().uuid("Must be a valid UUID")
);

/** Sortable session columns — values match the table column ids on the client. */
export const AGENT_SESSION_SORT_COLUMNS = [
  "user",
  "status",
  "repo",
  "harness",
  "model",
  "autonomy",
  "duration",
  "cost",
  "started",
  "priority",
  // ISS-6005: record-mutation recency (the `Updated` column) — a display-value
  // sort resolved in memory; see `session-sort-order.ts` / `compareByRecordUpdatedAt`.
  "updated",
  "lastActivity",
  // ISS-12251 (PLN-2176 T-3.1): the Owner sort, by the session's assignee.
  // `user` above is the spelling every existing client sends and means the same
  // thing; `resolveSessionSortRules` reads both as one column.
  "assignee",
] as const;

export type AgentSessionSortColumn =
  (typeof AGENT_SESSION_SORT_COLUMNS)[number];

const AGENT_SESSION_SORT_COLUMN_SET = new Set<string>(
  AGENT_SESSION_SORT_COLUMNS
);
const AGENT_SESSION_SORT_DIRS = ["asc", "desc"] as const;
const AGENT_SESSION_SORT_DIR_SET = new Set<string>(AGENT_SESSION_SORT_DIRS);

/** One validated rule of the ordered `sorts` list. */
export type AgentSessionSortRule = {
  column: AgentSessionSortColumn;
  dir: (typeof AGENT_SESSION_SORT_DIRS)[number];
};

/**
 * ISS-8335: the ORDERED sort rules the v2 toolbar can stack, one repeatable
 * `sorts=<column>:<dir>` entry per rule, in priority order.
 *
 * REJECTED, not dropped, when an entry is malformed or names a column/direction
 * outside the closed sets above — the same posture `quality` takes, and for the
 * same reason: an accept-and-drop rule is a toolbar row that renders as applied
 * while the order it asked for never happened, which is the whole defect this
 * param exists to close.
 *
 * Built by {@link queryArray} and NOT wrapped in a further `.transform`, which
 * would hand `repeatableQuerySchemas` a schema object the registered one is no
 * longer identical to — silently dropping `sorts` from
 * {@link AGENT_SESSION_REPEATABLE_QUERY_PARAM_NAMES} and so from the OpenAPI
 * drift guard's expectation. Per-column de-duplication belongs to
 * `resolveSessionSortRules`, which is the one place the applied rule list is
 * assembled.
 */
const agentSessionSortRulesQuerySchema = queryArray(
  z.string().transform((raw, ctx): AgentSessionSortRule => {
    const parts = parseSessionSortRule(raw);
    if (
      parts === null ||
      !AGENT_SESSION_SORT_COLUMN_SET.has(parts.column) ||
      !AGENT_SESSION_SORT_DIR_SET.has(parts.dir)
    ) {
      ctx.addIssue({
        code: "custom",
        message: `Invalid sort rule "${raw}" — expected <column>:<asc|desc>`,
      });
      return z.NEVER;
    }
    return {
      column: parts.column as AgentSessionSortColumn,
      dir: parts.dir as AgentSessionSortRule["dir"],
    };
  })
);

const baseAgentSessionQueryShape = {
  // ISS-12645: canonical component family applied before facets and pagination.
  componentSlug: z.string().trim().min(1).max(4096).optional(),
  startDate: isoDateQuerySchema.optional(),
  endDate: isoDateQuerySchema.optional(),
  // FEA-3009: completion-time lower bound (`sessionEndedAt >= completedAfter`),
  // distinct from the `startDate` window (which `findSessions` applies to
  // `lastActivityAt`). Backs the "sessions completed since I last opened Agents"
  // badge count. Rows with a null `sessionEndedAt` (still running) are excluded.
  completedAfter: isoDateQuerySchema.optional(),
  harness: optionalNonEmptyStringSchema,
  // Single-value `status`/`userId` stay for back-compat (e.g. the user-scoped
  // deep link); the array forms drive the multi-select Filter facets.
  status: optionalNonEmptyStringSchema,
  statuses: stringArrayQuerySchema,
  userId: optionalUuidSchema,
  userIds: uuidArrayQuerySchema,
  repositories: stringArrayQuerySchema,
  // Multi-select harness/model facets, plus autonomy-tier + cost-bucket ids.
  // Unknown tier/bucket ids are harmless — the service maps only the canonical
  // ids (see @repo/api/src/agent-session-filters) and ignores the rest.
  harnesses: stringArrayQuerySchema,
  models: stringArrayQuerySchema,
  autonomyTiers: stringArrayQuerySchema,
  costBuckets: stringArrayQuerySchema,
  // Change-presence ids ("has_changes"/"no_changes") and pull-request
  // association ids ("has_pr"/"no_pr"). Unknown ids are harmless — the service
  // maps only the canonical ids (see @repo/api/src/agent-session-filters).
  changePresence: stringArrayQuerySchema,
  prAssociation: stringArrayQuerySchema,
  // ISS-10332: priority members plus the unset token. A NEW facet with no
  // installed client, so an off-vocabulary value is REJECTED rather than
  // accepted-and-ignored the way the older id facets above are.
  priorities: queryArray(z.enum(PRIORITY_FILTER_VALUES)),
  // FEA-3284/FEA-3345/FEA-4145: the Substantive | Idle | All quality segment.
  // `substantive` excludes idle rows, `idle` isolates ONLY idle rows, `all`
  // shows both; absent resolves to the `all` fail-open default in `buildWhere`
  // (`DEFAULT_SESSION_QUALITY`) so ungated callers show every session. The
  // narrowing is applied to the list AND the usage/analytics/export aggregations
  // so counts stay consistent. An unsupported value is REJECTED here (z.enum)
  // rather than silently dropped, so the segment/query builder never disagree.
  quality: z.enum(SESSION_QUALITY_VALUES).optional(),
  // PRD-721: the toolbar's free-text term. Narrows the list read (`buildWhere`);
  // the usage aggregates are typed SQL with no search slot and ignore it.
  search: optionalNonEmptyStringSchema,
  viewerScope: z.enum(AGENT_SESSION_VIEWER_SCOPE_OPTIONS).optional(),
  teamId: optionalUuidSchema,
  projectId: optionalUuidSchema,
  // ISS-5355: multi-select Project facet. These are two DIFFERENT dimensions,
  // not two spellings of one — sending both ANDs them (see
  // `applyArtifactFacetFilters` in `query-builder.ts`):
  //   • `projectId` (above) sets `artifact.projectId` — "is the session's OWN
  //     artifact parented to this project?". Kept for the existing analytics
  //     scope callers. A synced SessionDetail artifact is created unparented, so
  //     this is null for essentially every desktop-synced session.
  //   • `projectIds` (here) walks `artifact.sourceLinks` to the session's linked
  //     DOCUMENTS — "did this session touch an artifact IN this project?", the
  //     same edge the detail view renders as "linked artifacts" (ISS-5236).
  // The facet sends `projectIds`; a client that sends `projectId` instead gets a
  // different (and, for synced sessions, empty) row set.
  projectIds: uuidArrayQuerySchema,
  // ISS-9477: the canonical filter/sort expression (ISS-9476), JSON text. It
  // never reaches a service: the first preprocess step lowers it to the legacy
  // params above (`list-query-param.ts`), so both spellings meet one schema and
  // one predicate set.
  [LIST_QUERY_EXPRESSION_PARAM]: z.string().optional(),
} as const;

const rawBaseAgentSessionQuerySchema = z
  .object(baseAgentSessionQueryShape)
  .strict();
const rawAgentSessionListQuerySchema = rawBaseAgentSessionQuerySchema.extend({
  // ISS-9692: the cap is the shared `SESSION_LIST_MAX_LIMIT`, derived from the
  // largest rung the rows-per-page ladder offers. It was a bare `100` here and
  // a second bare `100` in the service, so the ladder could grow past what this
  // schema admits and 400 the request before the service's clamp ever ran.
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(SESSION_LIST_MAX_LIMIT)
    .optional(),
  offset: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(SESSION_LIST_MAX_OFFSET)
    .optional(),
  sortBy: z.enum(AGENT_SESSION_SORT_COLUMNS).optional(),
  sortDir: z.enum(AGENT_SESSION_SORT_DIRS).optional(),
  // ISS-8335: the ordered multi-rule spelling of the same axis. See
  // `agentSessionSortRulesQuerySchema`; `resolveSessionSortRules` decides which
  // spelling a given request is speaking.
  sorts: agentSessionSortRulesQuerySchema,
});
// ISS-5809: the period-over-period comparison opt-in is modeled ONLY on the usage
// read. The list, analytics and export routes share the base shape above and have
// no comparison to compute, so accepting the param there would be an
// accept-and-drop filter — rejected by validation instead (AGENTS.md: "API query
// schemas must only accept filters that are implemented by the route's downstream
// predicates or service").
const rawAgentSessionUsageQuerySchema = rawBaseAgentSessionQuerySchema.extend({
  comparison: z.enum(AGENT_SESSION_COMPARISON_MODES).optional(),
  attribution: z.enum(AGENT_SESSION_USAGE_ATTRIBUTION_OPTIONS).optional(),
});
const legacyTeamIdQueryPreprocessor = z
  .object({
    viewerScope: z.enum(AGENT_SESSION_VIEWER_SCOPE_OPTIONS).optional(),
    teamId: optionalUuidSchema,
  })
  .passthrough();

export const baseAgentSessionQuerySchema = sessionReadQuerySchema(
  rawBaseAgentSessionQuerySchema
);

export const agentSessionListQuerySchema = sessionReadQuerySchema(
  rawAgentSessionListQuerySchema
);

export const agentSessionUsageQuerySchema = sessionReadQuerySchema(
  rawAgentSessionUsageQuerySchema
);

/**
 * The status params `GET /agent-sessions/status-counts` REFUSES, named once.
 *
 * {@link refineStatusCountsQuery} iterates this to raise the 400, and the drift
 * guard in `apps/api/__tests__/unit/openapi-agent-sessions-status-counts.test.ts`
 * takes it as the set the published spec must NOT document as accepted. Two
 * copies of that list would let the refusal and the documentation disagree
 * about which params are refused, which is the drift the guard exists to stop.
 */
export const AGENT_SESSION_STATUS_COUNTS_REJECTED_QUERY_PARAM_NAMES = [
  "status",
  "statuses",
] as const;

/**
 * ISS-8858: the status-counts read. The base shape MINUS a status facet — it
 * answers for every displayed status at once, so there is nothing for a status
 * selection to select; applying one would zero every bucket the caller did not
 * name, which is the one-way-door collapse `facet-count-where.ts` describes.
 *
 * REJECTED rather than accepted-and-dropped, per the rule the sibling
 * `comparison` param is held to above: a query schema must only accept filters
 * the route's downstream predicate actually implements.
 *
 * The base shape also carries no `limit`/`offset`, which is the point of the
 * endpoint — on the list read `limit` bounds the rows RETURNED and never the
 * work done to build them, so a caller counting statuses through
 * `?statuses=…&limit=1` paid the whole projection once per status.
 */
export const agentSessionStatusCountsQuerySchema = sessionReadQuerySchema(
  rawBaseAgentSessionQuerySchema,
  AGENT_SESSION_STATUS_COUNTS_REJECTED_QUERY_PARAM_NAMES
).superRefine(refineStatusCountsQuery);

// ISS-9477: without `listQuery`, which the first preprocess step lowers and
// removes, so no parsed query ever carries it to a service.
export type AgentSessionListQuery = Omit<
  z.infer<typeof agentSessionListQuerySchema>,
  typeof LIST_QUERY_EXPRESSION_PARAM
>;
// The usage query is the base shape PLUS the comparison opt-in. The
// analytics/export routes still parse with `baseAgentSessionQuerySchema`, whose
// narrower result stays assignable to this because `comparison` is optional.
export type AgentSessionUsageQuery = Omit<
  z.infer<typeof agentSessionUsageQuerySchema>,
  typeof LIST_QUERY_EXPRESSION_PARAM
>;

function applyLegacyTeamIdScope(value: unknown): unknown {
  const parsed = legacyTeamIdQueryPreprocessor.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.teamId === undefined ||
    parsed.data.viewerScope !== undefined
  ) {
    return value;
  }
  return { ...parsed.data, viewerScope: AgentSessionViewerScope.Team };
}

function refineTeamScopeQuery(
  params: {
    viewerScope?: AgentSessionViewerScope;
    teamId?: string;
  },
  ctx: z.RefinementCtx
): void {
  if (
    params.viewerScope === AgentSessionViewerScope.Team &&
    params.teamId === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      message: "teamId is required when viewerScope is team",
      path: ["teamId"],
    });
  }
  if (
    params.viewerScope !== AgentSessionViewerScope.Team &&
    params.teamId !== undefined
  ) {
    ctx.addIssue({
      code: "custom",
      message: "teamId requires viewerScope team",
      path: ["teamId"],
    });
  }
}

function refineStatusCountsQuery(
  params: Record<string, unknown>,
  ctx: z.RefinementCtx
): void {
  for (const name of AGENT_SESSION_STATUS_COUNTS_REJECTED_QUERY_PARAM_NAMES) {
    const value = params[name];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    ctx.addIssue({
      code: "custom",
      message:
        "status filters are not accepted here — this endpoint counts every displayed status",
      path: [name],
    });
  }
}

/**
 * ISS-6039: the exact query params `GET /agent-sessions` accepts, derived from
 * the schema rather than hand-listed. The published REST reference
 * (`apps/web/content/docs/api-reference/openapi.json`) documents this endpoint
 * by hand, and every array facet above was missing from it — a client generated
 * from the spec could reach only the single-value back-compat spellings. The
 * drift guard in `apps/api/__tests__/unit/openapi-agent-sessions-params.test.ts`
 * compares this list against the spec so a newly added facet fails a test
 * instead of silently vanishing from the public contract.
 */
export const AGENT_SESSION_LIST_QUERY_PARAM_NAMES = Object.keys(
  rawAgentSessionListQuerySchema.shape
);

/**
 * ISS-8858 (davetho, PR #6485): the exact query params
 * `GET /agent-sessions/status-counts` accepts — the base shape minus the status
 * facet it refuses — derived from the schema rather than hand-listed, for the
 * same reason {@link AGENT_SESSION_LIST_QUERY_PARAM_NAMES} is. The counts route
 * additionally takes none of the list's paging or sort params, which is
 * expressed by deriving from the BASE shape rather than the list one.
 */
export const AGENT_SESSION_STATUS_COUNTS_QUERY_PARAM_NAMES = Object.keys(
  rawBaseAgentSessionQuerySchema.shape
).filter(
  (name) =>
    !(
      AGENT_SESSION_STATUS_COUNTS_REJECTED_QUERY_PARAM_NAMES as readonly string[]
    ).includes(name)
);

/**
 * ISS-6039: the repeatable subset of {@link AGENT_SESSION_LIST_QUERY_PARAM_NAMES}
 * — the facets built by `queryArray`, which accept the param once per value.
 * Membership is recorded by `queryArray` at construction, so a new facet joins
 * by building one and cannot be forgotten here.
 *
 * This exists so the drift guard can take its expectation from the validator
 * instead of from the spec it is checking. Deriving multiplicity from
 * openapi.json (`schema.type === "array"`) lets a facet that is wrongly
 * documented as a scalar drop out of its own expectation, and the check then
 * passes vacuously on the very defect it is meant to catch.
 */
export const AGENT_SESSION_REPEATABLE_QUERY_PARAM_NAMES = Object.entries(
  rawAgentSessionListQuerySchema.shape
)
  .filter(([, schema]) => repeatableQuerySchemas.has(schema))
  .map(([name]) => name);

/**
 * ISS-8648 / ISS-8649: the Sessions WRITE boundary.
 *
 * `z.enum(SESSION_STATUS)` is the whole status guard, and it is derived rather
 * than listed: only the three LIFECYCLE values pass, so the display-only
 * spellings a read projects (`waiting`, `unknown`, `stale`) are rejected here
 * with no fold. Deriving it also means a future member of the lifecycle set
 * joins these endpoints without a second edit, and cannot silently disagree
 * with the set.
 *
 * None of these objects is `.strict()`, deliberately. Zod strips unknown keys,
 * which is the version-skew-safe reading of a body from a newer client: an
 * unrecognized field is ignored rather than rejecting the whole request. The
 * `satisfies Record<keyof …>` guard on each shape is what stops that leniency
 * from hiding a field the CONTRACT declares and the validator forgot — such a
 * field would otherwise be stripped before the service ever saw it.
 */
const sessionStatusWriteSchema = z.enum(SESSION_STATUS);

const agentSessionCreateShape = {
  computeTargetId: z.uuid("Must be a valid UUID"),
  // NO upper bound, matching the desktop ingest's own schema
  // (`desktop-agent-sessions-schema.ts`, `z.string().trim().min(1)`). The
  // index-key contract puts that limit at the WRITE, not at the wire: the
  // service projects an over-long id down to `INDEX_KEY_MAX_BYTES` before it
  // reaches the column. A wire cap here would reject exactly the ids ingest
  // accepts-and-projects, so a create could not pre-register those sessions —
  // and it would restate `INDEX_KEY_MAX_BYTES` in the wrong unit besides
  // (that bound is BYTES; `.max()` counts characters).
  externalSessionId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(500).optional(),
  status: sessionStatusWriteSchema.optional(),
  projectId: z.uuid("Must be a valid UUID").nullable().optional(),
  ownerUserId: z.uuid("Must be a valid UUID").nullable().optional(),
  harness: z.string().trim().min(1).max(100).optional(),
  repositoryFullName: z.string().trim().min(1).max(500).nullable().optional(),
  startedAt: isoDateQuerySchema.optional(),
} satisfies Record<keyof AgentSessionCreateRequest, z.ZodTypeAny>;

export const agentSessionCreateBodySchema = z.object(agentSessionCreateShape);

const agentSessionUpdateShape = {
  // ISS-8733: bounded by the SHARED ceiling rather than the create path's 500,
  // because this field no longer writes the same column. A rename lands on
  // `session_detail.name_override`, which also rides the desktop sync payload,
  // and that boundary TRUNCATES at `AGENT_SESSION_NAME_MAX_CHARS` — so a longer
  // name accepted here would be silently shortened by the next device sync.
  name: z.string().trim().min(1).max(AGENT_SESSION_NAME_MAX_CHARS).optional(),
  status: sessionStatusWriteSchema.optional(),
  // Nullable AND optional: absent leaves the stored value alone, `null` clears
  // the assignment. Collapsing the two would make "unassign" unexpressible.
  projectId: z.uuid("Must be a valid UUID").nullable().optional(),
  ownerUserId: z.uuid("Must be a valid UUID").nullable().optional(),
  priority: z.enum(Priority).nullable().optional(),
  expectedPriority: z.enum(Priority).nullable().optional(),
  // ISS-9486: NOT trimmed, bounded, or sanitized like `name`. It must equal the
  // rendered name byte for byte, and a collector-derived or created name is not
  // held to the rename ceiling, so bounding it like `name` would make such a
  // session impossible to rename under a guard. The body byte cap bounds it.
  expectedName: z.string().optional(),
  expectedStatus: sessionStatusWriteSchema.optional(),
  expectedProjectId: z.uuid("Must be a valid UUID").nullable().optional(),
  expectedOwnerUserId: z.uuid("Must be a valid UUID").nullable().optional(),
  surface: optionalSingleArtifactEditSurface,
} satisfies Record<keyof AgentSessionUpdateRequest, z.ZodTypeAny>;

export const agentSessionUpdateBodySchema = z.object(agentSessionUpdateShape);

const agentSessionBulkAssignShape = {
  // Bounded at BOTH ends by rejection rather than clamping: an empty set is a
  // caller bug, and a set over the cap is refused whole because silently
  // assigning a prefix would leave the grid reporting a bulk edit that only
  // partly happened.
  sessionIds: z
    .array(z.uuid("Must be a valid UUID"))
    .min(1, "At least one session ID required")
    .max(AGENT_SESSION_BULK_ASSIGN_MAX_IDS),
  field: z.enum(AgentSessionBulkAssignField),
  value: z.uuid("Must be a valid UUID").nullable(),
} satisfies Record<keyof AgentSessionBulkAssignRequest, z.ZodTypeAny>;

export const agentSessionBulkAssignBodySchema = z.object(
  agentSessionBulkAssignShape
);

const SANITIZED_UPDATE_TEXT_FIELDS = sanitizedTextFields({
  name: true,
  status: false,
  projectId: false,
  ownerUserId: false,
  priority: false,
  expectedPriority: false,
  expectedName: false,
  expectedStatus: false,
  expectedProjectId: false,
  expectedOwnerUserId: false,
  surface: false,
} satisfies Record<keyof AgentSessionUpdateRequest, boolean>);

/**
 * ISS-8717 review (tamsinb) — the write that made {@link sanitizeTextFields}
 * load-bearing: `{"name":"a\\u0000b"}` cleared the schema and then failed at the
 * `text` column (SQLSTATE 22021) as a 500, an input error reported as a server
 * fault.
 *
 * The unwrapped schema stays exported because `.shape` is what the OpenAPI
 * drift guard reads; a preprocessed one has none.
 */
export const sanitizedAgentSessionUpdateBodySchema = sanitizeTextFields(
  agentSessionUpdateBodySchema,
  SANITIZED_UPDATE_TEXT_FIELDS
);

const SANITIZED_CREATE_TEXT_FIELDS = sanitizedTextFields({
  computeTargetId: false,
  externalSessionId: true,
  name: true,
  status: false,
  projectId: false,
  ownerUserId: false,
  harness: true,
  repositoryFullName: true,
  startedAt: false,
} satisfies Record<keyof AgentSessionCreateRequest, boolean>);

/**
 * ISS-9073 §5: the create path was the one write on this resource that did not
 * sanitize, so a NUL in `externalSessionId` cleared `z.string().trim().min(1)`
 * and died at the `text` column (SQLSTATE 22021) as a 500. `externalSessionId`
 * is sanitized rather than rejected so the key this route pre-registers equals
 * the one the desktop ingest stores for the same run.
 */
export const sanitizedAgentSessionCreateBodySchema = sanitizeTextFields(
  agentSessionCreateBodySchema,
  SANITIZED_CREATE_TEXT_FIELDS
);

/**
 * ISS-9857: the position a prior `GET /agent-sessions/[id]/events` page ended
 * on, decoded HERE so a token this endpoint did not mint is a clean 400. The
 * codec only proves the token round-trips; the timestamp inside it is checked
 * separately, because a well-formed token carrying an unparsable `createdAt`
 * would otherwise reach Prisma as `new Date(NaN)` and answer 500 — and so
 * would one below the Postgres floor, which `new Date` accepts and the
 * `timestamp(3)` predicate then refuses (the same floor `isoDateQuerySchema`
 * holds the list's date window to). ISS-10436: `externalEventId` is compared
 * as `text`, so a NUL inside it is refused here too (SQLSTATE 22021 otherwise);
 * `createdAt` needs no such check because the service converts it with
 * `new Date` before it reaches Postgres.
 */
const sessionEventsPageCursorParam = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    const cursor = decodeSessionEventCursor(value);
    const instant = cursor ? Date.parse(cursor.createdAt) : Number.NaN;
    if (
      cursor &&
      Number.isFinite(instant) &&
      !isBelowPgTimestampFloor(instant) &&
      !containsNulCharacter(cursor.externalEventId)
    ) {
      return cursor;
    }
    ctx.addIssue({
      code: "custom",
      message: SESSION_EVENTS_CURSOR_REJECTION,
    });
    return z.NEVER;
  });

/**
 * Query params for `GET /agent-sessions/[id]/events`. `limit` is parsed here
 * and CLAMPED by the service (`clampPageLimit`), so an out-of-range value is a
 * bounded page rather than a 400 — but a blank `?limit=` is a 400, because
 * `pageBoundValidator` refuses a present-but-empty bound. `.strict()` like the
 * list's query schema: a misspelled parameter (`?limti=`) is a 400, not a
 * silently default-sized page.
 */
export const agentSessionEventsPageQuerySchema = z
  .object({
    cursor: sessionEventsPageCursorParam.optional(),
    limit: pageBoundValidator,
  })
  .strict();

export type AgentSessionEventsPageQuery = z.infer<
  typeof agentSessionEventsPageQuerySchema
>;

/**
 * ISS-10737: the session invocation-tree page query.
 *
 * The cursor is DECODED HERE, exactly as its `events` sibling is, so a token
 * this endpoint did not mint is a clean 400. Left to the service it was a thrown
 * `Error`, which the route's catch answered 500 — `?cursor=garbage` then reached
 * the error monitors as a server failure for what is a client mistake. A
 * present-but-blank `?cursor=` is refused on the same path rather than silently
 * restarting the walk at the head, which is how a walking caller never
 * terminates.
 *
 * The decoded value is discarded and the raw token passed on: the service owns
 * one decode of its own, which is the precondition that also holds for the
 * desktop-local producer.
 *
 * ISS-11195: shape is not enough. A token can decode cleanly and still carry a
 * value its column refuses, so the domain is checked here too — see
 * {@link isQueryableInvocationTreeCursor}.
 */
export const agentSessionInvocationTreeQuerySchema = z
  .object({
    cursor: z
      .string()
      .trim()
      .min(1)
      .superRefine((value, ctx) => {
        if (!isQueryableInvocationTreeCursor(value)) {
          ctx.addIssue({
            code: "custom",
            message: SESSION_INVOCATION_TREE_CURSOR_REJECTION,
          });
        }
      })
      .optional(),
  })
  .strict();

export const SESSION_INVOCATION_TREE_CURSOR_REJECTION =
  "must be a nextCursor returned by this endpoint";

export type AgentSessionInvocationTreeQuery = z.infer<
  typeof agentSessionInvocationTreeQuerySchema
>;

export const SESSION_EVENTS_CURSOR_REJECTION =
  "must be a nextCursor returned by this endpoint";

/**
 * ISS-11195: the cloud read binds the cursor against `id @db.Uuid`,
 * `sequence Int` and `external_invocation_id text`, and Postgres raises (22P02,
 * 22003, 22021) on a value outside any of them. The shared decoder stays
 * shape-only because the desktop reader is SQLite, where none of the three
 * raises. Every producer-minted cursor passes: the id is a stored uuid, and
 * the sequence was bounded to int4 by the ingest wire schema.
 */
function isQueryableInvocationTreeCursor(value: string): boolean {
  const cursor = decodeAgentComponentInvocationSessionTreeCursor(value);
  return (
    cursor !== null &&
    isUuid(cursor.id) &&
    isStorableInt4Count(cursor.sequence) &&
    !containsNulCharacter(cursor.externalInvocationId)
  );
}

/**
 * One Sessions read schema: lower `listQuery` first (ISS-9477), then the
 * legacy `teamId` scope fill, then the strict shape, then the team-scope rule.
 * Lowering runs before every superRefine, so a value that arrives through the
 * expression is judged by the same rules as one sent as a legacy param.
 */
function sessionReadQuerySchema<TShape extends z.ZodRawShape>(
  raw: z.ZodObject<TShape>,
  refusedParams: readonly string[] = []
) {
  const lowerListQuery = createListQueryPreprocess(
    listQueryTarget(raw.shape, refusedParams)
  );
  return z
    .preprocess(
      (value, ctx) => applyLegacyTeamIdScope(lowerListQuery(value, ctx)),
      raw
    )
    .superRefine(refineTeamScopeQuery);
}

/**
 * `refusedParams` are in the shape but refused by a superRefine
 * (status-counts). Leaving them out of `acceptedParams` makes a clause that
 * lowers to one a `list_query_field_unsupported` refusal naming the field,
 * instead of a code-less 400 on a param the caller never sent.
 */
function listQueryTarget(
  shape: z.ZodRawShape,
  refusedParams: readonly string[]
): ListQueryRequestTarget {
  return {
    acceptedParams: new Set(
      Object.keys(shape).filter((name) => !refusedParams.includes(name))
    ),
    repeatableParams: new Set(
      Object.entries(shape)
        .filter(([, schema]) => repeatableQuerySchemas.has(schema))
        .map(([name]) => name)
    ),
    listParamNames: new Set(Object.keys(rawAgentSessionListQuerySchema.shape)),
  };
}
