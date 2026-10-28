import {
  AGENT_COMPONENT_INVENTORY_CAP,
  AgentComponentKind,
  AgentComponentSortDir,
  AgentComponentSortKey,
  Harness,
} from "@repo/api/src/types/agent-component";
import {
  AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES,
  AGENT_COMPONENT_PAGE_SIZE,
  hasCompletePriorWindow,
  isUsableUsageBound,
  PRIOR_WINDOW_INCOMPLETE_MESSAGE,
  USAGE_BOUND_INVALID_MESSAGE,
} from "@repo/api/src/utils/agent-component-page-data";
import { z } from "zod";
import { repeatedQueryArrayOrEmpty } from "@/lib/repeated-query-array";

/**
 * ISS-6822 — query contract for `GET /agent-components/page-data`.
 *
 * Deliberately NOT an extension of the list endpoint's schema. The list
 * endpoint's `collaborator` / `source` / `harness` are SINGLE server-side
 * narrowings applied before its own paging; the Agents workspace's facets are
 * MULTI-select client state with union semantics (`harnessMatchesFacet` folds a
 * `Harness.Both` row into every individual harness). Reusing the singular names
 * would let a caller believe one meant the other.
 *
 * The two boolean gates are part of the contract because they change the
 * NUMBERS, not just the rendering — see `AgentComponentPageDataQuery`.
 */

/**
 * Default rows per page — the shared `AGENT_COMPONENT_PAGE_SIZE`, which the
 * workspace's own `AGENTS_PAGE_SIZE` also aliases, so a caller that omits
 * `pageSize` gets the page the surface would have asked for.
 */
export const AGENT_COMPONENT_PAGE_DATA_DEFAULT_PAGE_SIZE =
  AGENT_COMPONENT_PAGE_SIZE;

/**
 * Upper bound on one requested page. The inventory cap, so a caller may still
 * ask for the whole bounded population in one page (the pre-ISS-6822 behavior)
 * and this endpoint never exposes more rows than the list endpoint already
 * would.
 */
export const AGENT_COMPONENT_PAGE_DATA_MAX_PAGE_SIZE =
  AGENT_COMPONENT_INVENTORY_CAP;

/**
 * Every facet here is "unnarrowed" when absent, so it takes the `[]`-default
 * spelling of the shared repeated-param helper, which also owns the
 * de-duplication (ISS-7271) and the cap (ISS-9073): the open-valued
 * `collaborators` / `sources` narrow in memory at O(rows × N) in
 * `filterAgentComponentRows`, so an unbounded facet has no bind budget to
 * refuse it.
 */
function facetArray<T extends z.ZodTypeAny>(element: T) {
  return repeatedQueryArrayOrEmpty(
    element,
    AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES
  );
}

/**
 * A closed-by-default UI gate, as it arrives on a query string.
 *
 * Query params are strings, so `"false"` is truthy and `z.coerce.boolean()`
 * would read every explicitly-disabled gate as ENABLED — flipping both gates
 * open for exactly the callers that spelled out their intent to keep them shut.
 * Only the literal `"true"` enables.
 *
 * Deliberately NOT `z.enum(["true", "false"])`: rejecting anything else would
 * turn a version-skewed client that spells a flag `1` or `on` into a 400 and a
 * blank Agents list. An unrecognized spelling is not a request to open a
 * closed-by-default gate, so it degrades to CLOSED — the safe direction — rather
 * than failing the whole read.
 */
const flagSchema = z
  .string()
  .default("false")
  .transform((value) => value === "true");

/**
 * Permissive date-string schema, matching the sibling list endpoint: accepts
 * both a full ISO datetime and a bare calendar date via `Date.parse`.
 *
 * The predicate is the shared `isUsableUsageBound`, not a local copy, so the
 * desktop IPC schema that guards the SAME window contract cannot drift from
 * this one — which it had, accepting any string.
 */
const isoDateQuerySchema = z
  .string()
  .refine(isUsableUsageBound, USAGE_BOUND_INVALID_MESSAGE);

const agentComponentPageDataQueryFields = z.object({
  /** Inclusive lower bound of the CURRENT usage window; absent ⇒ all-time. */
  startDate: isoDateQuerySchema.optional(),
  /**
   * The PRECEDING equivalent window (FEA-3178). Both bounds or neither: a
   * half-specified prior window would silently compare the current window
   * against an unbounded population and report that as a period-over-period
   * change. Enforced by the refinement below.
   */
  prevStart: isoDateQuerySchema.optional(),
  prevEnd: isoDateQuerySchema.optional(),
  /**
   * ISS-6888: whether the caller wants the FEA-3202 unwindowed facet universe.
   *
   * Defaults OPEN, unlike the two gates below, and the asymmetry is the point:
   * absence here means "a client that predates the field", and this endpoint has
   * read the unwindowed universe whenever `startDate` was present since FEA-3202.
   * Defaulting closed would silently drop zero-count owner/source options for
   * every browser still running the previous bundle across a deploy. Only the
   * literal `"false"` withholds it, so an unrecognized spelling degrades to the
   * shipped behavior rather than to a quietly narrower facet menu.
   */
  unwindowedFacetUniverse: z
    .string()
    .optional()
    .transform((value) => value !== "false"),

  kinds: facetArray(
    z.enum(Object.values(AgentComponentKind) as [string, ...string[]])
  ),
  collaborators: facetArray(z.string()),
  sources: facetArray(z.string()),
  harnesses: facetArray(
    z.enum(Object.values(Harness) as [string, ...string[]])
  ),
  search: z.string().default(""),

  sortBy: z
    .enum(Object.values(AgentComponentSortKey) as [string, ...string[]])
    .default(AgentComponentSortKey.Name),
  sortDir: z
    .enum(Object.values(AgentComponentSortDir) as [string, ...string[]])
    .default(AgentComponentSortDir.Asc),

  page: z.coerce.number().int().nonnegative().default(0),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(AGENT_COMPONENT_PAGE_DATA_MAX_PAGE_SIZE)
    .default(AGENT_COMPONENT_PAGE_DATA_DEFAULT_PAGE_SIZE),

  honestSource: flagSchema,
  dedupePluginRollups: flagSchema,
});

/**
 * A prior window needs BOTH of its bounds or neither. `prevEnd` alone leaves the
 * baseline unbounded below (every component the org has ever had); `prevStart`
 * alone overlaps the current window. Either way the delta chip would report a
 * population difference as a usage change, so a half-specified window is
 * rejected rather than silently reduced against the wrong baseline.
 */
export const agentComponentPageDataQuerySchema =
  agentComponentPageDataQueryFields.refine(hasCompletePriorWindow, {
    message: PRIOR_WINDOW_INCOMPLETE_MESSAGE,
    path: ["prevStart"],
  });

export type AgentComponentPageDataQueryParams = z.infer<
  typeof agentComponentPageDataQuerySchema
>;
