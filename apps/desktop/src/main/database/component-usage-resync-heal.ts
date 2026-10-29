/**
 * @file component-usage-resync-heal.ts
 * @description ISS-6998 — one-time boot pass that re-queues sessions whose
 * component usage reached the cloud TRUNCATED, so the ISS-6884 fix reaches the
 * data it could not repair on its own.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * ISS-6884 (PR #5277) made component usage a paginated FOURTH stream, so a
 * session's whole set now reaches the cloud instead of the first
 * `MAX_SYNCED_COMPONENT_USAGE` rows. The fix is PRODUCER-side: a session that
 * already delivered a truncated subset re-sends in full only if it is
 * re-SELECTED, and selection is driven by local change state — the metadata lane
 * walks `sessions.updated_at` (`listUpdatedSessionCursorRows`) — not by "the
 * delivery was incomplete". A session that has gone quiet therefore keeps its
 * truncated cloud-side set indefinitely.
 *
 * This pass bumps `updated_at` on exactly those sessions, which is how the sync
 * lane is asked to re-upload them. It writes nothing else: the re-delivery
 * itself is the lane's business, and the payload builder is already correct.
 *
 * ── Why it needs a marker table, unlike its siblings ──────────────────────────
 * `billing-mode-heal.ts` needs no marker because it is CONVERGENT: it selects on
 * `billing_mode` and it WRITES `billing_mode`, so a healed row stops matching
 * the predicate and the next boot selects nothing. That property is what makes a
 * marker-free heal safe, and it is exactly what this pass does not have. Its
 * predicate is `COUNT(agent_component_session_usage) > cap`, and re-queuing a
 * session does not change that count by a single row. Keyed on the predicate
 * alone the pass would re-bump the same population on every boot forever —
 * the sync-cursor churn `billing-mode-heal.ts` documents and refuses.
 *
 * So the "already asked" fact is persisted in `component_usage_resync_seen`
 * (migration 0065), following the `artifact_link_backfill_seen` precedent. The
 * bump and the marker insert share ONE transaction: a bump without a marker
 * re-queues forever, and a marker without a bump silently strands the session
 * with its truncated cloud set — the marker is only ever written for a session
 * this pass actually re-queued, derived from the UPDATE's `RETURNING`, never
 * from the ids the discovery read proposed.
 *
 * A marker means "this device asked for a re-send". It is NOT an
 * acknowledgement, and nothing may read it as one — fabricating a delivery
 * state that implies data arrived is the failure mode the ticket names.
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
import { MAX_SYNCED_COMPONENT_USAGE } from "@repo/api/src/types/agent-session";
import type { DesktopPrisma } from "./prisma-client.js";
import { chunkWatermark } from "./session-sync-watermark.js";

/**
 * Sessions re-queued per chunk, and therefore the width of the tied-top
 * `updated_at` group this pass leaves for the sync cursor to carry as
 * `id NOT IN (…)` placeholders on each incremental tick.
 *
 * Same 25 as `BILLING_MODE_HEAL_CHUNK` and for the same reason — it is a sync
 * cursor width, not a memory bound — but deliberately a separate constant: the
 * two passes drain different populations and neither should silently resize
 * when the other is tuned.
 */
const COMPONENT_USAGE_RESYNC_CHUNK = 25;

/**
 * Consecutive chunk-WRITE failures tolerated before the pass gives up.
 *
 * A single failure is skipped rather than fatal, so a chunk that fails for a
 * reason tied to its own rows cannot head-of-line block the healthy tail behind
 * it on every boot. This cap stops that tolerance turning a store-wide failure
 * (disk full, store locked for the whole boot) into a corpus-length walk of
 * failing writes. `billing-mode-heal.ts` is the only sibling that carries one;
 * this pass takes the same posture rather than the missing one.
 */
const MAX_CONSECUTIVE_FAILED_CHUNKS = 3;

/** Rows this pass will not act on, because the count cannot be believed. */
type CandidateRow = { id: string; usage_rows: unknown };

