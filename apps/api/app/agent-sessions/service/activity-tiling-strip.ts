import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";
import { isFinalChunkDelivery } from "./chunk-revision-gating";
import type { AgentSessionUpsertTx } from "./records";

export const ACTIVITY_TILING_STRIPPED_EVENT =
  "agent_session_activity_tiling_stripped";

/**
 * The durable column patch for one session, or `{}` to leave the column alone.
 *
 * Three-way, mirroring `persistSessionActivitySegments`' own absent/empty/present
 * ladder rather than inventing a second vocabulary for the same fact:
 *
 * - `activitySegmentRowsStripped === true` — this payload deliberately shipped
 *   without the session's tiling. Recorded, so a reader of the row can tell a
 *   session whose tiling was DROPPED in transit from one that was never
 *   classified.
 * - anything else — a payload carrying its tiling, an events-only chunk of a
 *   split session, or a desktop too old to report. The column keeps whatever it
 *   held. Absent means "this client does not report", never "not stripped".
 *
 * NOTE WHAT IS NOT HERE: the CLEAR. It is tempting to read a payload that
 * carries tiling rows as positive evidence the tiling arrived, but "rows were on
 * the wire" and "rows were persisted" are different facts —
 * `persistSessionActivitySegments` has three paths that carry rows and write
 * none of them (sanity-validation reject, stale-classifier replace, append-lane
 * version mismatch), and it runs AFTER this patch has already been committed by
 * the detail upsert. Clearing here would reset a real strip to "tiling arrived"
 * on a payload whose tiling the receiver threw away, which is precisely the
 * conflation this column exists to break. The clear lives with the persistence
 * outcome instead — see {@link shouldClearRecordedTilingStrip}.
 */
export function resolveActivityTilingStripPatch(
  session: SyncedAgentSession,
  // The caller's `shouldUpdateGuardedColumns` — the same watermark that guards
  // `endsWithError`. A delayed retry of an older batch, or a stale chunk of an
  // abandoned sequence, must not win this column by arrival order. Taken here
  // rather than as a ternary at the call site so the whole decision reads in one
  // place (and the caller stays under its complexity ceiling).
  watermarkAllowsWrite = true
): { activitySegmentRowsStripped?: boolean } {
  return watermarkAllowsWrite && session.activitySegmentRowsStripped === true
    ? { activitySegmentRowsStripped: true }
    : {};
}

/**
 * Should a strip already recorded against this session be cleared?
 *
 * Only on proof: a row that currently reads `true` and a slice that ACTUALLY
 * persisted tiling rows. A strip is not permanent — a session whose tiling later
 * syncs in full has been repaired, and leaving the column latched would report a
 * loss that no longer exists — but the repair has to be witnessed rather than
 * inferred from the wire.
 *
 * Returns false for a row that is `false` or NULL so the common path issues no
 * write at all: this is a rare transition, not a per-sync column refresh.
 */
export function shouldClearRecordedTilingStrip(
  input: Readonly<{
    recordedStripped: boolean | null | undefined;
    activityTilingPersisted: boolean;
  }>
): boolean {
  return input.recordedStripped === true && input.activityTilingPersisted;
}

/**
 * Clear a recorded strip when — and only when — this slice repaired it.
 *
 * The write lives here rather than inline in `upsertSessionSlice` so the branch
 * does not push that function past the cognitive-complexity ceiling, and so the
 * column's whole lifecycle (declare, hold, clear) reads in one module.
 *
 * `watermarkAllowsWrite` is the caller's `shouldUpdateGuardedColumns`: the same
 * gate the declare arm rides, so a stale replay cannot clear what a fresher
 * payload recorded.
 */
export async function clearRecordedTilingStripIfRepaired(
  tx: AgentSessionUpsertTx,
  input: Readonly<{
    artifactId: string;
    recordedStripped: boolean | null | undefined;
    activityTilingPersisted: boolean;
    watermarkAllowsWrite: boolean;
  }>
): Promise<void> {
  if (!(input.watermarkAllowsWrite && shouldClearRecordedTilingStrip(input))) {
    return;
  }
  await tx.sessionDetail.update({
    where: { artifactId: input.artifactId },
    data: { activitySegmentRowsStripped: false },
    // Narrow `RETURNING *` to the primary key: the result is discarded, and a
    // bare update materialises every scalar column for nobody.
    select: { artifactId: true },
  });
}

