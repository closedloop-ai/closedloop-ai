/**
 * @file session-maintenance.ts
 * @description Session-maintenance writes on the single `DesktopPrisma` client.
 * Kept out of the electron-tainted sqlite.ts module so it (and its test) can
 * import only the Prisma facade and run electron-free.
 *
 * Two shapes live here. `sweepOrphanedSessions` / `sweepExpiredSessions` are
 * standalone write TRANSACTIONS (they open their own via `prisma.write`).
 * `sweepStaleActiveSessions` (ISS-5182) is a transaction BODY taking the
 * caller's `tx`, because the live `SessionStart` lane runs it inside the hook
 * transaction it shares with the rest of that hook's writes.
 */
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  DESKTOP_AGENT_STATUS,
  EVENT_INSERT_PARAM_CAP,
  TERMINAL_STATUS_SET,
} from "./db-constants.js";
import type { Prisma } from "./generated/client.js";
import type { DesktopPrisma } from "./prisma-client.js";
import {
  isCanonicalUtcTimestamp,
  SESSION_STARTED_AT_FLOOR_SQL,
  sessionStartedAtFloor,
} from "./session-timestamp-form.js";

// Terminal session statuses: a session in any of these is finished and is the
// only retention-sweep candidate. ISS-4586: `inactive` is the canonical
// terminal-not-failed state; the legacy `completed`/`abandoned` stay listed so
// not-yet-migrated rows remain sweepable.
//
// ISS-5182: these were previously re-declared as local string literals, on the
// stated grounds that importing them would taint this electron-free module.
// That is not what the import costs: `db-constants.ts` pulls in zod and the
// `@repo/api` branch type graph via `session-artifact-link`, but nothing
// electron — and the electron-free `token-cost-maintenance.ts` has always
// imported from it. The duplicate was the exact shape this file's own sweep
// divergence took, so it now reads from the canonical set. Named
// `_VALUES` because `db-constants.ts` already exports a `TERMINAL_STATUSES`
// that is a parenthesized SQL fragment, not an array.
const TERMINAL_STATUS_VALUES = [...TERMINAL_STATUS_SET];

/**
 * Session ids bound per swept statement. Each statement binds `now` plus one
 * placeholder per id, so the id budget is the repo's conservative
 * `EVENT_INSERT_PARAM_CAP` (see db-constants.ts — libSQL's default
 * `SQLITE_MAX_VARIABLE_NUMBER` is 999 on older builds) minus that one.
 *
 * ISS-5492: `sweepExpiredSessions` chunks against the same constant. Its child
 * deletes bind one parameter per expired session id too, and its id list is
 * corpus-sized on the first boot of an install older than the retention window.
 *
 * ISS-5182: the live lane did not need this before — it looped one session at a
 * time and bound 2-3 parameters per statement, so it was immune by
 * construction. Sharing the boot body makes the unbounded `IN (…)` list
 * reachable from `SessionStart`, where an overflow would abort the caller's
 * whole hook transaction (losing the session upsert and its SessionStart
 * event), and the boot reaper would fail on the same backlog — wedging every
 * subsequent hook. Chunking keeps each statement inside the cap.
 *
 * Exported so the over-chunk regression suite sizes its fixture from the REAL
 * boundary instead of a hardcoded number that would silently stop crossing it
 * if the cap ever changed.
 */
export const SWEEP_ID_CHUNK = EVENT_INSERT_PARAM_CAP - 1;

/**
 * The agent-scoped reading of {@link SESSION_STARTED_AT_FLOOR_SQL}. The
 * expression references an UNQUALIFIED `started_at`, so inside an
 * `UPDATE agents` it resolves to the agent's own start — the same GLOB guard
 * and 1970 fallback, applied to the other table. Aliased rather than re-spelled
 * so the two floors cannot drift.
 */
const AGENT_STARTED_AT_FLOOR_SQL = SESSION_STARTED_AT_FLOOR_SQL;

/**
 * How long a session may sit `active` with no write before a sweep declares it
 * terminal. Shared by both entry points so the live and boot sweeps cannot
 * drift to different thresholds.
 */
export const DEFAULT_STALE_SESSION_MINUTES = 180;

