/**
 * @file agent-ended-at-heal.ts
 * @description ISS-7069: the one-time repair for agents whose `ended_at` was
 * derived by the PRE-ISS-6893 sweep.
 *
 * ISS-6893 fixed the FORWARD path: the stale sweep's agent arm folded
 * `events.created_at` — raw harness transcript text, and the one timestamp
 * column the FEA-3743 heal never repairs — with a byte-wise `MAX()`. On a
 * mixed-encoding column that returns the EARLIER instant (`…:00Z` beats
 * `…:00.500Z` because `Z` 0x5A sorts after `.` 0x2E; a `Z` value beats an
 * offset value that is chronologically later), which SHORTENS the agent's
 * derived duration. That fix only changed what the sweep writes NEXT time.
 * Agents already swept by an earlier release keep the wrong value, and
 * `sync-source.ts` exports `agents.ended_at` onto the wire `agents[].endedAt`
 * verbatim — so the drift is already replicated to the cloud, not merely
 * rendered locally.
 *
 * NEITHER OBVIOUS REMEDY CLOSES IT, which is why this pass exists:
 *
 *  - Ordinary reimport does not reach the population at all. The terminal-end
 *    reconcile, `advanceTerminalEndedAt` (write-core-terminal-end.ts), updates
 *    `WHERE id = mainId` and only advances to the SESSION's parsed end — it
 *    touches no subagent and never re-derives from events.
 *  - A `DATA_REVISION` bump is not the remedy either, and is deliberately NOT
 *    taken here. It would force a full rebuild for every user. (ISS-9626: this
 *    line used to say the identical bump was "pending a human decision on
 *    ISS-6885"; that was true only while #5321 was open — the bump landed in
 *    `487db3543c`, 79 -> 80. It did not repair this population, for the reason
 *    below.) It would also be only a partial repair: the rebuild re-derives
 *    just the PARSER-OWNED
 *    subagent rows (`write-core.ts` deletes `type = 'subagent'` with a
 *    `%-sub-%` / `%-parser-sub-%` id in a terminal status), and only while the
 *    source transcript is still on disk — a missing-source session is stamped
 *    the new revision by the rollup bridge with no recompute at all, and the
 *    live-hook spawner's rows are spared by construction.
 *  - The live sweep cannot reach them either: its agent arm carries
 *    `AND status NOT IN ('completed', 'error')` (session-maintenance.ts), which
 *    excludes exactly the already-swept agents that are wrong.
 *
 * THE INVARIANT THIS REPAIRS, stated as an invariant rather than as "rows the
 * old sweep touched", because nothing durably marks a swept agent: an agent
 * cannot end BEFORE its own last event. Where it does, `ended_at` is wrong no
 * matter which writer produced it. So the repair is a monotone ADVANCE to the
 * chronological fold, and that shape is what makes it safe:
 *
 *  - It can never destroy a good value. An agent closed by the importer from
 *    `session.endedAt`, or by the live hook, whose own events all precede that
 *    stamp, does not match at all — the fold is not greater.
 *  - It preserves the `ended_at >= started_at` floor by construction: the fold
 *    is itself `MAX(<canonicalized started_at floor>, <canonical event fold>)`,
 *    so every value it can write already satisfies the floor (ISS-5182).
 *  - It is convergent, so idempotent. A healed agent's stored value IS the
 *    fold, so `fold > stored` is false on the next boot and the pass writes
 *    nothing. Nothing here re-queries from the head, so it cannot spin: one
 *    bounded discovery, then a fixed array walked in chunks (ISS-6906).
 *
 * WHAT IS DELIBERATELY NOT REPAIRED, said out loud rather than papered over —
 * and COUNTED, because "this pass could not judge it" must never be reported as
 * "there was nothing to repair". Both classes may still hold a too-early
 * `ended_at` that is already exported to cloud:
 *
 *  - LEGACY-MODE agents (`legacy`). One date-shaped event this engine cannot
 *    canonicalize makes {@link AGENT_CANONICAL_ENDED_AT_SQL} NULL for the whole
 *    fold. That is the same line `healSessionLastActivityAtFloor` draws, for the
 *    same reason: in legacy mode the fold is `main`'s verbatim, so there is
 *    nothing this repairs, and judging the row would mean the byte-wise
 *    comparison over mixed forms that IS the defect.
 *  - UNREADABLE stored values (`unreadable`). The stored `ended_at` itself will
 *    not canonicalize, so no sound comparison exists. Not re-keyed on a guess
 *    (ISS-6906) — left exactly as stored.
 *
 * NOTE that a non-canonical stored `ended_at` is the NORMAL shape of this
 * population, not an edge case: `agents.ended_at` is outside `HEALED_COLUMNS`,
 * and the pre-fix sweep copied the byte-wise-winning RAW `events.created_at`
 * text into it — which for a positive-offset form is both non-canonical AND the
 * wrong instant. That is why the comparison canonicalizes the STORED side too,
 * rather than only the fold.
 *
 * Runs in the background boot-maintenance chain (`boot-maintenance.ts`), not on
 * the awaited pre-sweep path: nothing either boot sweep reads depends on it, and
 * a long write transaction there would wall off every other lane on the first
 * boot after upgrade (ISS-6909). Chunked with per-chunk transactions, per-chunk
 * error isolation, and per-chunk sync watermarks, like every other store heal.
 */

