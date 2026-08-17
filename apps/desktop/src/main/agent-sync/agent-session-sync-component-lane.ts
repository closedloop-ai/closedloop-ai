/**
 * The component-inventory sync lane — the scheduling/drain concern that rides
 * alongside the session lane inside `AgentSessionSyncService`, extracted whole
 * (ISS-4676 seam #1).
 *
 * T-8.7: this lane runs independently from the session sync on the same 5s
 * interval. It batch-reads updated `agent_components` rows (STRICTLY after its
 * own keyset cursor), packs them into a `DesktopAgentComponentsPayload`, POSTs
 * them via `sendComponents`, and advances the persisted cursor on success.
 * Tombstoned rows ride along so the cloud receives uninstall signals.
 *
 * It owns ALL of its own state — keyset cursor, hydrated source key,
 * single-flight guard + in-flight run handle, transition logger, and dead-letter
 * tracker — so nothing about the component lane's drain semantics lives in the
 * session service any more. The service keeps the two lifecycle hooks it must
 * drive ({@link AgentComponentSyncLane.clearInFlightState} on a hard reset,
 * {@link AgentComponentSyncLane.clearCursorState} on identity change / stop) and
 * reads {@link AgentComponentSyncLane.deadLetteredCount} for `getSyncProgress`.
 *
 * The lane NEVER throws through: every await is try/caught internally, so callers
 * launch it fire-and-forget (`void lane.syncOnce()`).
 */
import { randomUUID } from "node:crypto";
import {
  AgentSessionSyncMode,
  type SyncedComponent,
} from "@repo/api/src/types/agent-session";
import {
  createTransitionLogger,
  errorMessage,
} from "../diagnostics/component-sync-diagnostics.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  advanceComponentCursor,
  buildComponentBoundaryKey,
  type ComponentCursorPersistObserver,
  ComponentCursorPersistOutcome,
  ComponentSendFailureOutcome,
  ComponentSyncDeadLetterTracker,
  ComponentSyncSendOutcome,
  type ComponentSyncSendResult,
  handleComponentSendFailure,
  persistComponentCursorPosition,
  recoverComponentDeadLetters,
} from "./agent-component-sync-dead-letter.js";
import type { AgentSessionSyncServiceOptions } from "./agent-session-sync-service-options.js";
import type {
  AgentComponentCursorRow,
  AgentSessionSyncSource,
  DesktopAgentComponentsPayload,
} from "./agent-session-sync-source.js";
import {
  AGENT_COMPONENT_BATCH_SIZE,
  AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
  buildAgentComponentSyncSourceKey,
} from "./agent-session-sync-source.js";
import { buildComponentCursorPersist } from "./component-cursor-persist.js";

const TAG = "agent-session-sync";

/**
 * The narrow slice of {@link AgentSessionSyncServiceOptions} this lane reads. It
 * is deliberately a `Pick` of the canonical options type rather than a parallel
 * declaration, so the wiring contract cannot drift from the service's.
 */
export type AgentComponentSyncLaneOptions = Pick<
  AgentSessionSyncServiceOptions,
  | "getSource"
  | "getSyncComputeTargetId"
  | "isCloudSyncTierAllowed"
  | "listComponentCursorRows"
  | "loadComponentRows"
  | "sendComponents"
>;

/**
 * The two pieces of owning-service lifecycle state the lane must read LIVE (not
 * snapshot at construction): the source-state generation it guards its post-await
 * writes on, and whether the service is still started. Both are supplied as
 * accessors so the lane never holds a reference to the service itself.
 */
export type AgentComponentSyncLaneHost = {
  /**
   * The owning service's `sourceStateGeneration`. Bumped by `resetSourceState()`;
   * the lane captures it at the top of a run and refuses to write a superseded
   * run's boundary / ids / cursor back into freshly-cleared state.
   */
  getSourceStateGeneration: () => number;
  /** The owning service's `started` flag, re-read after every await. */
  isStarted: () => boolean;
};

/** Inputs for the drained-cursor dead-letter recovery step. */
type ComponentDeadLetterRecoveryInput = {
  sendComponents: NonNullable<AgentComponentSyncLaneOptions["sendComponents"]>;
  loadComponentRows: NonNullable<
    AgentComponentSyncLaneOptions["loadComponentRows"]
  >;
  isCurrent: () => boolean;
  sinceTs: string;
  sinceId: string;
};

/** Inputs for the post-send outcome classification step. */
type ComponentSendOutcomeInput = {
  sendResult: ComponentSyncSendResult;
  boundaryKey: string;
  lastRow: AgentComponentCursorRow | undefined;
  batchIds: string[];
  componentCount: number;
  sourceKey: string;
  source: AgentSessionSyncSource | null;
};

