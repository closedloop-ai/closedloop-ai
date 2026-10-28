/**
 * @file authoritative-cost-resync-heal.ts
 * @description ISS-7229 — one-time boot pass that re-queues sessions whose
 * authoritative cost migration 0074 filled locally but never offered to the
 * cloud.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * 0074 set `sessions.authoritative_cost_usd` from the already-captured
 * `claude_code_cost_event` rows. It did not touch `updated_at`, and cloud
 * delivery selects on that cursor (the FEA-1962 incremental watermark), so every
 * figure it recovered is invisible to sync. Nothing else will pick them up
 * either: the runtime rollup re-stamps a session only when its computed sum
 * CHANGES, and a finished session's cost never changes again. Without an
 * explicit re-queue those figures stay local forever.
 *
 * This pass bumps `updated_at` on exactly those sessions, which is how the sync
 * lane is asked to re-upload them. It writes nothing else — the re-delivery is
 * the lane's business and the payload builder is already correct.
 *
 * ── Why it is a pass and not an `UPDATE` in the migration ─────────────────────
 * It was a migration first, and marisolashgrove caught the cost on #6406. A blanket
 * `UPDATE … SET updated_at = now` writes ONE identical instant across the whole
 * affected population, collapsing it onto a single top watermark; the sync
 * cursor then carries that entire tied-top group as uncapped `id NOT IN (…)`
 * placeholders on every incremental tick until the watermark advances.
 * `session-analytics-maintenance.ts` refuses a blanket bump for exactly this
 * reason and names it FEA-3485. Chunking with `chunkWatermark` is what keeps the
 * tied-top group one chunk wide.
 *
 * ── Why it needs a marker table ───────────────────────────────────────────────
 * `billing-mode-heal.ts` is marker-free because its predicate is CONVERGENT: it
 * selects on the column it writes, so a healed row stops matching and the next
 * boot selects nothing. This pass selects on `authoritative_cost_usd IS NOT
 * NULL` and writes `updated_at`, which does not change that predicate by one
 * row — keyed on the predicate alone it would re-bump the same population on
 * every boot forever. `authoritative_cost_resync_seen` (migration
 * 0077_iss7229_authoritative_cost_resync_seen) is the
 * durable "already asked" fact, following the `component_usage_resync_seen`
 * precedent.
 *
 * A marker means "this device asked for a re-send". It is NOT an
 * acknowledgement, and nothing may read it as one.
 *
 * ── The pass-start boundary (inherited from ISS-5259) ─────────────────────────
 * Boot maintenance runs CONCURRENTLY with live writers, so a session written
 * during the pass must not have its newer `updated_at` overwritten with this
 * pass's older stamp: if the sync cursor had already advanced past the newer
 * value, the row would sit BEHIND the cursor and never sync. Every statement
 * here is bounded by `updated_at < passStart` (NULL included — invisible to the
 * cursor today, so stamping it can only move it forward), and the bound is
 * RE-ASSERTED on the write, not merely trusted from the read.
 */
import type { DesktopPrisma } from "./prisma-client.js";
import { chunkWatermark } from "./session-sync-watermark.js";
import { publishableStoredCostUsd } from "./stored-cost-usd.js";

/**
 * Sessions re-queued per chunk, and therefore the width of the tied-top
 * `updated_at` group this pass leaves for the sync cursor to carry as
 * `id NOT IN (…)` placeholders on each incremental tick.
 *
 * Same 25 as `COMPONENT_USAGE_RESYNC_CHUNK` and for the same reason — it is a
 * sync cursor width, not a memory bound — but deliberately a separate constant:
 * the two passes drain different populations and neither should silently resize
 * when the other is tuned.
 */
const AUTHORITATIVE_COST_RESYNC_CHUNK = 25;

/**
 * Consecutive chunk-WRITE failures tolerated before the pass gives up.
 *
 * A single failure is skipped rather than fatal, so a chunk that fails for a
 * reason tied to its own rows cannot head-of-line block the healthy tail behind
 * it on every boot. This cap stops that tolerance turning a store-wide failure
 * (disk full, store locked for the whole boot) into a corpus-length walk of
 * failing writes.
 */
const MAX_CONSECUTIVE_FAILED_CHUNKS = 3;

type CandidateRow = { id: string; cost_usd: unknown };

export type AuthoritativeCostResyncResult = {
  /** Sessions whose `updated_at` this pass actually bumped. */
  requeued: number;
  /** Candidates skipped because their stored figure was not usable. */
  unusableCosts: number;
};

