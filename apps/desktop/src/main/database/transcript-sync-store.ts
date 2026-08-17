/**
 * @file transcript-sync-store.ts
 * @description Durable per-transcript-file fingerprint + upload-cursor store for
 * the archive lane (FEA-2715). Mirrors `createSqliteSessionSyncSource`: a thin
 * factory over {@link DesktopPrisma} whose methods take/return only
 * structure-clone-safe plain data, so they can be exposed on the runtime
 * `SqliteAgentDatabase` and invoked from the main process across the db-host
 * IPC boundary (FEA-2038) — writes never cross the boundary, they run in the
 * db-host child via `prisma.write`.
 *
 * The `TranscriptSyncState` row is a cache/queue only; server state from
 * `sync-plan` is authoritative (recovery invariant 2), so losing rows is
 * harmless. BigInt columns (byte offsets/sizes, mtime ms) are surfaced as
 * `number` — local transcript sizes are far below 2^53.
 */

// FEA-2715 / ISS-4719: the archive-lane status/class const unions + their
// DB-string narrowers are the canonical runtime bindings, defined in the
// node-free renderer boundary contract; import them directly (Biome's
// `noBarrelFile` forbids re-exporting the runtime bindings through the types
// module, which re-exports only the TYPES).
import {
  asTranscriptSyncStatus,
  emptyTranscriptStatusCounts,
  TranscriptSyncClass,
  TranscriptSyncStatus,
  type TranscriptSyncStatusCounts,
} from "../../shared/transcript-sync-status-contract.js";
import {
  TRANSCRIPT_MAIN_FILE_KEY,
  TRANSCRIPT_OVERSIZED_DEAD_LETTER_PREFIX,
  type TranscriptFingerprint,
  type TranscriptMainBlobState,
  transcriptCursorMatchesComputeTarget,
} from "../transcript-sync/transcript-sync-types.js";
import type { Prisma } from "./generated/client.js";
import type { DesktopPrisma } from "./prisma-client.js";
import {
  interleaveBackfillReady,
  type TranscriptRow,
  toBigInt,
  toFingerprint,
} from "./transcript-sync-rows.js";
import {
  CLEARED_CLOUD_ACK,
  revivedRowData,
  settleUpdateData,
  strandedCloudAckWhere,
  strandedCursorWhere,
  TRANSCRIPT_ROW_SELECT,
  type TranscriptFailureInput,
  type TranscriptSettle,
  type TranscriptUploadedInput,
  transcriptRowWhere,
} from "./transcript-sync-settle.js";

/**
 * Newest-first ordering shared by every live-batch/recent read: most-recent
 * `lastMtimeMs` first, with `updatedAt` ascending as a stable tie-break.
 */
const NEWEST_FIRST_ORDER_BY: Prisma.TranscriptSyncStateOrderByWithRelationInput[] =
  [{ lastMtimeMs: "desc" }, { updatedAt: "asc" }];

/** A file observed by discovery/hook, with cheap fingerprint fields. */
export type TranscriptObserveInput = {
  externalSessionId: string;
  fileKey: string;
  sourceHarness: string;
  sourcePath: string;
  sourcePathHash: string;
  mtimeMs: number | null;
  size: number | null;
  syncClass: TranscriptSyncClass;
  /**
   * The live compute target id when known (online), else null/undefined. A file
   * whose cached cursor belongs to a different target is re-queued so it
   * re-uploads to the newly selected target (the old cursor points at the old
   * target's S3 object). Legacy raw-domain cursors also re-queue here so old
   * unredacted archive objects are rewritten through the redaction lane.
   */
  currentComputeTargetId?: string | null;
  now: string;
};

/**
 * ISS-4849: the compound identity of one transcript sync row — the minimum a
 * caller needs to name a row without holding a whole fingerprint or settle.
 * Matches the `externalSessionId_fileKey` unique key.
 */
export type TranscriptRowIdentity = {
  externalSessionId: string;
  fileKey: string;
};

