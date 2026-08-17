/**
 * ISS-5283 (desktop half) — per-facet count scoping for the local usage summary.
 *
 * The cloud service does this in `apps/api/app/agent-sessions/service/
 * facet-count-where.ts`; this is the desktop twin, and the semantics are
 * deliberately identical because the SAME toolbar renders both:
 *
 *   **Each facet's option counts apply every OTHER active filter, but EXCLUDE
 *   that facet's own dimension.**
 *
 * Without it the desktop had the failure mode that file calls the WORSE of the
 * two: the usage half of the combined page read is scoped by the FULL filter set,
 * so selecting `Harness = Claude` would leave every other harness at 0 and the
 * facet would collapse to the value already chosen — a one-way door. (The
 * renderer previously dodged that by asking for a facet-UNFILTERED usage read,
 * which produced the OTHER failure: counts that describe the unfiltered corpus
 * while the table describes the filtered one.)
 *
 * ## Why it costs nothing on the common path
 *
 * A dimension carrying no active filter has a relaxed request identical to the
 * full one, so its breakdown is reused verbatim and NO extra read is issued. An
 * unfiltered Sessions view therefore performs exactly the reads it did before.
 * Only a dimension the user actually filtered on costs one additional
 * metadata-only aggregate (`getSharedAgentSessionUsage` prefers the SQL
 * COUNT/SUM/GROUP BY path — it never hydrates the corpus).
 *
 * ## What is deliberately NOT relaxed
 *
 * Only the facet's own selection is dropped. The date window, search, quality
 * segment, `userId`/`teamId`/`projectId` scope and every other facet stay, for
 * the same reason the cloud twin keeps them: they are AND constraints the facet
 * is not permitted to widen.
 */

import type {
  SharedAgentSessionsListRequest,
  SharedAgentSessionUsageSummary,
} from "../../shared/shared-agent-sessions-contract.js";

/** The Sessions facets whose option counts come from the usage summary. */
export const SessionFacetDimension = {
  Owner: "owner",
  Harness: "harness",
  Model: "model",
  Repository: "repository",
} as const;
export type SessionFacetDimension =
  (typeof SessionFacetDimension)[keyof typeof SessionFacetDimension];

/** Reads a usage summary for a request — `getSharedAgentSessionUsage`, injected. */
export type UsageReader = (
  request: SharedAgentSessionsListRequest
) => Promise<SharedAgentSessionUsageSummary>;

/**
 * True when the user has actually operated this facet. A facet nobody filtered
 * needs no exclusion, because there is nothing of its own to exclude.
 *
 * `harness` is checked alongside `harnesses` because the local query builder
 * still honors the legacy single-value field; excluding only the plural form
 * would leave a live harness predicate inside the Harness facet's own count.
 */
export function isFacetDimensionFiltered(
  request: SharedAgentSessionsListRequest,
  dimension: SessionFacetDimension
): boolean {
  if (dimension === SessionFacetDimension.Owner) {
    return (request.userIds?.length ?? 0) > 0;
  }
  if (dimension === SessionFacetDimension.Harness) {
    return (request.harnesses?.length ?? 0) > 0 || request.harness != null;
  }
  if (dimension === SessionFacetDimension.Model) {
    return (request.models?.length ?? 0) > 0;
  }
  return (request.repositories?.length ?? 0) > 0;
}

/** The caller's request with ONE dimension's facet selection removed. */
export function omitFacetDimension(
  request: SharedAgentSessionsListRequest,
  dimension: SessionFacetDimension
): SharedAgentSessionsListRequest {
  if (dimension === SessionFacetDimension.Owner) {
    // `userId` (the cross-surface scope) intentionally survives — see the
    // module doc and its cloud twin.
    return { ...request, userIds: undefined };
  }
  if (dimension === SessionFacetDimension.Harness) {
    return { ...request, harness: undefined, harnesses: undefined };
  }
  if (dimension === SessionFacetDimension.Model) {
    return { ...request, models: undefined };
  }
  return { ...request, repositories: undefined };
}

/**
 * Replace each FILTERED facet's breakdown in `usage` with the one that dimension
 * yields when its own selection is lifted. The summary TOTALS are untouched —
 * they describe the current view, exactly as the cloud twin leaves them.
 *
 * Returns `usage` by reference when nothing is filtered, so the common path
 * allocates nothing and issues no reads.
 */
export async function applyFacetScopedCounts(
  usage: SharedAgentSessionUsageSummary,
  request: SharedAgentSessionsListRequest,
  readUsage: UsageReader
): Promise<SharedAgentSessionUsageSummary> {
  const filtered = FACET_DIMENSIONS.filter((dimension) =>
    isFacetDimensionFiltered(request, dimension)
  );
  if (filtered.length === 0) {
    return usage;
  }
  const relaxed = await Promise.all(
    filtered.map(async (dimension) => {
      const summary = await readUsage(omitFacetDimension(request, dimension));
      return [dimension, summary] as const;
    })
  );
  const next = { ...usage };
  for (const [dimension, summary] of relaxed) {
    if (dimension === SessionFacetDimension.Owner) {
      next.byUser = summary.byUser;
    } else if (dimension === SessionFacetDimension.Harness) {
      next.byHarness = summary.byHarness;
    } else if (dimension === SessionFacetDimension.Model) {
      // FEA-4303: the Model FACET reads `modelFilterOptions` (primary-model
      // session counts), not `byModel` (which spans secondary/subagent models
      // and feeds the cost breakdown, a total that must keep describing the
      // current view).
      next.modelFilterOptions = summary.modelFilterOptions;
    } else {
      next.byRepository = summary.byRepository;
    }
  }
  return next;
}

const FACET_DIMENSIONS = [
  SessionFacetDimension.Owner,
  SessionFacetDimension.Harness,
  SessionFacetDimension.Model,
  SessionFacetDimension.Repository,
] as const;
