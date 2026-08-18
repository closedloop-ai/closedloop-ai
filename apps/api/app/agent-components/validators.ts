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

const agentComponentListQueryFields = z.object({
  kinds: queryArray(
    z.enum(Object.values(AgentComponentKind) as [string, ...string[]])
  ),
  // FEA-4098 (Slice 3): filter by a collaborator (author) display name, matched
  // against the component's `DefinitionVersionEditor` authors set. Replaces the
  // old single-`owner` filter.
  collaborator: z.string().trim().min(1).optional(),
  // ISS-4942 (wongk): the compatibility alias for the pre-FEA-4098 `?owner=`
  // filter. This object is not `.strict()`, so before this an unknown `owner`
  // was stripped and the filter silently returned the UNFILTERED inventory —
  // and a version-skewed deploy makes that reachable in both directions (the
  // API can advance ahead of the MCP image, or Vercel can stay advanced after
  // an ECS failure), so a still-deployed old MCP keeps sending `owner`.
  // Normalized onto `collaborator` in the transform below; `collaborator` wins
  // when both are supplied. Deliberately NOT `.min(1)`: an old client is
  // already able to send a blank `?owner=`, which used to be ignored, so
  // rejecting it now would turn a stale-client no-op into a 400. Blank is
  // treated as unset instead.
  owner: z.string().optional(),
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

/**
 * ISS-4942: resolve the deprecated `owner` alias onto `collaborator` at the
 * validator boundary so the service only ever sees the canonical filter name,
 * and drop `owner` from the parsed params so no downstream predicate can read a
 * second, stale spelling of the same filter.
 */
export const agentComponentListQuerySchema =
  agentComponentListQueryFields.transform(({ owner, ...query }) => {
    const collaborator = query.collaborator ?? owner?.trim();
    // Spread conditionally so `collaborator` stays an OPTIONAL key: emitting it
    // unconditionally as `string | undefined` would make every caller
    // constructing an `AgentComponentListQuery` literal have to pass it.
    return { ...query, ...(collaborator ? { collaborator } : {}) };
  });

export type AgentComponentListQuery = z.infer<
  typeof agentComponentListQuerySchema
>;

// ---------------------------------------------------------------------------
// FEA-3704: source-occurrences read (GET /agent-components/source-occurrences)
// ---------------------------------------------------------------------------

/** Default page size for the org-scoped source-occurrence read. */
export const SOURCE_OCCURRENCE_DEFAULT_LIMIT = 50;
/**
 * Hard upper bound on one occurrence page. A single exact `DefinitionVersion`
 * has a bounded provenance set (one row per proven location); 200 comfortably
 * exceeds any realistic version's occurrence count while keeping the payload
 * bounded — the same cap the pre-route service read used (`take = 200`).
 */
export const SOURCE_OCCURRENCE_MAX_LIMIT = 200;

/**
 * Query schema for the org-scoped source-occurrence read. `definitionVersionId`
 * is required (the exact `DefinitionVersion` whose provenance is requested);
 * `limit`/`offset` paginate. Org-scoping is enforced from the auth context in
 * the route/service, NOT from any client-supplied value.
 */
export const sourceOccurrenceQuerySchema = z.object({
  definitionVersionId: z.string().trim().uuid(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SOURCE_OCCURRENCE_MAX_LIMIT)
    .default(SOURCE_OCCURRENCE_DEFAULT_LIMIT),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export type SourceOccurrenceQuery = z.infer<typeof sourceOccurrenceQuerySchema>;
