import type { InsightsScope } from "@repo/api/src/types/insights";
import { log } from "@repo/observability/log";

/**
 * The Session Mesh value funnel, emitted to Datadog on every org-scope read
 * (ISS-11812).
 *
 * WHY THIS EXISTS: every metric downstream of `delivered` reads zero today, and
 * nothing says WHERE the funnel drops. A delivery that named no subject, one
 * that named one nobody then touched, and one that was engaged but never judged
 * are three different problems with three different fixes, and the card reports
 * all three as the same `0`. Diagnosing it meant reading transcripts by hand;
 * this makes it one Datadog query.
 *
 * Only `prompted` is missing, because it is desktop-local state that never
 * reaches the server. Its absence is stated rather than defaulted to zero.
 */
export type SessionMeshFunnel = {
  delivered: number;
  /**
   * Deliveries that named a subject: a non-empty `pathOverlap` or
   * `symbolOverlap`, the collision unit ISS-11755 defines. NOT
   * `relevance <> '{}'` — `publish` writes a non-empty relevance on every row it
   * creates (`{explicit: true}` for a targeted peer, otherwise `relevanceFor`'s
   * record), so that predicate sat at ~1.0 and the stage could not drop.
   */
  routed: number;
  engaged: number;
  judged: number;
};

/**
 * Emitted at `info`, with `status` as the gate requires. Counts only — no agent
 * id, repository, path or message content, because this is an organization-wide
 * log line and the funnel is answerable without any of them.
 */
export function logSessionMeshFunnel(
  organizationId: string,
  scope: InsightsScope,
  funnel: SessionMeshFunnel
): void {
  log.info(
    JSON.stringify({
      level: "info",
      status: "ok",
      event: "session_mesh_funnel",
      organizationId,
      scope,
      delivered: funnel.delivered,
      routed: funnel.routed,
      engaged: funnel.engaged,
      judged: funnel.judged,
      // Ratios are emitted rather than left to the query so a monitor can alert
      // on a stage collapsing without re-deriving the denominator each time.
      routedRate: rate(funnel.routed, funnel.delivered),
      engagedRate: rate(funnel.engaged, funnel.routed),
      judgedRate: rate(funnel.judged, funnel.engaged),
    })
  );
}

/**
 * A stage's share of the one before it, or `null` when the previous stage is
 * empty. Null, not zero: "nothing reached this stage" is not "this stage
 * converts at 0%", and a monitor alerting on the latter would fire on every
 * quiet window.
 */
function rate(numerator: number, denominator: number): number | null {
  if (!(Number.isFinite(denominator) && denominator > 0)) {
    return null;
  }
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}