import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { DESKTOP_AGENT_STATUS } from "./db-constants.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { SESSION_ANALYTICS_BACKFILL_CHUNK } from "./session-analytics-rollup.js";
import {
  bumpSessionsUpdatedAt,
  chunkWatermark,
} from "./session-sync-watermark.js";
import {
  AGENT_CANONICAL_ENDED_AT_SQL,
  AGENT_ENDED_AT_VALUE_SQL,
  CANONICAL_UTC_TIMESTAMP_GLOB_SQL,
  canonicalizeHealableTimestampSql,
  ISO_DATE_PREFIX_GLOB_SQL,
} from "./session-timestamp-form.js";

export type AgentEndedAtHealResult = {
  healed: number;
  failedChunks: number;
  /**
   * Agents in the suspect population whose STORED `ended_at` cannot be
   * canonicalized, so no sound comparison against the fold exists. Counted and
   * reported rather than re-keyed on a guess (ISS-6906); they are left exactly
   * as `main` stored them.
   */
  unreadable: number;
  /**
   * Agents in the suspect population whose FOLD cannot be canonicalized — one
   * date-shaped event this engine cannot parse drops the whole fold to legacy
   * mode. Reported for the same reason `sweepOrphanedSessions` reports
   * `heldBack`: such an agent may still hold a too-early `ended_at` that is
   * already exported to cloud, and "this pass could not judge it" must not look
   * identical to "there was nothing to repair".
   */
  legacy: number;
};

