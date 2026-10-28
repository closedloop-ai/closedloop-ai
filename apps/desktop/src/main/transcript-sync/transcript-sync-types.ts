/**
 * @file transcript-sync-types.ts
 * @description Shared types + tuning constants for the desktop transcript
 * archive lane (FEA-2715, PLN-1288). This lane is entirely separate from the
 * 256 KiB structured-metadata lane (`AgentSessionSyncService`): it fingerprints
 * raw Claude Code / Codex transcript files (main + subagent) and streams byte
 * deltas through the PLN-1287 control plane. No transcript bytes are parsed
 * here — raw bytes only.
 */

import {
  isMaterializedTranscriptHarness,
  TranscriptForbiddenCode,
} from "@repo/api/src/types/desktop-transcripts";
import type { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { exponentialBackoffMs } from "../../shared/exponential-backoff.js";
import {
  LANE_STALL_CEILING_MS,
  LANE_STALL_MAX_RETRY_MS,
  LANE_STALL_RETRY_FLOOR_MS,
  type LaneStallSchedule,
  laneStallDelayMs,
  laneStallRetryMs,
} from "../../shared/lane-stall-clock.js";
import {
  chargesItemBudget,
  classifySyncFailure,
  TRANSCRIPT_CONTROL_ROUTE_PROFILE,
} from "../../shared/sync-failure-classification.js";
import type {
  TranscriptSyncClass,
  TranscriptSyncStatus,
} from "../../shared/transcript-sync-status-contract.js";

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
  /**
   * ISS-7097: the start of this row's current unbroken LANE-WIDE failure run
   * (a 5xx/429 — the cloud is unreachable, nothing about this row is wrong), or
   * `null` when it is not in one. Those failures deliberately do not advance
   * {@link TranscriptFingerprint.retryCount}, so this is what bounds them
   * instead: see {@link TRANSCRIPT_LANE_STALL_CEILING_MS}.
   */
  laneStalledSince: string | null;
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
   * ISS-4815 (whitlockk, #4253): the durable cloud `uploaded` acknowledgement, and
   * the compute target whose cloud gave it. A missing-source file the cloud
   * already holds settles `idle` at a ZERO cursor, so without these fields the
   * projection reads "nothing readable" and discloses `syncing` forever — while
   * the stranded recovery, which DOES read them, correctly leaves the row
   * settled. Carrying them here is what keeps the disclosure and the recovery
   * telling the same story. Both null when never acknowledged.
   */
  cloudUploadedAt: string | null;
  cloudUploadedComputeTargetId: string | null;
  /**
   * ISS-9884 (migration 0090): WHY this row died, for a `dead` row — `null`
   * when it is not terminal, when it died before 0090, or when the persisted
   * label is one this build does not recognize.
   *
   * The local verdict mapped every `dead` row to `failedPermanent`
   * unconditionally before this, and structurally had to: the settle path
   * nulls `laneStalledSince` at the moment of death and `lastError` is an
   * unparseable client message, so the row kept no evidence of its cause. In
   * the bucket-unset case — the DEFAULT local-developer path — that made the
   * desktop's own list say "permanently failed" about a transcript the cloud
   * reports as merely paused.
   */
  terminalSkipReason: TranscriptSkipReason | null;
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
 * back-scans in fixed blocks, upload-window preparation hashes redacted bytes
 * in a single streamed pass, and the upload streams byte-range parts (multipart
 * for large deltas) — "multi-GB transcripts are never loaded into memory"
 * (PRD FR4 / AC5).
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

/**
 * ISS-7097: how long a durable `uploading` claim stays valid before the sweep's
 * reclaim treats it as stranded and re-arms the row.
 *
 * Sized to exceed the longest legitimate single-file upload by a wide margin.
 * The reported wedge was a ~90 MiB transcript, and the sweep that runs this
 * reclaim ticks every 30 min, so worst-case recovery latency is this bound plus
 * one sweep.
 *
 * Reclaiming too EARLY is the failure to avoid, and two things make an
 * over-eager reclaim survivable rather than corrupting: the drain's in-memory
 * `inFlight` Set still refuses to hand the same file to a second concurrent task
 * in this process (and the desktop holds a single-instance lock, so there is no
 * second process), and a duplicate `complete` for an already-verified upload is
 * answered `200 uploaded` by the server rather than a conflict. The cost of
 * being wrong is therefore a wasted transfer, not a corrupt row — but it is a
 * 90 MiB transfer, hence the generous bound.
 */
export const TRANSCRIPT_UPLOAD_LEASE_MS = 60 * 60_000;

/**
 * ISS-7097: how long ONE row may sit in an unbroken lane-wide failure run
 * (5xx/429) before it is dead-lettered anyway.
 *
 * Lane-wide failures deliberately do not advance `retryCount`, because a cloud
 * outage is not this row's fault and must not burn the per-row budget toward a
 * `retries_exhausted` skip the cloud would then believe (`sync/AGENTS.md`
 * invariant 4). That removes the only bound those failures had, and invariant 5
 * is explicit that every terminal path must stay reachable — so the bound moves
 * from attempts to wall-clock, measured from `laneStalledSince`.
 *
 * 24h matches the server's own stale-upload backstop, past which it aborts an
 * in-flight multipart upload: a stall this long is no longer a blip the lane
 * should keep silently absorbing.
 *
 * ISS-8615 (PRD-699 §7.3): the session lane's ceiling was a hand-kept copy of
 * this value, equal on purpose so two lanes measuring the same outage cannot
 * disagree about when to give up. Both are now this one constant, so the
 * agreement is a fact rather than a comment two files have to keep honoring.
 */
export const TRANSCRIPT_LANE_STALL_CEILING_MS = LANE_STALL_CEILING_MS;

/**
 * ISS-7097: the FLOOR of the lane-wide retry schedule — the delay a stall run
 * opens on, and the shortest wait any lane-wide failure ever gets.
 *
 * ISS-8689 turned this from the whole schedule into its first rung. What must
 * not change is WHY the schedule cannot be the row ladder: that ladder is a
 * function of `retryCount`, which a lane-wide failure deliberately does not
 * advance, so reusing it would pin every stalled row to whatever rung it
 * happened to be on — for a healthy row (`retryCount = 0`) a 15-second hammer
 * against an already-failing cloud. The staged schedule is keyed off the stall
 * CLOCK instead; see {@link transcriptLaneStallRetryMs}.
 *
 * Five minutes as the floor polls a fresh outage ~12 times an hour per row
 * instead of 240, and equals `SESSION_LANE_STALL_RETRY_MS` on the session lane
 * so two lanes measuring the same outage open on the same cadence.
 */
export const TRANSCRIPT_LANE_STALL_RETRY_MS = LANE_STALL_RETRY_FLOOR_MS;

/**
 * ISS-7097: is this HTTP status the CLOUD failing, rather than this row being
 * wrong? A thin adapter over the shared classification module (ISS-8614) — the
 * lane keeps the QUESTION and the module owns the ANSWER.
 *
 * `TRANSCRIPT_ROW_LADDER_STATUSES` used to live here as a hand-written
 * allow-list of `{400, 403, 409, 413}`. It is deleted: those four are now
 * `TRANSCRIPT_CONTROL_ROUTE_PROFILE` resolved against Appendix A's default
 * table, which assigns 400 and 413 ITEM on every route and holds the lane's two
 * genuine departures — the uncoded 403 (ISS-10002) and the `StaleUpload` 409
 * (ISS-10001) — as ledger entries that each name the ticket coding them away.
 * Read those entries for the reasoning; it is not repeated here, so there is one
 * copy to keep true.
 *
 * The resolved set is FIVE, not four: PRD-699 v2 (amended 2026-09-09) made 422
 * ITEM on every route, and this lane inherits that rather than recording a
 * deviation against it. The control route does not emit a 422 today, so the
 * widening is latent — but the desktop is version-skewed against the cloud, so
 * it is what an already-installed build would do the day the route starts, and
 * `sync-classification-standard-conformance.test.ts` pins it.
 *
 * ISS-9693 / ISS-9695 INVERTED this predicate and the module preserves that
 * shape: lane-wide is everything the classification does NOT call ITEM, so a
 * status no build has ever seen inherits ENVIRONMENTAL by omission rather than
 * by an edit. Before the inversion a platform deploy-skew 404 and any
 * unrecognized 4xx burned the per-row budget and walked healthy transcripts to
 * an acked `retries_exhausted` skip the cloud then records as authoritative —
 * the ISS-7730 shape, which is LOSS rather than retry cadence.
 *
 * `undefined` — no HTTP answer was received at all — is ENVIRONMENTAL, and
 * ISS-9793 CHOSE that rather than inheriting it. It used to keep the ladder on
 * the reasoning that each caller settles the non-HTTP case for itself before
 * asking, and `transcript-drain-queue`'s `recordFailure` never did — so all
 * SEVEN status-less throws in `desktop-transcripts-client.ts` took the
 * `retryCount + 1` arm. The ISS-7730 shape again, on the commonest failure there
 * is. Each was ruled on separately; none keeps the ladder:
 *
 * - **`postControl` fetch rejection / `AbortSignal.timeout`** and **`put` fetch
 *   rejection / upload timeout** — the ordinary offline period and the stalled
 *   uplink. No server judged these bytes, and nothing about them caused either.
 *   **`put`'s catch is WIDER than those two, and the third condition is this
 *   list's one exception (marisolashgrove review).** Its body is
 *   `openBoundedReadStream(stagedPath, …)` from `transcript-upload-window.ts`,
 *   so a read failure on THIS row's own staged window rejects inside undici and
 *   arrives as the same status-less throw. That one genuinely is the row's, and
 *   it is frozen with the rest rather than split out: both reach here as a
 *   `TranscriptSyncClientError` with no status and a `${label} failed:` message,
 *   so this call site holds no discriminator to split them by. It is bounded by
 *   the 24h stall ceiling below, so it terminates rather than retrying forever.
 * - **access token unavailable**, **"not signed in"**, **invalid API origin** —
 *   properties of the session or the configuration, identical for every row.
 *   Signed-out reads as a PAUSE rather than an outage, and a third state that
 *   neither charges the row nor engages the stall clock was considered and NOT
 *   built: the answers available here are "spend the budget", which is loss, and
 *   "freeze it", which is a visible `failed`.
 * - **non-JSON body** — a captive portal or proxy page. The control bodies are
 *   deterministic and ~8 KiB, so no request could have provoked one.
 * - **response failed schema validation** — the one that READS row-attributable
 *   and is not. It is version skew, a property of the DEPLOYED SERVER: every row
 *   on that endpoint gets the same rejection, and re-sending cannot change it
 *   any more than waiting can. Its status-side twin — an unrecognized STATUS
 *   from that same skewed server — is already environmental by construction, so
 *   charging the row here would make the cost of one skew depend on which door
 *   it arrived through.
 *
 * The cost is the one `docs/desktop-sync/transcript-lane.md` ("The cost of
 * ack-gated terminals") blesses, but carry the clause it depends
 * on (marisolashgrove review): a condition that never lifts leaves the row visibly
 * `failed` rather than reaching `dead` — not lost — **while the stall clock is
 * still inside `TRANSCRIPT_LANE_STALL_CEILING_MS`, or while the same condition
 * also refuses the SKIP.** Past the ceiling with a skip the cloud CAN ack,
 * `recordFailure`'s `deadEligible` is true on the FIRST failure of the run and
 * the row is retired at once. A laptop offline for a week comes back with a
 * week-old `laneStalledSince` already past the ceiling, so one ordinary 503 from
 * an otherwise reachable server is enough. That is not a regression from this
 * change — the pre-ISS-9793 `retryCount` path landed in the same place — but a
 * multi-day offline stretch is far commoner than a multi-day outage, so the
 * past-ceiling case is not the corner it reads as. Pinned by the past-ceiling
 * case in `transcript-lane-stall-backoff.test.ts`.
 *
 * **The PRESIGNED UPLOAD arm does not rely on this predicate alone (ISS-8608).**
 * Everything above argues from the CONTROL PLANE, but `recordFailure` also
 * classifies the upload arm, where the "deterministic ~8 KiB body" reasoning for
 * 400/413 never reached a multi-MB streamed part. `classifyS3PutFailure` in
 * `transcript-s3-put-classification.ts` refines 400/403 there by S3's own
 * `<Code>`; the two compose with OR at the call site, so a status that
 * refinement declines still lands exactly where this sends it.
 *
 * Status-based FOR THE CONTROL PLANE, on purpose: for every status but 403
 * `postControl` throws before reading the response body, so the status is the
 * only discriminator available at that call site — which is also why both ledger
 * entries above exist and why coding them away needs the client to start reading
 * the body. That deliberately folds a PLATFORM 5xx (load balancer, deployment
 * window) in with an application one, which is correct: an edge 503 is exactly
 * as lane-wide as the API's own.
 */
export function isLaneWideHttpStatus(status: number | undefined): boolean {
  if (status === undefined) {
    return true;
  }
  return !chargesItemBudget(
    classifySyncFailure(TRANSCRIPT_CONTROL_ROUTE_PROFILE, status)
  );
}

/**
 * ISS-8689: the ceiling on ONE lane-wide retry delay, distinct from
 * {@link TRANSCRIPT_LANE_STALL_CEILING_MS}, which bounds the whole RUN.
 *
 * An hour is where staging stops paying: past it the extra patience saves a
 * handful of requests over the 24h run while adding an hour to how long a
 * recovered cloud goes unnoticed. This caps what the SCHEDULE will choose on its
 * own; a server `Retry-After` may still ask for longer, bounded instead by the
 * run ceiling.
 */
export const TRANSCRIPT_LANE_STALL_MAX_RETRY_MS = LANE_STALL_MAX_RETRY_MS;

/**
 * ISS-8615: this lane's stall policy, as the shared {@link LaneStallSchedule}.
 *
 * The ceiling is the part every lane must agree on; the floor and per-delay cap
 * are the part a lane may legitimately choose — which is exactly why the shared
 * primitive takes a schedule rather than reading three module constants.
 */
const TRANSCRIPT_LANE_STALL_SCHEDULE: LaneStallSchedule = {
  floorMs: TRANSCRIPT_LANE_STALL_RETRY_MS,
  maxRetryMs: TRANSCRIPT_LANE_STALL_MAX_RETRY_MS,
  ceilingMs: TRANSCRIPT_LANE_STALL_CEILING_MS,
};

/**
 * ISS-8689 (PRD-699 F8): the lane-wide retry delay for a stall that has been
 * open for `stallAgeMs`, doubling from {@link TRANSCRIPT_LANE_STALL_RETRY_MS}
 * to {@link TRANSCRIPT_LANE_STALL_MAX_RETRY_MS}: 5, 10, 20, 40, 60 minutes.
 *
 * Keyed off the stall CLOCK, never off `retryCount` — that counter is frozen
 * for this class by design (`sync/AGENTS.md` invariant 4), so a delay derived
 * from it would not move. The age is the only thing that grows during a stall,
 * which is what makes it the right rung index.
 *
 * A non-finite or negative age reads as a fresh stall and gets the floor: a
 * clock we cannot subtract is not evidence that anything should wait longer.
 */
export function transcriptLaneStallRetryMs(stallAgeMs: number): number {
  return laneStallRetryMs(stallAgeMs, TRANSCRIPT_LANE_STALL_SCHEDULE);
}

/**
 * ISS-8689: how long the lane waits before its next attempt on a row whose
 * stall run opened at `stalledSinceMs`.
 *
 * `Retry-After` is a MINIMUM wait, so honoring it means never scheduling
 * earlier than the server asked — hence `max`, not `min`. A `min` here would
 * let the transient 60-second hint pin the schedule to its first rung forever
 * and defeat the staging entirely (PRD-699 F8), while a long configuration
 * hint would simply be ignored.
 *
 * While budget REMAINS, the result is capped by it, so `nextAttemptAt` can never
 * land past the give-up instant. Without that cap a server hint issued late in a
 * run would push the next attempt beyond the ceiling, and the ceiling is only
 * evaluated when an attempt actually runs — the terminal path would be scheduled
 * out of reach.
 *
 * Once the budget is SPENT the cap stops applying, and that is deliberate: a row
 * past its ceiling is dead-letter-eligible on every attempt, but dead-lettering
 * is ack-gated, so a cloud that cannot record the terminal skip leaves the row
 * on this schedule with a negative budget. Clamping that to zero would retry it
 * on every tick — a hot loop strictly worse than the flat delay this replaced,
 * and reachable in exactly the outage where the ack is least likely to land.
 */
export function transcriptLaneStallDelayMs(input: {
  stalledSinceMs: number;
  nowMs: number;
  retryAfterMs?: number;
}): number {
  return laneStallDelayMs({
    stalledSinceMs: input.stalledSinceMs,
    nowMs: input.nowMs,
    retryAfterMs: input.retryAfterMs,
    schedule: TRANSCRIPT_LANE_STALL_SCHEDULE,
  });
}

/**
 * ISS-8599 (PRD-699 §6 item 8): is this 403 the CLOUD refusing every file on
 * this target identically, rather than this row being wrong?
 *
 * Both coded 403s are, and neither may burn the per-row retry budget
 * (`sync/AGENTS.md` invariant 4 — "attributable to the item" means REPRODUCIBLE
 * FROM THE PERSISTED ROW, and no byte of the file participates in either
 * verdict). They are still two different failures, which is why the server
 * spells them apart and why this build records which one it got:
 *
 * - `NotOwned` is the transcript twin of the session lane's `target_not_owned`,
 *   which FEA-3425 already defers without touching a counter. RECOVERABLE, and
 *   recoverable by an event this lane sees — a sign-in, or the compute-target
 *   rewrite that follows one. What that rewrite drops is the STAND-DOWN
 *   DEADLINE (`nextAttemptAt`), so the new target is tried at once rather than
 *   serving out the old target's wait (`revivedNextAttemptAt`, ISS-8689). It
 *   does NOT clear the 24h clock: `laneStalledSince` survives, because an
 *   observation is not an event in the run and only a settle ends one
 *   (`sync/AGENTS.md` invariant 5, pinned by
 *   `transcript-sync-store-lane-stall.test.ts` — "the run still keeps its
 *   origin — a rewrite is not a settle").
 * - `PolicyDisabled` is recoverable only by an org admin re-enabling the policy,
 *   which nothing local can provoke — so it just burns the wall clock. That is
 *   the correct outcome and not a stall: the terminal that clock reaches is an
 *   ack-gated `retries_exhausted` skip, and while the policy is off the SKIP
 *   route answers the same 403, so the ack never lands and the cloud is never
 *   told a policy-denied transcript permanently failed. The row stays `failed`
 *   and truthful rather than walking to `dead` on a refusal it did not cause.
 *
 * `undefined` — no code, or a code from a newer cloud this build cannot name —
 * answers FALSE, which is the pre-ISS-8599 ladder. That is deliberately the
 * opposite default from the session lane's unknown ACK REASON (ISS-8595 treats
 * that as environmental): there the peer named a class and only the name was
 * unfamiliar, here there is no name at all and a bare 403 is what an unpatched
 * server has always sent. Widening it would change behaviour against every
 * server in the fleet on the strength of no signal.
 */
export function isLaneWideTranscriptForbidden(
  code: TranscriptForbiddenCode | undefined
): boolean {
  if (code === undefined) {
    return false;
  }
  // Exhaustive over the closed union so a new code fails `tsc` right here until
  // it is deliberately classified, rather than silently inheriting either answer.
  // biome-ignore lint/style/useDefaultSwitchClause: a default would hide contract growth behind an inherited classification — the thing this switch exists to prevent.
  switch (code) {
    case TranscriptForbiddenCode.NotOwned:
      return true;
    case TranscriptForbiddenCode.PolicyDisabled:
      return true;
  }
}