/**
 * ISS-5347 (wongk review): the identity stamp of ONE durable-cursor persist
 * attempt.
 *
 * The persist is fire-and-forget, so its outcome can land arbitrarily late —
 * after `clearCursorState()` re-scoped the lane to a different account, or after
 * a newer advance already issued its own persist. Without a stamp an OLD failure
 * dirties the NEW identity's flag and an OLD success clears a NEWER failure, and
 * {@link AgentComponentSyncLane.hasStaleDurableCursor} stops describing the
 * durable position at all. The lane accepts an outcome only from the attempt
 * that is still the current one for the still-current cursor identity.
 *
 * `watermark`/`lastId` are carried so a FAILED attempt can be re-driven: they
 * are the exact position that did not reach disk.
 */
type ComponentCursorPersistAttempt = {
  sourceKey: string;
  seq: number;
  watermark: string;
  lastId: string;
};

export class AgentComponentSyncLane {
  private readonly options: AgentComponentSyncLaneOptions;
  private readonly host: AgentComponentSyncLaneHost;
  /**
   * KEYSET cursor for the component inventory sync lane, split into the
   * `(last_seen_at, id)` pair. `watermark` is the normalized
   * `COALESCE(last_seen_at,'')` of the last-synced row; `lastId` is that row's
   * id. Together they are the durable keyset position: the next read selects rows
   * STRICTLY AFTER this pair, so the lane advances through a cluster of
   * same-`last_seen_at` rows one batch at a time instead of stalling on a `>=`
   * watermark that never moves past the cluster. `null` means not yet
   * initialized; the first tick reads from `('', '')` (full backfill).
   */
  private watermark: string | null = null;
  private lastId: string | null = null;
  /**
   * The source key the component sync cursor was last loaded for. Follows the
   * same identity-change pattern as the session lane's `hydratedSourceKey`.
   *
   * ISS-5347: this means "the durable cursor was successfully CONSULTED for this
   * key", NOT "the in-memory keyset belongs to this key" — a hydration that
   * could not reach the db host deliberately leaves it null so the next tick
   * re-reads. {@link cursorSourceKey} is the one that answers ownership.
   */
  private hydratedSourceKey: string | null = null;
  /**
   * ISS-5347 (wongk review): the identity the IN-MEMORY keyset actually belongs
   * to, tracked separately from {@link hydratedSourceKey}.
   *
   * The two diverge exactly when hydration could not consult the durable cursor:
   * `hydratedSourceKey` goes null while `watermark`/`lastId` still hold the
   * position they were advanced to. Keying the foreign-position drop off
   * `hydratedSourceKey` therefore missed a real case — target changes to B while
   * `hydratedSourceKey` is already null from an earlier failed hydration, the
   * drop is skipped, and target A's position is reused for B. The lane would
   * then read STRICTLY AFTER a foreign keyset (skipping B's earlier rows) and,
   * once the source returned mid-tick, persist that foreign position under B's
   * source key.
   *
   * Set wherever the in-memory position is established (a successful hydration
   * or an advance) and cleared with the position.
   */
  private cursorSourceKey: string | null = null;
  /**
   * FEA-3448: single-flight guard for this lane, mirroring the session lane's
   * `syncing`. The lane is launched fire-and-forget from the service's sync tick,
   * so when one upload takes longer than the 5s tick interval the next tick would
   * otherwise start a second concurrent run — both read the same keyset cursor,
   * re-POST the same batch, and race the cursor advance. Set on entry, cleared in
   * a `finally` so an in-flight run always releases it.
   */
  private syncing = false;
  /**
   * The currently in-flight run promise, or `null` when idle. {@link syncOnce}
   * sets this to the ONE real run it launches and clears it — by identity — only
   * when that same run settles, so a caller can await the REAL completion of the
   * lane (its load/send/advance awaits) rather than guessing a flush count.
   * Consumed by {@link whenSettled}.
   *
   * Identity ownership matters (shafty023 review): a second tick that arrives while
   * a slow run is still in flight is bounced by the {@link syncing} guard and
   * returns THIS same in-flight promise — it must not overwrite it with an
   * already-resolved one, or {@link whenSettled} would return before the real
   * load/send/advance completes. The clear is therefore identity-guarded.
   */
  private syncPromise: Promise<void> | null = null;
  /**
   * Transition-based logger for the component sync lane. Logs a pre-send
   * outcome (no compute target, empty cursor, read/send throw, …) only when it
   * changes, so a stuck skip names itself exactly once instead of being a
   * silent `return` every 5s tick. Shares its transition logic with the HTTP
   * client lane via `createTransitionLogger` (same behavior). Grep the
   * `agent-session-sync` tag for `component sync lane`.
   */
  private readonly diag = createTransitionLogger(
    TAG,
    (message) => `component sync lane: ${message}`
  );
  /**
   * ISS-4542: dead-letter tracker for the component lane. A batch that fails to
   * send is retried a BOUNDED number of times at its keyset boundary, then
   * dead-lettered to the BACK of the line (the cursor advances past it) so a
   * permanent failure (a never-clearing 403, schema drift, a poison row) can no
   * longer head-of-line-block the whole lane. Dead-lettered ids are re-attempted
   * only once the live cursor is drained AND no newer incremental has entered, on
   * a doubling backoff, then quarantined after a bounded count. Cleared on
   * identity change / stop with the rest of the component-lane cursor state.
   */
  private readonly deadLetters = new ComponentSyncDeadLetterTracker();
  /**
   * ISS-5347: true once an advance moved the in-memory keyset without the
   * durable `sync_state` row being written (no persist callback, or the persist
   * rejected). While set, this lane's in-memory position is AHEAD of what a
   * restart would resume from, so anything that reports "fully synced" must not
   * treat this lane's drained queue as durable progress.
   *
   * Cleared the moment a persist succeeds, and on identity change / stop with
   * the rest of the cursor state.
   */
  private staleDurableCursor = false;
  /**
   * ISS-5347 (wongk review): monotonically increasing id for durable-persist
   * attempts. Bumped on every attempt AND on every reset of the cursor identity
   * (so an in-flight attempt from the previous identity is superseded on the
   * spot). Only the attempt whose `seq` still equals this may report an outcome.
   */
  private cursorAttemptSeq = 0;
  /**
   * ISS-5347 (wongk review): the latest keyset position that MOVED in memory
   * without reaching disk, or `null` when the durable row is current.
   *
   * Naming a failed persist is not enough on its own: nothing re-attempts it.
   * Once the live cursor drains there is no further row to advance past, so
   * `applyCursorAdvance` is never called again and the durable row stays frozen
   * at the pre-failure position until some unrelated component changes — the
   * exact shape of the three-day freeze this ticket is about, just reached
   * through a rejected write instead of an absent one. The lane therefore holds
   * the unpersisted position and retries it on a later tick.
   */
  private pendingCursorPersist: ComponentCursorPersistAttempt | null = null;
  /**
   * ISS-5347 (wongk review): resolves when the CURRENT durable-persist attempt
   * has reported its outcome, or `null` when no attempt is outstanding. The
   * durable write is fire-and-forget, so without this a caller has no completion
   * signal for it and has to guess microtask turns. Consumed by
   * {@link whenCursorPersistSettled}.
   */
  private cursorPersistSettle: Promise<void> | null = null;
  /**
   * ISS-5347: transition logger for the durable-persist outcome, kept SEPARATE
   * from {@link diag} so a persist failure cannot overwrite (or be overwritten
   * by) the pre-send skip states — the two describe different halves of the
   * tick and both need to name themselves exactly once.
   */
  private readonly persistDiag = createTransitionLogger(
    TAG,
    (message) => `component sync lane: ${message}`
  );