export type TranscriptSyncStore = {
  get(
    externalSessionId: string,
    fileKey: string
  ): Promise<TranscriptFingerprint | null>;
  /**
   * Bounded, most-recent-first window of rows for the status snapshot UI. Backs
   * the polled `getTranscriptSyncStatus` IPC, so it must never materialize every
   * sync-state row (one per session×transcript-file, growing unboundedly with
   * the device's history) inside the heap-capped db-host worker (FEA-3385).
   * Newest `lastMtimeMs` first, `updatedAt` as a stable tie-break — same
   * ordering as `listReady`.
   */
  listRecent(limit: number): Promise<TranscriptFingerprint[]>;
  /**
   * ISS-5348: whole-table row census keyed by lifecycle status, backing the
   * polled `getTranscriptSyncStatus` IPC.
   *
   * This replaced `listRecent(100)` on that path for two reasons. Cost: nothing
   * indexes `lastMtimeMs DESC, updatedAt ASC`, so that read scanned every row
   * and built a temp b-tree every 5 seconds while the import splash was up,
   * during exactly the rebuild when the table is largest. A `GROUP BY status`
   * is served by the leading column of `idx_transcript_sync_state_status_next`
   * and materializes no rows in the heap-capped db-host worker. Correctness: a
   * newest-100 window is a SAMPLE biased toward recently-touched files, so a
   * device with thousands of older dead-lettered rows reported a clean lane —
   * the footer missed the failure it exists to report. Counts describe the
   * whole population.
   *
   * Every {@link TranscriptSyncStatus} key is always present; a status with no
   * rows is `0`. A row carrying an unknown/corrupt `status` string is counted
   * under no key rather than throwing.
   */
  statusCounts(): Promise<TranscriptSyncStatusCounts>;
  /**
   * ISS-4647: the `main` transcript blob state for a bounded set of sessions, so
   * the desktop LOCAL Sessions list can disclose a transcript lane that is still
   * behind (parity with the cloud list, which reads `SessionTranscript`).
   * Scoped to the page's identities — never a full-table read — and returns only
   * the four clone-safe fields the derivation needs. Sessions with no `main` row
   * are simply absent from the result: that is "no verdict", not "behind".
   */
  listMainBlobStates(
    externalSessionIds: string[]
  ): Promise<TranscriptMainBlobState[]>;
  listReady(now: string, limit: number): Promise<TranscriptFingerprint[]>;
  observe(input: TranscriptObserveInput): Promise<TranscriptFingerprint>;
  markUploading(
    externalSessionId: string,
    fileKey: string,
    now: string
  ): Promise<void>;
  /** Settle a file with no actionable work (missing / no complete line yet). */
  markIdle(
    externalSessionId: string,
    fileKey: string,
    now: string
  ): Promise<void>;
  /**
   * ISS-4815: settle a file the CLOUD authoritatively acknowledged it already
   * holds (the terminal-skip answer `uploaded` — a verified archive exists, so
   * the server refused to mask readable bytes with a late skip). Like
   * {@link TranscriptSyncStore.markIdle} there is no work left, so the queue
   * status is `idle`; unlike it, the acknowledgement is recorded DURABLY in
   * `cloudUploadedAt`, which excludes the row from
   * {@link TranscriptSyncStore.requeueStrandedMissingBlobs}.
   *
   * Without that durable mark, an already-uploaded MISSING-source row (whose
   * local cursor is necessarily still 0 — the desktop never uploaded a byte of
   * it) matched the stranded predicate on every launch, replayed the whole
   * missing-source failure ladder, and re-emitted the terminal skip just to be
   * told `uploaded` again. Self-correcting, but a needless skip round-trip and
   * ladder churn per boot for a transcript the cloud already holds.
   */
  markCloudUploaded(
    externalSessionId: string,
    fileKey: string,
    now: string,
    /** The compute target whose cloud gave the ack; null when unknown. */
    computeTargetId: string | null
  ): Promise<void>;
  /**
   * Terminally skip a file (status `dead`, `reason` retained in `lastError`)
   * without a retry — used for the oversize cap. Unlike `recordFailure` this is
   * a deliberate, non-retryable skip, not a consecutive-failure dead-letter.
   * `planObservation` re-queues it only if the file later changes.
   */
  markDead(
    externalSessionId: string,
    fileKey: string,
    reason: string,
    now: string
  ): Promise<void>;
  recordUploaded(input: TranscriptUploadedInput): Promise<void>;
  recordFailure(input: TranscriptFailureInput): Promise<void>;
  /**
   * ISS-4723 PR2: apply a whole drain batch's TERMINAL settles in ONE queued
   * `prisma.write` (one write-queue entry, so ONE checkpoint-eligible write)
   * instead of one write per file. The statements autocommit within the single
   * write turn (mirroring the `upsertPlans` / `sqliteEnqueueOutboxEntries`
   * batching idiom — no interactive `$transaction` needed for a set of
   * independent single-row updates on `synchronous=NORMAL`). Each settle applies
   * the exact same `data` its per-file method would (via the shared
   * `settleUpdateData` builder), so terminal semantics are unchanged; this only
   * coalesces the WRITES. An empty batch does no write. The whole settle array is
   * validated (each payload built via the exhaustive `settleUpdateData`) BEFORE
   * the first autocommit, so an unknown kind aborts before any partial write;
   * each row applies via a zero-row-safe `updateMany`, so a missing row (concurrent
   * prune) is a 0-count no-op — NOT a P2025 throw that would strand every later
   * settle in the batch. A dropped settle is harmless anyway: the row is still
   * `uploading` (the claim landed per-file) and `requeueStale` revives it on the
   * next boot, so the server-authoritative cursor re-plans it.
   */
  recordBatchSettled(settles: TranscriptSettle[]): Promise<void>;
  /**
   * ISS-4849: IN-PROCESS recovery for a batch flush that REJECTED.
   *
   * When `recordBatchSettled` fails (a db-host error mid-flush), every file in
   * that batch is left `uploading` — and `uploading` is invisible to
   * `listReady`, so nothing in the running process ever re-arms them. The only
   * thing that did was `requeueStale`, which is boot-only: a single transient
   * flush failure stranded a whole batch until the next app restart. That is a
   * silent hole in the eventual-consistency guarantee, so the drain now closes
   * it while it is still running.
   *
   * Scoped to `status = uploading` ON PURPOSE, and to the given identities only:
   * `recordBatchSettled` autocommits per statement, so a rejection mid-loop can
   * leave EARLIER settles already applied. Re-queuing by identity alone would
   * resurrect a row that legitimately settled `dead`/`idle` in the same batch.
   * Only a row still sitting in the claim state genuinely lost its settle.
   *
   * Deliberately does NOT touch the retry ladder (`retryCount`,
   * `missingSourceCount`, `nextAttemptAt`, `lastError`) — mirroring
   * `requeueStale`. The UPLOAD did not fail here; only the settle write did, so
   * advancing a failure counter would punish the wrong thing.
   *
   * Returns the number of rows revived (0 when every settle actually landed).
   */
  requeueUnsettledBatch(
    identities: readonly TranscriptRowIdentity[],
    now: string
  ): Promise<number>;
  /**
   * Boot recovery: reset rows left in `uploading` by a crash/force-quit back to
   * `queued`. Safe on start because no upload is in flight in a fresh process,
   * and `listReady`/`planObservation` would otherwise never re-pick them.
   * Returns the number of rows revived.
   */
  requeueStale(now: string): Promise<number>;
  /**
   * ISS-4621: boot recovery for STRANDED transcript blobs — rows that settled to
   * `idle` having never uploaded a single byte (`syncedByteOffset === 0`). Such a
   * row is invisible to BOTH lanes that would otherwise terminate it: `listReady`
   * only picks `queued`/`failed`, and the discovery sweep only re-`observe`s a
   * file still on disk (a vanished source is never re-enumerated, so
   * `planObservation` never flips it back to `queued`). The result is the
   * SES-78221 limbo — the cloud shows the transcript `missing`/`syncing` forever
   * with `permanentFailureReason` null, even though the session has full derived
   * data, because nothing ever drives the file to upload OR to a terminal
   * dead-letter.
   *
   * Re-queuing these lets the existing per-file executor re-stat the source and
   * TERMINATE the file honestly: source present ⇒ it uploads; source gone (the
   * SES-78221 case) ⇒ `handleMissingSource` climbs the bounded missing-source
   * ladder to a terminal `source_gone` dead-letter AND emits the cloud skip, so
   * the read path finally derives `failedPermanent` instead of eternal `syncing`.
   * No new terminal machinery — this only re-arms rows the existing ladder can
   * already carry to completion.
   *
   * Scoped tightly so it never disturbs a healthy row: `status = idle` AND the
   * row holds no bytes THE CURRENT COMPUTE TARGET's cloud can read. A
   * `queued`/`uploading`/`failed`/`dead` row is already owned by a lane. One
   * atomic `updateMany` (no read-then-write) resets the backoff/counters exactly
   * like `requeueStale`. Returns the rows re-armed.
   *
   * ISS-4647: "holds no readable bytes" is NOT just `syncedByteOffset = 0`. A
   * positive cursor can belong to a PREVIOUS compute target (or to the
   * pre-FEA-3735 raw-byte domain), in which case the current target's cloud row
   * has nothing — `planObservation` already treats such a cursor as stale via
   * `transcriptCursorMatchesComputeTarget`, and this recovery applies the same
   * check so a vanished source whose only bytes live on the old target is not
   * silently excluded. When `computeTargetId` is null (offline) the cursor
   * domain is unknowable, so the predicate falls back to `syncedByteOffset = 0`
   * only — never widening the re-arm on a guess.
   *
   * ISS-4815: a row carrying a durable `cloudUploadedAt` is excluded too. Its
   * cursor is 0 (the desktop never uploaded a byte) yet it is NOT stranded — the
   * cloud told us it holds a verified archive, and re-arming it replayed the
   * missing-source ladder and the terminal skip on every launch. Pre-migration
   * rows hold `null` and are unaffected.
   */
  requeueStrandedMissingBlobs(input: {
    now: string;
    computeTargetId: string | null;
  }): Promise<number>;
  /**
   * ISS-4621: settle a row whose upload the privacy gate revoked mid-flight
   * back to `queued` (NOT `idle`). Revocation is not a failure — no bytes
   * escaped — so the ladder is reset like a revived row. It must not settle to
   * `idle` either: `planObservation` re-queues an idle row only when the file
   * CHANGES, and an ended session's transcript never changes again, so
   * idle-at-zero-bytes was an absorbing state (the SES-78221 strand). A `queued`
   * row costs nothing while the gate is closed (`shouldRun` suppresses the
   * drain) and resumes the moment the tier reopens. One atomic `updateMany`
   * scoped to the single identity; returns the rows re-queued (0 if the row
   * vanished).
   */
  requeueRevoked(
    externalSessionId: string,
    fileKey: string,
    now: string
  ): Promise<number>;
  /**
   * FEA-3932: automatic dead-letter redrive scoped to ONE harness. Atomically
   * flips matching `dead` rows for `sourceHarness` back to `queued` and resets
   * their failure/missing counters + backoff so the normal drain re-attempts them
   * after the source re-materializes. One `updateMany` (atomic, no read-then-write)
   * so a concurrent observe/drain can't lost-update. Returns the rows redriven.
   *
   * Deliberately harness-scoped: called once on service start for `opencode`
   * only, so Claude/Codex dead-letters are left untouched. `lastErrorPrefix`
   * narrows FURTHER within the harness to a single terminal FAMILY — the caller
   * passes the "source gone" prefix so only pre-materialization missing-source
   * dead-letters are revived. Genuinely terminal `too_large` / oversized-line
   * OpenCode dead-letters carry a different `lastError` and stay dead (re-running
   * materialization can't shrink a pathological file), so they don't churn back
   * onto the queue on every start.
   */
  redriveDeadLettered(input: {
    sourceHarness: string;
    lastErrorPrefix?: string;
    now: string;
  }): Promise<number>;
  /**
   * FEA-3489 (PRD-536): user-initiated force-archive of ONE oversized transcript.
   * Atomically flips a single `dead` row for `(externalSessionId, fileKey)` back
   * to `queued` and resets its failure/missing counters + backoff so the next
   * drain re-attempts it. Scoped to one identity AND to the WHOLE-FILE size-cap
   * terminal only (one `updateMany` with the compound-key + `lastError`-prefix
   * predicate — atomic, no read-then-write) so it can never revive an unrelated
   * dead-letter, nor a `source_gone` / redacted-line-too-long terminal the
   * size-cap bypass cannot fix (reviving those would loop the action forever).
   * Returns the number of rows revived (0 when the row is absent, not `dead`, or
   * dead for a non-cap reason — the caller reports `notFound`/`permanent`). The
   * size-cap bypass itself lives in the executor call, gated by this being a user
   * action — the row's revival alone does not waive the cap.
   */
  reviveForForcedSync(input: {
    externalSessionId: string;
    fileKey: string;
    now: string;
  }): Promise<number>;
};