export type ComponentUsageResyncResult = {
  /** Sessions whose `updated_at` this pass actually bumped. */
  requeued: number;
  /** Candidates skipped because their counted row total was not usable. */
  unusableCounts: number;
};

/**
 * Re-queue sessions whose component usage was truncated before ISS-6884.
 * Background/boot pass — never throws into the caller.
 */
export async function requeueTruncatedComponentUsage(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = COMPONENT_USAGE_RESYNC_CHUNK
): Promise<ComponentUsageResyncResult> {
  // Captured BEFORE the first read, so the boundary covers every statement this
  // pass issues rather than only the chunks after the one that observed it.
  const passStart = new Date().toISOString();
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  const result: ComponentUsageResyncResult = {
    requeued: 0,
    unusableCounts: 0,
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
    const usable = partitionUsableCounts(candidates, log);
    result.unusableCounts += candidates.length - usable.length;
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
      `component-usage re-sync complete (ISS-6998): re-queued ${result.requeued} session(s) whose usage exceeded ${MAX_SYNCED_COMPONENT_USAGE} rows`
    );
  }
  return result;
}

/**
 * One chunk of sessions that hold more than the wire cap in local usage rows and
 * have not already been asked for a re-send.
 *
 * Driven FROM `agent_component_session_usage` so the grouping walks that table's
 * primary key — `(session_id, component_kind, component_key, git_branch)` —
 * whose leading column is both the group key and the keyset order, instead of
 * probing a correlated COUNT once per session row.
 *
 * The keyset term is emitted CONDITIONALLY rather than written as a nullable
 * bound: SQLite plans at PREPARE time, so a `($n IS NULL OR session_id > $n)`
 * form references no column the planner can range over and degrades to a
 * residual filter — the same reason `billingModeHealChunkSelectSql` builds its
 * keyset the same way.
 *
 * ISS-7701: the session bound and the marker probe are HAVING terms, not WHERE
 * terms, and that is the whole cost difference. A WHERE term is evaluated once
 * per USAGE ROW, so every row of the widest table this pass touches paid one
 * index probe into `sessions` and another into `component_usage_resync_seen` —
 * a settled store with nothing left to heal still paid both, per row, to prove
 * it. HAVING is evaluated once per GROUP, after aggregation, so the same two
 * probes are now paid once per OVER-CAP session, of which a settled steady
 * state has none. Neither term can change a `COUNT(*)`, so the candidate set is
 * identical; what changes is only how often the two probes run.
 *
 * The grouped index scan itself is deliberately KEPT. It is what proves the
 * population is drained, and the module header sets out why no completion
 * marker or cutoff is sound here — ceasing to heal is far worse than the scan.
 *
 * `ORDER BY` stays on the bare grouping column so the covering index supplies
 * the order; `component-usage-resync-query-plan.test.ts` pins that and the
 * ABSENCE of a temp b-tree, because a plan that sorted would have to drain every
 * over-cap group before `LIMIT` could stop it.
 *
 * Positional parameters, in TEXTUAL order — which is also bind order, so the
 * keyset term leads the WHERE clause rather than sitting after the boundary:
 * - without a bound: `$1` cap, `$2` pass start, `$3` chunk size
 * - with a bound:    `$1` bound, `$2` cap, `$3` pass start, `$4` chunk size
 */
export function componentUsageResyncChunkSelectSql(
  hasKeysetBound: boolean
): string {
  const keysetSql = hasKeysetBound ? "\n     WHERE u.session_id > $1" : "";
  const capParam = hasKeysetBound ? "$2" : "$1";
  const passStartParam = hasKeysetBound ? "$3" : "$2";
  const limitParam = hasKeysetBound ? "$4" : "$3";
  return `SELECT u.session_id AS id, COUNT(*) AS usage_rows
     FROM agent_component_session_usage u${keysetSql}
     GROUP BY u.session_id
     HAVING COUNT(*) > ${capParam}
        AND EXISTS (
          SELECT 1 FROM sessions s
           WHERE s.id = u.session_id
             AND (s.updated_at IS NULL OR s.updated_at < ${passStartParam})
        )
        AND NOT EXISTS (
          SELECT 1 FROM component_usage_resync_seen m WHERE m.session_id = u.session_id
        )
     ORDER BY u.session_id ASC
     LIMIT ${limitParam}`;
}

