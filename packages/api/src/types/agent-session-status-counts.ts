import {
  type DisplayedSessionStatus,
  SESSION_STATUS,
  type SessionStatus,
} from "./session-status.ts";

/**
 * ISS-8858: the response of `GET /agent-sessions/status-counts` — how many
 * sessions each DISPLAYED status holds for one filter set, in ONE request that
 * builds no row projection.
 *
 * `countsByStatus` spans the whole displayed vocabulary rather than listing the
 * statuses that happen to be non-empty, because a reader cannot tell an absent
 * key from a zero.
 *
 * Sibling of `AgentSessionListResponse`, deliberately NOT a member of it: the
 * list response is the full projection this endpoint exists to avoid paying for.
 * It lives here rather than in `agent-session.ts` because that module pulls Zod
 * and a wide transitive graph, and this contract needs neither.
 */
export type AgentSessionStatusCountsResponse = {
  /**
   * One entry per displayed status. Exhaustive over
   * {@link DisplayedSessionStatus}, so a new member fails `tsc` here until
   * this read is taught to answer for it.
   */
  countsByStatus: AgentSessionStatusCounts;
  /**
   * The same population WITHOUT any status facet. Counted, not summed: summing
   * would make the response self-consistent by construction and unable to report
   * a partition that has stopped being one.
   *
   * THE BUCKETS DO NOT SUM TO IT, and a consumer must treat `total` as the
   * denominator rather than deriving one: each bucket is equality on the
   * persisted `artifacts.status` column, which the unfiltered population is not
   * restricted to. What this read DOES guarantee is that a bucket for status S
   * is exactly the population `GET /agent-sessions?statuses=S` pages over —
   * buckets and list are one predicate since ISS-10629, so they agree by
   * construction.
   */
  total: number;
};

/**
 * Counts keyed by displayed status.
 *
 * ISS-10629 retired the Waiting/Stale/Unknown filter facet and stopped counting
 * those three, and they reported `null` — never `0`, which would state a count
 * nobody took. ISS-10364 then retired the three from
 * {@link DisplayedSessionStatus} itself, so there is no uncounted member left
 * and no `null` arm: every key of this type is a real count. The keys went with
 * them (`openapi.json` too), rather than staying as permanently-`null` buckets
 * naming a vocabulary the product no longer has.
 *
 * Written as a mapped type over {@link DisplayedSessionStatus} rather than a
 * hand-written record so it stays exhaustive: a new member cannot be silently
 * omitted. Counting a display-only status again would mean re-deriving a
 * predicate, not re-widening a constant — ISS-10629 deleted
 * `buildStatusFacetClause` and the whole projection it built.
 */
export type AgentSessionStatusCounts = Record<DisplayedSessionStatus, number>;

/**
 * The statuses this endpoint actually counts.
 *
 * Derived from {@link SESSION_STATUS} — the persisted lifecycle set, every
 * member, none added — so the counted vocabulary cannot drift from what a
 * producer can write. Since ISS-10364 that is also the whole displayed
 * vocabulary, so every documented bucket is counted.
 */
export const AGENT_SESSION_COUNTED_STATUSES: readonly SessionStatus[] =
  Object.values(SESSION_STATUS);
