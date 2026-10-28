/**
 * @file session-authoritative-cost.ts
 * @description ISS-7229: roll Claude Code's OWN reported cost up from the OTel
 * `claude_code_cost_event` rows onto `sessions.authoritative_cost_usd`.
 *
 * This is NOT a second opinion of `sessions.cost_usd_estimated`. That column is
 * OUR estimate, priced by our own engine from `token_usage`; this one is what
 * Claude says it charged. The two are the OPERANDS of the estimator-drift
 * delta, so nothing may sum or coalesce them — doing so blends two accounting
 * systems and the delta stops meaning anything.
 *
 * Its own module rather than a function in `token-cost-writes.ts`: that file is
 * ~880 lines and carries a shrink-only grandfather entry in `biome.jsonc`, so
 * adding to it is forbidden. It is also the wrong neighbour — everything there
 * derives OUR estimate from `token_usage`, and this derives THEIRS from a
 * capture table.
 *
 * WHY SUMMING IS CORRECT, and why that is not obvious. Summing an OTel counter
 * is usually wrong: a cumulative counter reports a running total, so adding two
 * points double-counts. Claude Code exports `claude_code.cost.usage` with DELTA
 * temporality and the normalizer REFUSES a non-delta point
 * (`../otel/claude-code-otel-normalizer.ts`), so every row here is an interval
 * that is additive by construction — the same property
 * `claude-code-otel-signal-reduction.ts` already relies on when it sums two
 * points colliding on one natural key.
 */

import type { Prisma } from "./generated/client.js";
import { advanceSessionSyncWatermark } from "./session-sync-watermark.js";

/**
 * Recompute `sessions.authoritative_cost_usd` for one session from its captured
 * cost events.
 *
 * ONE SET-BASED STATEMENT, not a read-then-write, for two reasons. It lets the
 * rollup join its caller's transaction — so a session's total commits atomically
 * with the events it was computed from, and a crash between the two cannot leave
 * a total that describes rows nobody stored. And it obeys the repo's standing
 * rule against decomposing an atomic operation into a separate read and write.
 *
 * THE CHANGE TEST IS THE `WHERE`, not a `CASE` over `updated_at`, so the
 * statement's own affected-row count answers "did this move the figure?" — which
 * is what {@link rollUpSessionAuthoritativeCost} needs in order to decide
 * whether to advance the shared sync cursor. `IS NOT` is SQLite's null-safe
 * inequality, so NULL→NULL and 42→42 match nothing while NULL→42 and 42→43
 * match one row.
 *
 * NULL WHEN THERE ARE NO EVENTS, and this is the whole subtlety. The reflex
 * spelling `COALESCE(SUM(cost_usd), 0)` would turn "Claude never reported
 * anything for this session" into a confident "Claude reported $0.00" — on the
 * MAJORITY of rows, since capture is gated on the `claudeCodeOtelCapture` Labs
 * setting and only reaches sessions whose Claude process was pointed at the
 * local receiver. Bare `SUM` is exactly right instead: SQL defines it as NULL
 * over an empty set, and as `0` over rows that really do sum to zero, which is
 * the distinction this column exists to keep. A stored `0` here is a REPORTED
 * zero and a real measurement. Do not add a COALESCE.
 *
 * RECOMPUTES FROM SCRATCH rather than accumulating, so a re-import, a re-export,
 * or a replayed OTel batch cannot double-count: the answer depends only on the
 * rows present when it runs. Same guard the sibling estimate rollup
 * (`updateSessionCostRollup`) turns on.
 */
export const SESSION_AUTHORITATIVE_COST_ROLLUP_SQL = `UPDATE sessions
   SET authoritative_cost_usd = (
     SELECT SUM(cost_usd)
     FROM claude_code_cost_event
     WHERE session_id = sessions.id
   )
   WHERE id = $1
     AND (
       SELECT SUM(cost_usd)
       FROM claude_code_cost_event
       WHERE session_id = sessions.id
     ) IS NOT authoritative_cost_usd`;

/**
 * Roll one session's Claude-reported total up, and advance the sync cursor when
 * — and only when — the figure actually moved.
 *
 * ADVANCES THE SYNC WATERMARK (whitlockk on #6393). Cloud delivery selects on the
 * `sessions.updated_at` cursor (FEA-1962), so writing the column alone left an
 * already-acked session invisible to every later sync: cost that arrived after
 * the first delivery — the normal order, since OTel lands when Claude exits and
 * the transcript may have imported long before — never reached the cloud at all.
 *
 * CONDITIONAL, because the cursor is shared. The import phase runs this for
 * EVERY session, including the majority with no cost events at all, so an
 * unconditional bump would re-queue the whole corpus for delivery on every
 * import. The statement above makes its own `WHERE` the test, so the affected
 * count is the condition rather than a second evaluation that could disagree
 * with it.
 *
 * THROUGH `advanceSessionSyncWatermark`, NOT A LOCAL SPELLING (davetho on
 * #6406). This column's bump used to be an inline `MAX(updated_at, $2)`, a
 * second and weaker implementation of semantics ISS-8758 had already settled on
 * the canonical helper, and it was wrong in both the ways that ticket names.
 * The TIE: `importSession` captures one `now` for the whole pass and commits its
 * phases separately, so the session group can publish `updated_at = now` before
 * this rollup fires with the same `now` — and a sync tick landing between the
 * two commits acks the row at that timestamp, after which `MAX(now, now)` leaves
 * it exactly where the cursor has already passed and the cost never leaves the
 * machine. Strict forward progress is what clears it. The NULL: SQLite's
 * two-argument scalar `max()` yields NULL if either argument is NULL, and
 * `sessions.updated_at` is nullable — so on such a row the bump wrote NULL back,
 * preserving the invisibility and destroying the row's watermark besides. The
 * helper reads the stored value and decides, which is the only shape that can
 * answer both.
 *
 * CALL IT INSIDE THE TRANSACTION THAT COMMITS THE ROLLUP. The helper's read and
 * write ride the caller's transaction and therefore the single writer
 * connection, so nothing can interleave; and the pair being all-or-nothing with
 * the figure is what makes the bump re-derivable on a retry.
 */
export async function rollUpSessionAuthoritativeCost(
  tx: Pick<Prisma.TransactionClient, "$executeRawUnsafe" | "$queryRawUnsafe">,
  sessionId: string,
  now: string
): Promise<void> {
  const changedRows = await tx.$executeRawUnsafe(
    SESSION_AUTHORITATIVE_COST_ROLLUP_SQL,
    sessionId
  );
  if (changedRows > 0) {
    await advanceSessionSyncWatermark(tx, sessionId, now);
  }
}

/**
 * The session ids a batch of OTel signals reported cost for, de-duplicated.
 *
 * One rollup per DISTINCT session rather than per event: an export carries many
 * points for one session (per model, per attribution tuple, per interval), and
 * the statement above recomputes the whole total each time, so running it once
 * per event would issue N identical writes for one answer.
 *
 * Typed on the narrow shape it actually reads rather than the signal union, so
 * a caller can hand it any cost-bearing record without this module importing
 * the OTel contract — the dependency would point the wrong way, from the
 * database layer into the collector layer.
 */
export function distinctCostEventSessionIds(
  events: readonly { readonly sessionId: string }[]
): string[] {
  return [...new Set(events.map((event) => event.sessionId))];
}