  constructor(
    options: AgentComponentSyncLaneOptions,
    host: AgentComponentSyncLaneHost
  ) {
    this.options = options;
    this.host = host;
  }

  /**
   * Live dead-letter count, reported by the service as
   * `getSyncProgress().deadLetteredComponents`.
   */
  get deadLetteredCount(): number {
    return this.deadLetters.size;
  }

  /**
   * ISS-5347: whether this lane's in-memory keyset has advanced past what is
   * durably recorded in `sync_state`. Read-only signal for diagnostics and for
   * any caller that must not claim durable catch-up on an unpersisted cursor.
   */
  get hasStaleDurableCursor(): boolean {
    return this.staleDurableCursor;
  }

  /**
   * T-8.7: one component inventory sync tick. Requires `sendComponents`,
   * `listComponentCursorRows`, and `loadComponentRows` to be wired; otherwise
   * this is a no-op.
   */
  syncOnce(): Promise<void> {
    const { sendComponents, listComponentCursorRows, loadComponentRows } =
      this.options;
    if (!(sendComponents && listComponentCursorRows && loadComponentRows)) {
      return Promise.resolve();
    }
    // FEA-3448: single-flight this lane. A prior tick's upload may still be in
    // flight (a slow send outlasting the 5s interval); return the SAME in-flight
    // run (shafty023 review) so a bounced tick still awaits the real load/send/
    // advance instead of an already-resolved promise — otherwise it would launch a
    // second concurrent run that re-reads the same cursor and duplicates the upload.
    if (this.syncing) {
      return this.syncPromise ?? Promise.resolve();
    }
    this.syncing = true;
    const run = (async () => {
      try {
        await this.run(
          sendComponents,
          listComponentCursorRows,
          loadComponentRows
        );
      } finally {
        this.syncing = false;
      }
    })().finally(() => {
      // Clear by identity: only null the field if it still points at THIS run, so a
      // later run that has already replaced it is never clobbered.
      if (this.syncPromise === run) {
        this.syncPromise = null;
      }
    });
    this.syncPromise = run;
    return run;
  }

  /**
   * Await the current component-lane run to fully settle (its load/send/advance
   * awaits all complete and the single-flight guard clears), then flush one more
   * microtask turn so the `finally` that nulls the promise has run. Returns
   * immediately when the lane is idle. This is the REAL completion signal for the
   * fire-and-forget component lane — tests await it (through the service's
   * `whenComponentSyncSettled`) instead of guessing a fixed flush count
   * (FEA-2399 determinism / shafty023 review). It never throws (the lane's awaits
   * are all try/caught internally).
   */
  async whenSettled(): Promise<void> {
    // A run may enqueue no further work, but its awaits can span several turns;
    // await the captured promise (if any), then yield once so the `.finally`
    // that clears `syncPromise` has executed before the caller proceeds.
    while (this.syncPromise) {
      await this.syncPromise;
    }
  }