/**
 * Re-queue sessions carrying a 0074-backfilled authoritative cost the cloud was
 * never offered. Background/boot pass — never throws into the caller.
 */
export async function requeueBackfilledAuthoritativeCosts(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = AUTHORITATIVE_COST_RESYNC_CHUNK
): Promise<AuthoritativeCostResyncResult> {
  // Captured BEFORE the first read, so the boundary covers every statement this
  // pass issues rather than only the chunks after the one that observed it.
  const passStart = new Date().toISOString();
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  const result: AuthoritativeCostResyncResult = {
    requeued: 0,
    unusableCosts: 0,
  };
  let bound: string | null = null;
  let consecutiveFailures = 0;
  let chunkIndex = 0;
  while (consecutiveFailures < MAX_CONSECUTIVE_FAILED_CHUNKS) {
    // Annotated, not inferred: the keyset assignment below feeds `bound` back
    // into this call's argument, and TypeScript reads that round trip as a
    // circular initializer (TS7022) unless one end of it is pinned.
    const candidates: CandidateRow[] | null = await selectCandidateChunk(
      prisma,
      { bound, chunkSize: safeChunkSize, passStart }
    ).catch((error) => {
      log(failureMessage("discovery", error));
      return null;
    });
    if (candidates === null) {
      consecutiveFailures += 1;
      continue;
    }
    if (candidates.length === 0) {
      break;
    }
    // The keyset advances off the READ, so a chunk whose write fails is still
    // stepped over rather than retried forever inside this pass. It is the
    // marker table, not the keyset, that makes the NEXT boot skip it.
    bound = candidates.at(-1)?.id ?? bound;
    const usable = partitionUsableCosts(candidates, log);
    result.unusableCosts += candidates.length - usable.length;
    if (usable.length === 0) {
      continue;
    }
    const written = await writeChunk(prisma, {
      candidates: usable,
      // FEA-3485: each chunk gets its OWN strictly-increasing watermark. One
      // shared `now` would collapse every chunk's sessions into a single
      // tied-top `updated_at` group, which the sync cursor carries as uncapped
      // `id NOT IN (…)` placeholders on every tick until the watermark advances.
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
  }
  if (result.requeued > 0) {
    log(
      `authoritative-cost re-sync complete (ISS-7229): re-queued ${result.requeued} session(s) whose 0074-backfilled cost had never been offered to the cloud`
    );
  }
  return result;
}

/**
 * One chunk of sessions that hold a backfilled authoritative cost and have not
 * already been asked for a re-send.
 *
 * The keyset term is emitted CONDITIONALLY rather than written as a nullable
 * bound: SQLite plans at PREPARE time, so a `($n IS NULL OR id > $n)` form
 * references no column the planner can range over and degrades to a residual
 * filter — the same reason `componentUsageResyncChunkSelectSql` builds its
 * keyset the same way.
 *
 * Positional parameters, in TEXTUAL order — which is also bind order, so the
 * keyset term leads the WHERE clause rather than sitting after the boundary:
 * - without a bound: `$1` pass start, `$2` chunk size
 * - with a bound:    `$1` bound, `$2` pass start, `$3` chunk size
 */
export function authoritativeCostResyncChunkSelectSql(
  hasKeysetBound: boolean
): string {
  const keysetSql = hasKeysetBound ? "s.id > $1\n       AND " : "";
  const passStartParam = hasKeysetBound ? "$2" : "$1";
  const limitParam = hasKeysetBound ? "$3" : "$2";
  return `SELECT s.id AS id, s.authoritative_cost_usd AS cost_usd
     FROM sessions s
     WHERE ${keysetSql}s.authoritative_cost_usd IS NOT NULL
       AND (s.updated_at IS NULL OR s.updated_at < ${passStartParam})
       AND NOT EXISTS (
         SELECT 1 FROM authoritative_cost_resync_seen m WHERE m.session_id = s.id
       )
     ORDER BY s.id ASC
     LIMIT ${limitParam}`;
}

/**
 * Discovery goes through the READER pool, never `prisma.client`.
 *
 * `prisma.client` IS the single writer connection, so running this scan on it
 * would put it on the one connection live-hook ingest and both sync lanes depend
 * on, AND outside `write()`'s queue — ahead of the fairness system rather than
 * in it. `read()` fans out across the `query_only` reader connections and runs
 * concurrently with the writer.
 *
 * A reader snapshot is committed but may lag the writer, which is harmless here:
 * the WRITE re-asserts the pass-start bound and derives its markers from
 * `RETURNING`, so a candidate this read proposes from a stale snapshot is
 * skipped rather than acted on, and is left unmarked for a later boot.
 */
function selectCandidateChunk(
  prisma: DesktopPrisma,
  input: { bound: string | null; chunkSize: number; passStart: string }
): Promise<CandidateRow[]> {
  const sql = authoritativeCostResyncChunkSelectSql(input.bound !== null);
  const params: (string | number)[] =
    input.bound === null
      ? [input.passStart, input.chunkSize]
      : [input.bound, input.passStart, input.chunkSize];
  return prisma.read((reader) =>
    reader.$queryRawUnsafe<CandidateRow[]>(sql, ...params)
  );
}

/**
 * Drop candidates whose stored figure cannot be believed, reporting each.
 *
 * The column crosses the raw-query boundary as a driver-supplied value, so this
 * is a real parse boundary rather than a type-forbidden case. A figure that is
 * not a storable cost is NOT coerced into one: the row is left unmarked and
 * unqueued, so a later boot can re-examine it once the store reads correctly,
 * and the condition is reported rather than absorbed. Re-queuing such a row
 * would ask the lane to ship a number the cloud's own width guard will refuse.
 */
function partitionUsableCosts(
  candidates: CandidateRow[],
  log: (message: string) => void
): { id: string; costUsd: number }[] {
  const usable: { id: string; costUsd: number }[] = [];
  for (const candidate of candidates) {
    const costUsd = publishableStoredCostUsd(candidate.cost_usd);
    if (costUsd === null) {
      log(
        `authoritative-cost re-sync (ISS-7229): session ${candidate.id} reported an unusable cost (${String(candidate.cost_usd)}); left unqueued for a later pass`
      );
      continue;
    }
    usable.push({ id: candidate.id, costUsd });
  }
  return usable;
}

/**
 * Bump one chunk's sessions and mark them, in ONE transaction. Returns how many
 * were actually re-queued.
 *
 * The pass-start bound is RE-ASSERTED on the UPDATE rather than trusted from the
 * read: between the two statements a live writer can have bumped a row past the
 * boundary, and overwriting that newer stamp with this pass's older one would
 * put the row behind the durable sync cursor. `RETURNING` is therefore the only
 * honest source for what changed, and the marker rows are derived from it — a
 * session the UPDATE skipped is left unmarked so a later boot re-examines it,
 * rather than recorded as asked-for when it was not.
 */
async function writeChunk(
  prisma: DesktopPrisma,
  input: {
    candidates: { id: string; costUsd: number }[];
    chunkNow: string;
    passStart: string;
  }
): Promise<number> {
  const costById = new Map(
    input.candidates.map((candidate) => [candidate.id, candidate.costUsd])
  );
  const ids = input.candidates.map((candidate) => candidate.id);
  return await prisma.write((client) =>
    client.$transaction(async (tx) => {
      const idPlaceholders = ids.map((_, index) => `$${index + 2}`).join(", ");
      const passStartParam = `$${ids.length + 2}`;
      const bumped = await tx.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE sessions SET updated_at = $1
         WHERE id IN (${idPlaceholders})
           AND (updated_at IS NULL OR updated_at < ${passStartParam})
         RETURNING id`,
        input.chunkNow,
        ...ids,
        input.passStart
      );
      // Marked rows are the intersection of "the UPDATE bumped it" and "we hold
      // the figure that selected it" — never a fabricated `0` for an id whose
      // cost went missing, which would persist evidence the pass never observed.
      const marked: { id: string; costUsd: number }[] = [];
      for (const row of bumped) {
        const costUsd = costById.get(row.id);
        if (costUsd !== undefined) {
          marked.push({ id: row.id, costUsd });
        }
      }
      if (marked.length === 0) {
        return bumped.length;
      }
      const values = marked
        .map(
          (_, index) =>
            `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`
        )
        .join(", ");
      const params: (string | number)[] = [];
      for (const row of marked) {
        params.push(row.id, row.costUsd, input.chunkNow);
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO authoritative_cost_resync_seen (session_id, cost_usd, requeued_at)
         VALUES ${values}
         ON CONFLICT (session_id) DO NOTHING`,
        ...params
      );
      return bumped.length;
    })
  );
}

function failureMessage(phase: string, error: unknown): string {
  return `authoritative-cost re-sync ${phase} failed (ISS-7229): ${error instanceof Error ? error.message : String(error)}`;
}