// Default data-governance retention window, in days. Terminal sessions whose
// last activity predates this window are purged outright — see
// `sweepExpiredSessions`. 90 days bounds how long the local store keeps full
// session history (transcripts, tool calls, token usage, agents).
const DEFAULT_RETENTION_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60_000;

/**
 * ISS-5429: the outcome of one stale-session sweep.
 *
 * `heldBack` is not a success count — it is a BAD-DATA SIGNAL the caller MUST
 * report. Before ISS-5429 the held-back rows were counted nowhere and logged
 * nowhere, so a session could sit `active` in the Sessions UI indefinitely with
 * nothing anywhere saying why.
 */
export type StaleSessionSweepResult = {
  /** Sessions this sweep declared terminal. */
  swept: number;
  /**
   * Stale rows this sweep left completely untouched because their timestamps
   * are not in the canonical UTC form — see {@link hasCanonicalTimestampForm}.
   */
  heldBack: number;
};

/**
 * ISS-6031: the outcome of one retention sweep.
 *
 * `deferredUndelivered` is not a failure count and it is not noise — it is the
 * number of past-window sessions this sweep deliberately did NOT purge because
 * the cloud has not acknowledged them yet. Reported separately so a store that
 * is quietly accumulating undeliverable history is visible in the boot log
 * instead of looking identical to a store with nothing to purge.
 */
export type ExpiredSessionSweepResult = {
  /** Sessions this sweep deleted, with every session-keyed child row. */
  purged: number;
  /**
   * Past-window sessions left in place because they still hold an UNRESOLVED row
   * in `agent_session_sync_outbox` — data that has never reached the cloud. The
   * row is deleted only by `clearOutboxOnAck`, so its continued existence in
   * EITHER status is the whole signal; they become purgeable on a later boot
   * once a verified ack removes it.
   */
  deferredUndelivered: number;
};

/** The stale-row projection both the guard and the chunk loop read. */
type StaleSessionRow = {
  id: string;
  endsWithError: number | null;
  startedAt: string | null;
  lastActivityAt: string;
};

// Gap 8: Orphaned session cleanup — DECLARES stale 'active' sessions terminal.
// Called during boot import to clean up sessions interrupted by process kill /
// laptop close that never received a SessionEnd hook. ISS-4586: the reaper is
// one of the two paths (the importer is the other) that declares a session
// inactive, and it reads the durable `ends_with_error` flag persisted at import
// to decide the terminal status WITHOUT re-parsing the transcript: `error` when
// the last import saw the run end on an unrecovered error, else `inactive`. A
// swept session's non-terminal agents go to `completed`; the main agent of an
// error-ending session goes to `error`, mirroring `importedMainAgentStatus`.
export function sweepOrphanedSessions(
  prisma: DesktopPrisma,
  now: string,
  staleMinutes = DEFAULT_STALE_SESSION_MINUTES
): Promise<StaleSessionSweepResult> {
  // One atomic write transaction on the single client (serialized through the
  // shared queue via `write`). The live entry point (`SessionStart`) instead
  // joins the caller's open hook transaction, which is why the body below takes
  // a `tx` rather than opening its own.
  return prisma.write((client) =>
    client.$transaction((tx) =>
      sweepStaleActiveSessions(tx, { now, staleMinutes })
    )
  );
}