  /**
   * FEA-3448: clear the single-flight guard on a HARD reset (stop/restart of the
   * same service instance), mirroring the session lane's `syncing`, so a stop
   * while a component upload is in flight can never leave a stale `true` that
   * permanently skips the lane after restart. Deliberately NOT part of
   * {@link clearCursorState}: that also runs on the live identity-change path,
   * where an in-flight component run may still be draining and clearing its guard
   * would admit a second concurrent run — exactly what the guard prevents.
   *
   * Also drops the in-flight run handle: after a hard reset its settle is no
   * longer the lane's current work, so {@link whenSettled} must not block on it.
   * The abandoned run's identity-guarded `finally` becomes a no-op.
   */
  clearInFlightState(): void {
    this.syncing = false;
    this.syncPromise = null;
  }

  /**
   * T-8.7: reset the keyset cursor so the next tick re-hydrates from the
   * persisted position (or performs a full backfill if absent). ISS-4542: also
   * drops the dead-letter tracker on identity change / stop so a prior account's
   * dead-lettered ids and boundary failure counters never leak into the next
   * identity's lane.
   */
  clearCursorState(): void {
    this.watermark = null;
    this.lastId = null;
    this.hydratedSourceKey = null;
    this.deadLetters.clear();
    // ISS-5347: the staleness flag describes the CLEARED cursor's divergence, so
    // it must not survive into the next identity's lane.
    this.staleDurableCursor = false;
    this.dropCursorIdentity();
  }

  /**
   * ISS-5347 (wongk review): await the current durable-cursor persist attempt's
   * OUTCOME (persisted / rejected / no persist available / nothing to write).
   * Returns immediately when no attempt is outstanding, and never throws — the
   * persist is best-effort and its rejection is reported, not propagated.
   *
   * This is the completion signal for the half of a tick that {@link whenSettled}
   * deliberately does not cover: the durable write is issued fire-and-forget
   * INSIDE the advance, so the lane's run promise can settle while the write is
   * still in flight. Kept separate from {@link whenSettled} so an existing caller
   * that only wants the drain to finish is unaffected.
   */
  async whenCursorPersistSettled(): Promise<void> {
    while (this.cursorPersistSettle) {
      const settle = this.cursorPersistSettle;
      await settle;
      if (this.cursorPersistSettle === settle) {
        this.cursorPersistSettle = null;
      }
    }
  }

