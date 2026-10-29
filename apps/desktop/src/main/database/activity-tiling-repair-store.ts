/**
 * @file activity-tiling-repair-store.ts
 * @description ISS-7265 AC3 — the durable ledger that turns the ISS-4578
 * activity-tiling STRIP from a discard into a deferral.
 *
 * ── The judgment this file implements ─────────────────────────────────────────
 * AC3 asked which of strip-and-flag, chunk-further or refuse-and-retry is right
 * rather than inheriting the answer. Chunk-further is already the behaviour
 * whenever the server advertises `agentSessionSyncActivityChunking` — the tiling
 * is paginated across chunks and nothing is dropped — so it is not available on
 * the branch in question, which is reached only once chunking has been TRIED and
 * produced nothing: with the capability absent, because a multi-part tiling would
 * corrupt the receiver; with it present (ISS-9865), because a tiling large enough
 * to exhaust `MAX_SESSION_SYNC_CHUNKS` has no valid split. Refuse-and-retry is worse
 * than the defect: dead-lettering the whole session withholds its events,
 * agents, metadata and token events too, trading a partial degradation for total
 * non-delivery. So the strip stays — but it stops being permanent. A confirmed
 * stripped delivery records a DEBT here, and the debt is settled by
 * re-delivering the tiling once the capability that forced the strip arrives.
 *
 * ── Why a marker table ────────────────────────────────────────────────────────
 * Same reason as `component-usage-resync-heal.ts` (ISS-6998): the repair is a
 * `sessions.updated_at` bump, which is how the sync lane is asked to re-upload a
 * row, and the predicate that selects a stripped session is not convergent — a
 * bump does not change the fact that the session was once stripped. Without a
 * persisted "already asked" fact the pass would re-bump the same population
 * forever, the sync-cursor churn `billing-mode-heal.ts` documents and refuses.
 *
 * A row means "this device owes the cloud this session's tiling". It is never an
 * acknowledgement, and its ABSENCE is not evidence a tiling arrived — only that
 * none is recorded owed.
 *
 * ── Why it is session-scoped, not `sourceKey`-scoped ──────────────────────────
 * `main/sync/AGENTS.md` invariant 2 scopes queues, cursors and outbox rows by
 * `sourceKey` so one account can never inherit another's DELIVERY state. This is
 * not delivery state: it is a fact about the LOCAL row (this device's copy was
 * not fully replicated), and its only effect is a local `sessions.updated_at`
 * bump — exactly what any local edit does. Which account may then upload the row
 * is still decided downstream by the ownership/parking sweep, which is where
 * that question belongs. `component_usage_resync_seen` (ISS-6998) is the same
 * shape for the same reason.
 */
import type { DesktopPrisma } from "./prisma-client.js";
import { chunkWatermark } from "./session-sync-watermark.js";

/**
 * Sessions re-queued per chunk, and therefore the width of the tied-top
 * `updated_at` group this pass leaves for the sync cursor to carry as
 * `id NOT IN (…)` placeholders on each incremental tick. The same 25 as its
 * `component-usage-resync-heal.ts` sibling, and a separate constant for the same
 * reason: the two drain different populations.
 */
const ACTIVITY_TILING_REPAIR_CHUNK = 25;

/**
 * Consecutive chunk failures tolerated before the pass gives up, mirroring the
 * boot-heal siblings. One failing chunk must not head-of-line block the healthy
 * tail behind it, and a store-wide failure must not turn that tolerance into a
 * corpus-length walk of failing writes.
 */
const MAX_CONSECUTIVE_FAILED_CHUNKS = 3;

export type ActivityTilingRepairResult = {
  /** Sessions whose `updated_at` this pass actually bumped. */
  requeued: number;
};

/**
 * Record that these sessions shipped WITHOUT their activity tiling and the
 * server confirmed the delivery, so the cloud is now holding a session whose
 * tiling this device still owes it.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert, and that is the self-limiting
 * half of the design: it preserves an existing row's `requeued_at`, so a session
 * that strips AGAIN on the re-delivery this pass asked for cannot reset itself
 * to unasked and drive an endless bump loop. A debt re-arms only through
 * {@link settleActivityTilingDebt}, which deletes the row when a delivery is
 * confirmed with the tiling intact.
 */