/**
 * The sweep itself, run inside the CALLER's transaction.
 *
 * ISS-5182: this was two near-identical copies — this one (boot) and
 * `sweepStaleSessions` in write-core.ts (live, on `SessionStart`). Their
 * selection rules were the same predicate, the same 180-minute threshold, and
 * the same `ends_with_error` terminal-status derivation; the only real
 * difference was excluding the session whose hook is in flight, which the boot
 * path does not have. The copies then drifted exactly as copies do — FEA-3580
 * and FEA-3266 corrected `ended_at` here and left the live twin stamping the
 * sweep wall clock, so a live-swept session carried a phantom idle tail of at
 * least `staleMinutes`. One body, two entry points, so a fix cannot land on one
 * and miss the other.
 *
 * `excludeSessionId` is the live path's in-flight session: it is mid-write and
 * must never be declared terminal by its own hook.
 *
 * `swept` is NOT necessarily the number found stale: a row whose timestamps are
 * not in the canonical UTC form is held back by
 * {@link hasCanonicalTimestampForm} and left completely
 * untouched. ISS-5429: that hold-back is now COUNTED in `heldBack` and reported
 * by both callers. It used to be counted nowhere and logged nowhere, so a row
 * the heals could not reach sat `active` in the Sessions UI indefinitely — and,
 * never reaching a terminal status, stayed outside the retention purge too —
 * with nothing anywhere saying so.
 *
 * Typed throughout: BOTH arms are raw set-based UPDATEs so each swept row's
 * `ended_at` can be set from its own true last activity rather than the sweep
 * time — the session arm from its denormalized `last_activity_at` column, the
 * agent arm from MAX(events.created_at) over the agent's own events (agents have
 * no `last_activity_at` column). See FEA-3580 (session) / FEA-3266 (agent) and
 * the inline notes below. Set-based also means the cost is 3 statements for the
 * whole stale set, not the 2-3 per row the live copy used to issue.
 */
export async function sweepStaleActiveSessions(
  tx: Prisma.TransactionClient,
  input: {
    now: string;
    staleMinutes?: number;
    excludeSessionId?: string;
  }
): Promise<StaleSessionSweepResult> {
  const { now } = input;
  const cutoff = new Date(
    new Date(now).valueOf() -
      (input.staleMinutes ?? DEFAULT_STALE_SESSION_MINUTES) * 60_000
  ).toISOString();
  const stale = await tx.session.findMany({
    where: {
      status: SESSION_STATUS.ACTIVE,
      updatedAt: { lt: cutoff },
      // ISS-5182: an EXPLICIT undefined check, not truthiness. An empty-string
      // id cannot reach here today (`processEvent` rejects it, and the hook
      // bumps the in-flight row's `updated_at` before sweeping), but a
      // truthiness test would silently widen the sweep to include the caller's
      // own session for any future caller that passes one — the exact failure
      // this exclusion exists to prevent.
      ...(input.excludeSessionId === undefined
        ? {}
        : { id: { not: input.excludeSessionId } }),
    },
    select: {
      id: true,
      endsWithError: true,
      // ISS-5182 (review): read the two timestamps the session arm's floor
      // compares, so a row whose text form makes that comparison unsound can be
      // held back — see `hasCanonicalTimestampForm`.
      startedAt: true,
      lastActivityAt: true,
    },
  });
  // ISS-5429 (review): ONE pass, not a `filter` and its negation — two passes
  // would evaluate the predicate twice per row and give it two call sites to
  // drift between.
  const sweepable: StaleSessionRow[] = [];
  let heldBack = 0;
  for (const row of stale) {
    if (hasCanonicalTimestampForm(row)) {
      sweepable.push(row);
    } else {
      heldBack += 1;
    }
  }
  for (let start = 0; start < sweepable.length; start += SWEEP_ID_CHUNK) {
    await sweepStaleChunk(
      tx,
      now,
      sweepable.slice(start, start + SWEEP_ID_CHUNK)
    );
  }
  return { swept: sweepable.length, heldBack };
}

/**
 * One bounded batch of the sweep — at most {@link SWEEP_ID_CHUNK} sessions, so
 * every statement stays inside the bound-parameter cap.
 */
