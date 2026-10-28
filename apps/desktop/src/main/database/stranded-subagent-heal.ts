/**
 * @file stranded-subagent-heal.ts
 * @description ISS-7474: close subagents left non-terminal on a session that is
 * already terminal.
 *
 * ISS-6902 fixed the FORWARD path — `Stop(stop_reason='error')` now runs
 * `closeNonTerminalAgents` before it flips the session to `error`, so no NEW
 * subagent is stranded. It deliberately did not touch rows stranded by an
 * earlier release, and NOTHING ELSE REACHES THEM:
 *
 *  - `sweepStaleActiveSessions` selects `status = 'active'` sessions only, so it
 *    cannot see a subagent whose parent is already terminal.
 *  - `maybeReactivate` never revives an `error` session.
 *  - Reimport does not reach them either: `write-core.ts` re-derives only the
 *    PARSER-OWNED subagent rows, and the live-hook spawner's rows — which is
 *    exactly this population — are spared by construction.
 *
 * `sync-source.ts` exports `agents.status` onto the wire verbatim, so each of
 * these rows is already telling the cloud that a finished subagent is still
 * working, indefinitely.
 *
 * ── `completed`, never `error` ────────────────────────────────────────────────
 * The closing status is {@link DESKTOP_AGENT_STATUS.COMPLETED}, and that is a
 * correctness constraint rather than a preference. `matchSubagent`
 * (live-hook.ts) admits `working` and `completed` candidates only, so an `error`
 * subagent sits outside BOTH of its candidate sets: a late `SubagentStop` would
 * then be recorded against a null agent AND skip its sidecar transcript ingest.
 * `review-soul` caught that as a data-loss regression on #5553. It is also the
 * call `sweepStaleChunk` already makes for this same population (ISS-4586) — the
 * RUN failed, its subagents individually did not.
 *
 * ── Why MAIN agents are out of scope ──────────────────────────────────────────
 * Not an omission. Both terminal hooks close the main agent BEFORE they close
 * the rest (`Stop(error)` stamps it `error` directly; `SessionEnd` passes the
 * session's own final status), so a main agent was never in the ISS-6902
 * stranding population. Widening to `type = 'main'` would also have to reproduce
 * the main/subagent status SPLIT that `sweepStaleChunk` applies — main takes
 * `error` on an error-ending session, subagents stay `completed` — which is a
 * second decision this repair has no stranded rows to justify.
 *
 * ── `ended_at` is filled, never overwritten ───────────────────────────────────
 * `COALESCE(ended_at, <fold>)`. A row that already carries an `ended_at` keeps
 * its own value: something recorded that outcome and this pass has no better
 * evidence than the writer that was there. The fold is
 * {@link AGENT_ENDED_AT_VALUE_SQL} — the SAME expression `sweepStaleChunk`
 * assigns, so the `started_at` floor and the ISS-5497 all-or-nothing
 * canonicalization guard are shared by construction rather than by copy, and a
 * closed subagent never gets the phantom idle tail (FEA-3266) that stamping
 * `now` would give it.
 *
 * ── Convergent, so idempotent, with no marker table ───────────────────────────
 * A healed row is `completed`, which no longer matches the discovery predicate,
 * so the next boot selects it again never. One bounded discovery, then a fixed
 * array walked in chunks — nothing re-queries from the head, so it cannot spin.
 *
 * Runs in the background boot-maintenance chain (`boot-maintenance.ts`), not on
 * the awaited pre-sweep path: nothing either boot sweep reads depends on it.
 */

import { DESKTOP_AGENT_STATUS, TERMINAL_STATUSES } from "./db-constants.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { SESSION_ANALYTICS_BACKFILL_CHUNK } from "./session-analytics-rollup.js";
import {
  bumpSessionsUpdatedAt,
  chunkWatermark,
} from "./session-sync-watermark.js";
import { AGENT_ENDED_AT_VALUE_SQL } from "./session-timestamp-form.js";

export type StrandedSubagentHealResult = {
  /** Subagent rows actually written, never the discovered chunk size. */
  healed: number;
  failedChunks: number;
  /**
   * Discovered candidates a SUCCEEDING chunk's re-assertion declined — the row
   * or its session changed between the reader-pool discovery and the write.
   * Counted because `healed + failedChunks` alone cannot express a partial pass:
   * with every chunk committing, a heal that reached only some of its corpus is
   * indistinguishable from one that reached all of it, and the caller would read
   * `failedChunks: 0` as "the corpus is repaired". Rows still stranded here
   * match again on the next boot (the pass is convergent); rows a live writer
   * closed on its own needed nothing.
   */
  skipped: number;
};

