/**
 * @file transcript-sync-types.ts
 * @description Shared types + tuning constants for the desktop transcript
 * archive lane (FEA-2715, PLN-1288). This lane is entirely separate from the
 * 256 KiB structured-metadata lane (`AgentSessionSyncService`): it fingerprints
 * raw Claude Code / Codex transcript files (main + subagent) and streams byte
 * deltas through the PLN-1287 control plane. No transcript bytes are parsed
 * here — raw bytes only.
 */

import { isMaterializedTranscriptHarness } from "@repo/api/src/types/desktop-transcripts";
import { exponentialBackoffMs } from "../../shared/exponential-backoff.js";

// FEA-2715 / ISS-4719: the archive-lane `TranscriptSyncStatus` /
// `TranscriptSyncClass` const unions (and their DB-string narrowers
// `asTranscriptSyncStatus` / `asTranscriptSyncClass`) are now defined in the
// node-free renderer boundary contract (`shared/transcript-sync-status-contract.ts`)
// rather than here. `TranscriptSyncStatus` crosses into the renderer as the KEYS
// of `TranscriptSyncStatusCounts`, so keeping the narrow unions ON that boundary
// is what stops an impossible
// fixture like `status: "syncing"` from compiling and preserves the renderer's
// exhaustive checks. The TYPES are re-exported below so this lane's existing
// importers keep their local reference; runtime value consumers (the const
// objects' members and the narrowers) import them directly from the contract
// (Biome's `noBarrelFile` forbids re-exporting the runtime bindings).
export type {
  TranscriptSyncClass,
  TranscriptSyncStatus,
} from "../../shared/transcript-sync-status-contract.js";

import type {
  TranscriptSyncClass,
  TranscriptSyncStatus,
} from "../../shared/transcript-sync-status-contract.js";

/**
 * The harnesses the archive lane syncs. `claude`/`codex` sync their raw
 * on-disk `.jsonl` transcripts directly. `opencode` is a BATCH harness whose
 * canonical store is a foreign SQLite DB (`opencode.db`) — the byte-delta lane
 * cannot upload the DB, so the desktop materializer projects it into
 * line-delimited JSON under a materialized root and THOSE files are what sync
 * (FEA-3932). See {@link isBatchMaterializedHarness}.
 */
export const TranscriptSourceHarness = {
  Claude: "claude",
  Codex: "codex",
  OpenCode: "opencode",
} as const;
export type TranscriptSourceHarness =
  (typeof TranscriptSourceHarness)[keyof typeof TranscriptSourceHarness];

/**
 * True for a harness whose transcript files are MATERIALIZED by the desktop
 * (a deterministic re-derivable projection of a foreign store) rather than the
 * agent's own raw on-disk transcript. Today only OpenCode: its per-session
 * `main.jsonl`/`subagent:<id>.jsonl` files are regenerated from `opencode.db`
 * every sweep, so a transiently-absent materialized source at
 * `syncedByteOffset === 0` is re-created next sweep and must NOT dead-letter as
 * `source_gone` (unlike a genuinely-vanished Claude/Codex rollout). Accepts an
 * unconstrained string so a cross-repo/DB `sourceHarness` value narrows safely.
 */
export function isBatchMaterializedHarness(sourceHarness: string): boolean {
  // ISS-4820: the SERVER now enforces the same split at the skip write boundary
  // (a recoverable reason is only valid for a materialized harness), so the set
  // lives in the wire contract and both sides read it. Re-declaring the literal
  // here is exactly how the two would drift.
  return isMaterializedTranscriptHarness(sourceHarness);
}

/**
 * Whether each archive-lane harness's transcript can be live-enqueued from a
 * single changed source path (FEA-3640).
 *
 * The `satisfies Record<TranscriptSourceHarness, boolean>` is LOAD-BEARING, not
 * decoration: adding a member to {@link TranscriptSourceHarness} fails typecheck
 * here until someone decides which lane it belongs to. Without it a new harness
 * would compile clean, pass every test, and silently never arm the ~5 min live
 * flush — reproducing, for that harness, the exact gap FEA-3640 fixes for Codex.
 *
 * Deliberately a decision table rather than `!isBatchMaterializedHarness(...)`:
 * deriving it would make an unrecognized new harness default to "raw", so a
 * harness whose source is NOT its transcript (the OpenCode shape) would upload
 * the wrong bytes if someone forgot to also update that predicate. Defaulting to
 * a wrong-bytes upload is a worse failure than defaulting to sweep-only, so the
 * two stay independent and this table is the one that must be updated.
 */