export async function recordActivityTilingDebt(
  prisma: DesktopPrisma,
  sessionIds: readonly string[],
  recordedAt: string
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  const values = sessionIds
    .map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`)
    .join(", ");
  const params: string[] = [];
  for (const sessionId of sessionIds) {
    params.push(sessionId, recordedAt);
  }
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO activity_tiling_repair_owed (session_id, recorded_at)
       VALUES ${values}
       ON CONFLICT (session_id) DO NOTHING`,
      ...params
    )
  );
}

/**
 * Settle the debt for sessions the server confirmed WITH their tiling intact.
 *
 * Deleting on the complement of the strip — rather than on "the payload carried
 * segment rows" — is what keeps the ledger honest in both directions: a session
 * that has no tiling at all owes nothing, and a session whose tiling this
 * delivery actually carried owes nothing either. Both are the same fact, "this
 * delivery was not degraded", and it is the fact the wire flag already states.
 *
 * SCOPE, stated rather than assumed: this settles on the DELIVERY, so it means
 * "this device shipped the tiling and the server confirmed the row". It is not a
 * claim that the receiver STORED it — `persistSessionActivitySegments` has three
 * paths that carry rows and write none — and that half is the cloud's
 * `activity_segment_rows_stripped` column, which is derived from real
 * persistence. Do not read this ledger as cloud state.
 *
 * The emptiness probe is not an optimisation detail: the steady state on a
 * healthy device is a server that merges multi-part tilings, so nothing ever
 * strips and this table is empty forever — and without the probe every single
 * ack would take the write queue for a delete that can match nothing. The probe
 * runs on the READER pool, and a `false` from it means only "no row is recorded
 * owed", never "no tiling was ever lost".
 */
export async function settleActivityTilingDebt(
  prisma: DesktopPrisma,
  sessionIds: readonly string[]
): Promise<void> {
  if (sessionIds.length === 0 || !(await hasRecordedDebt(prisma))) {
    return;
  }
  const placeholders = sessionIds.map((_, index) => `$${index + 1}`).join(", ");
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `DELETE FROM activity_tiling_repair_owed WHERE session_id IN (${placeholders})`,
      ...sessionIds
    )
  );
}

/** Does this store hold ANY recorded tiling debt? A btree-root probe. */
function hasRecordedDebt(prisma: DesktopPrisma): Promise<boolean> {
  return prisma
    .read((reader) =>
      reader.$queryRawUnsafe<{ one: number }[]>(
        "SELECT 1 AS one FROM activity_tiling_repair_owed LIMIT 1"
      )
    )
    .then((rows) => rows.length > 0);
}

/**
 * Ask the sync lane to re-deliver every owed tiling that has not been asked for
 * yet, by bumping `sessions.updated_at` — the one lever that puts a quiet
 * session back in the incremental cursor's path.
 *
 * The CALLER owns the precondition: this must run only when the server has
 * advertised `agentSessionSyncActivityChunking`, because that is the constraint
 * whose absence forced the strip. Under that capability the payload builder
 * paginates the tiling across chunks, so the re-delivery this pass provokes
 * carries the rows for every session the missing capability was what stopped.
 *
 * ISS-9865: that capability is no longer the ONLY thing that can force a strip —
 * a tiling too large for the chunk budget strips under the capability too. Such a
 * session is re-queued once and strips again, and then stays quiet: the debt row
 * keeps the `requeued_at` this pass stamped (see {@link recordActivityTilingDebt}),
 * so the discovery predicate never matches it again until a delivery carries the
 * tiling intact and {@link settleActivityTilingDebt} clears the row. One wasted
 * re-delivery per such session, not a loop.
 *
 * Never throws into the caller: a repair that cannot run leaves the debt
 * recorded and unasked, which a later pass retries, rather than failing a sync
 * tick over a maintenance write.
 */
