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

export const baseAgentSessionQuerySchema = z.object({
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
  teamId: optionalUuidSchema,
  projectId: optionalUuidSchema,
});

export const agentSessionListQuerySchema = baseAgentSessionQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  sortBy: z.enum(AGENT_SESSION_SORT_COLUMNS).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

export type AgentSessionListQuery = z.infer<typeof agentSessionListQuerySchema>;
export type AgentSessionUsageQuery = z.infer<
  typeof baseAgentSessionQuerySchema
>;
export type AgentSessionSortColumn =
  (typeof AGENT_SESSION_SORT_COLUMNS)[number];