const LIVE_ENQUEUEABLE_BY_HARNESS = {
  [TranscriptSourceHarness.Claude]: true,
  [TranscriptSourceHarness.Codex]: true,
  // Batch-materialized: the collector's source is the foreign `opencode.db`, not
  // a transcript, so its projections come from `materialize()` + discovery.
  [TranscriptSourceHarness.OpenCode]: false,
} satisfies Record<TranscriptSourceHarness, boolean>;

/**
 * Narrow an arbitrary collector harness key to a harness whose RAW on-disk
 * transcript can be live-enqueued from a single changed source path (FEA-3640).
 * Returns null — meaning "leave it to the discovery sweep" — for:
 *
 * - a harness with no archive-lane support at all (`cursor`, `copilot`): they
 *   have no transcript refs, so there is nothing to enqueue;
 * - a BATCH-materialized harness (`opencode`, see
 *   {@link isBatchMaterializedHarness}): the collector's source is the foreign
 *   `opencode.db`, NOT a transcript file, so enqueuing that path would archive
 *   the wrong bytes. Its projections are regenerated by `materialize()` and
 *   enumerated by discovery.
 *
 * Accepts an unconstrained string so a collector key (or a cross-version value)
 * narrows safely instead of widening the archive lane's harness union.
 */
export function toRawTranscriptSourceHarness(
  harness: string
): TranscriptSourceHarness | null {
  if (!Object.hasOwn(LIVE_ENQUEUEABLE_BY_HARNESS, harness)) {
    return null; // no archive-lane support at all (cursor, copilot)
  }
  const known = harness as TranscriptSourceHarness;
  return LIVE_ENQUEUEABLE_BY_HARNESS[known] ? known : null;
}

/** The `main` transcript file key. */
export const TRANSCRIPT_MAIN_FILE_KEY = "main";

/** Build the `subagent:{fileId}` file key for a sidechain transcript. */
export function subagentFileKey(fileId: string): string {
  return `subagent:${fileId}`;
}

/**
 * A discovered transcript file identity (before fingerprinting). One logical
 * session owns one `main` file plus zero or more `subagent:{fileId}` files;
 * every file is identified by `(externalSessionId, fileKey)`.
 */
export type TranscriptFileRef = {
  externalSessionId: string;
  fileKey: string;
  sourceHarness: TranscriptSourceHarness;
  sourcePath: string;
};

/** The cheap stat fields the sync lane reads off a transcript file. */
export type TranscriptFileStat = { size: number; mtimeMs: number };

/**
 * The persisted fingerprint + upload cursor for one transcript file — a plain,
 * structured-clone-safe projection of the `TranscriptSyncState` row (BigInt
 * columns surfaced as `number`; safe for local transcript sizes well under
 * 2^53). Server state from `sync-plan` is always authoritative, so these cached
 * fields are advisory (recovery invariant 2).
 */
export type TranscriptFingerprint = {
  externalSessionId: string;
  fileKey: string;
  sourceHarness: string;
  sourcePath: string;
  sourcePathHash: string;
  lastMtimeMs: number | null;
  lastSize: number | null;
  syncedByteOffset: number;
  syncedSha256: string | null;
  storedEtag: string | null;
  syncedComputeTargetId: string | null;
  status: TranscriptSyncStatus;
  syncClass: TranscriptSyncClass;
  retryCount: number;
  /**
   * FEA-3555: consecutive missing-source observations only (reset on any
   * non-missing outcome or on a file reappearance/requeue). Distinct from
   * `retryCount`, which also counts transient upload failures — see
   * {@link TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS}.
   */
  missingSourceCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
};