export async function healSweptAgentEndedAt(
  prisma: DesktopPrisma,
  now: string,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<AgentEndedAtHealResult> {
  // Discovery goes through the READER pool, never `prisma.client`. That handle
  // IS the single writer connection, so running this scan on it would put the
  // largest read this pass ever performs — the first boot after upgrade, on the
  // biggest pre-fix corpus — on the one connection live-hook ingest and both
  // sync lanes depend on, AND outside `write()`'s queue, so ahead of the
  // fairness system rather than in it. `read()` fans out across the reader pool
  // and runs concurrently with the writer, which is the shape ISS-6906's repair
  // uses. Deliberately still ONE unbounded scan rather than keyset pages: the
  // non-canonical-operand gate makes candidates rare, the set is materialized
  // once and then walked as a fixed array (so it cannot spin), and paging a
  // predicate whose truth a concurrent write can flip would need an ordering key
  // this table has no natural candidate for.
  const candidates = await prisma.read((reader) =>
    reader.$queryRawUnsafe<AgentEndedAtCandidateRow[]>(
      AGENT_ENDED_AT_DISCOVERY_SQL
    )
  );
  // Three outcomes, kept distinct. `unreadable` is checked FIRST and is the more
  // specific of the two unjudgeable classes: when the stored value itself cannot
  // be read, the state of the fold is beside the point.
  const unreadable = candidates.filter((row) => row.unreadable === 1).length;
  const legacy = candidates.filter(
    (row) => row.unreadable !== 1 && row.legacy === 1
  ).length;
  if (unreadable > 0) {
    log(
      `agent ended_at heal: ${unreadable} agent(s) have an un-canonicalizable stored ended_at and were left as stored`
    );
  }
  if (legacy > 0) {
    log(
      `agent ended_at heal: ${legacy} agent(s) fold in legacy mode and could not be judged; they were left as stored and may still be too early`
    );
  }
  const violating = candidates.filter(
    (row) => row.unreadable !== 1 && row.legacy !== 1
  );
  if (violating.length === 0) {
    return { healed: 0, failedChunks: 0, unreadable, legacy };
  }

  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  let healed = 0;
  let failedChunks = 0;
  for (let start = 0; start < violating.length; start += safeChunkSize) {
    const chunk = violating.slice(start, start + safeChunkSize);
    // FEA-3485: each chunk gets its OWN strictly-increasing watermark, so a
    // multi-chunk heal does not collapse the whole corrected set onto one
    // sync-cursor top `updated_at`.
    const chunkNow = chunkWatermark(now, start / safeChunkSize);
    try {
      // The UPDATE re-asserts the qualifying test, so it can legitimately write
      // FEWER rows than the chunk holds. `healed` reports what was actually
      // written — never the chunk size, which would be a confident number for
      // rows this pass deliberately skipped.
      //
      // The bump set is derived from that same re-check rather than from the
      // discovery chunk, so it names the sessions whose agents were WRITTEN. A
      // chunk-mate that stopped qualifying must not drag its own session along:
      // that would re-queue it to the cloud for a correction that never
      // happened, and hand the retention purge an outbox row to defer on. The
      // re-check runs INSIDE this transaction on the single writer connection,
      // so no writer can interleave between it and the UPDATE and the two see
      // the same set.
      healed += await prisma.write((client) =>
        client.$transaction(async (tx) => {
          const ids = chunk.map((row) => row.id);
          const writable = await tx.$queryRawUnsafe<AgentEndedAtBumpRow[]>(
            buildAgentEndedAtRecheckSql(chunk.length),
            ...ids
          );
          if (writable.length === 0) {
            return 0;
          }
          const written = await tx.$executeRawUnsafe(
            buildAgentEndedAtUpdateSql(chunk.length),
            chunkNow,
            ...ids
          );
          const bumpIds = bumpableSessionIds(writable);
          if (bumpIds.length > 0) {
            await bumpSessionsUpdatedAt(tx, bumpIds, chunkNow);
          }
          return written;
        })
      );
    } catch (error) {
      failedChunks += 1;
      log(
        `agent ended_at heal failed for chunk [${start}, ${start + chunk.length}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (failedChunks > 0) {
    log(
      `agent ended_at heal: ${failedChunks} chunk(s) failed, will retry next boot`
    );
  }
  return { healed, failedChunks, unreadable, legacy };
}

/** What {@link bumpableSessionIds} needs: the row and the session that owns it. */
type AgentEndedAtBumpRow = {
  id: string;
  sessionId: string;
  sessionStatus: string | null;
};

type AgentEndedAtCandidateRow = AgentEndedAtBumpRow & {
  unreadable: number;
  legacy: number;
};

/**
 * The stored `ended_at` re-expressed as canonical fixed-width UTC, or NULL when
 * it cannot be. Both sides of the discovery comparison have to live in that one
 * domain before `>` means "later", because these are TEXT columns and `>` is a
 * byte comparison (ISS-5330).
 */
const CANONICAL_STORED_ENDED_AT_SQL =
  canonicalizeHealableTimestampSql("ended_at");

/**
 * The cheap gate that comes FIRST, and it is a NECESSARY CONDITION rather than
 * only an optimization: the ISS-6893 defect requires that SOME operand of the
 * fold be non-canonical. When every operand is already canonical, byte order IS
 * time order, so the old byte-wise fold and the new canonical one return the same
 * text and the stored value is already right. Paying a handful of GLOBs and one
 * index probe here keeps the expensive per-agent fold off the overwhelmingly
 * common agent — the same ordering discipline `healSessionLastActivityAtFloor`
 * uses for its own fold.
 *
 * BOTH operands are tested, because the fold has two: {@link AGENT_ENDED_AT_VALUE_SQL}
 * is `MAX(<started_at floor>, <event fold>)`, and the pre-ISS-6893 sweep took
 * that same `MAX` over the RAW text of both. So a non-canonical `started_at`
 * alone is sufficient — an agent started `2026-06-22T20:00:00+05:30` (14:30Z)
 * whose events are all canonical with a last event at `2026-06-22T18:00:00.000Z`
 * sorts the START above the event and was swept to a value 3.5h BEFORE its own
 * last event. Gating on the events alone would leave that whole population
 * undiscovered and permanently wrong, locally and in the cloud, because nothing
 * else revisits it.
 */
const AGENT_HAS_NON_CANONICAL_FOLD_OPERAND_SQL = `(
       (
         started_at GLOB ${ISO_DATE_PREFIX_GLOB_SQL}
         AND started_at NOT GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
       )
       OR EXISTS (
         SELECT 1
           FROM events e
          WHERE e.agent_id = agents.id
            AND e.created_at GLOB ${ISO_DATE_PREFIX_GLOB_SQL}
            AND e.created_at NOT GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
       )
     )`;

const AGENT_TERMINAL_STATUS_SQL = `status IN ('${DESKTOP_AGENT_STATUS.COMPLETED}', '${DESKTOP_AGENT_STATUS.ERROR}')`;

/**
 * The whole qualifying test, spelled ONCE because discovery and the write BOTH
 * have to apply it — see {@link buildAgentEndedAtUpdateSql} for why the write
 * re-asserts rather than trusting the id list. Two statements evaluating the
 * same rule is exactly the kind of pair that drifts, so there is one expression.
 *
 * lexical-timestamp-ok: the `>` compares the canonical arm of
 * `AGENT_ENDED_AT_VALUE_SQL` against `canonicalizeHealableTimestampSql(ended_at)`
 * — BOTH operands are re-expressed as fixed-width canonical UTC inside
 * session-timestamp-form.ts before the comparison sees them, and the arm is NULL
 * (so the row does not qualify) whenever that re-expression is not possible.
 * ISS-5330's gate cannot follow the interpolated expressions into that module,
 * so the marker is how that is declared.
 */
const AGENT_ENDED_AT_QUALIFIES_SQL = `ended_at IS NOT NULL
   AND ${AGENT_TERMINAL_STATUS_SQL}
   AND ${AGENT_HAS_NON_CANONICAL_FOLD_OPERAND_SQL}
   AND COALESCE(${AGENT_CANONICAL_ENDED_AT_SQL}, ${CANONICAL_STORED_ENDED_AT_SQL})
       > ${CANONICAL_STORED_ENDED_AT_SQL}`;

/**
 * The {@link AgentEndedAtBumpRow} projection, spelled once because discovery and
 * the in-transaction re-check both select it.
 */
const AGENT_BUMP_ROW_PROJECTION_SQL = `id,
    session_id AS sessionId,
    (SELECT s.status FROM sessions s WHERE s.id = agents.session_id) AS sessionStatus`;

/**
 * `agents` is deliberately UNALIASED: the interpolated fold resolves
 * `agents.id` (its event scope) and a bare `started_at` (its floor) against this
 * FROM clause exactly as it does inside the sweep's `UPDATE agents`, so the
 * value discovery judges is the value the write will store.
 *
 * Discovery is the qualifying test WIDENED to admit the two classes this pass
 * CANNOT judge, so they are seen and counted rather than silently missing: a
 * stored value that will not canonicalize, and a fold that will not (legacy
 * mode). `COALESCE(<canonical fold> > <canonical stored>, 1)` is that widening
 * in one term — the comparison is NULL exactly when either operand is NULL, and
 * `COALESCE(NULL, 1)` admits the row — which keeps the fold to ONE evaluation in
 * the predicate. Neither class can ever be written: both make
 * {@link AGENT_ENDED_AT_QUALIFIES_SQL} false, and both are filtered out in JS
 * before chunking.
 *
 * The `legacy` flag column costs a SECOND fold evaluation, and that is a
 * deliberate trade the sibling session heal declined. It could afford to,
 * running awaited on the pre-sweep boot path where it measured 63ms vs 40ms;
 * this pass runs in the background chain on the reader pool, so the honest count
 * is worth more here than the saved scan.
 *
 * lexical-timestamp-ok: the `>` compares `AGENT_CANONICAL_ENDED_AT_SQL` against
 * `canonicalizeHealableTimestampSql(ended_at)` — BOTH operands are re-expressed
 * as fixed-width canonical UTC inside session-timestamp-form.ts before the
 * comparison sees them, so byte order IS time order here. Either operand is NULL
 * exactly when its re-expression is impossible, and the enclosing `COALESCE(…,1)`
 * routes that row to the `legacy`/`unreadable` counts instead of to a write —
 * so a value this gate would be right to distrust is never compared, only
 * reported. ISS-5330's gate cannot follow the interpolated expressions into that
 * module, so the marker is how that is declared.
 */
const AGENT_ENDED_AT_DISCOVERY_SQL = `SELECT
    ${AGENT_BUMP_ROW_PROJECTION_SQL},
    CASE WHEN ${CANONICAL_STORED_ENDED_AT_SQL} IS NULL THEN 1 ELSE 0 END AS unreadable,
    CASE WHEN ${AGENT_CANONICAL_ENDED_AT_SQL} IS NULL THEN 1 ELSE 0 END AS legacy
  FROM agents
 WHERE ended_at IS NOT NULL
   AND ${AGENT_TERMINAL_STATUS_SQL}
   AND ${AGENT_HAS_NON_CANONICAL_FOLD_OPERAND_SQL}
   AND COALESCE(
         ${AGENT_CANONICAL_ENDED_AT_SQL} > ${CANONICAL_STORED_ENDED_AT_SQL},
         1
       )`;

/**
 * The repair, assigning the SAME expression the post-ISS-6893 sweep assigns.
 * Discovery has already established that the canonical arm is non-NULL and
 * strictly later for every id here, so this `COALESCE` resolves to that arm —
 * the value discovery compared — and the write is convergent.
 *
 * `agents.updated_at` is bumped so the row does not claim to be older than its
 * corrected `ended_at`; it is NOT what carries the correction to the cloud (the
 * sync cursor reads `sessions.updated_at` only — see `bumpableSessionIds`).
 *
 * The WHOLE qualifying test is RE-ASSERTED here rather than trusted from the id
 * list, and that is load-bearing rather than defensive. Discovery runs on
 * `prisma.read()`, OUTSIDE the write queue that serializes this transaction, so
 * a row can stop qualifying in between — and `agents.ended_at` has a SECOND
 * legitimate writer whose value is deliberately not the event fold:
 * `advanceTerminalEndedAt` (write-core-terminal-end.ts) advances the main agent
 * to the session's PARSED end. An id-only `WHERE` would let this pass overwrite
 * that fresher parser evidence with an older fold, and unlike everything else
 * here that damage would NOT be self-correcting — once written, stored equals
 * the fold, so the next boot's discovery sees a healthy row and never revisits
 * it. Re-asserting makes the write skip such a row instead; it is picked up on a
 * later boot if it still qualifies then.
 *
 * This is where this pass diverges from `healSessionLastActivityAtFloor`, which
 * writes blind under the same shape. That is safe THERE because
 * `last_activity_at` has exactly one derivation and every writer computes it the
 * same way, so a racing write cannot disagree. `ended_at` does not have that
 * property, so the precedent's blind write is not the part to copy.
 */
function buildAgentEndedAtUpdateSql(idCount: number): string {
  const placeholders = Array.from(
    { length: idCount },
    (_, index) => `$${index + 2}`
  ).join(", ");
  return `UPDATE agents
       SET ended_at = ${AGENT_ENDED_AT_VALUE_SQL},
           updated_at = $1
     WHERE id IN (${placeholders})
       AND ${AGENT_ENDED_AT_QUALIFIES_SQL}`;
}

/**
 * The distinct owning sessions to bump, which is what actually ships the
 * correction: `listUpdatedSessionCursorRows` (sync-source.ts) selects on
 * `sessions.updated_at` and never looks at `agents.updated_at`, and hydration
 * then re-reads every agent row fresh, so bumping the session is both necessary
 * and sufficient for the corrected `endedAt` to reach the cloud payload.
 *
 * `active` sessions are EXCLUDED for the reason `healSessionLastActivityAtFloor`
 * excludes them: the orphan sweep's only predicate on an active row is
 * `updated_at < cutoff`, so bumping one lifts a genuinely-stale session out of
 * the sweep and keeps it alive. A terminal agent can sit inside a still-active
 * session (a finished subagent of a running run), so the case is reachable here.
 *
 * Where the correction then comes from, spelled out because THIS pass will not
 * retry it: once the agent row is written, the discovery predicate is false for
 * it forever, so no later boot re-attempts the withheld bump. Delivery is handed
 * to the session's own lifecycle, and both exits bump `updated_at` and carry the
 * already-corrected `ended_at` with them — ordinary ingest while the session
 * stays live, or `sweepStaleActiveSessions` once it passes the staleness cutoff.
 * That sweep cannot clobber the repair on the way out: its agent arm skips
 * `completed`/`error` rows, which is exactly this pass's population.
 */
function bumpableSessionIds(rows: readonly AgentEndedAtBumpRow[]): string[] {
  return [
    ...new Set(
      rows
        .filter((row) => row.sessionStatus !== SESSION_STATUS.ACTIVE)
        .map((row) => row.sessionId)
    ),
  ];
}

/**
 * Which ids of a chunk still qualify, read inside the repair transaction so the
 * session bump can name the rows that were WRITTEN rather than the rows that
 * were discovered. Applies the SAME {@link AGENT_ENDED_AT_QUALIFIES_SQL} the
 * UPDATE re-asserts, so the two cannot disagree about what "writable" means, and
 * re-reads `sessions.status` rather than trusting discovery's copy.
 */
function buildAgentEndedAtRecheckSql(idCount: number): string {
  const placeholders = Array.from(
    { length: idCount },
    (_, index) => `$${index + 1}`
  ).join(", ");
  return `SELECT ${AGENT_BUMP_ROW_PROJECTION_SQL}
     FROM agents
    WHERE id IN (${placeholders})
      AND ${AGENT_ENDED_AT_QUALIFIES_SQL}`;
}