  private async run(
    sendComponents: NonNullable<
      AgentComponentSyncLaneOptions["sendComponents"]
    >,
    listComponentCursorRows: NonNullable<
      AgentComponentSyncLaneOptions["listComponentCursorRows"]
    >,
    loadComponentRows: NonNullable<
      AgentComponentSyncLaneOptions["loadComponentRows"]
    >
  ): Promise<void> {
    const source = this.options.getSource?.() ?? null;
    const computeTargetId = this.options.getSyncComputeTargetId?.() ?? null;
    if (!computeTargetId) {
      this.diag.note(
        "warn",
        "no-compute-target",
        "no compute target yet (offline / pre-auth); nothing uploaded"
      );
      return;
    }
    const sourceKey = buildAgentComponentSyncSourceKey(computeTargetId);
    // ISS-4542 (wongk review): capture the source-state generation up front so a
    // send/recover await that resolves AFTER a `resetSourceState()` (stop /
    // identity change bumped the generation and cleared the tracker + cursor for a
    // NEW target) cannot write the OLD boundary/ids/cursor back into the now-cleared
    // shared state. Mirrors the session lane's `sourceStateGeneration` guard around
    // its awaits. Every mutation after an await is gated on this holding.
    const componentGeneration = this.host.getSourceStateGeneration();
    // ISS-4623: ALSO re-read the LIVE egress gate + target; the generation guard
    // alone misses an org-policy close and a mid-drain target switch. Rationale in
    // `sync-egress-gate.ts`.
    const isCurrentComponentState = () =>
      this.host.getSourceStateGeneration() === componentGeneration &&
      this.host.isStarted() &&
      (this.options.isCloudSyncTierAllowed?.() ?? true) &&
      (this.options.getSyncComputeTargetId?.() ?? null) === computeTargetId;

    // Hydrate persisted keyset cursor on identity change or first run. The
    // durable shape reuses `PersistedSyncState`: `observedTopUpdatedAt` carries
    // the normalized `COALESCE(last_seen_at,'')` and `observedIdsAtTopUpdatedAt`
    // carries the single last-synced id (the `(ts, id)` keyset pair).
    if (sourceKey !== this.hydratedSourceKey) {
      await this.hydrateCursorFor(sourceKey, source);
    }

    // Keyset position `('', '')` on first run reads every row (full backfill):
    // an empty `last_seen_at` sorts before any ISO timestamp and `id > ''`
    // matches every row. Nulls normalize to '' in the query so they page first.
    const sinceTs = this.watermark ?? "";
    const sinceId = this.lastId ?? "";
    let cursorRows: AgentComponentCursorRow[];
    try {
      cursorRows = await listComponentCursorRows(
        sinceTs,
        sinceId,
        AGENT_COMPONENT_BATCH_SIZE
      );
    } catch (error) {
      // DB read failure — skip this tick, retry next interval.
      this.diag.note(
        "warn",
        "cursor-read-failed",
        `component cursor read failed: ${errorMessage(error)}`
      );
      return;
    }
    if (cursorRows.length === 0) {
      // ISS-5347 (wongk review): a drained cursor is exactly where an unpersisted
      // position gets stranded — there is no next row to advance past, so nothing
      // would ever re-attempt the durable write. Re-drive it here so the lane
      // recovers with no new component required.
      this.retryPendingCursorPersist(sourceKey);
      // ISS-4542: the live cursor is drained — this is the ONLY moment we
      // re-attempt dead-lettered rows, so a poison backlog item can never starve
      // live/incremental data.
      await this.recoverDeadLettersOnDrainedCursor({
        sendComponents,
        loadComponentRows,
        isCurrent: isCurrentComponentState,
        sinceTs,
        sinceId,
      });
      return;
    }

    // FEA-3438: the DB read is bounded by `LIMIT AGENT_COMPONENT_BATCH_SIZE`, so
    // `cursorRows` already holds at most one batch. This slice defensively keeps
    // the batch invariant for injected sources that ignore the `limit` argument.
    const batchRows = cursorRows.slice(0, AGENT_COMPONENT_BATCH_SIZE);
    const batchIds = batchRows.map((r) => r.id);
    let components: SyncedComponent[];
    try {
      components = await loadComponentRows(batchIds);
    } catch (error) {
      this.diag.note(
        "warn",
        "load-rows-failed",
        `loading ${batchIds.length} component row(s) failed: ${errorMessage(
          error
        )}`
      );
      return;
    }
    if (components.length === 0) {
      this.diag.note(
        "warn",
        "load-rows-empty",
        `cursor returned ${batchIds.length} id(s) but row load returned 0 rows`
      );
      return;
    }

    const payload: DesktopAgentComponentsPayload = {
      schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
      batchId: randomUUID(),
      syncMode: AgentSessionSyncMode.Incremental,
      componentCount: components.length,
      components,
    };

    // ISS-4623: re-check before the POST; a close mid-load must abort the send.
    if (!isCurrentComponentState()) {
      this.diag.note(
        "info",
        "gate-closed-pre-send",
        `egress gate closed or target changed before sending ${components.length} component(s); skipping this batch`
      );
      return;
    }
    let sendResult: ComponentSyncSendResult;
    try {
      sendResult = await sendComponents(payload);
    } catch (error) {
      // A thrown send is lane-wide (dropped socket / serialization), NOT a
      // per-batch rejection — skip the cursor advance, do NOT charge the poison
      // budget, retry the same batch next tick.
      this.diag.note(
        "warn",
        "send-threw",
        `sendComponents threw for ${components.length} component(s): ${errorMessage(
          error
        )}`
      );
      return;
    }
    // ISS-4542 (wongk review): the send await may have resolved AFTER a
    // `resetSourceState()` cleared the tracker/cursor for a new identity. If the
    // generation moved, this run is superseded — do NOT write its stale boundary,
    // ids, or cursor back into the fresh state; the new identity's lane owns it now.
    if (!isCurrentComponentState()) {
      return;
    }
    this.applySendOutcome({
      sendResult,
      boundaryKey: buildComponentBoundaryKey(sinceTs, sinceId),
      lastRow: batchRows.at(-1),
      batchIds,
      componentCount: components.length,
      sourceKey,
      source,
    });
  }

  /**
   * Advance the component KEYSET cursor past `lastRow` via `advanceComponentCursor`
   * (ISS-4542), writing the returned position back onto the lane's in-memory cursor
   * fields. Shared by the accepted-send and dead-letter paths. The persist callback
   * MUST come from `buildComponentCursorPersist` — see that module's header for the
   * ISS-4620 proxy-clone crash it prevents.
   */
  private applyCursorAdvance(
    sourceKey: string,
    lastRow: AgentComponentCursorRow,
    source: AgentSessionSyncSource | null
  ): void {
    // ISS-5347: re-resolve the source HERE rather than reusing the one captured
    // at the top of `run()`. `listComponentCursorRows` / `loadComponentRows`
    // already re-resolve per call, so the lane can be reading and sending
    // happily through a live source while the run-entry capture is a stale null
    // from a db-host restart — and a null capture silently disables the durable
    // persist for the whole run. Prefer the live source; fall back to the
    // captured one so behavior is unchanged when there is no live one.
    const persistSource = this.options.getSource?.() ?? source;
    // The in-memory keyset is about to belong to `sourceKey`, whether or not the
    // durable cursor was ever consulted for it (wongk review). Recorded BEFORE
    // the advance so an outcome reported synchronously from inside it (no
    // persist available, or nothing to write) is not mistaken for a superseded
    // one.
    this.cursorSourceKey = sourceKey;
    const next = advanceComponentCursor(
      {
        watermark: this.watermark,
        lastId: this.lastId,
      },
      lastRow,
      sourceKey,
      buildComponentCursorPersist(persistSource),
      // ISS-4542: ride the dead-letter ids along so a cold restart re-drives them.
      this.deadLetters.deadLetteredIds(),
      // ISS-5347: observe the durable persist so a failed or absent write is
      // named instead of silently discarded, and stamp the attempt so a late
      // outcome from a superseded one cannot rewrite the staleness flag.
      this.beginCursorPersistAttempt(
        sourceKey,
        lastRow.last_seen_at ?? "",
        lastRow.id
      )
    );
    this.watermark = next.watermark;
    this.lastId = next.lastId;
  }

