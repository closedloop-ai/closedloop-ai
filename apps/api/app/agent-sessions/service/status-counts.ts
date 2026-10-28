import {
  AGENT_SESSION_COUNTED_STATUSES,
  type AgentSessionStatusCounts,
  type AgentSessionStatusCountsResponse,
} from "@repo/api/src/types/agent-session-status-counts";
import { Prisma, withDb } from "@repo/database";
import type { SessionUsageInput } from "./records";
import { SESSIONS_SURFACE_DATE_FIELD } from "./session-date-field";
import { buildUsageSummaryWhere } from "./usage-summary-where";

/**
 * ISS-8858: how many sessions each DISPLAYED status holds for one filter set, in
 * ONE request that builds NO row projection.
 *
 * ## What this replaces
 *
 * `GET /agent-sessions` has exactly one shape — the full list projection. Getting
 * a count per status meant one `?statuses=<s>&limit=1` call per status, and
 * `limit` bounds the rows RETURNED, never the work: every one of those calls
 * still resolved source links, branch and authored-PR lanes, custom fields,
 * comment counts and cost for the page it built. This read issues one
 * `COUNT(*)` per bucket and materialises no row at all.
 *
 * ## Which status vocabulary this counts, and why
 *
 * The PERSISTED three — {@link AGENT_SESSION_COUNTED_STATUSES} is
 * active/inactive/error. ISS-10629 stopped this endpoint counting `waiting`,
 * `stale` and `unknown`, which then reported `null`; ISS-10364 retired the three
 * from the displayed vocabulary, so those keys are gone from the response and
 * every bucket is a real count.
 *
 * Each bucket is EQUALITY on the persisted `artifacts.status` column.
 *
 * ## The counts and the list share ONE status predicate
 *
 * `applyStatusFacetFilter` builds the same equality for the list, so a count for
 * status S is exactly the population `GET /agent-sessions?statuses=S` pages
 * over, and there is no second predicate to drift. Every other facet is already
 * one `where` conjunct `buildUsageSummaryWhere` composes for both sides.
 *
 * It was the DISPLAY projection `buildStatusFacetClause` until ISS-10629, on
 * the FEA-4301 / ISS-5366 reasoning that a row awaiting input STORES `active`
 * and DISPLAYS as Waiting. When this PR moved the list's FILTER to the persisted
 * column and left this endpoint on the projection, the two split and the badge
 * could contradict the table it labels (whitlockk). Operator ruling 2026-09-18: the
 * display projection is being phased out, so the counts followed the list rather
 * than the list moving back.
 *
 * `total` counts the status-free population — the denominator the buckets
 * partition — rather than summing them, so a partition that has stopped being one
 * is reportable instead of being hidden by arithmetic that cannot disagree with
 * itself.
 *
 * ## The Status facet is excluded from its own counts
 *
 * The caller's OWN `status`/`statuses` selection is dropped before the buckets are
 * built, exactly as `facet-count-where.ts` drops each facet's own dimension:
 * applying it would zero every status the caller did not already pick and turn the
 * facet into a one-way door. The counts route rejects a status filter outright
 * rather than accepting and silently dropping it.
 */
export async function buildAgentSessionStatusCounts(
  input: SessionUsageInput
): Promise<AgentSessionStatusCountsResponse> {
  const totalWhere = await buildUsageSummaryWhere(
    {
      ...input,
      filters: { ...input.filters, status: undefined, statuses: undefined },
    },
    SESSIONS_SURFACE_DATE_FIELD
  );
  // Each bucket is EQUALITY on the persisted `artifacts.status` column — the
  // same predicate `applyStatusFacetFilter` now builds for the list, so the two
  // agree by construction again (whitlockk review).
  //
  // It was `buildStatusFacetClause`, the display projection (deleted once this
  // read and the list both stopped calling it). ISS-10629 moved the list's
  // FILTER to the persisted column and left this endpoint on the
  // projection, which split them: a row that STORES `active` and DISPLAYS as
  // Waiting was inside the list's `active` page and outside this `active`
  // bucket, so the badge contradicted the table it labels. Operator ruling
  // 2026-09-18 — the display projection is being phased out, so the counts move
  // to the list's predicate rather than the list moving back.
  //
  // Dropping the projection also drops the shared clock reading it needed
  // (whitlockk, PR #6485): the ACTIVE and STALE arms anchored on cutoffs
  // milliseconds apart, so a row landing between them satisfied both and the
  // buckets stopped partitioning `total`. Plain equality has no clock and
  // cannot double-count.
  const bucketWheres = AGENT_SESSION_COUNTED_STATUSES.map((status) => ({
    status,
    where: {
      AND: [totalWhere, { artifact: { is: { status } } }],
    } satisfies Prisma.SessionDetailWhereInput,
  }));
  const [total, ...bucketCounts] = await withStatusCountsSnapshot(() =>
    countInSequence([totalWhere, ...bucketWheres.map((bucket) => bucket.where)])
  );
  // ISS-10629 reported the display-only statuses as `null` — NOT `0`, which
  // would state a count nobody took. ISS-10364 retired the three from the
  // displayed vocabulary, so the keys are gone rather than permanently `null`,
  // and every bucket this builds is a real count. Counting a display-only
  // status again needs a predicate that derives it, which is a rebuild rather
  // than a flag: `buildStatusFacetClause` built one for all six and ISS-10629
  // deleted it.
  const countsByStatus = Object.fromEntries(
    bucketWheres.map((bucket, index) => [bucket.status, bucketCounts[index]])
  ) as AgentSessionStatusCounts;
  return { countsByStatus, total };
}

function countSessions(where: Prisma.SessionDetailWhereInput): Promise<number> {
  return withDb((db) => db.sessionDetail.count({ where }));
}

/**
 * The same ceiling `SESSION_LIST_SNAPSHOT_TX_TIMEOUT_MS` gives the list's own
 * snapshot. These counts walk the same population, so they take the same bound
 * rather than Prisma's 5s interactive-transaction default.
 */
export const STATUS_COUNTS_SNAPSHOT_TX_TIMEOUT_MS = 30_000;

/**
 * Every count in this response is ONE observation of ONE population.
 *
 * `withDb` is not transactional — it hands back the pooled client, so each
 * `count` took its own READ COMMITTED snapshot. A session inserted, deleted, or
 * moved between statuses while the counts ran therefore left the response
 * contradicting itself: a row present in its old bucket AND its new one, in
 * neither, or in a bucket while absent from `total` (`apps/api/AGENTS.md`: "A
 * page and its total read in two statements are not one snapshot"). Because
 * `total` is counted independently rather than summed, that discrepancy was
 * directly readable off the response.
 *
 * `RepeatableRead` pins one MVCC snapshot across all of them, exactly as
 * `withSessionListSnapshot` does for the list's count plus page. The counts run
 * SEQUENTIALLY inside it rather than through `mapWithDbConcurrency`: an
 * interactive transaction pins a single connection and queues its statements on
 * it anyway, so a concurrency limiter there would bound nothing and only add a
 * scheduler. That is the same trade `withSessionListSnapshot` states.
 */
function withStatusCountsSnapshot<T>(fn: () => Promise<T>): Promise<T> {
  return withDb.tx(fn, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    timeout: STATUS_COUNTS_SNAPSHOT_TX_TIMEOUT_MS,
  });
}

async function countInSequence(
  wheres: Prisma.SessionDetailWhereInput[]
): Promise<number[]> {
  const counts: number[] = [];
  for (const where of wheres) {
    counts.push(await countSessions(where));
  }
  return counts;
}