type PlannedObservation = Pick<
  TranscriptFingerprint,
  | "status"
  | "syncClass"
  | "retryCount"
  | "missingSourceCount"
  | "nextAttemptAt"
  | "lastError"
> & {
  /**
   * Whether to persist the freshly observed mtime/size/path onto the row. Only
   * true when this observation is acted on (`needsSync`): advancing these while
   * a row is `uploading` (or otherwise not re-queued) would consume the growth
   * signal — a file that grows mid-upload would look "unchanged" once the
   * in-flight upload settles to `idle`, and its trailing bytes would never
   * re-queue (permanent loss of the appended lines).
   */
  advanceObserved: boolean;
};

/**
 * Decide the row's next status/class/retry from a fresh observation. A file is
 * (re)queued only when it is new or actually changed — mtime/size/path differs,
 * or the cached cursor does not already describe redacted bytes for the current
 * compute target. That cursor-domain check intentionally treats pre-FEA-3735
 * raw-domain cursors (`syncedComputeTargetId === computeTargetId`) as stale so
 * old unredacted archive objects are rewritten. Change detection alone drives
 * re-sync: multi-window continuation is carried by `recordUploaded` leaving the
 * row `queued`, so an unchanged, already-synced file (including one whose
 * partial trailing line is not on a newline boundary) settles to `idle` and
 * never flaps back to `queued`. An in-flight (`uploading`) row is never
 * disturbed; a dead-lettered row re-queues only on a real change (one more
 * chance for a grown file), and a changed/new
 * file resets the backoff.
 */