/**
 * Discovery goes through the READER pool, never `prisma.client`.
 *
 * `prisma.client` IS the single writer connection, so running this scan on it
 * would put a GROUP BY over `agent_component_session_usage` — the widest read
 * this pass performs, and one every boot still pays once to prove the population
 * is drained — on the one connection live-hook ingest and both sync lanes depend
 * on, AND outside `write()`'s queue, so ahead of the fairness system rather than
 * in it. `read()` fans out across the `query_only` reader connections and runs
 * concurrently with the writer. Same shape as `healSweptAgentEndedAt`'s
 * discovery, for the same reason.
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
  const sql = componentUsageResyncChunkSelectSql(input.bound !== null);
  const params: (string | number)[] =
    input.bound === null
      ? [MAX_SYNCED_COMPONENT_USAGE, input.passStart, input.chunkSize]
      : [
          input.bound,
          MAX_SYNCED_COMPONENT_USAGE,
          input.passStart,
          input.chunkSize,
        ];
  return prisma.read((reader) =>
    reader.$queryRawUnsafe<CandidateRow[]>(sql, ...params)
  );
}

/**
 * Drop candidates whose counted row total cannot be believed, reporting each.
 *
 * `COUNT(*)` crosses the raw-query boundary as a driver-supplied value, so this
 * is a real parse boundary rather than a type-forbidden case. A count that is
 * not a finite integer above the cap is NOT coerced into one: the row is left
 * unmarked and unqueued, so a later boot can re-examine it once the store reads
 * correctly, and the condition is reported rather than absorbed.
 */
function partitionUsableCounts(
  candidates: CandidateRow[],
  log: (message: string) => void
): { id: string; usageRows: number }[] {
  const usable: { id: string; usageRows: number }[] = [];
  for (const candidate of candidates) {
    const usageRows = coerceCount(candidate.usage_rows);
    if (usageRows === null || usageRows <= MAX_SYNCED_COMPONENT_USAGE) {
      log(
        `component-usage re-sync (ISS-6998): session ${candidate.id} reported an unusable usage-row count (${String(candidate.usage_rows)}); left unqueued for a later pass`
      );
      continue;
    }
    usable.push({ id: candidate.id, usageRows });
  }
  return usable;
}

/** `COUNT(*)` arrives as a number or a bigint depending on the driver path. */
function coerceCount(value: unknown): number | null {
  if (typeof value === "bigint") {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
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
    candidates: { id: string; usageRows: number }[];
    chunkNow: string;
    passStart: string;
  }
): Promise<number> {
  const usageById = new Map(
    input.candidates.map((candidate) => [candidate.id, candidate.usageRows])
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
      // the count that selected it" — never a fabricated `0` for an id whose
      // count went missing, which would persist a delivery-evidence value the
      // pass never actually observed.
      const marked: { id: string; usageRows: number }[] = [];
      for (const row of bumped) {
        const usageRows = usageById.get(row.id);
        if (usageRows !== undefined) {
          marked.push({ id: row.id, usageRows });
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
        params.push(row.id, row.usageRows, input.chunkNow);
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO component_usage_resync_seen (session_id, usage_rows, requeued_at)
         VALUES ${values}
         ON CONFLICT (session_id) DO NOTHING`,
        ...params
      );
      return bumped.length;
    })
  );
}

function failureMessage(phase: string, error: unknown): string {
  return `component-usage re-sync ${phase} failed (ISS-6998): ${error instanceof Error ? error.message : String(error)}`;
}
