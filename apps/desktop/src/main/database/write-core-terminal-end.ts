/**
 * @file write-core-terminal-end.ts
 * @description The re-import reconciliation for a session row that is ALREADY
 * terminal: advance its frozen `ended_at` when a fresh parse proves the run went
 * on longer, then heal its failed-vs-completed classification.
 *
 * Extracted from `importPhaseSessionAndMainAgent` in `write-core.ts` (a
 * grandfathered over-ceiling file) so the terminal-end rules live in one place
 * with their own tests, and so `write-core.ts` shrinks rather than grows.
 */

import {
  SESSION_STATUS,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import type { NormalizedSession } from "../collectors/types.js";
import { TERMINAL_STATUS_SET } from "./db-constants.js";
import type { Prisma } from "./generated/client.js";
import {
  importedMainAgentStatus,
  resolveImportedSessionStatus,
} from "./imported-session-status.js";

/** The stored columns this reconciliation reads off the existing session row. */
type ExistingTerminalSession = {
  status: string;
  endedAt: string | null;
};

type ReconcileInput = {
  existing: ExistingTerminalSession;
  session: Pick<
    NormalizedSession,
    | "sessionId"
    | "endedAt"
    | "apiErrors"
    | "endedOnUnrecoveredError"
    | "messages"
  >;
  /** The `<sessionId>-main` agent id. */
  mainId: string;
  /** The import wall clock. */
  now: string;
};

/** What the caller needs after the reconciliation to rebuild a missing main agent. */
export type TerminalReconciliation = {
  /** The reconciled terminal status. */
  status: SessionStatus;
  /**
   * The row's `ended_at` AFTER this reconciliation — the advanced value when one
   * was written, else the stored one. The caller stamps this on a main agent it
   * has to recreate, so a recreated agent cannot be re-frozen at the pre-advance
   * end the stored row carried on entry.
   */
  endedAt: string | null;
};

/**
 * Reconcile an existing TERMINAL session row against a fresh parse.
 *
 * Returns `null` when the row is not terminal and this reconciliation does not
 * apply.
 *
 * Two independent steps, in order:
 *
 *  1. {@link advanceTerminalEndedAt} — the run genuinely continued past the end
 *     we froze. ISS-5182 makes `ended_at` authoritative for duration, so this
 *     path has to exist or a resumed transcript reimported outside the
 *     recently-active window keeps the PRE-resume end forever.
 *  2. FEA-4187 status heal — re-run the failed-vs-completed classifier and
 *     reconcile BOTH the session row and its main agent, so old mislabeled rows
 *     heal on re-import and on the DATA_REVISION rebuild pass, and so a rebuild
 *     can never turn a correctly-classified ERROR run back into COMPLETED. Only
 *     the failed↔completed pair is reconciled; ACTIVE/ended-null and
 *     non-terminal stored states are left to their owning paths.
 */
export async function reconcileTerminalSession(
  tx: Prisma.TransactionClient,
  input: ReconcileInput
): Promise<TerminalReconciliation | null> {
  const { existing, mainId, now, session } = input;
  if (!TERMINAL_STATUS_SET.has(existing.status)) {
    return null;
  }
  const advancedEndedAt = await advanceTerminalEndedAt(tx, input);
  const resolved = resolveImportedSessionStatus(session, false);
  if (resolved !== existing.status) {
    // The advance above already committed, so prefer it over the stored value —
    // otherwise this COALESCE would re-read the pre-advance `ended_at` for the
    // agent arm and re-freeze the truncated end one level down.
    const reconciledEndedAt =
      advancedEndedAt ?? existing.endedAt ?? session.endedAt ?? now;
    // ISS-4586: heal the durable flag alongside the status so a row whose
    // failed↔not-failed classification just flipped (or a legacy
    // completed/abandoned row healing to inactive) carries the matching
    // ends_with_error the reaper would later read.
    const reconciledEndsWithError = resolved === SESSION_STATUS.ERROR ? 1 : 0;
    await tx.$executeRawUnsafe(
      "UPDATE sessions SET status = $1, ended_at = COALESCE(ended_at, $2), updated_at = $3, ends_with_error = $4 WHERE id = $5",
      resolved,
      reconciledEndedAt,
      now,
      reconciledEndsWithError,
      session.sessionId
    );
    await tx.$executeRawUnsafe(
      "UPDATE agents SET status = $1, ended_at = COALESCE(ended_at, $2), updated_at = $3 WHERE id = $4",
      importedMainAgentStatus(resolved),
      reconciledEndedAt,
      now,
      mainId
    );
  }
  return { endedAt: advancedEndedAt ?? existing.endedAt, status: resolved };
}

/**
 * ISS-5182 (review thread 3): advance a terminal row's `ended_at` when the fresh
 * parse's OWN end post-dates the stored one. Returns the value written, or
 * `null` when nothing was advanced.
 *
 * Why this is required by the same change that made `ended_at` authoritative:
 * `importPhaseSessionAndMainAgent` writes `ended_at` on an existing row only
 * through `COALESCE(ended_at, …)`, which can fill a NULL but can never move a
 * non-NULL one. So a session that terminated, was RESUMED, and is then
 * reimported OUTSIDE the recently-active window (the resume is old enough that
 * the row is not reactivated) keeps its pre-resume `ended_at` while
 * `last_activity_at` is recomputed from the newly-imported tail. Before this
 * change the activity-first anchor papered over that; with `ended_at`
 * authoritative it would truncate the continuation to the pre-resume end. The
 * reviewer is right that late activity is not always corruption — a historical
 * reimport of a resumed transcript is the legitimate cause, and it is
 * distinguishable from the corrupt one by WHERE the later instant comes from.
 *
 * The discriminator is the SOURCE, not the lateness:
 *  - the parser's own `session.endedAt`, re-read from the transcript, is
 *     first-class evidence that the run continued — adopt it.
 *  - a bare later `events.created_at` / `last_activity_at` with no corresponding
 *    parser end is NOT adopted. That is the population ISS-5182 exists to
 *    surface (a parser or status defect), and adopting it is exactly the
 *    post-terminal drift this PR removes.
 *
 * Deliberately narrow, matching the constraints the retired FEA-3593 heal
 * documents for the same column:
 *  - only when BOTH ends are present. A parse that supplies no `endedAt` falls
 *    back to the import wall clock elsewhere (`session.endedAt ?? now`), and a
 *    wall clock is never evidence of a later end.
 *  - only strictly LATER, compared as instants via `Date.parse` rather than as
 *    text, so a legacy offset-form stored value cannot be mis-ranked by byte
 *    order (ISS-5330). Never moves an end backward: a worker-truncated reimport
 *    keeps a correct scalar `endedAt` while its event tail is dropped, and that
 *    must not back-date the row.
 *  - `updated_at` is bumped so the corrected duration reaches the cloud; the
 *    `wallClock`/`span` sync fields are payload projections recomputed at
 *    emit time, so the watermark bump is what carries the correction.
 *
 * The main agent is advanced with the session. A main agent's end is the
 * session's end by construction in every writer that sets both — the live hook
 * stamps one instant on both, the import new-row branch uses `session.endedAt`
 * for both, and the sweep's agent arm maxes over that agent's own events while
 * the session arm maxes over `last_activity_at` (all session events) — so
 * `agents.ended_at <= sessions.ended_at`, and a strictly-later session end never
 * moves the agent backward either. The `ended_at IS NOT NULL` predicate on that
 * arm keeps this a pure ADVANCE: an agent row that was never closed is not
 * something this correction should close as a side effect, and it already has
 * two owners — the status-reconcile arm's `COALESCE` below, and the recreate
 * INSERT in `write-core.ts`, which stamps this function's returned value.
 */
async function advanceTerminalEndedAt(
  tx: Prisma.TransactionClient,
  input: ReconcileInput
): Promise<string | null> {
  const { existing, mainId, now, session } = input;
  const advanced = laterParsedEnd(existing.endedAt, session.endedAt);
  if (advanced === null) {
    return null;
  }
  await tx.$executeRawUnsafe(
    "UPDATE sessions SET ended_at = $1, updated_at = $2 WHERE id = $3",
    advanced,
    now,
    session.sessionId
  );
  await tx.$executeRawUnsafe(
    "UPDATE agents SET ended_at = $1, updated_at = $2 WHERE id = $3 AND ended_at IS NOT NULL",
    advanced,
    now,
    mainId
  );
  return advanced;
}

/**
 * The freshly-parsed end when it is a strictly later INSTANT than the stored
 * one, else `null`. Both operands must be present and parseable — an absent or
 * malformed value is "no evidence", never a reason to write.
 */
function laterParsedEnd(
  storedEndedAt: string | null,
  parsedEndedAt: string | null | undefined
): string | null {
  if (!(storedEndedAt && parsedEndedAt)) {
    return null;
  }
  const storedMs = Date.parse(storedEndedAt);
  const parsedMs = Date.parse(parsedEndedAt);
  if (!(Number.isFinite(storedMs) && Number.isFinite(parsedMs))) {
    return null;
  }
  return parsedMs > storedMs ? parsedEndedAt : null;
}