function planObservation(
  existing: TranscriptFingerprint | null,
  input: TranscriptObserveInput
): PlannedObservation {
  const cursorNeedsRewrite =
    input.currentComputeTargetId != null &&
    existing?.syncedComputeTargetId != null &&
    !transcriptCursorMatchesComputeTarget(
      existing.syncedComputeTargetId,
      input.currentComputeTargetId
    );
  // `fs.stat` reports a fractional `mtimeMs` (sub-ms precision on APFS/ext4),
  // but the stored `lastMtimeMs` was truncated to an integer via `toBigInt`
  // (`BigInt(Math.trunc(...))`). Truncate the observed mtime to the same
  // precision before comparing (preserving `null`), otherwise `changed` is
  // always true and every sweep re-queues every file (FEA-2834).
  const observedMtimeMs =
    input.mtimeMs == null ? null : Math.trunc(input.mtimeMs);
  const changed =
    !existing ||
    cursorNeedsRewrite ||
    existing.lastMtimeMs !== observedMtimeMs ||
    existing.lastSize !== input.size ||
    existing.sourcePath !== input.sourcePath;

  // `uploading` is left alone (an upload is in flight); every other status
  // re-queues iff the file changed. When `changed` is false the row keeps its
  // current status, so a `dead` row stays dead until the file actually grows.
  const needsSync =
    changed && existing?.status !== TranscriptSyncStatus.Uploading;
  const resetBackoff = needsSync;
  const syncClass: TranscriptSyncClass =
    input.syncClass === TranscriptSyncClass.Live
      ? TranscriptSyncClass.Live
      : (existing?.syncClass ?? TranscriptSyncClass.Backfill);

  return {
    status: needsSync
      ? TranscriptSyncStatus.Queued
      : (existing?.status ?? TranscriptSyncStatus.Idle),
    syncClass,
    retryCount: resetBackoff ? 0 : (existing?.retryCount ?? 0),
    // FEA-3555: a reappeared/changed file (`resetBackoff`) restarts the
    // missing-source run; otherwise carry the isolated counter forward.
    missingSourceCount: resetBackoff ? 0 : (existing?.missingSourceCount ?? 0),
    nextAttemptAt: resetBackoff ? null : (existing?.nextAttemptAt ?? null),
    lastError: resetBackoff ? null : (existing?.lastError ?? null),
    advanceObserved: needsSync,
  };
}

