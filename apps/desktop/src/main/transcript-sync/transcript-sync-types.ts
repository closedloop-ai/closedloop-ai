/**
 * @file transcript-sync-types.ts
 * @description Shared types + tuning constants for the desktop transcript
 * archive lane (FEA-2715, PLN-1288). This lane is entirely separate from the
 * 256 KiB structured-metadata lane (`AgentSessionSyncService`): it fingerprints
 * raw Claude Code / Codex transcript files (main + subagent) and streams byte
 * deltas through the PLN-1287 control plane. No transcript bytes are parsed
 * here — raw bytes only.
 */

/** Upload/queue lifecycle stored on `TranscriptSyncState.status`. */
export const TranscriptSyncStatus = {
  Idle: "idle",
  Queued: "queued",
  Uploading: "uploading",
  Failed: "failed",
  Dead: "dead",
} as const;
export type TranscriptSyncStatus =
  (typeof TranscriptSyncStatus)[keyof typeof TranscriptSyncStatus];

/**
 * Priority class. `live` (hook/watcher-driven current sessions) is always
 * drained ahead of `backfill` (historical files enumerated on first connect /
 * startup sweep) so a large history pass never starves active-session sync.
 */
export const TranscriptSyncClass = {
  Live: "live",
  Backfill: "backfill",
} as const;
export type TranscriptSyncClass =
  (typeof TranscriptSyncClass)[keyof typeof TranscriptSyncClass];

const TRANSCRIPT_SYNC_STATUS_VALUES = new Set<string>(
  Object.values(TranscriptSyncStatus)
);
const TRANSCRIPT_SYNC_CLASS_VALUES = new Set<string>(
  Object.values(TranscriptSyncClass)
);

/** Narrow an unconstrained DB `status` string to a known member, else null. */
export function asTranscriptSyncStatus(
  value: string
): TranscriptSyncStatus | null {
  return TRANSCRIPT_SYNC_STATUS_VALUES.has(value)
    ? (value as TranscriptSyncStatus)
    : null;
}

/** Narrow an unconstrained DB `sync_class` string to a known member, else null. */
export function asTranscriptSyncClass(
  value: string
): TranscriptSyncClass | null {
  return TRANSCRIPT_SYNC_CLASS_VALUES.has(value)
    ? (value as TranscriptSyncClass)
    : null;
}

export type TranscriptSourceHarness = "claude" | "codex";

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
  nextAttemptAt: string | null;
  lastError: string | null;
};

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
 * Compute the backoff delay (ms) for the Nth consecutive failure (1-indexed),
 * capped at {@link TRANSCRIPT_SYNC_RETRY_MAX_MS}.
 */
export function transcriptRetryDelayMs(retryCount: number): number {
  const exponent = Math.max(0, retryCount - 1);
  const raw = TRANSCRIPT_SYNC_RETRY_BASE_MS * 2 ** exponent;
  return Math.min(raw, TRANSCRIPT_SYNC_RETRY_MAX_MS);
}