export async function requeueOwedActivityTilings(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = ACTIVITY_TILING_REPAIR_CHUNK
): Promise<ActivityTilingRepairResult> {
  // Captured BEFORE the first read so the boundary covers every statement this
  // pass issues. A live writer that advances a session past it must win: the
  // sync cursor may already have moved beyond that newer stamp, and overwriting
  // it with this pass's older one would leave the row behind the cursor and
  // never synced — the ISS-5259 boundary the boot heals share.
  const passStart = new Date().toISOString();
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  const result: ActivityTilingRepairResult = { requeued: 0 };
  let consecutiveFailures = 0;
  let chunkIndex = 0;
  while (consecutiveFailures < MAX_CONSECUTIVE_FAILED_CHUNKS) {
    const owedIds = await selectUnaskedDebtChunk(prisma, {
      chunkSize: safeChunkSize,
      passStart,
    }).catch((error) => {
      log(failureMessage("discovery", error));
      return null;
    });
    if (owedIds === null) {
      consecutiveFailures += 1;
      continue;
    }
    if (owedIds.length === 0) {
      break;
    }
    const written = await requeueChunk(prisma, {
      sessionIds: owedIds,
      // FEA-3485: each chunk gets its OWN strictly-increasing watermark, so a
      // multi-chunk repair cannot collapse into one tied-top `updated_at` group
      // that the sync cursor then carries as uncapped id placeholders.
      chunkNow: chunkWatermark(passStart, chunkIndex),
      passStart,
    }).catch((error) => {
      log(failureMessage("re-queue", error));
      return null;
    });
    if (written === null) {
      consecutiveFailures += 1;
      continue;
    }
    consecutiveFailures = 0;
    chunkIndex += 1;
    result.requeued += written;
    // No keyset: the write stamps `requeued_at` on exactly the rows it asked
    // for, so a drained chunk stops matching the discovery predicate. A chunk
    // whose rows the UPDATE skipped is marked asked all the same (see
    // `requeueChunk`), which is what keeps this loop finite.
  }
  if (result.requeued > 0) {
    log(
      `activity-tiling repair (ISS-7265): re-queued ${result.requeued} session(s) whose tiling shipped stripped`
    );
  }
  return result;
}

/**
 * One chunk of sessions that owe a tiling and have not been asked for it yet.
 *
 * Runs on the READER pool rather than `prisma.client`: that connection is the
 * single writer every live ingest and both sync lanes depend on, and a
 * maintenance probe has no business queueing ahead of them. The reader snapshot
 * may lag, which is harmless — the write re-asserts the pass-start bound.
 */
function selectUnaskedDebtChunk(
  prisma: DesktopPrisma,
  input: { chunkSize: number; passStart: string }
): Promise<string[]> {
  return prisma
    .read((reader) =>
      reader.$queryRawUnsafe<{ id: string }[]>(
        `SELECT d.session_id AS id
           FROM activity_tiling_repair_owed d
           JOIN sessions s ON s.id = d.session_id
          WHERE d.requeued_at IS NULL
            AND (s.updated_at IS NULL OR s.updated_at < $1)
          ORDER BY d.session_id ASC
          LIMIT $2`,
        input.passStart,
        input.chunkSize
      )
    )
    .then((rows) => rows.map((row) => row.id));
}

/**
 * Bump one chunk's sessions and mark the whole chunk asked, in ONE transaction.
 *
 * The pass-start bound is RE-ASSERTED on the bump rather than trusted from the
 * read, so a row a live writer advanced mid-pass keeps its newer stamp.
 *
 * `requeued_at` is stamped on EVERY candidate in the chunk, not only on the ids
 * the bump moved — deliberately, and it is the opposite of the ISS-6998 sibling,
 * which derives its marker from `RETURNING` so a skipped row is re-examined
 * later. The two differ because the skip means opposite things: there, a skipped
 * row was never asked and still needs to be; here, a row is skipped precisely
 * because a live writer ALREADY advanced its `updated_at` past this pass, which
 * is the very re-selection this pass exists to cause. Marking it asked records
 * what is true; deriving from `RETURNING` would leave it unasked forever and
 * re-select it on every pass, since the condition that skipped it does not
 * clear.
 */
async function requeueChunk(
  prisma: DesktopPrisma,
  input: { sessionIds: string[]; chunkNow: string; passStart: string }
): Promise<number> {
  const { sessionIds, chunkNow, passStart } = input;
  return await prisma.write((client) =>
    client.$transaction(async (tx) => {
      const idPlaceholders = sessionIds
        .map((_, index) => `$${index + 2}`)
        .join(", ");
      const passStartParam = `$${sessionIds.length + 2}`;
      const bumped = await tx.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE sessions SET updated_at = $1
          WHERE id IN (${idPlaceholders})
            AND (updated_at IS NULL OR updated_at < ${passStartParam})
        RETURNING id`,
        chunkNow,
        ...sessionIds,
        passStart
      );
      await tx.$executeRawUnsafe(
        `UPDATE activity_tiling_repair_owed SET requeued_at = $1
          WHERE session_id IN (${idPlaceholders})
            AND requeued_at IS NULL`,
        chunkNow,
        ...sessionIds
      );
      return bumped.length;
    })
  );
}

function failureMessage(phase: string, error: unknown): string {
  return `activity-tiling repair ${phase} failed (ISS-7265): ${error instanceof Error ? error.message : String(error)}`;
}