/**
 * How many sessions this batch DURABLY LANDED without their tiling.
 *
 * THE POPULATION, stated once and here (whitlockk, #5741). A session counts when all
 * three hold: it DECLARED the strip, its slice COMMITTED, and this payload was
 * that session's FINAL delivery — unchunked, or the last chunk of a split. That
 * is neither of the two contracts next to it, and both neighbours are wrong in
 * opposite directions:
 *
 * - the ACK ECHO (`persistedSessionIds`) is too NARROW. A session whose
 *   monitored-activity target never resolves is withheld from the echo on every
 *   attempt — correctly, the desktop must keep retrying it — while its columns,
 *   the strip among them, are already durable. Keying on the echo goes
 *   permanently silent on exactly the rows most likely to be stuck.
 * - "every committed slice" is too WIDE. `chunkOversizedSession` spreads the
 *   base session into every part, so a stripped session that also had to chunk
 *   carries the flag on ALL of its chunks and each of them commits. Counting the
 *   non-final ones reports one lost tiling once per part, inflating the single
 *   number an ISS-7265 ruling depends on. A non-final chunk has also dequeued
 *   nothing yet, which is why the desktop delivery side defers to the final
 *   chunk too (`resolveDeliveredStrip`'s `hasMoreChunks` gate) — the two sides
 *   now count the same event.
 *
 * The finality half is read from the payload's own chunk marker rather than from
 * `shouldCommitRevision`, which additionally requires a non-null `dataRevision`:
 * tying a degradation report to a field an older producer may omit would silence
 * it for exactly the builds most likely to strip.
 *
 * What that costs, stated rather than hidden: a stripped sequence abandoned
 * before its final chunk holds a durable `true` column this event never names.
 * The column is the ledger of record and still says so, and the abandoned
 * sequence's own retry re-delivers a final chunk and reports then.
 */
export function countStrippedTilings(
  sessions: readonly SyncedAgentSession[],
  committedSessionIds: readonly string[]
): number {
  if (committedSessionIds.length === 0) {
    return 0;
  }
  const committed = new Set(committedSessionIds);
  return sessions.filter(
    (session) =>
      session.activitySegmentRowsStripped === true &&
      committed.has(session.externalSessionId) &&
      isFinalChunkDelivery(session.chunk)
  ).length;
}

/**
 * The STABLE emission key: what an operator would act on, with no per-session
 * component. A compute target must already exist under the organization for the
 * ingest to run at all, so nothing a caller varies within a request can grow
 * this keyspace — it is bounded by (orgs × their real targets), which is why
 * this choke point needs no second, coarser budget the way
 * `corruptAgentRosterThrottle` does.
 */
type StrippedTilingScope = {
  organizationId: string;
  computeTargetId: string;
};

/** Composite-key delimiter. Both key parts are ids, so `|` cannot collide. */
const KEY_DELIMITER = "|";