  /**
   * ISS-5347 (wongk review): open a stamped durable-persist attempt for
   * `(watermark, lastId)` under `sourceKey` and return the observer that reports
   * its outcome.
   *
   * Bumping {@link cursorAttemptSeq} here is what supersedes every earlier
   * in-flight attempt: only the newest stamp is accepted by
   * {@link noteCursorPersistOutcome}. The observer also releases
   * {@link cursorPersistSettle}, which is the awaitable completion signal for the
   * otherwise fire-and-forget write.
   */
  private beginCursorPersistAttempt(
    sourceKey: string,
    watermark: string,
    lastId: string
  ): ComponentCursorPersistObserver {
    const supersededSeq = this.cursorAttemptSeq;
    const supersededSettle = this.cursorPersistSettle;
    this.cursorAttemptSeq += 1;
    const attempt: ComponentCursorPersistAttempt = {
      sourceKey,
      seq: this.cursorAttemptSeq,
      watermark,
      lastId,
    };
    let release: () => void = () => undefined;
    const settle = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.cursorPersistSettle = settle;
    return (outcome, error) => {
      if (outcome === ComponentCursorPersistOutcome.Unchanged) {
        // The advance was a no-op, so no durable write was ever issued for this
        // stamp. It must not supersede a REAL attempt that is still in flight:
        // hand the sequence and the settle handle back to it untouched.
        if (this.cursorAttemptSeq === attempt.seq) {
          this.cursorAttemptSeq = supersededSeq;
          this.cursorPersistSettle = supersededSettle;
        }
        release();
        return;
      }
      this.noteCursorPersistOutcome(attempt, outcome, error);
      if (this.cursorPersistSettle === settle) {
        this.cursorPersistSettle = null;
      }
      release();
    };
  }

  /**
   * ISS-5347: fold one durable-cursor persist outcome into the lane's staleness
   * flag, its retry slot, and its transition log.
   *
   * A success clears the flag (the durable row now matches the in-memory
   * keyset). A failure or an absent persist sets it: the lane has advanced past
   * what a restart would resume from, which is the exact condition that ran
   * unnoticed for three days on Mike's install. The transition logger keeps a
   * persistent failure to ONE line rather than one per 5s tick.
   *
   * SUPERSEDED outcomes are ignored (wongk review). The write is fire-and-forget,
   * so an attempt can settle after the cursor identity was cleared or after a
   * newer advance issued its own persist; letting those land meant an old failure
   * dirtied the new identity and an old success cleared a newer failure.
   *
   * Never reached with {@link ComponentCursorPersistOutcome.Unchanged} — that
   * outcome means no write was issued, and {@link beginCursorPersistAttempt}
   * unwinds its own stamp for it before this is called.
   */
  private noteCursorPersistOutcome(
    attempt: ComponentCursorPersistAttempt,
    outcome: ComponentCursorPersistOutcome,
    error?: unknown
  ): void {
    if (
      attempt.seq !== this.cursorAttemptSeq ||
      attempt.sourceKey !== this.cursorSourceKey
    ) {
      return;
    }
    if (outcome === ComponentCursorPersistOutcome.Persisted) {
      this.staleDurableCursor = false;
      this.pendingCursorPersist = null;
      this.persistDiag.set("ok");
      return;
    }
    this.staleDurableCursor = true;
    // Hold the position that did not reach disk so a later tick can re-drive it
    // even after the live cursor drains and nothing is left to advance past.
    this.pendingCursorPersist = attempt;
    if (outcome === ComponentCursorPersistOutcome.Unavailable) {
      this.persistDiag.note(
        "warn",
        "cursor-persist-unavailable",
        "keyset advanced with no durable persist available; the cursor on disk is now BEHIND this lane and a restart will re-walk from it"
      );
      return;
    }
    this.persistDiag.note(
      "warn",
      "cursor-persist-failed",
      `durable cursor persist failed: ${errorMessage(error)}; the cursor on disk is now BEHIND this lane and a restart will re-walk from it`
    );
  }