/**
 * ISS-4647: the minimal, structured-clone-safe projection of a session's `main`
 * transcript row that the desktop LOCAL Sessions list needs to derive the same
 * `cloudSyncState` disclosure the cloud list derives from
 * `SessionTranscript`. Deliberately narrow — status plus the cursor identity —
 * so it can cross the db-host IPC boundary per page without carrying the whole
 * fingerprint row.
 */
export type TranscriptMainBlobState = {
  externalSessionId: string;
  status: TranscriptSyncStatus;
  syncedByteOffset: number;
  syncedComputeTargetId: string | null;
  /**
   * ISS-4815 (wongk, #4253): the durable cloud `uploaded` acknowledgement, and
   * the compute target whose cloud gave it. A missing-source file the cloud
   * already holds settles `idle` at a ZERO cursor, so without these fields the
   * projection reads "nothing readable" and discloses `syncing` forever — while
   * the stranded recovery, which DOES read them, correctly leaves the row
   * settled. Carrying them here is what keeps the disclosure and the recovery
   * telling the same story. Both null when never acknowledged.
   */
  cloudUploadedAt: string | null;
  cloudUploadedComputeTargetId: string | null;
};

const REDACTED_ARCHIVE_CURSOR_SUFFIX = "#redacted-jsonl-v1";

/** Mark a local cursor as describing redacted archive bytes for one target. */
export function redactedArchiveCursorTargetId(computeTargetId: string): string {
  return `${computeTargetId}${REDACTED_ARCHIVE_CURSOR_SUFFIX}`;
}

/** True when a cached cursor is known to describe redacted bytes for target. */
export function isRedactedArchiveCursorForComputeTarget(
  syncedComputeTargetId: string | null,
  computeTargetId: string
): boolean {
  return (
    syncedComputeTargetId === redactedArchiveCursorTargetId(computeTargetId)
  );
}

/** True only when a cached cursor already describes redacted bytes for target. */
export function transcriptCursorMatchesComputeTarget(
  syncedComputeTargetId: string | null,
  computeTargetId: string
): boolean {
  return isRedactedArchiveCursorForComputeTarget(
    syncedComputeTargetId,
    computeTargetId
  );
}

/** Dedup / queue key for a transcript file. "/"-joined; externalSessionId is path-safe (no "/"), so pairs never collide. */
export function transcriptQueueKey(
  externalSessionId: string,
  fileKey: string
): string {
  return `${externalSessionId}/${fileKey}`;
}

// --- Tuning constants ---------------------------------------------------------

/** Executor drain cadence (mirrors AgentSessionSyncService's 5s tick). */
export const TRANSCRIPT_SYNC_TICK_INTERVAL_MS = 5000;

/**
 * Full discovery + reconciliation sweep cadence. On this interval (and on
 * service start) the service enumerates every transcript file — not just known
 * fingerprints — and enqueues new/grown files. This is the startup mini-backfill
 * that syncs sessions worked while the app was closed (PLN-1288 AC7).
 */
export const TRANSCRIPT_SYNC_SWEEP_INTERVAL_MS = 30 * 60_000;

/**
 * Debounce for activity (non-terminal) hook/watcher events (owner: ~5 min).
 * Terminal events (Stop / SessionEnd / SubagentStop) enqueue immediately.
 */
export const TRANSCRIPT_SYNC_ACTIVITY_DEBOUNCE_MS = 5 * 60_000;

/** Concurrent per-file uploads. */
export const TRANSCRIPT_SYNC_CONCURRENCY = 2;