async function sweepStaleChunk(
  tx: Prisma.TransactionClient,
  now: string,
  batch: readonly { id: string; endsWithError: number | null }[]
): Promise<void> {
  const staleIds = batch.map((row) => row.id);
  // ISS-4586: the error-ending swept sessions, by the durable flag persisted
  // at import. Their MAIN agent is set to `error` (below); the session arm
  // reads `ends_with_error` directly so it needs no id partition.
  const errorIds = batch
    .filter((row) => row.endsWithError === 1)
    .map((row) => row.id);
  // FEA-3266: a swept agent's `ended_at` must be its true LAST ACTIVITY, not
  // the sweep/boot time (`now`) — the same phantom-idle-tail bug FEA-3580
  // fixed for sessions. Agent duration is derived as `ended_at - started_at`
  // (see the subagent-type `avg_duration` in local-insights.ts), so stamping
  // `now` gives every swept agent a phantom idle tail of (sweepTime -
  // lastActivity), inflating that metric. Agents lack a denormalized
  // `last_activity_at` column, so derive it per-row from MAX(events.created_at)
  // over the agent's own events (GLOB-guarded to ISO timestamps).
  //
  // ISS-5182: the outer MAX is the FLOOR. This was previously a bare COALESCE,
  // which is a fallback, not a floor — when an agent HAS events but all of them
  // predate its `started_at` (a resumed session whose agent inherits
  // parent-transcript timestamps), the COALESCE took the earlier events value
  // and produced `ended_at < started_at`, i.e. a negative duration in
  // `avg_duration`. `recomputeSessionLastActivityAt` wraps its own COALESCE the
  // same way.
  //
  // ISS-5497 KNOWN GAP — this arm is NO LONGER the recompute's twin. That fold
  // now canonicalizes each `events.created_at` PER ROW first, so it compares
  // fixed-width text and writes canonical UTC, because a byte-wise `MAX()` over
  // that column — raw harness transcript text, and the one timestamp column the
  // FEA-3743 heal never repairs — returns the EARLIER instant on a
  // mixed-precision or offset-form column. The same defect is live here on
  // `agents.ended_at`, and `hasCanonicalTimestampForm` does NOT cover it: that guard
  // deliberately gates only on the session columns the heal repairs (see its
  // scope note), so `agents.ended_at` can still be stamped from the wrong event.
  // Left for its own change rather than folded into ISS-5497, which is scoped to
  // `sessions.last_activity_at`: correcting this moves swept-agent durations and
  // wants its own coverage.
  const agentPlaceholders = staleIds
    .map((_, index) => `$${index + 2}`)
    .join(", ");
  await tx.$executeRawUnsafe(
    `UPDATE agents
       SET status = '${DESKTOP_AGENT_STATUS.COMPLETED}',
           ended_at = MAX(
             ${AGENT_STARTED_AT_FLOOR_SQL},
             COALESCE(
               (
                 SELECT MAX(
                   CASE
                     WHEN e.created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
                       THEN e.created_at
                     ELSE NULL
                   END
                 )
                 FROM events e
                 WHERE e.agent_id = agents.id
               ),
               ${AGENT_STARTED_AT_FLOOR_SQL}
             )
           ),
           updated_at = $1
     WHERE session_id IN (${agentPlaceholders})
       AND status NOT IN ('${DESKTOP_AGENT_STATUS.COMPLETED}', '${DESKTOP_AGENT_STATUS.ERROR}')`,
    now,
    ...staleIds
  );
  // FEA-3580: a swept session's `ended_at` must be its true LAST ACTIVITY,
  // NOT the sweep/boot time (`now`). Duration is derived as
  // `ended_at - started_at` (durMs / session_analytics.runtime_ms), so
  // stamping `now` gives every swept session a phantom idle tail of
  // (sweepTime - lastActivity) — hours or days of dead time it never
  // worked — inflating wall/runtime. `updated_at` still reflects the sweep.
  //
  // ISS-5182: floored to `started_at` for the same reason the agent arm is.
  // `last_activity_at` is NOT NULL with a 1970 epoch default, and the boot
  // chain REFUSES to sweep when `healSessionLastActivityAtFloor` fails
  // (sqlite.ts) precisely because "sweeping unhealed rows could stamp pre-start
  // ended_at values". That refusal is local to the boot path and cannot gate
  // the live `SessionStart` lane, which now runs this same body — so the floor
  // has to live in the statement rather than in the caller. Both MAX arguments
  // are non-NULL by construction, which matters because SQLite's scalar
  // `max(a, b)` propagates NULL (unlike the aggregate `MAX(col)`).
  //
  // ISS-5182 (review): non-NULL is necessary but NOT sufficient — the floor is
  // only a floor for values whose TEXT order is their TIME order, and these are
  // TEXT columns, so `max(a, b)` compares BYTE-WISE. A legacy offset-form
  // `started_at` like `2026-06-22T07:00:00-05:00` is chronologically 12:00Z but
  // sorts BELOW `2026-06-22T10:00:00Z`, so MAX would return the wrong operand
  // and stamp `ended_at` BEFORE the true start — the exact negative duration
  // this floor exists to prevent. `hasCanonicalTimestampForm` therefore holds
  // such a row out of the swept set entirely, so this statement only ever runs
  // on rows where byte order is time order.
  //
  // lexical-timestamp-ok: `hasCanonicalTimestampForm` filters the swept set to
  // canonical `…Z` rows before this UPDATE runs, so the guard is upstream of the
  // statement rather than inside it. ISS-5330's gate cannot see a JS-side filter,
  // so the marker is how that is declared.
  await tx.$executeRawUnsafe(
    `UPDATE sessions
       SET status = CASE WHEN ends_with_error = 1 THEN '${SESSION_STATUS.ERROR}' ELSE '${SESSION_STATUS.INACTIVE}' END,
           ended_at = MAX(${SESSION_STARTED_AT_FLOOR_SQL}, last_activity_at),
           updated_at = $1
     WHERE id IN (${staleIds.map((_, index) => `$${index + 2}`).join(", ")})`,
    now,
    ...staleIds
  );
  // ISS-4586: the bulk agent arm above set EVERY swept agent (main included)
  // to `completed`. Override the MAIN agent of an error-ending session to
  // `error` so its terminal agent status matches the session's `error` and
  // the importer's `importedMainAgentStatus(ERROR)`. Subagents stay
  // `completed` — a failed run's own subagents still individually finished.
  if (errorIds.length > 0) {
    await tx.$executeRawUnsafe(
      `UPDATE agents
         SET status = '${DESKTOP_AGENT_STATUS.ERROR}', updated_at = $1
       WHERE type = 'main'
         AND session_id IN (${errorIds
           .map((_, index) => `$${index + 2}`)
           .join(", ")})`,
      now,
      ...errorIds
    );
  }
}

