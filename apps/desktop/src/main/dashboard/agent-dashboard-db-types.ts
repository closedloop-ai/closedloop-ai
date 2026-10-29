import type { CacheWriteTtl } from "@repo/lib/harness/types";
import type { Harness, NormalizedSession } from "../collectors/types.js";
import type {
  WriteDispatchProbe,
  WriteQueueCancelOutcome,
} from "../database/write-queue.js";
import type { ParsePolicy } from "../parse-policy/parse-policy.js";

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
   * ISS-12251: true when an existing row's `created_at` was filled or lowered.
   * Set only by `importSessionWithTx`, like `sessionDataChanged`; a
   * `created_at`-only change does not move `updated_at`, so the rebuild reports
   * the row in `needsResync` on this signal alone.
   */
  createdAtChanged?: boolean;
  /**
   * ISS-5103: labels of the tolerated record groups that failed when
   * `incomplete` is set (the write-core `runGroup` labels, in failure order).
   * Additive and optional — omitted when no tolerated group failed, and absent
   * entirely from importer implementations that predate it. Import-health
   * telemetry maps these onto the contract's closed `ImportGroupLabel` set
   * (unrecognized labels degrade to `unknown`).
   */
  failedGroups?: readonly string[];
  /**
   * ISS-12036: this import was a BYTE-IDENTICAL re-offer — the session already
   * existed and nothing about it changed, so there was nothing to write.
   *
   * It qualifies `skipped`, which `write-core.ts` sets for two unrelated
   * reasons: the FEA-3227 no-op above, and a REFUSAL that wrote no row (an
   * unusable session id, the FEA-2027 unsafe token count). Both return
   * `{ skipped: true, reactivated: false }`, so {@link isDurableImportProgress}
   * reports neither as progress and import-health telemetry then classified a
   * window of pure no-ops as `wedged` — the false positive ISS-12036 measured
   * at 134 of 208 outcomes on one install.
   *
   * Set ONLY on the no-op path, never on a refusal, so the absent default is the
   * conservative one: an importer that predates this field, and any refusal site
   * added later, keep counting toward the wedge rather than silently excusing
   * themselves from it. Optional and clone-safe, so the db-host proxy carries it
   * unchanged.
   */
  unchanged?: boolean;
};

export type Importer = {
  importSession(
    session: NormalizedSession,
    harness: Harness,
    /**
     * ISS-12552 (PRD-800 "Rollout"): the policy the session was parsed
     * under. Optional and clone-safe; absent, the store imports under its own
     * current policy.
     */
    parsePolicy?: ParsePolicy
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
  /**
   * ISS-7256: has this session's import write been sitting in the serialized write
   * queue WITHOUT ever dispatching? The read-only form of the question
   * {@link cancelInFlightWrite} answers with
   * {@link WriteQueueCancelOutcome.Queued} — but that one can only answer it by
   * evicting the task, which is precisely what the bound must not do to a session
   * that has done nothing wrong.
   *
   * `importSessionBounded` asks at its deadline. `true` means the whole bound was
   * spent behind a DIFFERENT owner's write, so this session neither wedged the
   * writer nor burned the deadline on its own work — the ISS-4410 premise does not
   * hold and abandoning the source would cost a full re-parse and re-import next
   * pass for nothing.
   *
   * Optional and clone-safe on both topologies, but NOT answered in the same
   * place on both — and that difference is the point (whitlockk review). The
   * in-process importer reads the queue directly. The DB-host proxy forwards the
   * property path as an IPC `invoke`, and the DISPATCHER answers it from a
   * mirror of the store thread's queue rather than forwarding it on. It has to:
   * the deadline fires because the store thread is inside a long synchronous
   * write, so a request that has to reach that thread is answered by nothing
   * until the very condition it asks about has ended. See
   * `db-host/write-dispatch-mirror.ts`.
   *
   * An importer without the hook keeps the pre-ISS-7256 behavior (the deadline
   * always ends the attempt).
   */
  hasUndispatchedWrite?(
    sessionId: string
  ): WriteDispatchProbe | Promise<WriteDispatchProbe>;
};

/**
 * Whether this result wrote something durable. A `failed` import halted before
 * the session was durably handled, and a skip that did not reactivate matched an
 * existing row and wrote nothing; everything else landed a row.
 *
 * The canonical predicate, not a copy: the collector manager gates its imported
 * tally, the mid-source quantum, and the resume cursor on it, and import-health
 * telemetry classifies a tally window with it. A returned result is NOT by
 * itself progress, so the two must not drift.
 */
export function isDurableImportProgress(result: ImportResult): boolean {
  return !(result.failed || (result.skipped && !result.reactivated));
}

/**
 * ISS-12036: did this import leave its source to be RE-OFFERED without landing
 * what it was offered for?
 *
 * The condition the source's retry budget is charged on, and deliberately not
 * the negation of {@link isDurableImportProgress} — the two answer different
 * questions and disagree in both directions:
 *
 *   - an `incomplete` import DID write durably, and still leaves the source
 *     unmarked so the failed record group is retried next pass;
 *   - a byte-identical re-offer (`unchanged`) writes nothing and is not progress,
 *     yet there is nothing left to land, so charging it would quarantine a
 *     healthy source the orphan self-heal merely keeps re-listing.
 *
 * Everything else that is not durable progress — a `failed` import, and the
 * refusals that write no row (an unusable session id, the FEA-2027 unsafe token
 * count) — is an offer that did not land. `unchanged` is checked FIRST and wins
 * outright: write-core never sets it alongside a failed record group, so the two
 * cannot both be true, and reading it first keeps that guarantee local.
 */
export function isUnlandedImportOffer(result: ImportResult): boolean {
  if (result.unchanged === true) {
    return false;
  }
  return result.incomplete === true || !isDurableImportProgress(result);
}