/**
 * Hard size cap for a single transcript file, retained only as a backstop
 * against a pathological runaway file — NOT as a routine throughput guard.
 *
 * FEA-3583: the previous 25 MiB cap silently dead-lettered the MAIN transcript
 * of large/long sessions (`<sessionId>.jsonl` easily exceeds tens of MB) while
 * every small `subagents/agent-*.jsonl` sidechain sailed under it. The session
 * detail then showed subagent transcripts but no primary conversation trace —
 * losing the exact data operators most need on the biggest, most expensive runs.
 *
 * The whole executor path is streamed, never buffered: {@link findNewlineBoundary}
 * back-scans in fixed blocks, {@link computeWindowChecksums} hashes in a single
 * streamed pass, and the upload streams byte-range parts (multipart for large
 * deltas) — "multi-GB transcripts are never loaded into memory" (PRD FR4 / AC5).
 * So size does not threaten memory, and a slow large upload is strictly better
 * than dropping the primary transcript. The cap is therefore raised well above
 * any realistic main transcript; only a genuinely pathological file (a runaway
 * write far beyond any real session) is dead-lettered. Live sync stays ahead of
 * backfill via {@link TranscriptSyncClass}, so a big historical main file cannot
 * starve active-session sync.
 */
export const TRANSCRIPT_SYNC_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** Exponential-backoff base for a failed file's next attempt. */
export const TRANSCRIPT_SYNC_RETRY_BASE_MS = 30_000;

/** Cap on the exponential backoff delay. */
export const TRANSCRIPT_SYNC_RETRY_MAX_MS = 15 * 60_000;

/**
 * Consecutive-failure threshold after which a file is dead-lettered (status
 * `dead`, `lastError` retained for the availability UI, FEA-2716). Mirrors the
 * consecutive-count dead-letter discipline of AgentSessionSyncService.
 */
export const TRANSCRIPT_SYNC_MAX_CONSECUTIVE_FAILURES = 5;

/**
 * FEA-3555: consecutive missing-source observations after which a never-uploaded
 * transcript is treated as terminally gone (status `dead`, cloud skip reason
 * `source_gone`) rather than idled forever. A single missing stat is NOT
 * terminal — the source can be transiently absent (atomic rename/rotation
 * mid-write, or a live session whose `<uuid>.jsonl` was not flushed yet), so we
 * require the file to be observed missing this many drain attempts in a row
 * before giving up. Each miss records a backoff via `recordFailure` (which drives
 * the shared retry-delay ladder off `retryCount`) while incrementing the DEDICATED
 * `missingSourceCount` — this threshold reads that isolated counter, so an unrelated
 * transient upload-failure run can never contribute to it. A reappearance re-queues
 * the row (`planObservation` requeues a changed file) and any non-missing outcome
 * resets the count to 0. Set below
 * {@link TRANSCRIPT_SYNC_MAX_CONSECUTIVE_FAILURES} intentionally — a missing
 * source is a deterministic dead end, not a flaky upload, so it need not burn
 * the full transient-failure ladder before going terminal.
 */
export const TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS = 3;

/**
 * ISS-4647: the same terminal threshold for a BATCH-MATERIALIZED harness
 * ({@link isBatchMaterializedHarness}, today OpenCode), set far higher than
 * {@link TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS} because an absent
 * materialized projection is usually the materializer not having (re)written it
 * yet, and the next 30-min sweep regenerates it.
 *
 * FEA-3932 handled that by settling such a row to `idle` UNCONDITIONALLY, with
 * no ladder at all. That left materialization failures with no exit: the
 * stranded-blob recovery re-queues the row, `handleMissingSource` immediately
 * re-idles it, and the cloud reads `missing`/`syncing` forever
 * (idle→queued→idle). A bound is what makes the loop terminate — this many
 * CONSECUTIVE misses spans several materialize passes, so a transient absence
 * still resolves by re-materializing, while a source that never materializes
 * finally dead-letters as `source_gone` and the cloud derives `failedPermanent`.
 * Recovery is preserved: the FEA-3932 one-shot OpenCode redrive revives exactly
 * this dead-letter family on the next start, so a fixed materializer heals the
 * row instead of leaving it terminal forever.
 *
 * Deliberately ABOVE {@link TRANSCRIPT_SYNC_MAX_CONSECUTIVE_FAILURES}, unlike its
 * raw-harness sibling. That comparison does not apply here: the consecutive-
 * failure dead-letter is driven by the DRAIN QUEUE from a THROWN `syncFile`
 * error, whereas a missing source RETURNS a `skipped` result and settles its own
 * row, so a long missing-source run never reaches that threshold. The two
 * counters are isolated by design (FEA-3555), which is what lets this bound be
 * sized by "how many materialize passes should we wait" rather than by the
 * transient-upload ladder.
 */
