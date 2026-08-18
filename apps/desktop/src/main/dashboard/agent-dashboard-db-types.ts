import type { CacheWriteTtl } from "@repo/lib/harness/types";
import type { Harness, NormalizedSession } from "../collectors/types.js";
import type { WriteQueueCancelOutcome } from "../database/write-queue.js";

/** Snake_case hook payload `data` block as delivered by the hook handlers. */
export type HookData = {
  session_id?: string;
  cwd?: string;
  model?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown> | null;
  source?: string;
  stop_reason?: string;
  message?: string;
  agent_type?: string;
  subagent_type?: string;
  prompt?: string;
  description?: string;
  session_name?: string;
  [key: string]: unknown;
};

/**
 * The harness that POSTs live hook events. Attribution is route-owned (the
 * listener sets it from the request path), never payload-chosen. Codex hooks
 * were removed (PRD-431), so Claude is the only harness that emits hooks today —
 * a single-member union that keeps the hook write path (`processEvent` /
 * `handleHook`) statically narrow. This is intentionally NOT the broader
 * `Harness`: the importer/collector path handles all five harnesses, but the
 * hook path only ever sees "claude".
 */
export type HookHarness = "claude";

/** Cumulative per-model token counts from the current transcript segment. */
export type TokenUsageCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** FEA-3419: cache-write TTL subdivision; absent = never reported. */
  cacheWriteTtl?: CacheWriteTtl;
  /** FEA-2085: true when `model` is a fallback placeholder, not an extracted id. */
  inferred?: boolean;
};

/** Effective reconciled per-(session, model) token counts. Internal: never crosses IPC. */
export type TokenUsageRow = {
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** FEA-3419: TTL subdivision from the nullable columns; null = absent. */
  cacheWrite5mTokens?: number | null;
  cacheWrite1hTokens?: number | null;
  estimatedCostUsd?: number;
};

export type ImportResult = {
  /** True when the session already existed and nothing new was written. */
  skipped: boolean;
  /** True when a terminal session was revived because its file is recently active. */
  reactivated: boolean;
  /** True when the importer failed before the session was durably handled. */
  failed?: boolean;
  /**
   * True when the session was durably handled but at least one (tolerated)
   * record group failed to commit, so the import is partial. The collector must
   * NOT mark the source seen — it should re-import next pass to retry the failed
   * group (each group is idempotent, so committed groups converge). Unlike
   * `failed`, this does not halt the rest of the source.
   */
  incomplete?: boolean;
  /**
   * FEA-3659: true when the session's derived payload (the synced metadata blob)
   * actually changed, so its `updated_at` sync watermark was bumped. Set only by
   * the atomic rebuild path (`importSessionWithTx`); undefined on the normal
   * ingest path, which does not need it. The data-revision rebuild uses this to
   * enqueue exactly the rows that genuinely changed under a new DATA_REVISION,
   * skipping byte-identical re-derivations.
   */
  sessionDataChanged?: boolean;
  /**
   * ISS-5103: labels of the tolerated record groups that failed when
   * `incomplete` is set (the write-core `runGroup` labels, in failure order).
   * Additive and optional — omitted when no tolerated group failed, and absent
   * entirely from importer implementations that predate it. Import-health
   * telemetry maps these onto the contract's closed `ImportGroupLabel` set
   * (unrecognized labels degrade to `unknown`).
   */
  failedGroups?: readonly string[];
};

export type Importer = {
  importSession(
    session: NormalizedSession,
    harness: Harness
  ): ImportResult | Promise<ImportResult>;
  /**
   * ISS-4572 (task-scoped): evict THIS session's own queued/in-flight historical
   * import write from the single serialized write queue so later sources proceed.
   * `importSession` commits its record groups through that one queue tagging each
   * with the session id; a genuinely-wedged group (the DB-host write accepted but
   * never completing) parks every later source behind it. `importSessionBounded`
   * calls this on its timeout with the timed-out `sessionId`, so ONLY that
   * session's write is evicted — never an unrelated healthy session's transaction
   * that merely happens to be at the queue head (the wrong-victim hazard the first
   * head-of-line cut had). Returns `true` if a write owned by `sessionId` was
   * evicted, `none` when none is queued/running (including when the head belongs
   * to a different session). Optional: importers without a cancellable write queue
   * (or the cloud/proxy view) omit it, and the bounded wrapper degrades to the
   * prior abandon-only behavior.
   *
   * ISS-6115: the outcome distinguishes `running` (this session's own write held
   * the writer) from `queued` (it never dispatched — the whole bound was spent
   * waiting behind a DIFFERENT session), which is what lets `importSessionBounded`
   * charge a source's retry budget only for a deadline the source actually burned.
   * The values are plain strings, so the outcome stays structured-clone-safe across
   * the DB-host IPC boundary exactly as the boolean was.
   *
   * The in-process SQLite importer returns a synchronous `boolean`, but in
   * DB-host mode (FEA-2038) the manager holds the `createDbHostAgentDatabase`
   * PROXY, which answers `importer.cancelInFlightWrite` as a forwarded op path —
   * so calling it issues an IPC `invoke` and returns a `Promise<boolean>` that
   * settles once the child evicts its own queue task. Both args are clone-safe
   * (`sessionId: string`, `reason: Error`). The return type spans both, so
   * `importSessionBounded` must treat the result as possibly a promise and
   * swallow its rejection: a rejection from a dying DB host (the write usually
   * wedged BECAUSE the host is unhealthy) must never surface as an unhandled
   * rejection in the Electron main process.
   */
  cancelInFlightWrite?(
    sessionId: string,
    reason?: Error
  ): WriteQueueCancelOutcome | Promise<WriteQueueCancelOutcome>;
};
