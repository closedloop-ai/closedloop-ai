/**
 * @file data-revision.ts
 * @description Versions the semantics of parser/import-derived DB rows (FEA-1785).
 *
 * Every session row is stamped with the current revision at import time. On boot, the
 * rebuild pass (data-revision-rebuild.ts) queries for sessions whose
 * data_revision differs from the current value, re-parses them from source
 * transcripts, and transactionally replaces the derived rows. Pre-existing rows
 * (before the data_revision column existed) carry the column DEFAULT of 1,
 * making them implicitly revision 1.
 *
 * ISS-9283 — the equivalence-class ruling. EVERY value that is not the current
 * current revision is one class: "re-derive this row from source". The stamp
 * SELECTS a row for rebuild; it does not SHAPE the record. No production code
 * branches on the stored number to shape a record: every SENTINEL-VS-REAL read
 * is an ELIGIBILITY screen against
 * MIN_REAL_DATA_REVISION (`deferSentinelRevisionCandidates` in
 * `main/agent-sync/agent-session-sync-dispositions.ts`, which reads it through
 * `isSealedDataRevision`, and `sqliteSelectRedrivableSessionDeadLetters` in
 * `main/database/sync-outbox-store.ts`), never a per-revision transform — which
 * is exactly why that constant is a sentinel boundary and not a floor. Those
 * two are the sentinel screens, NOT every read of the column: the rebuild
 * selection (`database/sqlite-maintenance-facade.ts`), the content-change
 * comparison against the current revision
 * (`database/write-core-import-phases-session.ts`), and the import-pending row
 * count (`database/store-health-methods.ts`) all read it too, and none of them
 * is a sentinel-vs-real screen — so a claim about ALL reads is wider than the
 * one this paragraph makes. The
 * rebuild is not a migration either —
 * it is teardown-and-reimport through `importSessionWithTx`
 * (`main/database/write-core.ts`), which runs the SAME `buildImportSessionContext`
 * + `importPhase*` sequence a fresh import runs. The two entry points differ only
 * in transaction shape — a fresh import goes through `importSessionIsolated`,
 * committing each record group independently, while the rebuild needs one
 * caller-supplied transaction so a mid-rebuild failure rolls the teardown back —
 * never in how the record is derived. So there is no migration
 * chain, no transform table, and no versioned parser anywhere in the tree. A
 * row stamped 47 is therefore NOT a "revision-47 record": a genuine one would
 * be the output of the revision-47 parser, which no longer exists. The ledger
 * in `docs/desktop-data-revision-history.md` is PROSE documenting past semantic
 * changes, not a set of migratable states, and it must not be read as one.
 *
 * Three consequences that are load-bearing, and that a future optimization is
 * likely to break:
 *
 *  - Selection is a SET INEQUALITY WITH NO FLOOR (`dataRevision: { not:
 *    currentRevision }`, `database/sqlite-maintenance-facade.ts`). Not `lt`,
 *    not `gte`, no partitioning. A sentinel row, a revision-1 row, and a row a
 *    downgraded build stamped AHEAD of us all enter the identical path.
 *  - COMPONENT_INVOCATION_STORED_REBUILD_REVISION is a FEATURE floor for stored
 *    invocations and MIN_REAL_DATA_REVISION is the sentinel boundary. Neither
 *    is a retention floor; do not promote either into the selection.
 *  - Retention is bound to RAW SOURCE and a TIME WINDOW, never to a derived
 *    revision (ISS-7708: "raw/source session evidence retained independently of
 *    any one derived schema"). The 90-day sweep in
 *    `database/session-maintenance.ts` selects on status and last activity
 *    only — it never reads the source transcript, so EVERY terminal session past
 *    the cutoff is deleted regardless of whether its source still exists (its one
 *    further narrowing, the ISS-6031 undelivered-outbox deferral, is likewise
 *    revision-blind). Stranding a missing-source session at its old revision is
 *    the REBUILD pass's behaviour, not the sweep's: `data-revision-rebuild.ts`
 *    re-derives only sessions whose source transcript still exists and leaves the
 *    rest at their stored revision.
 *
 * Both properties are pinned by `test/retention-revision-bound-contract.test.ts`,
 * whose expectations are hand-written literals for a reason stated in its header.
 *
 * Revision history (what changed at each revision, and why): see
 * `docs/desktop-data-revision-history.md`.
 */
import { isSessionDisplayStale } from "@repo/api/src/types/session-status";
import { TERMINAL_STATUS_SET } from "../../database/db-constants.js";
import { SESSION_TIMESTAMP_EPOCH } from "../../database/session-timestamp-form.js";
import type { ParsePolicy } from "../../parse-policy/parse-policy.js";
export const COMPONENT_INVOCATION_STORED_REBUILD_REVISION = 39 as const;