export const TRANSCRIPT_SYNC_MAX_MATERIALIZED_SOURCE_ATTEMPTS = 10;

/**
 * `lastError` prefix stamped on a dead-letter that fired because the local
 * transcript source was missing for {@link TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS}
 * consecutive attempts (the "source gone" terminal). FEA-3932 uses this as the
 * discriminator for the one-shot OpenCode redrive: OpenCode sessions dead-lettered
 * under a PRE-materialization build always failed this way (their `.jsonl` never
 * existed on disk), so re-materializing them makes the source appear and the
 * redrive is warranted. Genuinely terminal dead-letters (`too_large`, oversized
 * redacted line) carry a DIFFERENT reason and must NOT be redriven — re-materializing
 * cannot shrink a pathological file. Kept as a shared constant so the producer
 * (executor) and the redrive predicate stay a single source of truth.
 */
export const TRANSCRIPT_SOURCE_GONE_DEAD_LETTER_PREFIX =
  "skipped: local transcript source gone" as const;

/**
 * `lastError` prefix stamped on a dead-letter that fired because the whole FILE
 * exceeded {@link TRANSCRIPT_SYNC_MAX_FILE_BYTES} (FEA-3489 / PRD-536). This is
 * the ONLY dead reason a user-initiated force-archive can fix: the size cap is a
 * local backstop the per-file `bypassSizeCap` override waives, whereas the two
 * OTHER terminal reasons on this lane — `source_gone`
 * ({@link TRANSCRIPT_SOURCE_GONE_DEAD_LETTER_PREFIX}) and a single redacted JSONL
 * line over the per-line wire limit — are NOT fixable by re-uploading the same
 * bytes, so the force-archive path must NOT revive them (it would loop on the
 * same terminal failure forever). `TranscriptSyncStore.reviveForForcedSync`
 * scopes its atomic revive to rows whose `lastError` starts with this prefix, so
 * the prefix is a single source of truth shared by the producer (executor
 * `markDead`) and that predicate — keep them in lockstep.
 */
export const TRANSCRIPT_OVERSIZED_DEAD_LETTER_PREFIX =
  "skipped: transcript file exceeds size cap" as const;

/**
 * Compute the backoff delay (ms) for the Nth consecutive failure (1-indexed),
 * capped at {@link TRANSCRIPT_SYNC_RETRY_MAX_MS}. Thin wrapper over the shared
 * {@link exponentialBackoffMs} ladder (FEA-3795) so this schedule and the
 * agent-session dead-letter schedule stay a single source of truth.
 */
export function transcriptRetryDelayMs(retryCount: number): number {
  return exponentialBackoffMs(
    retryCount,
    TRANSCRIPT_SYNC_RETRY_BASE_MS,
    TRANSCRIPT_SYNC_RETRY_MAX_MS
  );
}

/** Add a delay (ms) to an ISO-8601 instant, returning a new ISO-8601 string. */
export function isoAfter(nowIso: string, deltaMs: number): string {
  return new Date(Date.parse(nowIso) + deltaMs).toISOString();
}

/**
 * ISS-4647: the consecutive missing-source threshold that terminates a file,
 * chosen by harness class. A batch-materialized projection gets the longer
 * {@link TRANSCRIPT_SYNC_MAX_MATERIALIZED_SOURCE_ATTEMPTS} ladder (its producer
 * may simply not have re-written it yet); a raw agent-owned transcript keeps the
 * short {@link TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS} ladder. Both are
 * BOUNDED — the point of this helper is that no harness gets an unbounded
 * "always retry" path, which is what left OpenCode rows cycling idle→queued→idle.
 */
export function missingSourceAttemptLimit(sourceHarness: string): number {
  return isBatchMaterializedHarness(sourceHarness)
    ? TRANSCRIPT_SYNC_MAX_MATERIALIZED_SOURCE_ATTEMPTS
    : TRANSCRIPT_SYNC_MAX_MISSING_SOURCE_ATTEMPTS;
}
