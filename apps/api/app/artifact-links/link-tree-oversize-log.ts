import "server-only";

import type {
  ArtifactLink,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/artifact";
import { log } from "@repo/observability/log";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";

/** Structured event name for the oversize-traversal record (root `AGENTS.md`). */
const OVERSIZE_LINK_TREE_EVENT = "artifact_link_tree_oversize";

/**
 * Aggregate rollup for occurrences the per-org budget suppressed. A separate
 * event name rather than a field on the detail record, so a monitor counting
 * detail records is never inflated by a rollup that stands for many.
 */
const OVERSIZE_LINK_TREE_SUPPRESSED_EVENT =
  "artifact_link_tree_oversize_suppressed";

/**
 * Links in one traversal above which the request is reported.
 *
 * Measured, not guessed: on a seeded graph the pre-fix shape held 194 MB of JS
 * heap for 10,025 links and 487 MB for 42,060, against a 2,048 MB ceiling, and
 * the production requests that were killed had walked 9,875 and 14,776 nodes.
 * 5,000 sits an order of magnitude above any healthy tree — the product
 * surfaces that call tree mode render a document's own lineage — and far enough
 * below the danger zone that the record is written while the request is still
 * alive to write it.
 */
export const OVERSIZE_LINK_TREE_LINK_COUNT = 5000;

/**
 * Detail records ONE ORG may emit per window before the rest are counted into a
 * rollup. Above 1 because the record's value is naming WHICH artifact and depth
 * killed the request: a budget of 1 would let the first oversize tree in a
 * window hide four differently-shaped ones behind a bare count. Five is a hard
 * ceiling on a path an authenticated caller drives, and the rollup carries
 * whatever exceeds it.
 */
export const OVERSIZE_LINK_TREE_MAX_PER_WINDOW = 5;

/**
 * Process-local and best-effort, per `apps/api/AGENTS.md` ("Serverless Routes
 * and State"): each instance bounds itself independently, which preserves the
 * fleet-wide signal while denying any single hot instance an unbounded emit
 * stream. Keyed on the organization id — a stable principal, never an ephemeral
 * connection id.
 *
 * Exported so a suite can `clear()` it between cases — the budget is
 * module-level state that would otherwise carry from one case into the next and
 * make the file order-dependent. Production code must never call `clear()`: it
 * discards pending suppressed counts instead of flushing them.
 */
export const oversizeLinkTreeThrottle = new FixedWindowEmissionThrottle<string>(
  {
    maxPerWindow: OVERSIZE_LINK_TREE_MAX_PER_WINDOW,
    onFlush: (organizationId, suppressedCount, cause) =>
      logOversizeSuppressed(organizationId, suppressedCount, cause),
  }
);

/**
 * Report a traversal whose size is heading for the memory ceiling. Silent for
 * every normally-sized tree, which is all of them, and bounded per org above
 * that.
 */
export function reportOversizeLinkTree(params: {
  organizationId: string;
  artifactId: string;
  direction: LinkDirection;
  maxDepth: number;
  linkType?: LinkType;
  links: readonly ArtifactLink[];
}): void {
  const now = Date.now();
  // Every tree read reaches here, so this is the terminal path the throttle
  // needs: an org whose burst is followed by quiet still gets its rollup
  // instead of leaving it pending until the same org is oversize again. O(1)
  // while nothing has expired, which is the normal case — the map is empty.
  oversizeLinkTreeThrottle.drainExpired(now);

  if (params.links.length < OVERSIZE_LINK_TREE_LINK_COUNT) {
    return;
  }

  const decision = oversizeLinkTreeThrottle.record(
    params.organizationId,
    params.organizationId,
    now
  );
  if (decision.flushedSuppressedCount > 0) {
    logOversizeSuppressed(
      params.organizationId,
      decision.flushedSuppressedCount,
      EmissionRollupCause.Window
    );
  }
  if (!decision.emit) {
    return;
  }

  const endpointIds = new Set<string>();
  for (const link of params.links) {
    endpointIds.add(link.sourceId);
    endpointIds.add(link.targetId);
  }

  log.warn(OVERSIZE_LINK_TREE_EVENT, {
    organizationId: params.organizationId,
    artifactId: params.artifactId,
    direction: params.direction,
    maxDepth: params.maxDepth,
    linkType: params.linkType ?? null,
    links: params.links.length,
    // The gap between these two is the multiplication the hydration used to
    // pay: pre-ISS-10041 it built one endpoint per EDGE END, not per artifact.
    distinctEndpoints: endpointIds.size,
    threshold: OVERSIZE_LINK_TREE_LINK_COUNT,
  });
}

/**
 * Emit one aggregate rollup for occurrences a window suppressed. `flushedBy`
 * says what materialised it, because a query that cannot tell an expiry drain
 * from an LRU eviction cannot tell a quiet org from keyspace pressure.
 */
function logOversizeSuppressed(
  organizationId: string,
  suppressed: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(OVERSIZE_LINK_TREE_SUPPRESSED_EVENT, {
    organizationId,
    suppressed,
    flushedBy,
    threshold: OVERSIZE_LINK_TREE_LINK_COUNT,
  });
}