export async function healStrandedSubagents(
  prisma: DesktopPrisma,
  now: string,
  log: (message: string) => void,
  // The shared 25, matching `healSweptAgentEndedAt`. NOTE that the constant's
  // own name overstates what binds here: its value is sized against a `json_each`
  // heap ceiling (FEA-3056) this pass cannot hit, writing three scalar columns
  // per row. What actually binds is the sync cursor's tied-top `updated_at`
  // group, which the per-chunk watermark below keeps narrow.
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<StrandedSubagentHealResult> {
  // Discovery goes through the READER pool, never `prisma.client` — that handle
  // IS the single writer connection, and putting this pass's largest read on it
  // would sit ahead of live-hook ingest and both sync lanes rather than in the
  // write queue's fairness system. Same shape as `healSweptAgentEndedAt`.
  const candidates = await prisma.read((reader) =>
    reader.$queryRawUnsafe<StrandedSubagentRow[]>(
      STRANDED_SUBAGENT_DISCOVERY_SQL,
      now
    )
  );
  if (candidates.length === 0) {
    return { healed: 0, failedChunks: 0, skipped: 0 };
  }

  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  let healed = 0;
  let failedChunks = 0;
  let skipped = 0;
  for (let start = 0; start < candidates.length; start += safeChunkSize) {
    const chunk = candidates.slice(start, start + safeChunkSize);
    // FEA-3485: each chunk gets its OWN strictly-increasing watermark so a
    // multi-chunk heal does not collapse the whole corrected set onto one
    // sync-cursor top `updated_at`.
    const chunkNow = chunkWatermark(now, start / safeChunkSize);
    try {
      const written = await prisma.write((client) =>
        client.$transaction(async (tx) => {
          const rows = await tx.$queryRawUnsafe<StrandedSubagentRow[]>(
            buildStrandedSubagentUpdateSql(chunk.length),
            chunkNow,
            ...chunk.map((row) => row.id)
          );
          // The bump set is derived from what the UPDATE actually WROTE, not
          // from the discovery chunk. A chunk-mate that stopped qualifying must
          // not drag its session along: that would re-queue it to the cloud for
          // a correction that never happened, and hand the retention purge an
          // outbox row to defer on.
          const sessionIds = [...new Set(rows.map((row) => row.sessionId))];
          if (sessionIds.length > 0) {
            await bumpSessionsUpdatedAt(tx, sessionIds, chunkNow);
          }
          return rows.length;
        })
      );
      healed += written;
      // Tallied only on the COMMITTED path: a chunk that threw is described by
      // `failedChunks`, and counting its rows here too would report the same
      // candidates under two different outcomes.
      skipped += chunk.length - written;
    } catch (error) {
      failedChunks += 1;
      log(
        `stranded subagent heal failed for chunk [${start}, ${start + chunk.length}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (healed > 0) {
    log(
      `stranded subagent heal (ISS-7474): closed ${healed} subagent(s) left running on a terminal session`
    );
  }
  if (skipped > 0) {
    // Said out loud, because "no chunk failed" is NOT "the corpus is repaired".
    log(
      `stranded subagent heal: ${skipped} discovered candidate(s) no longer qualified at write time and were left as stored; any still stranded are re-selected next boot`
    );
  }
  if (failedChunks > 0) {
    log(
      `stranded subagent heal: ${failedChunks} chunk(s) failed, will retry next boot`
    );
  }
  return { healed, failedChunks, skipped };
}

/** The agent and the session that owns it — what the sync bump needs. */
type StrandedSubagentRow = {
  id: string;
  sessionId: string;
};

const NON_TERMINAL_SUBAGENT_SQL = `agents.type = 'subagent'
   AND agents.status NOT IN ('${DESKTOP_AGENT_STATUS.COMPLETED}', '${DESKTOP_AGENT_STATUS.ERROR}')`;

/**
 * ISS-5259: the boundary, and why it is on `sessions.updated_at`.
 *
 * This pass BUMPS `sessions.updated_at` to ship the correction, and boot
 * maintenance runs concurrently with live writers. Without a boundary, a session
 * a live writer touched after `now` was read would have its NEWER stamp
 * overwritten by this pass's OLDER one — and if the durable sync cursor had
 * already passed the newer value, the corrected row would sit BEHIND the cursor
 * and never sync at all. The property that closes that is: EVERY bump must be
 * strictly forward, in exactly the ordering `listUpdatedSessionCursorRows`
 * compares. A held-back row is not lost: the pass is convergent, so it still
 * matches on the next boot.
 *
 * So the bound is stated against the stamp being WRITTEN, and the two call sites
 * pass different ones on purpose:
 *
 *  - DISCOVERY passes the pass-start `now`, which keeps the candidate set to
 *    sessions quiescent when the scan ran.
 *  - The WRITE passes THAT CHUNK'S watermark, which is the value it is about to
 *    store. Pinning the write to pass-start instead would make this pass fight
 *    ITSELF: the chunk watermarks are `now + chunkIndex` ms, so as soon as one
 *    chunk bumps a session to `now`, every LATER chunk holding a candidate of
 *    that same session reads its own pass's bump as a live write and returns no
 *    rows. Any terminal session with more stranded subagents than the chunk size
 *    would then be half-repaired, silently, with `failedChunks` still 0.
 *    Comparing against the chunk watermark cannot do that — `chunkWatermark` is
 *    strictly increasing, so a value this pass wrote is always strictly below
 *    the next chunk's — while still rejecting any live write at or above it.
 *
 * The re-check and the bump run in ONE transaction on the single writer
 * connection (`prisma.write` serializes through the write queue), so no writer
 * interleaves between them and the bump this admits is forward at commit time,
 * not merely forward when it was judged.
 *
 * A NULL `updated_at` is included — it is invisible to the cursor today, so
 * stamping it can only move it forward.
 */
function sessionBumpIsForwardSql(bumpParam: string): string {
  return `(sessions.updated_at IS NULL OR sessions.updated_at < ${bumpParam})`;
}

/**
 * Reuses `TERMINAL_STATUSES` rather than re-spelling the pair: building from
 * `SESSION_STATUS` would survive a value RENAME but not a MEMBERSHIP change, and
 * membership on this axis has already moved once (ISS-4586 dropped
 * `completed`/`abandoned`). Since this pass is by its own premise the only thing
 * that reaches these rows, a stale copy here would strand a population nothing
 * else revisits.
 */
const TERMINAL_SESSION_SQL = `sessions.status IN ${TERMINAL_STATUSES}`;

const STRANDED_SUBAGENT_DISCOVERY_SQL = `SELECT
    agents.id AS id,
    agents.session_id AS sessionId
  FROM agents
  JOIN sessions ON sessions.id = agents.session_id
 WHERE ${NON_TERMINAL_SUBAGENT_SQL}
   AND ${TERMINAL_SESSION_SQL}
   AND ${sessionBumpIsForwardSql("$1")}`;

/**
 * The repair. `RETURNING` reports the rows that were actually written, which is
 * what the session bump is derived from.
 *
 * The WHOLE qualifying test is RE-ASSERTED here rather than trusted from the id
 * list, and that is load-bearing rather than defensive: discovery ran on
 * `prisma.read()`, OUTSIDE the write queue that serializes this transaction, so
 * between the two a live hook can have closed the subagent on its own or
 * `maybeReactivate` can have pulled the session back to `active`. Re-asserting
 * makes the write skip such a row instead of overwriting a fresher decision with
 * this pass's older one.
 *
 * The session guard is bound to `$1`, the chunk watermark this statement also
 * STORES — see {@link sessionBumpIsForwardSql} for why it is that stamp and not
 * the pass start, and what a pass-start binding does to a session whose
 * candidates span more than one chunk.
 *
 * lexical-timestamp-ok: the only comparison this statement makes on a timestamp
 * column is `sessions.updated_at < $1` against a `Date#toISOString` stamp, which
 * is the same raw-string ordering `listUpdatedSessionCursorRows` itself uses on
 * that column. The `ended_at` write performs no comparison at all — it is a
 * `COALESCE`, and the fold inside {@link AGENT_ENDED_AT_VALUE_SQL} canonicalizes
 * its own operands (session-timestamp-form.ts) before any `MAX` sees them.
 *
 * Positional parameters: `$1` chunk watermark, `$2…` agent ids.
 */
function buildStrandedSubagentUpdateSql(idCount: number): string {
  const placeholders = Array.from(
    { length: idCount },
    (_, index) => `$${index + 2}`
  ).join(", ");
  return `UPDATE agents
       SET status = '${DESKTOP_AGENT_STATUS.COMPLETED}',
           ended_at = COALESCE(ended_at, ${AGENT_ENDED_AT_VALUE_SQL}),
           updated_at = $1
     WHERE agents.id IN (${placeholders})
       AND ${NON_TERMINAL_SUBAGENT_SQL}
       AND EXISTS (
             SELECT 1 FROM sessions
              WHERE sessions.id = agents.session_id
                AND ${TERMINAL_SESSION_SQL}
                AND ${sessionBumpIsForwardSql("$1")}
           )
 RETURNING id, session_id AS sessionId`;
}
