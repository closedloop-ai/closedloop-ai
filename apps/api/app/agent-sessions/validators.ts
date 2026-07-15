import {
  AGENT_SESSION_VIEWER_SCOPE_OPTIONS,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { z } from "zod";

const isoDateQuerySchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid date");

const optionalNonEmptyStringSchema = z.string().trim().min(1).optional();
const optionalUuidSchema = z.string().uuid("Must be a valid UUID").optional();

// Repeated query params arrive from `parseQueryParams` as a string (one value)
// or string[] (many). Normalize both to an array so multi-select facets work
// regardless of how many values were selected.
function queryArray<T extends z.ZodTypeAny>(element: T) {
  return z
    .preprocess((value) => {
      if (value === undefined) {
        return undefined;
      }
      return Array.isArray(value) ? value : [value];
    }, z.array(element))
    .optional();
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
  "lastActivity",
] as const;

const baseAgentSessionQueryShape = {
  startDate: isoDateQuerySchema.optional(),
  endDate: isoDateQuerySchema.optional(),
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
  viewerScope: z.enum(AGENT_SESSION_VIEWER_SCOPE_OPTIONS).optional(),
  teamId: optionalUuidSchema,
  projectId: optionalUuidSchema,
} as const;

const rawBaseAgentSessionQuerySchema = z.object(baseAgentSessionQueryShape);
const rawAgentSessionListQuerySchema = rawBaseAgentSessionQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  sortBy: z.enum(AGENT_SESSION_SORT_COLUMNS).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
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

export type AgentSessionListQuery = z.infer<typeof agentSessionListQuerySchema>;
export type AgentSessionUsageQuery = z.infer<
  typeof baseAgentSessionQuerySchema
>;
export type AgentSessionSortColumn =
  (typeof AGENT_SESSION_SORT_COLUMNS)[number];

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