// Privacy / data-governance retention sweep. Deletes terminal
// (inactive/error, plus legacy completed/abandoned) sessions whose last activity
// predates the governance window, together with EVERY session-keyed child row —
// events/transcripts, token usage/events, codex trace spans, claude-code OTel
// rows, artifact links, pull-request detail and the derived analytics rollups —
// with agents removed via the sessions(id) FK cascade. Active/running sessions
// are never touched (re-checked by the status filter inside the same
// transaction). Returns {@link ExpiredSessionSweepResult}.
//
// ISS-6031: a past-window session that still owes the cloud a delivery is NOT
// purged. `agent_session_sync_outbox` holds one row per session that has been
// enqueued and not yet acked; deleting such a session destroys, on the only
// machine that has it, data that never reached the cloud — and the sync lane
// then reads an empty hydration for an id it is still holding. That was the
// measured loss: five sessions whose last activity predated the 90-day window
// were purged at boot while `pending` in the outbox, and every subsequent sync
// cycle dead-lettered them as "locally deleted after enqueue".
//
// The predicate is ROW EXISTENCE, in EITHER status — deliberately not `pending`
// alone. `dead_lettered` does not mean delivered and it is not terminal: it is a
// deferred retry that the lane re-drives from three places, each of which flips
// the row back to `pending` (`recoverExpiredDeadLetters` on window expiry and
// `promoteDeadLetterIfIdle` once backfill drains, both via
// `recordOutboxReEnqueue`; and `hydratePersistedCursorIfNeeded` re-seeds the
// persisted dead-letter set on a COLD RESTART, which is what feeds the latter).
// The shared lane contract says the same thing in one line — "recorded rather
// than dropped, so … a recovery pass can still re-drive it". Purging on
// `dead_lettered` would therefore delete the only local copy in the window
// between the boot sweep and the recovery pass that was about to re-send it,
// which is the very data-loss class this change exists to remove.
//
// The one status-blind consequence, stated rather than hidden: a row whose
// status is neither member (the column is unconstrained TEXT — see
// `asOutboxStatus`) also defers. That is the intended direction. An
// unrecognizable status is an unresolved delivery, and a wrong retention is
// recoverable where a wrong purge is not.
//
// So the deferral is bounded by DELIVERY, not by abandonment: only
// `clearOutboxOnAck` — a verified server ack — removes the row and lets the
// session purge on a later boot. A session the lane can never deliver is
// retained rather than destroyed, and `deferredUndelivered` in the boot log is
// what makes that visible instead of silent. Sessions with no outbox row at all
// are purged exactly as before — the outbox is the record of an OUTSTANDING
// delivery, not of a completed one, so its absence cannot be read as "never
// synced" (see the ISS-6031 PR for the remaining never-enqueued gap).
//
// One deferral is genuinely open-ended, and deliberately so: the sync lane
// retries an id whose absence it could not PROVE for as long as the row is
// there (`retainUnprovenCandidates`), so such a session stays `pending` and
// therefore stays retained past its window. That is the intended ordering —
// destroying data the cloud never received is strictly worse than holding it
// past a governance boundary — and it is visible, because the boot log reports
// the deferral count on every sweep.
//
// Unlike the inline delete paths in sqlite.ts (this module stays electron-free
// and cannot import that electron-tainted one), the sweep must leave NOTHING
// session-attributable behind: a retention purge has no reimport to rebuild
// derived state from. So the set is the union of every session-keyed table the
// codebase deletes — `deleteSessionRow`'s child set (which since FEA-2347 also
// purges the `session_analytics` / `session_tool_analytics` /
// `agent_component_session_usage` rollups and since FEA-3132 the
// `session_turn_bucket` per-turn rollup) plus `pull_requests` /
// `pr_backfill_seen` (cleared by `rebuildSessionFromParse`). The rollups matter
// because standalone reads (e.g. the earliest-history delta gate) scan
// `session_analytics` without a `sessions` join, so an orphaned rollup would
// otherwise leak a purged session's totals into the dashboard. One atomic write
// transaction on the single client, matching `sweepOrphanedSessions` above.
//
// ISS-5492: the child deletes are CHUNKED to `SWEEP_ID_CHUNK`, like the stale
// sweep above. The expired set is NOT one day's worth of sessions in general —
// the first boot on an install older than the retention window purges the whole
// backlog at once, so the id list is corpus-sized. Every delete here binds one
// parameter per id (including the raw `token_events` statement), and they all
// share one transaction, so a parameter-limit overflow rolled back the ENTIRE
// purge and then recurred identically on every subsequent boot rather than
// converging.
//
// What chunking does NOT change: the whole purge is still ONE interactive
// transaction, so it remains bounded by `TRANSACTION_TIMEOUT_MS` (120s, see
// prisma-client.ts) and holds off a WAL checkpoint for its duration. A backlog
// large enough to exceed that ceiling would roll back and re-fail the same way —
// converging that case needs per-chunk transactions, which would give up the
// all-or-nothing property this sweep is documented to have, so it is deliberately
// left alone here.
export function sweepExpiredSessions(
  prisma: DesktopPrisma,
  now: string,
  retentionDays = DEFAULT_RETENTION_DAYS
): Promise<ExpiredSessionSweepResult> {
  const cutoff = new Date(
    new Date(now).valueOf() - retentionDays * MS_PER_DAY
  ).toISOString();
  return prisma.write((client) =>
    client.$transaction(async (tx) => {
      // `lastActivityAt` is NOT NULL (epoch floor default, maintained at
      // ingest), so it is the robust age anchor for the cutoff.
      const expired = await tx.session.findMany({
        where: {
          status: { in: TERMINAL_STATUS_VALUES },
          lastActivityAt: { lt: cutoff },
        },
        select: { id: true },
      });
      if (expired.length === 0) {
        return { purged: 0, deferredUndelivered: 0 };
      }
      const candidateIds = expired.map((row) => row.id);
      const undelivered = await selectUndeliveredSessionIds(tx, candidateIds);
      const expiredIds = candidateIds.filter((id) => !undelivered.has(id));
      for (let start = 0; start < expiredIds.length; start += SWEEP_ID_CHUNK) {
        await purgeExpiredChunk(
          tx,
          expiredIds.slice(start, start + SWEEP_ID_CHUNK)
        );
      }
      return {
        purged: expiredIds.length,
        deferredUndelivered: undelivered.size,
      };
    })
  );
}