/**
 * ISS-12552 (PRD-800 "Rollout"): the revision is a pair, chosen by the
 * parse policy. A Desktop with `attribution-evidence-policy` off stamps
 * {@link DATA_REVISION_BASE}, the revision main stamps (112, invocation
 * success verdicts); with it on, {@link DATA_REVISION_ATTRIBUTION}. A flip changes
 * the current revision, so the rebuild re-derives every session under the new
 * policy. A process reads its current one through `effectiveDataRevision()`
 * (`effective-parse-policy.ts`).
 */
export const DATA_REVISION_BASE = 112 as const;
export const DATA_REVISION_ATTRIBUTION = 113 as const;

export function dataRevisionFor(policy: ParsePolicy): number {
  return policy.attributionEvidence
    ? DATA_REVISION_ATTRIBUTION
    : DATA_REVISION_BASE;
}

/**
 * ISS-4572: the sentinel `data_revision` stamped on a session row by the ISOLATED
 * import path's FK-parent gate group BEFORE its later derived-row groups commit.
 * The real revision is stamped only by the final seal group, once
 * every group has committed without a per-session write-queue eviction.
 *
 * Why a sentinel is needed: the isolated import commits each record group in its
 * OWN write-queue transaction, and a genuinely-wedged group can be evicted by the
 * per-session import timeout (`cancelInFlightWrite`). If the gate had stamped the
 * real revision up front, an interrupted import would leave the session row at the
 * CURRENT revision with its events / token_usage / artifact-link groups missing —
 * and `data-revision-rebuild` (which re-derives only rows whose `data_revision`
 * differs from the current value) would never re-heal it, so it would render as a
 * fully-imported session with zero events until the next boot's re-import.
 * Stamping the sentinel first and sealing last means an interrupted import leaves
 * the row at `-1`, so the very next rebuild pass re-derives it.
 *
 * `-1` is chosen because every real revision the app has ever stamped is `>= 1`
 * (the column DEFAULT is 1 and every real revision is at least 1), so it can
 * never collide with a legitimately-stamped value and always satisfies the
 * rebuild's `data_revision != currentRevision` predicate.
 */
export const DATA_REVISION_IMPORT_PENDING = -1 as const;

/**
 * ISS-5260: the `data_revision` a MAINTENANCE PASS stamps on a session whose
 * derived rows are known stale for a reason the revision counter cannot express
 * — the evidence a derivation depends on changed AFTER the session was sealed at
 * the current revision, so a one-shot bump can never select it again.
 *
 * The concrete case is skill resolution ordering. The slash-invocation re-point
 * gates on a RESOLVED skill inventory row read at materialization time. A
 * session imported before the definition collector promotes `(skill, X)` to
 * resolved keeps its `(command, /X)` attribution and is sealed at the CURRENT
 * revision, after which nothing selects it. Migration 0045 handled the same
 * dependency by resetting `data_revision` on the affected sessions rather than
 * leaning on the bump, and this is that mechanism made repeatable — see
 * `database/skill-shadow-inventory-maintenance.ts`.
 *
 * `0` is chosen for the same reason `-1` was: the column DEFAULT is 1 and
 * every real revision is at least 1, so it can never collide with a
 * legitimately-stamped value and always satisfies the rebuild's
 * `data_revision != currentRevision` predicate. It is deliberately DISTINCT from
 * {@link DATA_REVISION_IMPORT_PENDING} so a row parked for re-derivation is not
 * mistaken in diagnostics for an import that was interrupted mid-flight.
 */
export const DATA_REVISION_MAINTENANCE_STALE = 0 as const;

/**
 * ISS-8601: what the rebuild may do with a stale-revision row.
 *
 * `Terminal` and `WedgedNonTerminal` are both REBUILDABLE and differ only in
 * accounting — the second is the cohort this ticket admits, and the selection
 * counts it so the backstop firing is visible in the log. `LiveCapture` is the
 * one refusal.
 *
 * Three-way rather than a boolean because the two callers ask different
 * questions: the selection has to tell an ordinary terminal row from an admitted
 * wedged one, while the in-transaction guards only care whether the row is a
 * live capture. A boolean would have made the selection re-ask the terminal
 * question separately, which is how the duplicate status set this ticket deletes
 * came to exist.
 */
export const StaleRowAdmission = {
  Terminal: "terminal",
  WedgedNonTerminal: "wedged-non-terminal",
  LiveCapture: "live-capture",
} as const;
export type StaleRowAdmission =
  (typeof StaleRowAdmission)[keyof typeof StaleRowAdmission];

