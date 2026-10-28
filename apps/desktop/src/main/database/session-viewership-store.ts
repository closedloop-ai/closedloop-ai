/**
 * @file session-viewership-store.ts
 * @description ISS-7830 — the durable store behind "did a user ever open this
 * thread", the signal the dynamic headless ruling needs and nothing on
 * `origin/main` captured.
 *
 * The invariants this store implements — navigation is the act, the record is
 * monotonic, and it must outlive a `DATA_REVISION` rebuild — and the reasons for
 * each are stated once in `packages/lib/session-trace/thread-viewership.ts`. This
 * file is where the monotonicity is enforced rather than asserted.
 */

import { z } from "zod";
import { MAX_DB_ID_LENGTH } from "./ipc-validation.js";
import type {
  DesktopPrisma,
  DesktopPrismaReadClient,
} from "./prisma-client.js";
import { selectRowsByIds } from "./session-detail-mappers.js";

/**
 * The `store:` op name for the capture. A write cannot cross the db-host proxy
 * (`DbHostPrisma` omits `write`, so a write through it is a compile error), so
 * the renderer's capture is forwarded into the db-host child by name.
 */
export const SESSION_VIEWERSHIP_RECORD_STORE_OP = "sessionViewership.record";

/**
 * Ceiling for the stamped instant. It is a machine-generated ISO string
 * (`2026-08-24T10:00:00.000Z`, 24 chars); the allowance is for a longer offset
 * form, not for free text. Without a bound this would be an unbounded TEXT column
 * reachable from the renderer.
 */
const MAX_VIEWED_AT_CHARS = 40;

/**
 * Args as they arrive in the db-host child — a process boundary, so they are
 * parsed there rather than trusted. The id bound is the same
 * {@link MAX_DB_ID_LENGTH} every `desktop:db:*` identifier is held to.
 */
export const sessionViewershipRecordArgsSchema = z.tuple([
  z.string().min(1).max(MAX_DB_ID_LENGTH),
  z.string().min(1).max(MAX_VIEWED_AT_CHARS),
]);

/**
 * Record that a user navigated into this thread, and re-queue that session for
 * cloud sync when the record is new.
 *
 * Three things happen here and each is load-bearing.
 *
 * `ON CONFLICT DO NOTHING` is the MONOTONICITY, not an idempotence nicety: it
 * preserves the FIRST view, so re-opening a thread cannot move the timestamp and
 * no write path exists that could retract the fact. A caller therefore never has
 * to read before writing, and two renderers racing the same mount agree.
 *
 * `WHERE EXISTS` makes the insert PARENT-CONDITIONAL. `session_viewership` has a
 * foreign key to `sessions` and every connection runs `PRAGMA foreign_keys=ON`,
 * so a bare insert for a session this device holds no row for raises
 * `SQLITE_CONSTRAINT_FOREIGNKEY` — and that state is not hypothetical, because
 * the detail view captures the view on mount precisely so a not-found session is
 * not silently dropped. Without the guard the throw crosses the db-host boundary,
 * rejects the IPC handler, and is swallowed by the renderer's `.catch`. With it,
 * the caller gets a truthful "not recorded" instead of an exception nobody sees.
 *
 * The `updated_at` BUMP is what makes the new classification reach the cloud.
 * Sync selection walks `sessions.updated_at`, and viewership is written outside
 * `importSession` — so without this a session already uploaded as headless would
 * keep that stale classification on the cloud forever, however the local answer
 * changed. It fires ONLY when the insert actually wrote a row, which the
 * monotonic table makes at most once per session ever, so a re-opened thread
 * cannot drive the endless cursor churn `billing-mode-heal.ts` documents and
 * refuses. Both statements share one queued write so a view is never recorded
 * without its re-queue. The bump only ever moves the watermark FORWARD: a live
 * session's `updated_at` can already be ahead of this instant, and writing the
 * older value would drop it back BELOW the sync cursor — hiding the very row
 * this is trying to re-deliver.
 *
 * A session already ahead therefore takes NO bump, and that leaves a residual
 * window this store cannot close by itself, because it cannot see the cursor:
 * "ahead of `viewedAt`" is not the same claim as "ahead of the sync cursor". A
 * row whose `updated_at` already led the view instant, which sits AT the top
 * cursor timestamp and is already in `observedIdsAtTopUpdatedAt`, is excluded
 * by that selection's `NOT IN` (`listUpdatedSessionCursorRows`) and keeps the
 * stale classification until an unrelated write moves it again. Reaching it
 * needs a backward clock skew, or a final content write landing in the same
 * millisecond as the view with none after it — for a settled session
 * `updated_at` is stamped in the past and the bump fires normally. Tracked as
 * ISS-7871; closing it means a durable enqueue, not a wider bump.
 *
 * Returns whether a view is ON RECORD for this session afterwards — which is not
 * the same as "this call inserted one". A repeat view inserts nothing and is
 * still recorded, so the second probe distinguishes that from the session simply
 * not existing here.
 */
export async function recordThreadViewed(
  prisma: DesktopPrisma,
  sessionId: string,
  viewedAt: string
): Promise<boolean> {
  const inserted = await prisma.write(async (client) => {
    const written = await client.$executeRawUnsafe(
      `INSERT INTO session_viewership (session_id, first_viewed_at)
       SELECT $1, $2
       WHERE EXISTS (SELECT 1 FROM sessions WHERE id = $3)
       ON CONFLICT (session_id) DO NOTHING`,
      sessionId,
      viewedAt,
      sessionId
    );
    if (written > 0) {
      await client.$executeRawUnsafe(
        `UPDATE sessions SET updated_at = $1
         WHERE id = $2 AND (updated_at IS NULL OR updated_at < $1)`,
        viewedAt,
        sessionId
      );
    }
    return written;
  });
  if (inserted > 0) {
    return true;
  }
  return await hasRecordedThreadView(prisma, sessionId);
}

/**
 * Which of these sessions a user has opened.
 *
 * Returns the VIEWED subset rather than a per-session answer, because the absent
 * ids carry two different facts this table cannot tell apart — never opened, and
 * opened on a build that predated the capture — and a `false` per id would assert
 * the first. Every consumer treats absence as the safe default (unviewed), which
 * is today's classification, so the ambiguity costs nothing as long as nobody
 * reports it as evidence.
 */
export async function selectViewedSessionIds(
  reader: DesktopPrismaReadClient,
  sessionIds: readonly string[]
): Promise<ReadonlySet<string>> {
  if (sessionIds.length === 0) {
    return new Set<string>();
  }
  const rows = await selectRowsByIds<{ session_id: string }>(
    reader,
    "SELECT session_id FROM session_viewership WHERE session_id IN (__IDS__)",
    [...sessionIds]
  );
  return new Set(rows.map((row) => row.session_id));
}

/**
 * Whether a view is already on record for one session — a primary-key probe on
 * the WRITER connection, so it reads this call's own insert.
 */
async function hasRecordedThreadView(
  prisma: DesktopPrisma,
  sessionId: string
): Promise<boolean> {
  const rows = await prisma.client.$queryRawUnsafe<{ one: number }[]>(
    "SELECT 1 AS one FROM session_viewership WHERE session_id = $1",
    sessionId
  );
  return rows.length > 0;
}