/**
 * One bounded batch of the retention purge — at most {@link SWEEP_ID_CHUNK}
 * sessions, so every statement stays inside the bound-parameter cap. Mirrors
 * {@link sweepStaleChunk}, which chunks the stale sweep for the same reason.
 *
 * Statement order is unchanged from the single-shot body this replaced: the
 * batch's child rows first, then its session rows, whose delete is what fires
 * the `agents` FK cascade.
 */
async function purgeExpiredChunk(
  tx: Prisma.TransactionClient,
  // A fresh `slice` from the caller, mutable because Prisma's `in` filter takes
  // a mutable array — hence no `readonly` here and no defensive copy inside.
  expiredIds: string[]
): Promise<void> {
  const where = { sessionId: { in: expiredIds } };
  await tx.event.deleteMany({ where });
  // token_events is @@ignore'd (no PK → no typed delegate); delete it raw,
  // with one positional placeholder per id, inside the same transaction.
  await tx.$executeRawUnsafe(
    `DELETE FROM token_events WHERE session_id IN (${expiredIds
      .map((_, index) => `$${index + 1}`)
      .join(", ")})`,
    ...expiredIds
  );
  // FEA-2267: session_activity_segments has no FK cascade, so purge it with
  // the session so the activity-timing rows do not outlive it.
  await tx.sessionActivitySegment.deleteMany({ where });
  // FEA-3132: session_turn_bucket has no FK cascade (buckets are re-derived
  // per import); a retention purge has no reimport, so clear it too so the
  // per-turn rows do not outlive the purged session.
  await tx.sessionTurnBucket.deleteMany({ where });
  await tx.tokenUsage.deleteMany({ where });
  await tx.codexTraceSpan.deleteMany({ where });
  await tx.claudeCodeCostEvent.deleteMany({ where });
  await tx.claudeCodePermissionEvent.deleteMany({ where });
  await tx.claudeCodeApiRequest.deleteMany({ where });
  await tx.sessionArtifactLink.deleteMany({ where });
  await tx.artifactLinkBackfillSeen.deleteMany({ where });
  await tx.activitySegmentBackfillSeen.deleteMany({ where });
  // Pull-request lifecycle detail (no FK cascade): session_id rows carry
  // identifying repo/branch/title/url, so purge them with the session.
  await tx.pullRequest.deleteMany({ where });
  await tx.prBackfillSeen.deleteMany({ where });
  // Derived rollups (no FK cascade): clear them too so a purged session
  // leaves no cost/token aggregates behind. FEA-2347: includes
  // agent_component_session_usage (previously missed here — same orphan
  // class as the analytics rollups).
  await tx.sessionAnalytics.deleteMany({ where });
  await tx.sessionToolAnalytics.deleteMany({ where });
  await tx.agentComponentSessionUsage.deleteMany({ where });
  // FEA-2273: session_activity_metrics is the same no-FK derived-rollup class
  // — purge it too so a retention sweep leaves no cohort/coverage row to leak
  // a purged session's spend into the aggregate GROUP BY reads.
  await tx.sessionActivityMetrics.deleteMany({ where });
  // agents cascade via the sessions(id) FK (foreign_keys=ON on the adapter
  // connection); the explicit deletes above cover the no-cascade tables.
  await tx.session.deleteMany({ where: { id: { in: expiredIds } } });
}