  /**
   * ISS-5347 (wongk review): re-drive the latest keyset position that moved in
   * memory but never reached disk.
   *
   * Naming a failed persist left the lane with no way back: once the live cursor
   * drains, `applyCursorAdvance` is never called again, so the durable row stayed
   * frozen at the pre-failure position until an unrelated component happened to
   * change. This retries the exact held position — no new row required — so the
   * lane recovers on its own the moment the durable write does.
   *
   * A no-op when nothing is pending, or when the held position belongs to a
   * different identity than the tick now running.
   */
  private retryPendingCursorPersist(sourceKey: string): void {
    const pending = this.pendingCursorPersist;
    if (!pending || pending.sourceKey !== sourceKey) {
      return;
    }
    persistComponentCursorPosition(
      buildComponentCursorPersist(this.options.getSource?.() ?? null),
      sourceKey,
      {
        watermark: pending.watermark,
        lastId: pending.lastId,
        deadLetteredIds: this.deadLetters.deadLetteredIds(),
      },
      this.beginCursorPersistAttempt(
        sourceKey,
        pending.watermark,
        pending.lastId
      )
    );
  }

  /**
   * ISS-5347 (wongk review): drop everything that identifies WHICH cursor the
   * lane is holding — the owner key, the retry slot, and (by bumping the attempt
   * sequence) any persist still in flight for the old identity.
   */
  private dropCursorIdentity(): void {
    this.cursorSourceKey = null;
    this.pendingCursorPersist = null;
    this.cursorAttemptSeq += 1;
  }

  /**
   * Hydrate the persisted keyset cursor for `sourceKey` (identity change or first
   * run). The durable shape reuses `PersistedSyncState`: `observedTopUpdatedAt`
   * carries the normalized `COALESCE(last_seen_at,'')` and
   * `observedIdsAtTopUpdatedAt` carries the single last-synced id (the `(ts, id)`
   * keyset pair). Called ONLY when the key actually changed, so an unchanged tick
   * still performs no read and no await.
   */
  private async hydrateCursorFor(
    sourceKey: string,
    source: AgentSessionSyncSource | null
  ): Promise<boolean> {
    // ISS-5347 / invariant 2: a keyset position that belongs to a DIFFERENT
    // identity must never be reused, so drop it before anything else. (The
    // service also clears this state on an identity change; this is the local
    // guarantee, independent of that call order.)
    //
    // The owner is {@link cursorSourceKey}, NOT `hydratedSourceKey` (wongk
    // review): the latter goes null whenever hydration could not consult the
    // durable cursor, while `watermark`/`lastId` keep the position they were
    // advanced to. Testing `hydratedSourceKey` therefore skipped the drop in
    // exactly the case that matters — target changes to B while a previous
    // hydration for A had already failed — leaving A's position in place for B
    // to read STRICTLY AFTER (skipping B's earlier rows) and, once the source
    // returned mid-tick, to persist under B's source key.
    if (this.cursorSourceKey !== null && this.cursorSourceKey !== sourceKey) {
      this.watermark = null;
      this.lastId = null;
      this.hydratedSourceKey = null;
      this.deadLetters.clear();
      this.staleDurableCursor = false;
      this.dropCursorIdentity();
    }
    // ISS-5347: a null `source` is TRANSIENT — `getSyncSource()` returns null
    // while the db host restarts (observed twice in one day on Mike's install as
    // `component cursor read failed: db-host exited (code: 0)`) — and the durable
    // cursor is still on disk.
    //
    // This used to clear the in-memory keyset and then mark the lane hydrated
    // anyway. That was the stall: one transient blip replaced a real cursor with
    // the EPOCH position, `hydratedSourceKey` was set so it was never re-read,
    // and `buildComponentCursorPersist(null)` returned undefined so every
    // subsequent advance moved in memory only. The durable row then froze — on
    // Mike's install at `2026-08-03T20:56:53Z` / `data_revision 65` against a
    // current `DATA_REVISION` of 68 — while the lane kept logging successful
    // syncs, and every restart re-walked the whole inventory from that stale
    // position.
    //
    // Now the position is left EXACTLY as it was and the lane is NOT marked
    // hydrated, so the next tick re-reads the durable cursor and adopts it as
    // the truth once the db host is back. Returning false lets callers tell
    // "hydrated" from "could not consult the durable cursor".
    if (!source) {
      return false;
    }
    this.watermark = null;
    this.lastId = null;
    this.hydratedSourceKey = null;
    if (source.loadSyncState) {
      const persisted = await source.loadSyncState(sourceKey);
      if (persisted?.observedTopUpdatedAt !== undefined) {
        this.watermark = persisted?.observedTopUpdatedAt ?? null;
        this.lastId = persisted?.observedIdsAtTopUpdatedAt?.[0] ?? null;
      }
      // ISS-4542: re-seed the dead-letter tracker from the durable snapshot so
      // a poison item the cursor already advanced past is re-driven after a
      // cold restart (fresh window), never permanently stranded.
      if (persisted?.deadLetteredIds?.length) {
        this.deadLetters.seedDeadLetters(persisted.deadLetteredIds, Date.now());
      }
    }
    this.hydratedSourceKey = sourceKey;
    // The adopted position came straight off disk, so it IS the durable truth:
    // nothing is pending, nothing is stale, and any write still in flight for the
    // position we just discarded is superseded — it must not re-dirty the flag or
    // re-arm the retry slot with a position this lane no longer holds (wongk
    // review). `dropCursorIdentity` bumps the attempt sequence to do exactly that.
    this.dropCursorIdentity();
    this.cursorSourceKey = sourceKey;
    this.staleDurableCursor = false;
    return true;
  }