export function createTranscriptSyncStore(
  // ISS-4710: `read` is required for the reader-pool `listReady` claim-discovery
  // scan so it runs concurrently with a busy writer during a rebuild.
  prisma: Pick<DesktopPrisma, "client" | "write" | "read">
): TranscriptSyncStore {
  async function get(
    externalSessionId: string,
    fileKey: string
  ): Promise<TranscriptFingerprint | null> {
    const row = await prisma.client.transcriptSyncState.findUnique({
      where: { externalSessionId_fileKey: { externalSessionId, fileKey } },
    });
    return row ? toFingerprint(row) : null;
  }

  return {
    get,
    listRecent(limit: number): Promise<TranscriptFingerprint[]> {
      // ISS-4710 / ISS-4716: status reads run on the READER pool (`prisma.read`)
      // for the same reason `listReady` below does — during a first-boot
      // DATA_REVISION rebuild the writer is saturated with bulk rebuild
      // `$transaction`s, and a `prisma.client` read here would contend for that
      // connection's per-statement mutex. This is a read-only status projection
      // for the import-splash footnote, polled while the splash is visible (i.e.
      // throughout that very rebuild), so a slightly-stale committed-WAL
      // snapshot is exactly the right trade.
      return prisma.read(async (reader) => {
        const rows = await reader.transcriptSyncState.findMany({
          orderBy: NEWEST_FIRST_ORDER_BY,
          take: limit,
        });
        return rows.map((row) => toFingerprint(row));
      });
    },
    statusCounts(): Promise<TranscriptSyncStatusCounts> {
      // Reader pool for the same reason `listRecent` above uses it: this is
      // polled throughout the first-boot rebuild that saturates the writer.
      return prisma.read(async (reader) => {
        const grouped = await reader.transcriptSyncState.groupBy({
          by: ["status"],
          _count: { _all: true },
        });
        const counts = emptyTranscriptStatusCounts();
        for (const group of grouped) {
          // `status` is an unconstrained TEXT column; narrow it the same way
          // `toFingerprint` does. A version-skewed or corrupt value is dropped
          // rather than throwing — it belongs to no known lifecycle state, and
          // inventing one would move the footer to a status it cannot support.
          const status = asTranscriptSyncStatus(group.status);
          if (status) {
            counts[status] = group._count._all;
          }
        }
        return counts;
      });
    },
    async listMainBlobStates(
      externalSessionIds: string[]
    ): Promise<TranscriptMainBlobState[]> {
      if (externalSessionIds.length === 0) {
        return [];
      }
      const rows = await prisma.client.transcriptSyncState.findMany({
        where: {
          fileKey: TRANSCRIPT_MAIN_FILE_KEY,
          externalSessionId: { in: externalSessionIds },
        },
        select: {
          externalSessionId: true,
          status: true,
          syncedByteOffset: true,
          syncedComputeTargetId: true,
          cloudUploadedAt: true,
          cloudUploadedComputeTargetId: true,
        },
      });
      return rows.map((row) => ({
        externalSessionId: row.externalSessionId,
        // `status` is an unconstrained TEXT column; narrow it the same way
        // `toFingerprint` does rather than trusting an unchecked cast.
        status: asTranscriptSyncStatus(row.status) ?? TranscriptSyncStatus.Idle,
        syncedByteOffset: Number(row.syncedByteOffset),
        syncedComputeTargetId: row.syncedComputeTargetId,
        cloudUploadedAt: row.cloudUploadedAt,
        cloudUploadedComputeTargetId: row.cloudUploadedComputeTargetId,
      }));
    },
    listReady(now: string, limit: number): Promise<TranscriptFingerprint[]> {
      const readyWhere = {
        status: {
          in: [TranscriptSyncStatus.Queued, TranscriptSyncStatus.Failed],
        },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      };
      // ISS-4710: the drain's claim-discovery read runs on the READER pool
      // (`prisma.read`), NOT the writer connection (`prisma.client`). During a
      // first-boot DATA_REVISION rebuild the writer is saturated with bulk
      // rebuild `$transaction`s; a `prisma.client` read here would contend for
      // that busy writer connection's per-statement mutex and stall the transcript
      // drain until the rebuild let go. The reader pool reads a committed WAL
      // snapshot CONCURRENTLY with the writer, so the transcript lane keeps
      // discovering + uploading ready files while the rebuild writes. The claim
      // itself is an in-memory `inFlight` Set claim in the drain queue and the
      // settle-write is a later `prisma.write`, so a slightly-stale snapshot at
      // worst re-lists an already-claimed file (deduped by `inFlight`).
      // Live (active-session) transcripts always drain first: they are bounded
      // and must stay within the freshness SLA. Most-recent first, updatedAt as
      // a stable tie-break.
      return prisma.read(async (reader) => {
        const live = await reader.transcriptSyncState.findMany({
          where: { ...readyWhere, syncClass: TranscriptSyncClass.Live },
          orderBy: NEWEST_FIRST_ORDER_BY,
          take: limit,
        });
        const remaining = limit - live.length;
        let backfill: TranscriptRow[] = [];
        if (remaining > 0) {
          // Backfill stays newest-first for freshness (PLN-1288), but each batch
          // reserves interleaved slots for the OLDEST queued files so a large
          // historical tail can never be starved indefinitely by newer
          // transcripts continually arriving at the head. Query both orderings
          // and pincer-merge; see interleaveBackfillReady.
          const [newest, oldest] = await Promise.all([
            reader.transcriptSyncState.findMany({
              where: { ...readyWhere, syncClass: TranscriptSyncClass.Backfill },
              orderBy: NEWEST_FIRST_ORDER_BY,
              take: remaining,
            }),
            reader.transcriptSyncState.findMany({
              where: { ...readyWhere, syncClass: TranscriptSyncClass.Backfill },
              orderBy: [{ lastMtimeMs: "asc" }, { updatedAt: "asc" }],
              take: remaining,
            }),
          ]);
          backfill = interleaveBackfillReady(newest, oldest, remaining);
        }
        return [...live, ...backfill].map((row) => toFingerprint(row));
      });
    },
    async observe(
      input: TranscriptObserveInput
    ): Promise<TranscriptFingerprint> {
      const mtime = toBigInt(input.mtimeMs);
      const size = toBigInt(input.size);
      const where = {
        externalSessionId_fileKey: {
          externalSessionId: input.externalSessionId,
          fileKey: input.fileKey,
        },
      };
      // Read-decide-write in ONE serialized write turn so a concurrent observe
      // (sweep vs hook) for the same file cannot lost-update the status/backoff
      // computed from a stale snapshot (AGENTS.md: no read-then-write around an
      // upsert). The upserted row is returned authoritatively.
      const row = await prisma.write(async (client) => {
        const existingRow = await client.transcriptSyncState.findUnique({
          where,
        });
        const existing = existingRow ? toFingerprint(existingRow) : null;
        const next = planObservation(existing, input);
        return client.transcriptSyncState.upsert({
          where,
          create: {
            externalSessionId: input.externalSessionId,
            fileKey: input.fileKey,
            sourceHarness: input.sourceHarness,
            sourcePath: input.sourcePath,
            sourcePathHash: input.sourcePathHash,
            lastMtimeMs: mtime,
            lastSize: size,
            status: next.status,
            syncClass: next.syncClass,
            retryCount: next.retryCount,
            missingSourceCount: next.missingSourceCount,
            nextAttemptAt: next.nextAttemptAt,
            lastError: next.lastError,
            createdAt: input.now,
            updatedAt: input.now,
          },
          // Cursor fields (syncedByteOffset/syncedSha256/storedEtag/
          // syncedComputeTargetId) are deliberately NOT touched here — only
          // recordUploaded advances them. The observed mtime/size/path advance
          // ONLY when this observation is acted on (`advanceObserved`); see
          // PlannedObservation — advancing them for an `uploading` row would
          // erase the growth signal and lose lines appended mid-upload.
          update: {
            sourceHarness: input.sourceHarness,
            status: next.status,
            syncClass: next.syncClass,
            retryCount: next.retryCount,
            missingSourceCount: next.missingSourceCount,
            nextAttemptAt: next.nextAttemptAt,
            lastError: next.lastError,
            updatedAt: input.now,
            ...(next.advanceObserved
              ? {
                  sourcePath: input.sourcePath,
                  sourcePathHash: input.sourcePathHash,
                  lastMtimeMs: mtime,
                  lastSize: size,
                  // ISS-4815: the file is back and CHANGED, so the row re-queues
                  // and will upload the new bytes. A prior cloud acknowledgement
                  // described the old content only — drop it so the re-armed row
                  // is recoverable again if this attempt strands.
                  ...CLEARED_CLOUD_ACK,
                }
              : {}),
          },
        });
      });
      return toFingerprint(row);
    },
    async markUploading(
      externalSessionId: string,
      fileKey: string,
      now: string
    ): Promise<void> {
      await prisma.write((client) =>
        client.transcriptSyncState.update({
          where: { externalSessionId_fileKey: { externalSessionId, fileKey } },
          data: { status: TranscriptSyncStatus.Uploading, updatedAt: now },
          select: TRANSCRIPT_ROW_SELECT,
        })
      );
    },
    async markDead(
      externalSessionId: string,
      fileKey: string,
      reason: string,
      now: string
    ): Promise<void> {
      await prisma.write((client) =>
        client.transcriptSyncState.update({
          where: transcriptRowWhere(externalSessionId, fileKey),
          data: settleUpdateData({
            kind: "dead",
            externalSessionId,
            fileKey,
            reason,
            now,
          }),
          select: TRANSCRIPT_ROW_SELECT,
        })
      );
    },
    async markIdle(
      externalSessionId: string,
      fileKey: string,
      now: string
    ): Promise<void> {
      await prisma.write((client) =>
        client.transcriptSyncState.update({
          where: transcriptRowWhere(externalSessionId, fileKey),
          data: settleUpdateData({
            kind: "idle",
            externalSessionId,
            fileKey,
            now,
          }),
          select: TRANSCRIPT_ROW_SELECT,
        })
      );
    },
    async markCloudUploaded(
      externalSessionId: string,
      fileKey: string,
      now: string,
      computeTargetId: string | null
    ): Promise<void> {
      await prisma.write((client) =>
        client.transcriptSyncState.update({
          where: transcriptRowWhere(externalSessionId, fileKey),
          data: settleUpdateData({
            kind: "cloudUploaded",
            externalSessionId,
            fileKey,
            now,
            computeTargetId,
          }),
          select: TRANSCRIPT_ROW_SELECT,
        })
      );
    },
    async recordUploaded(input: TranscriptUploadedInput): Promise<void> {
      await prisma.write((client) =>
        client.transcriptSyncState.update({
          where: transcriptRowWhere(input.externalSessionId, input.fileKey),
          data: settleUpdateData({ kind: "uploaded", ...input }),
          select: TRANSCRIPT_ROW_SELECT,
        })
      );
    },
    async recordFailure(input: TranscriptFailureInput): Promise<void> {
      await prisma.write((client) =>
        client.transcriptSyncState.update({
          where: transcriptRowWhere(input.externalSessionId, input.fileKey),
          data: settleUpdateData({ kind: "failure", ...input }),
          select: TRANSCRIPT_ROW_SELECT,
        })
      );
    },
    async recordBatchSettled(settles: TranscriptSettle[]): Promise<void> {
      if (settles.length === 0) {
        return;
      }
      // Build EVERY update payload up front, BEFORE the first autocommit. The
      // settles cross the DB-host protocol as `unknown[]` and only the request
      // kind is validated before dispatch, so an unknown settle kind must fail
      // here — where nothing has been written yet — rather than fall through
      // `settleUpdateData` mid-loop and leave earlier rows applied but later
      // ones skipped. `settleUpdateData`'s exhaustive switch throws on an
      // unmapped kind, so a malformed batch aborts the whole flush cleanly.
      const updates = settles.map((settle) => ({
        externalSessionId: settle.externalSessionId,
        fileKey: settle.fileKey,
        data: settleUpdateData(settle),
      }));
      // ONE queued write turn for the whole batch: the statements autocommit in
      // order within the single write-queue entry (mirroring `upsertPlans`),
      // so the drain pays ONE checkpoint-eligible write instead of one per file.
      // `updateMany` on the unique identity is zero-row-safe: a settle whose row
      // vanished (concurrent prune) is a 0-count no-op, NOT a P2025 throw that
      // would abort the autocommit mid-batch and skip every later settle.
      await prisma.write(async (client) => {
        for (const update of updates) {
          await client.transcriptSyncState.updateMany({
            where: {
              externalSessionId: update.externalSessionId,
              fileKey: update.fileKey,
            },
            data: update.data,
          });
        }
      });
    },
    async requeueUnsettledBatch(
      identities: readonly TranscriptRowIdentity[],
      now: string
    ): Promise<number> {
      if (identities.length === 0) {
        return 0;
      }
      // ONE zero-row-safe `updateMany` for the whole batch: a row whose settle
      // DID land is no longer `uploading` and is simply not matched, so this can
      // never undo an applied terminal state.
      const result = await prisma.write((client) =>
        client.transcriptSyncState.updateMany({
          where: {
            status: TranscriptSyncStatus.Uploading,
            OR: identities.map((identity) => ({
              externalSessionId: identity.externalSessionId,
              fileKey: identity.fileKey,
            })),
          },
          data: { status: TranscriptSyncStatus.Queued, updatedAt: now },
        })
      );
      return result.count;
    },
    async requeueStale(now: string): Promise<number> {
      const result = await prisma.write((client) =>
        client.transcriptSyncState.updateMany({
          where: { status: TranscriptSyncStatus.Uploading },
          data: { status: TranscriptSyncStatus.Queued, updatedAt: now },
        })
      );
      return result.count;
    },
    async requeueStrandedMissingBlobs(input: {
      now: string;
      computeTargetId: string | null;
    }): Promise<number> {
      // ISS-4621: re-arm rows that settled `idle` holding no bytes the cloud can
      // read. These are stranded — never `listReady` (idle), never re-observed (a
      // vanished source drops out of discovery) — so the drain never gets to
      // TERMINATE them (upload or `source_gone` dead-letter). Re-queue + reset
      // backoff/counters (same "revived" reset the dead-letter redrive uses) so
      // the existing per-file executor + bounded missing-source ladder can drive
      // each to an honest terminal state. One atomic `updateMany`.
      //
      // ISS-4647: a fully-synced idle row (`syncedByteOffset > 0` under the
      // CURRENT target's redacted cursor domain) is still untouched, but a
      // positive cursor from a PREVIOUS target no longer counts as "the cloud has
      // it" — that is the same staleness `planObservation` already applies via
      // `transcriptCursorMatchesComputeTarget`.
      const result = await prisma.write((client) =>
        client.transcriptSyncState.updateMany({
          where: {
            status: TranscriptSyncStatus.Idle,
            // ISS-4815: a row the CURRENT target's cloud authoritatively
            // acknowledged it already holds is SETTLED, not stranded — re-arming
            // it replays the whole missing-source ladder and re-emits the
            // terminal skip on every launch just to be told `uploaded` again.
            // Scoped to the acknowledging target, exactly like the cursor
            // clause: an ack from a PREVIOUS target says nothing about what this
            // one holds.
            //
            // Combined under `AND` rather than spread side by side: both helpers
            // can return a top-level `OR`, and spreading the second would
            // silently clobber the first's.
            AND: [
              strandedCloudAckWhere(input.computeTargetId),
              strandedCursorWhere(input.computeTargetId),
            ],
          },
          data: revivedRowData(input.now),
        })
      );
      return result.count;
    },
    async requeueRevoked(
      externalSessionId: string,
      fileKey: string,
      now: string
    ): Promise<number> {
      // ISS-4621: a revoked upload settles back to `queued`, never `idle` —
      // an idle row at zero bytes only re-queues when the file CHANGES, and an
      // ended session's transcript never changes again, so idling here minted
      // permanently-stranded rows. Same "revived" reset the redrives use (a
      // revocation is not a failure, so the ladder restarts clean). `updateMany`
      // on the unique identity: atomic, and a vanished row is a 0-count no-op
      // rather than a throw.
      const result = await prisma.write((client) =>
        client.transcriptSyncState.updateMany({
          where: { externalSessionId, fileKey },
          data: revivedRowData(now),
        })
      );
      return result.count;
    },
    async redriveDeadLettered(input: {
      sourceHarness: string;
      lastErrorPrefix?: string;
      now: string;
    }): Promise<number> {
      const result = await prisma.write((client) =>
        client.transcriptSyncState.updateMany({
          where: {
            status: TranscriptSyncStatus.Dead,
            sourceHarness: input.sourceHarness,
            // Narrow to a single terminal FAMILY when a prefix is supplied so
            // genuinely-terminal dead-letters (too_large / oversized line, which
            // carry a different reason) are NOT revived. `startsWith` maps to a
            // SQLite `LIKE 'prefix%'`.
            ...(input.lastErrorPrefix
              ? { lastError: { startsWith: input.lastErrorPrefix } }
              : {}),
          },
          data: revivedRowData(input.now),
        })
      );
      return result.count;
    },
    async reviveForForcedSync(input: {
      externalSessionId: string;
      fileKey: string;
      now: string;
    }): Promise<number> {
      const result = await prisma.write((client) =>
        client.transcriptSyncState.updateMany({
          where: {
            externalSessionId: input.externalSessionId,
            fileKey: input.fileKey,
            // Only a terminal dead-letter is force-revived; a row already
            // queued/uploading/idle is left to the normal lane (no-op → 0).
            status: TranscriptSyncStatus.Dead,
            // Scope to the WHOLE-FILE size-cap terminal ONLY (FEA-3489 review):
            // `dead` also covers `source_gone` and the redacted-line-too-long
            // limit, both surfaced as `too_large`/permanent but NOT fixable by the
            // size-cap bypass. Reviving those would loop the force-archive action
            // on the same terminal failure forever. `startsWith` maps to a SQLite
            // `LIKE 'prefix%'`; the prefix is the single source of truth shared
            // with the executor's oversized `markDead`.
            lastError: { startsWith: TRANSCRIPT_OVERSIZED_DEAD_LETTER_PREFIX },
          },
          data: revivedRowData(input.now),
        })
      );
      return result.count;
    },
  };
}
