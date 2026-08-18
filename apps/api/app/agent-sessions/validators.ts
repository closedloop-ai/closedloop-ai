import { SESSION_QUALITY_VALUES } from "@repo/api/src/agent-session-filters";
import {
  AGENT_SESSION_VIEWER_SCOPE_OPTIONS,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { AGENT_SESSION_COMPARISON_MODES } from "@repo/api/src/types/agent-session-usage-comparison";
import { z } from "zod";

const isoDateQuerySchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid date");

const optionalNonEmptyStringSchema = z.string().trim().min(1).optional();
const optionalUuidSchema = z.string().uuid("Must be a valid UUID").optional();

// Every schema `queryArray` builds, recorded at construction so the repeatable
// facet set below cannot drift from the facets that actually exist.
const repeatableQuerySchemas = new Set<z.ZodTypeAny>();

// Repeated query params arrive from `parseQueryParams` as a string (one value)
// or string[] (many). Normalize both to an array so multi-select facets work
// regardless of how many values were selected.
function queryArray<T extends z.ZodTypeAny>(element: T) {
  const schema = z
    .preprocess((value) => {
      if (value === undefined) {
        return undefined;
      }
      return Array.isArray(value) ? value : [value];
    }, z.array(element))
    .optional();
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
  "duration",
  "cost",
  "started",
  // ISS-6005: record-mutation recency (the `Updated` column) — a display-value
  // sort resolved in memory; see `session-sort-order.ts` / `compareByRecordUpdatedAt`.
  "updated",
  "lastActivity",
] as const;

const baseAgentSessionQueryShape = {
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
  // FEA-3284/FEA-3345/FEA-4145: the Substantive | Idle | All quality segment.
  // `substantive` excludes idle rows, `idle` isolates ONLY idle rows, `all`
  // shows both; absent resolves to the `all` fail-open default in `buildWhere`
  // (`DEFAULT_SESSION_QUALITY`) so ungated callers show every session. The
  // narrowing is applied to the list AND the usage/analytics/export aggregations
  // so counts stay consistent. An unsupported value is REJECTED here (z.enum)
  // rather than silently dropped, so the segment/query builder never disagree.
  quality: z.enum(SESSION_QUALITY_VALUES).optional(),
  // Accepted for backward compatibility — version-skewed Desktop clients may
  // still serialize this field. Not implemented server-side (AGENTS.md L87-96).
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
} as const;

const rawBaseAgentSessionQuerySchema = z
  .object(baseAgentSessionQueryShape)
  .strict();
const rawAgentSessionListQuerySchema = rawBaseAgentSessionQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  sortBy: z.enum(AGENT_SESSION_SORT_COLUMNS).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});
// ISS-5809: the period-over-period comparison opt-in is modeled ONLY on the usage
// read. The list, analytics and export routes share the base shape above and have
// no comparison to compute, so accepting the param there would be an
// accept-and-drop filter — rejected by validation instead (AGENTS.md: "API query
// schemas must only accept filters that are implemented by the route's downstream
// predicates or service").
const rawAgentSessionUsageQuerySchema = rawBaseAgentSessionQuerySchema.extend({
  comparison: z.enum(AGENT_SESSION_COMPARISON_MODES).optional(),
});
const legacyTeamIdQueryPreprocessor = z
  .object({
    viewerScope: z.enum(AGENT_SESSION_VIEWER_SCOPE_OPTIONS).optional(),
    teamId: optionalUuidSchema,
  })
  .passthrough();

export const baseAgentSessionQuerySchema = z
  .preprocess(applyLegacyTeamIdScope, rawBaseAgentSessionQuerySchema)
  .superRefine(refineTeamScopeQuery);

export const agentSessionListQuerySchema = z
  .preprocess(applyLegacyTeamIdScope, rawAgentSessionListQuerySchema)
  .superRefine(refineTeamScopeQuery);

export const agentSessionUsageQuerySchema = z
  .preprocess(applyLegacyTeamIdScope, rawAgentSessionUsageQuerySchema)
  .superRefine(refineTeamScopeQuery);

export type AgentSessionListQuery = z.infer<typeof agentSessionListQuerySchema>;
// The usage query is the base shape PLUS the comparison opt-in. The
// analytics/export routes still parse with `baseAgentSessionQuerySchema`, whose
// narrower result stays assignable to this because `comparison` is optional.
export type AgentSessionUsageQuery = z.infer<
  typeof agentSessionUsageQuerySchema
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