/**
 * ISS-6031: of `candidateIds`, which still owe the cloud a delivery?
 *
 * A session owes one exactly when `agent_session_sync_outbox` holds ANY row for
 * it, under ANY source key and in ANY status. Two deliberate widenings:
 *
 * - **Any source key.** The lane is keyed by (sourceKey, externalSessionId) and
 *   the sourceKey changes with the signed-in cloud identity, so scoping this
 *   probe to one key would let a purge slip through after an identity change
 *   while the row is still owed under the other.
 * - **Any status** (codex review). `dead_lettered` is a deferred retry, not a
 *   delivery receipt — `recoverExpiredDeadLetters`, `promoteDeadLetterIfIdle`
 *   and the cold-restart re-seed in `hydratePersistedCursorIfNeeded` all put
 *   such a row back on the wire — so filtering to `pending` would re-open the
 *   purge on exactly the rows a recovery pass was about to re-send. The status
 *   column is also unconstrained TEXT, so an unrecognized value defers too.
 *
 * What remains is a single identity-independent question — "has this been
 * handed off and not yet acked?" — answered by row existence, because
 * `clearOutboxOnAck` is the only writer that deletes a row.
 *
 * Chunked to {@link SWEEP_ID_CHUNK} for the same bound-parameter reason as the
 * purge itself (ISS-5492): the candidate list is corpus-sized on the first boot
 * of an install older than the retention window.
 */
