import {
  AGENT_COMPONENT_INVENTORY_CAP,
  AgentComponentKind,
  AgentComponentSortDir,
  AgentComponentSortKey,
} from "@repo/api/src/types/agent-component";
import { z } from "zod";

export const AGENT_COMPONENT_LIST_DEFAULT_LIMIT = 50;
/**
 * Upper bound a caller may request in one page. This is the shared
 * `AGENT_COMPONENT_INVENTORY_CAP` (5000) — the same value as the service-side
 * `MAX_ORG_INVENTORY_ROWS` DB read cap: the org inventory is a bounded set the
 * service never returns more than that many rows for, so allowing a single
 * full-inventory fetch exposes no additional data — it just lets the Agents
 * workspace pull the whole set and do its filtering / grouping / pagination /
 * summary client-side (the surface is entirely client-side; a lower cap
 * silently truncated the list to 50 and made the summary cards undercount).
 */
export const AGENT_COMPONENT_LIST_MAX_LIMIT = AGENT_COMPONENT_INVENTORY_CAP;

/**
 * Normalize a repeated query param: `parseQueryParams` gives a string for
 * one value or string[] for multiple. We always want an array.
 */
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

/**
 * Permissive date-string schema mirroring the sibling agent-sessions endpoint
 * (`isoDateQuerySchema` in `../agent-sessions/validators.ts`): accepts both a
 * full ISO datetime (`2026-07-14T00:00:00Z`) and a bare calendar date
 * (`2026-07-14`) via `Date.parse`, instead of the strict `z.string().datetime()`
 * that rejected the bare-date form the Agents workspace's date control emits.
 */
const isoDateQuerySchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid date");

export const agentComponentListQuerySchema = z.object({
  kinds: queryArray(
    z.enum(Object.values(AgentComponentKind) as [string, ...string[]])
  ),
  owner: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1).optional(),
  harness: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(AGENT_COMPONENT_LIST_MAX_LIMIT)
    .default(AGENT_COMPONENT_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().nonnegative().default(0),
  // FEA-3160: inclusive lower bound for the USAGE time window (30/60/90-day
  // control on the Agents workspace). Scopes usage aggregation to
  // `AgentComponentSessionUsage.lastInvokedAt >= startDate` server-side.
  startDate: isoDateQuerySchema.optional(),
  // FEA-3178: inclusive UPPER bound for the USAGE time window, on the SAME
  // `lastInvokedAt` basis as `startDate`. Scopes usage aggregation to
  // `AgentComponentSessionUsage.lastInvokedAt <= endDate` server-side. Absent ⇒
  // unbounded above (unchanged behavior). Used to fetch the PRECEDING
  // equivalent window (`startDate = prevStart`, `endDate = prevEnd`) for the
  // period-over-period delta on the summary cards.
  endDate: isoDateQuerySchema.optional(),
  sortBy: z
    .enum(Object.values(AgentComponentSortKey) as [string, ...string[]])
    .optional(),
  sortDir: z
    .enum(Object.values(AgentComponentSortDir) as [string, ...string[]])
    .optional(),
});

export type AgentComponentListQuery = z.infer<
  typeof agentComponentListQuerySchema
>;