  /**
   * ISS-4542: the live cursor is drained — nothing newer/incremental is pending.
   * Re-attempt the dead-lettered rows, so a poison backlog item can never starve
   * live/incremental data. If a re-attempt runs (making forward progress or
   * re-failing one bounded step), skip the idle "nothing to upload" transition so
   * recovery owns this tick's diagnostic. The step lives in
   * `agent-component-sync-dead-letter.ts`; we inject the tracker + transport so it
   * does not grow this file.
   */
  private async recoverDeadLettersOnDrainedCursor(
    input: ComponentDeadLetterRecoveryInput
  ): Promise<void> {
    const { sendComponents, loadComponentRows, isCurrent, sinceTs, sinceId } =
      input;
    const recovered = await recoverComponentDeadLetters({
      tracker: this.deadLetters,
      batchLimit: AGENT_COMPONENT_BATCH_SIZE,
      loadComponentRows,
      sendComponents: (components) =>
        sendComponents({
          schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
          batchId: randomUUID(),
          syncMode: AgentSessionSyncMode.Incremental,
          componentCount: components.length,
          components,
        }),
      diag: this.diag,
      logTag: TAG,
      // ISS-4542 (wongk review): supersede late recovery writes when the identity
      // changed mid-await, so the outcome never lands on the new tracker.
      isCurrent,
    });
    if (!recovered) {
      this.diag.note(
        "info",
        "cursor-empty",
        `no components after keyset (${sinceTs || "epoch"}, ${sinceId || "-"}); nothing to upload`
      );
    }
  }

  /**
   * Classify a completed `sendComponents` call and apply its cursor / dead-letter
   * consequences. Reached only after the identity guard re-confirmed this run is
   * still current, so every mutation here belongs to the live lane.
   */
  private applySendOutcome(input: ComponentSendOutcomeInput): void {
    const {
      sendResult,
      boundaryKey,
      lastRow,
      batchIds,
      componentCount,
      sourceKey,
      source,
    } = input;
    if (sendResult.outcome === ComponentSyncSendOutcome.LaneFailure) {
      // ISS-4542 (shafty023 review): a lane-wide failure — auth (401/403), no
      // compute target/origin, transport/timeout, rate limit (429), or server 5xx
      // — must NOT charge the boundary's poison budget or advance the cursor, or
      // an outage/policy denial would strand healthy rows and walk the inventory
      // forward. Pause the lane (same batch retries next tick) and clear any
      // near-threshold count so an outage cannot push it toward dead-lettering.
      this.deadLetters.clearBoundary(boundaryKey);
      this.diag.note(
        "warn",
        "lane-failure",
        `component sync lane-wide failure for ${componentCount} component(s) (see components-sync-client log); pausing without advancing the cursor or charging the dead-letter budget`
      );
      return;
    }
    if (sendResult.outcome === ComponentSyncSendOutcome.BatchRejected) {
      // ISS-4542: a PERMANENT per-batch rejection (400/409/413/422, or a locally-
      // oversized component), charged against the batch's keyset boundary. The
      // retry-in-place vs dead-letter-to-the-back decision lives in
      // `handleComponentSendFailure`; only when it dead-letters AND we have a last
      // row do we advance the cursor PAST the failing batch here.
      const outcome = handleComponentSendFailure({
        tracker: this.deadLetters,
        boundaryKey,
        batchIds,
        componentCount,
        canAdvance: lastRow !== undefined,
        diag: this.diag,
      });
      if (outcome === ComponentSendFailureOutcome.DeadLettered && lastRow) {
        this.applyCursorAdvance(sourceKey, lastRow, source);
      }
      return;
    }
    // Clear any prior skip so the next skip re-logs, and reset this boundary's
    // failure budget so a later unrelated failure here starts fresh.
    this.deadLetters.clearBoundary(boundaryKey);
    // ISS-4542 (wongk review): a previously dead-lettered (even quarantined) row
    // can re-enter this LIVE keyset path once its `last_seen_at` advances past the
    // cursor, and succeed here. Clear its dead-letter entry too, or it lingers (a
    // stale `deadLetteredComponents` count in Settings while the row IS synced)
    // and is re-sent next drain. `noteReattemptResult(.., true)` deletes exactly
    // the accepted ids.
    this.deadLetters.noteReattemptResult(batchIds, true, Date.now());
    this.diag.set("ok");

    if (lastRow) {
      this.applyCursorAdvance(sourceKey, lastRow, source);
    }

    gatewayLog.info(
      TAG,
      `synced ${componentCount} agent component(s) to cloud inventory`
    );
  }
}