/**
 * ISS-8601: the ONE answer to "may the rebuild touch this row?", shared by the
 * selection and by both in-transaction guards.
 *
 * Before this ticket the answer was `TERMINAL_STATUS_SET.has(status)`, hand-rolled
 * at three sites, and it refused a NON-TERMINAL row forever. That is correct for a
 * live capture — rebuilding mid-capture races the live write paths — but it also
 * refused rows the live write paths can never reach again: `sweepStaleActiveSessions`
 * holds back any row whose timestamps are not canonical UTC and leaves it
 * completely untouched, so it stays `active` for good, outside the retention purge
 * AND outside every rebuild. Nothing ever healed those.
 *
 * The age bound separates the two. A non-terminal row that has been silent longer
 * than the product's own {@link STALE_SESSION_DISPLAY_THRESHOLD_HOURS} is not a
 * capture in progress; it is one the 180-minute sweep demonstrably failed to heal,
 * and 24h is deliberately 8x that window so only those reach here.
 *
 * FAIL CLOSED on an anchor we cannot read: `isSessionDisplayStale` answers `false`
 * for a null, absent or unparseable timestamp, so such a row is treated as a live
 * capture and refused. A row whose age cannot be established is never assumed dead.
 * That leaves the unparseable remainder of the held-back cohort still refused,
 * which is the deliberate, conservative half of this trade.
 *
 * The EPOCH DEFAULT fails closed for the same reason, and it is the one value that
 * would otherwise slip through, because it parses. `sessions.last_activity_at` is
 * NOT NULL with a `1970-01-01T00:00:00.000Z` default and the INSERT on the isolated
 * import path does not write it — the real value lands in a LATER write-queue group. So
 * a row whose import is still in flight, and durably any row whose import was
 * evicted between those groups, carries the default and would read as 56 years
 * silent. That is a column default nothing ever wrote, not evidence of silence,
 * and admitting it would tear down a session mid-import and stamp over the
 * `DATA_REVISION_IMPORT_PENDING` sentinel that exists so an interrupted import
 * re-heals instead of sealing with derived rows missing.
 *
 * `now` is the STORE's clock, not the wall clock — see the caller in
 * `data-revision-rebuild.ts`, which awaits it once, and the note on
 * `SqliteAgentDatabase.now`.
 */
export function classifyStaleRow(
  row: { status: string; lastActivityAt?: string | null },
  now: Date
): StaleRowAdmission {
  if (TERMINAL_STATUS_SET.has(row.status)) {
    return StaleRowAdmission.Terminal;
  }
  if (row.lastActivityAt === SESSION_TIMESTAMP_EPOCH) {
    return StaleRowAdmission.LiveCapture;
  }
  return isSessionDisplayStale(row.lastActivityAt, now)
    ? StaleRowAdmission.WedgedNonTerminal
    : StaleRowAdmission.LiveCapture;
}

/**
 * Should the stale-session rebuild fallback SKIP this session, and with what
 * result? Returns `null` when the rebuild should proceed.
 *
 * The boot-time stale list is advisory: it is a snapshot taken before the write
 * queue drains. Two things can change under it, and both are re-checked inside
 * the writer transaction rather than trusted from the snapshot.
 *
 *  - The session is a LIVE CAPTURE — non-terminal AND active within the staleness
 *    bound. It heals through ordinary import instead, so report it as an active
 *    race. ISS-8601 narrowed this arm from "non-terminal" to "live": a non-terminal
 *    row that has been silent past the bound is admitted, because no ordinary
 *    import is coming for it. Since the row is re-read HERE, inside the
 *    transaction, a row that genuinely revived since the snapshot carries a fresh
 *    `last_activity_at` and is still refused — the guard got more precise, not
 *    looser, and `activeRace` now means what its name says.
 *  - whitlockk (#4255): an ordinary watcher import finished AFTER the snapshot and
 *    sealed the session at the CURRENT revision — it is terminal and already
 *    fresh. Rebuilding anyway would delete that fully-derived invocation set,
 *    reconstruct it from stored rows (which cannot emit Hook candidates), and
 *    re-stamp the same revision, so nothing would ever select it again. A
 *    session already at the current revision is a no-op, not a rebuild.
 */
export function staleRebuildSkip(
  session: {
    status: string;
    dataRevision: number;
    lastActivityAt?: string | null;
  } | null,
  currentRevision: number,
  now: Date
): { rebuilt: false; activeRace: boolean } | null {
  if (!session) {
    return { rebuilt: false, activeRace: false };
  }
  if (classifyStaleRow(session, now) === StaleRowAdmission.LiveCapture) {
    return { rebuilt: false, activeRace: true };
  }
  if (session.dataRevision === currentRevision) {
    return { rebuilt: false, activeRace: false };
  }
  return null;
}