async function selectUndeliveredSessionIds(
  tx: Prisma.TransactionClient,
  candidateIds: string[]
): Promise<Set<string>> {
  const undelivered = new Set<string>();
  for (let start = 0; start < candidateIds.length; start += SWEEP_ID_CHUNK) {
    const rows = await tx.agentSessionSyncOutbox.findMany({
      where: {
        externalSessionId: {
          in: candidateIds.slice(start, start + SWEEP_ID_CHUNK),
        },
      },
      select: { externalSessionId: true },
    });
    for (const row of rows) {
      undelivered.add(row.externalSessionId);
    }
  }
  return undelivered;
}

/**
 * ISS-5182 (review): may this stale row's `ended_at` be picked by a BYTE-WISE
 * comparison?
 *
 * The last-activity arm stamps `ended_at = MAX(started_at-floor,
 * last_activity_at)`, and these are TEXT columns, so SQLite's scalar
 * `max(a, b)` compares bytes, not instants. That is only equivalent to a
 * chronological max when both operands are in the canonical UTC `…Z` form
 * (fixed width ⇒ byte order is time order). A legacy offset form such as
 * `2026-06-22T07:00:00-05:00` is 12:00Z but sorts below
 * `2026-06-22T10:00:00Z`, so MAX would return the EARLIER instant and the sweep
 * would persist `ended_at` < `started_at`.
 *
 * The chosen resolution for a non-canonical row is to leave it entirely
 * UNSWEPT — no status change, no `ended_at`, and its agents untouched — rather
 * than stamp a value we know may be wrong. That is the same call the boot chain
 * already makes (it refuses to sweep at all when `healSessionLastActivityAtFloor`
 * fails), and unlike a refusal in the caller it also covers the live
 * `SessionStart` lane, which now runs this body. ISS-5429: the row is COUNTED
 * into `heldBack` and reported, which it never was, and the FEA-3743 heal it
 * converges on now discovers every DATE-SHAPED value rather than only
 * `YYYY-MM-DDT…` ones, so a shape it used to miss (a date-only
 * `last_activity_at`) is rewritten to `Z` form on the next boot and swept
 * normally instead of being stranded forever. ISS-5497 closed the reverse leak:
 * `recomputeSessionLastActivityAt` used to copy raw `events.created_at` text
 * back over the healed column on every hook event and every import, so for an
 * ACTIVE session the heal was not convergent at all and the hold-back could
 * recur without end; the recompute now emits canonical text.
 *
 * ISS-5429 (review): the test is over the FLOOR's value, not over the raw
 * `started_at`. A `started_at` the floor rejects — NULL, or any value its
 * date-prefix GLOB does not match — never reaches the comparison, because the
 * CASE substitutes the canonical 1970 literal. Reading the raw column instead
 * would hold back a row with, say, an empty-string `started_at` and a perfectly
 * canonical `last_activity_at`, whose MAX is in fact entirely sound.
 *
 * Scope note: the AGENT arm reads `agents.started_at` and `events.created_at`,
 * which are NOT in `HEALED_COLUMNS` — holding those back would strand the agent
 * non-terminal forever instead of converging, so this guard deliberately gates
 * only on the session columns the heal actually repairs.
 */
function hasCanonicalTimestampForm(row: StaleSessionRow): boolean {
  return (
    isCanonicalUtcTimestamp(row.lastActivityAt) &&
    isCanonicalUtcTimestamp(sessionStartedAtFloor(row.startedAt))
  );
}