/**
 * WHY THIS IS THROTTLED (#5741 review). Per-batch is the wrong unit to stop at:
 * the batch IS the request, and an authenticated desktop drives the request
 * rate. A session withheld from the ack echo by an unresolved monitored-activity
 * target is re-sent on every sync pass while its strip column is already
 * durable, so the un-throttled emission is one warning per request, forever,
 * from one stuck session — the amplification vector `apps/api/AGENTS.md`
 * ("Emission and Abuse Control") forbids.
 *
 * `FixedWindowEmissionThrottle` supplies both bounds: at most one event per
 * (org, compute target) per window plus one aggregate rollup, and a hard
 * max-entry LRU cap on the keyspace, since an unbounded map would only trade a
 * log leak for a memory leak (root `AGENTS.md`).
 *
 * THE FIRST OCCURRENCE ALWAYS EMITS. A key with no live window emits before it
 * can suppress anything, so a genuinely new (org, target) strip is never the one
 * the bound eats — the throttle only ever collapses REPETITION.
 *
 * WHAT THE ROLLUP COUNTS, precisely. `occurrences` is BATCH REPORTS, not
 * sessions: the throttle counts events, and the suppressed batches did not
 * necessarily carry the same sessions, so summing their `strippedSessionCount`
 * would double-count one stuck session across its retries. The per-session
 * ledger is the durable `session_detail.activity_segment_rows_stripped` column,
 * which is written by the slice and is unaffected by any of this; this event is
 * the ALERT that sends an operator to that column, not the count of record.
 *
 * WHAT `sum(occurrences)` IS WORTH (the #5508 lesson). A suppressed count is
 * materialised by an event, never by a clock: the next stripped batch on the
 * SAME key rolling its window over, or an LRU eviction. Nothing wires
 * `drainExpired` to a terminal path here, so a burst followed by quiet stays
 * pending in process memory and a serverless instance that freezes first loses
 * its terminal window. Read the sum as an eventual lower bound, not a total.
 *
 * Process-local per serverless instance, matching the sibling throttles.
 * Exported so tests can reset it between cases; production code must not reach
 * into it.
 */
export const activityTilingStrippedThrottle =
  new FixedWindowEmissionThrottle<StrippedTilingScope>({
    onFlush: (scope, occurrences, cause) =>
      emitStrippedTilingRollup(scope, occurrences, cause),
  });

/**
 * Raise the monitored event for a batch that persisted at least one stripped
 * session. Silent when none did — this reports a degradation, so a `0` would be
 * traffic rather than signal.
 *
 * Ids and counts only, never session content: the organization and compute
 * target are the operator's own scoping keys, and the rest is a count.
 *
 * NEVER THROWS. It runs from the batch's `finally`, where a throw would replace
 * whatever error the batch was already propagating — a failure to REPORT the
 * degradation must not also change the ingest's outcome.
 */
export function reportStrippedTilings(
  context: Readonly<StrippedTilingScope>,
  strippedSessionCount: number
): void {
  if (strippedSessionCount <= 0) {
    return;
  }
  const scope: StrippedTilingScope = {
    computeTargetId: context.computeTargetId,
    organizationId: context.organizationId,
  };
  try {
    const decision = activityTilingStrippedThrottle.record(
      buildStrippedTilingKey(scope),
      scope,
      Date.now()
    );
    if (decision.flushedSuppressedCount > 0) {
      emitStrippedTilingRollup(
        scope,
        decision.flushedSuppressedCount,
        EmissionRollupCause.Window
      );
    }
    if (decision.emit) {
      log.warn(ACTIVITY_TILING_STRIPPED_EVENT, {
        ...scope,
        strippedSessionCount,
        occurrences: 1,
      });
    }
  } catch (error) {
    log.warn("[agent-sessions] Failed to report a stripped activity tiling", {
      event: ACTIVITY_TILING_STRIPPED_EVENT,
      computeTargetId: scope.computeTargetId,
      error: parseError(error),
    });
  }
}

function buildStrippedTilingKey(scope: StrippedTilingScope): string {
  return [scope.organizationId, scope.computeTargetId].join(KEY_DELIMITER);
}

/**
 * The rollup for batch reports a closed window suppressed, emitted as ONE event
 * carrying their total so `sum(occurrences)` still tracks how often a degraded
 * batch landed. It deliberately omits `strippedSessionCount` — the suppressed
 * batches did not necessarily carry the same sessions, and a summed count would
 * report one stuck session once per retry — and carries `aggregated` so a
 * monitor can tell a rollup from a first occurrence.
 *
 * `flushedBy` is the CAUSE the throttle reported, never a constant this module
 * picks (the ISS-7360 lesson): stamping one literal would tell an operator the
 * 10,000-key cap was hit when a quiet key was merely drained.
 */
function emitStrippedTilingRollup(
  scope: StrippedTilingScope,
  occurrences: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(ACTIVITY_TILING_STRIPPED_EVENT, {
    ...scope,
    occurrences,
    aggregated: true,
    flushedBy,
  });
}
