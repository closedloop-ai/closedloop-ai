import type {
  AgentComponentInvocationSyncAck,
  AgentComponentInvocationSyncPart,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { AgentComponentInvocationSyncRejectReason as InvocationRejectReason } from "@repo/api/src/types/agent-component-invocation";
import type { InvocationSyncParent } from "@repo/api/src/types/invocation-sync-diagnostics";
import {
  laneStallDelayMs,
  laneStallWindow,
} from "../../shared/lane-stall-clock.js";
import type { AgentComponentInvocationSyncClientResult } from "../dashboard/desktop-agent-component-invocations-client.js";
import {
  decideOutboxFailure,
  OutboxFailureOutcome,
} from "../sync/durable-outbox.js";
import type { SignedInUserIdentity } from "../util/user-identity.js";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_OUTBOX_TABLE,
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AgentComponentInvocationSyncLocalError,
  buildAgentComponentInvocationSyncSourceKey,
} from "./agent-component-invocation-sync-constants.js";
import {
  ackMatchesPart,
  readLaneStallOrigin,
} from "./agent-component-invocation-sync-service-helpers.js";
import type { AgentSessionSyncSource } from "./agent-session-sync-source.js";
import {
  INVOCATION_ACK_MISMATCH_REASON,
  isInvocationDeadLetterRecoveryCause,
  isInvocationEnvironmentalRejectionReason,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  rejectionBudgetForRow,
  SessionMissingRetryHorizon,
  terminalCauseForRejection,
} from "./invocation-sync-rejection-policy.js";

const SYNC_INTERVAL_MS = 5000;
const READY_PART_LIMIT = 10;
const PREPARE_SESSION_LIMIT = 10;

/**
 * ISS-5973: how many consecutive ticks may skip `prepareInvocationSyncTarget`
 * because ready parts were already materialized, before one runs ANYWAY.
 *
 * ## The stall this exists to stop
 *
 * ISS-5789 removed the "bail whenever the delivery queue holds ANY pending row"
 * rule from INSIDE promotion and replaced it with a depth ceiling
 * (`MAX_PENDING_INVOCATION_DELIVERY_PARTS`), precisely so one undrainable part
 * could not wedge every other session behind it. The ISS-4710 fast-path in
 * `syncOnce` then re-imposed exactly those semantics one layer UP: promotion runs
 * only when this tick found zero ready parts, so any permanently-ready part
 * suppresses promotion forever.
 *
 * Measured on a live install (2026-08-11): the delivery queue held 85 ready parts
 * — 71 never attempted plus 14 retrying `session_missing` on a ladder that keeps
 * re-arming them — so `entries.length` was never 0, promotion never ran, and 16
 * sessions the template cursor said were owed were never materialized. The depth
 * guard one layer down would have admitted every one of them (85 is far below the
 * 500 ceiling); it was simply never asked.
 *
 * ## Why a deferral count and not "always prepare"
 *
 * ISS-4710's fast-path is real: during a first-boot DATA_REVISION rebuild the
 * shared writer is monopolized, and running the heavy `$transaction` every tick
 * parks this lane behind it and uploads nothing. Bounding the deferral keeps that
 * win for the common case while making "eventually" actually terminate — the
 * escape costs one prepare per minute of sustained backlog, and promotion is a
 * no-op when the depth ceiling is genuinely reached.
 */
const MAX_CONSECUTIVE_PROMOTION_DEFERRALS = 12;

export type AgentComponentInvocationSyncSource = {
  loadInvocationSyncParents?(
    sessionSourceKey: string,
    sessionIds: string[]
  ): Promise<InvocationSyncParent[]>;
  /**
   * ISS-7096: `identity` (the signed-in pair, null when unknown) lets the
   * promotion step release and stop materializing delivery rows for sessions
   * another identity owns — on a multi-environment device, the other
   * environment's sessions. Optional and additive: an older caller degrades to
   * the ungated behavior.
   */
  prepareInvocationSyncTarget(
    sourceKey: string,
    templateSourceKey: string,
    sessionLimit: number,
    identity?: SignedInUserIdentity | null
  ): Promise<void>;
  loadReadyInvocationSyncParts(
    sourceKey: string,
    now: string,
    limit: number
  ): Promise<AgentComponentInvocationSyncOutboxEntry[]>;
  recoverInvocationSyncDeadLetters(
    sourceKey: string,
    now: string,
    limit: number
  ): Promise<AgentComponentInvocationSyncDeadLetterRecoveryResult>;
  recordInvocationSyncRetry(
    sourceKey: string,
    part: AgentComponentInvocationSyncPart,
    retry: AgentComponentInvocationSyncRetryWrite
  ): Promise<void>;
  clearAcknowledgedInvocationSyncPart(
    sourceKey: string,
    ack: Pick<
      AgentComponentInvocationSyncAck,
      "externalGenerationId" | "partIndex" | "partHash"
    >
  ): Promise<boolean>;
  deadLetterInvocationSyncPart(
    sourceKey: string,
    part: AgentComponentInvocationSyncPart,
    deadLetter: AgentComponentInvocationSyncDeadLetterWrite
  ): Promise<boolean>;
};

export type AgentComponentInvocationSyncRetryWrite = {
  attemptCount: number;
  permanentAttemptCount: number;
  nextAttemptAt: string;
  error: string;
  laneStalledSince: string | null;
};

export type AgentComponentInvocationSyncDeadLetterWrite = {
  attemptCount: number;
  permanentAttemptCount: number;
  error: string;
};

export type AgentComponentInvocationSyncDeadLetterRecoveryResult = {
  recoveredParts: number;
  cappedParts: number;
  quarantinedParts: number;
};

export type AgentComponentInvocationSyncOutboxEntry = {
  part: AgentComponentInvocationSyncPart;
  attemptCount: number;
  permanentAttemptCount: number;
  laneStalledSince: string | null;
  deadLetterRecoveryCount: number;
  /**
   * ISS-5789: the row's persisted `created_at`. `session_missing` is budgeted by
   * how long the part has been retrying rather than by the shared `attempt_count`
   * column that every transient failure also bumps, so the drain needs the row's
   * age — see `rejectionBudgetForRow`.
   */
  createdAt: string;
};

export type AgentComponentInvocationSyncServiceOptions = {
  isReady: () => boolean;
  getSource: () => AgentComponentInvocationSyncSource | null;
  getComputeTargetId: () => string | null;
  /** ISS-7096: the signed-in identity pair, for the promotion ownership gate. */
  getSyncIdentity?: () => SignedInUserIdentity | null;
  sendPart: (
    part: AgentComponentInvocationSyncPart,
    computeTargetId: string
  ) => Promise<AgentComponentInvocationSyncClientResult>;
  /**
   * Report the parts this tick lost to a missing parent session. `canStillSend`
   * is this lane's own pre-send gate (readiness + consent tier + compute target),
   * handed down so the reporter re-reads exactly what the send path re-reads
   * after its own awaits instead of a second copy of the predicate that can drift
   * from it — see `main/sync/AGENTS.md` section 12a.
   */
  onSessionMissingParts?: (
    entries: AgentComponentInvocationSyncOutboxEntry[],
    computeTargetId: string,
    source: AgentComponentInvocationSyncSource,
    canStillSend: () => boolean
  ) => Promise<void>;
  waitForBackgroundSlot?: () => Promise<void>;
  now?: () => Date;
  /**
   * ISS-4710 diagnostic sink. Emits a one-line note when this tick DEFERS the
   * heavy `prepareInvocationSyncTarget` `$transaction` because ready parts are
   * already materialized — observability for the "writer busy during a rebuild,
   * component lane still draining" condition. Optional; defaults to a no-op.
   */
  log?: (message: string) => void;
  /** Best-effort observer for a tick that rejected before its next retry. */
  onSyncError?: (error: unknown) => void;
};

export class AgentComponentInvocationSyncService {
  private readonly options: AgentComponentInvocationSyncServiceOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private syncTask: Promise<void> | null = null;
  private started = false;
  private syncing = false;
  /**
   * ISS-5347: how many invocation parts this process has dead-lettered.
   *
   * `sync_state.dead_lettered_ids` does NOT and cannot cover this lane — that
   * column belongs to the session and component-INVENTORY lanes, which keep
   * their dead letters as a cursor-row id set, while invocation parts keep
   * theirs as a `status = 'dead_lettered'` row in
   * `agent_component_invocation_sync_outbox`. The two records were therefore
   * guaranteed to disagree (`dead_lettered_ids = []` on both cursors while the
   * invocation outbox held a dead-lettered row), and nothing anywhere reported
   * the second one. This counter is the invocation lane's own signal; the outbox
   * `status` column remains the authoritative record.
   */
  private deadLetteredParts = 0;
  private lastRecoveryCapReport: {
    sourceKey: string;
    cappedParts: number;
  } | null = null;
  /**
   * ISS-5973: consecutive ticks that skipped promotion because ready parts were
   * already materialized. Bounded by
   * {@link MAX_CONSECUTIVE_PROMOTION_DEFERRALS} so a permanently-ready part
   * cannot starve promotion forever.
   */
  private promotionDeferrals = 0;

  constructor(options: AgentComponentInvocationSyncServiceOptions) {
    this.options = options;
  }

  /**
   * ISS-5347: invocation parts this process has dead-lettered. Distinct from the
   * session/component lanes' `sync_state.dead_lettered_ids`, which never covers
   * this lane — see {@link deadLetteredParts}.
   */
  get deadLetteredPartCount(): number {
    return this.deadLetteredParts;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.refresh();
  }

  stop(): void {
    this.started = false;
    this.clearTimer();
    // ISS-5347 (whitlockk review): the counter and its log line both say "this run",
    // so a restart of the SAME service instance must not carry the previous
    // lifecycle's abandoned parts forward — that would report a prior run's
    // strandings as current and inflate the next run's log line. Reset it here
    // with the rest of the accumulated lifecycle state.
    this.deadLetteredParts = 0;
    // ISS-5973: the deferral count is scoped to one run's backlog composition, so
    // it is re-baselined here with the rest of the lifecycle state — invariant 2's
    // "re-scope the lane wholesale rather than reuse a stale position", and the
    // same discipline the burn-down reporter applies to its own ISS-5973 counters.
    // Carrying it could only make the next run promote SOONER (the escape resets
    // the count in the tick it fires), never later, so this is auditability rather
    // than a correctness fix — but a count earned under one account's backlog must
    // not decide when the next account's heavy `$transaction` runs.
    this.promotionDeferrals = 0;
    this.lastRecoveryCapReport = null;
  }

  refresh(): void {
    if (!(this.started && this.options.isReady())) {
      this.clearTimer();
      return;
    }
    if (this.syncTask) {
      return;
    }
    this.clearTimer();
    this.syncTask = this.syncOnce()
      .catch((error: unknown) => {
        // Durable work remains pending; the next scheduled tick retries.
        const onSyncError = this.options.onSyncError;
        if (onSyncError) {
          try {
            onSyncError(error);
          } catch {
            // Diagnostics are best-effort and must not break the retry schedule.
          }
        }
      })
      .finally(() => {
        this.syncTask = null;
        this.schedule();
      });
  }

  async syncOnce(): Promise<void> {
    if (this.syncing || !this.options.isReady()) {
      return;
    }
    const source = this.options.getSource();
    const computeTargetId = this.options.getComputeTargetId();
    if (!(source && computeTargetId)) {
      return;
    }
    const sourceKey =
      buildAgentComponentInvocationSyncSourceKey(computeTargetId);
    this.syncing = true;
    try {
      await this.options.waitForBackgroundSlot?.();
      // ISS-4623 (whitlockk review): the readiness gate and the compute target were
      // sampled once at entry, BEFORE the async prep below. A consent-tier change
      // or an account switch can land during `waitForBackgroundSlot` / prep, so
      // re-verify the LIVE gate and that the target is unchanged before touching
      // the outbox or sending — otherwise a just-closed gate would still POST
      // data, and a
      // switched account would send under the previous account's target.
      if (!this.canStillSend(computeTargetId)) {
        return;
      }
      const now = this.now();
      await this.recoverDeadLetters(source, sourceKey, now.toISOString());
      if (!this.canStillSend(computeTargetId)) {
        return;
      }
      // ISS-4710: check for already-materialized ready parts FIRST via the cheap
      // reader-path load, BEFORE the heavy `prepareInvocationSyncTarget`
      // `$transaction`. During a first-boot DATA_REVISION rebuild the shared
      // writer is monopolized by bulk rebuild writes; running the heavy prepare
      // every tick would park this whole lane behind that writer and upload
      // nothing. When a prior tick already queued parts, skip re-running prepare
      // this tick and drain those parts straight away — during a rebuild they
      // upload without waiting on the busy writer.
      //
      // ISS-5973: this used to add "a prepare is a no-op anyway, it short-circuits
      // on `pendingPartCount > 0`". That has been FALSE since ISS-5789, which
      // replaced that bail-out with a DEPTH ceiling
      // (`pendingPartCount >= MAX_PENDING_INVOCATION_DELIVERY_PARTS`, 500) exactly
      // because the `> 0` form turned one stuck part into a total outage — see
      // `database/invocation-sync-promotion.ts`. Deferring prepare therefore does
      // NOT "lose no work": below the ceiling a deferred prepare is real promotion
      // not happening, which is why the deferral below has to be bounded.
      let entries = await source.loadReadyInvocationSyncParts(
        sourceKey,
        now.toISOString(),
        READY_PART_LIMIT
      );
      // ISS-5973: promotion runs when nothing is ready (the ISS-4710 fast-path)
      // OR when it has been deferred for too many consecutive ticks. The second
      // arm is the starvation escape: without it a part that is permanently
      // ready — one retrying `session_missing` on a re-arming ladder — keeps
      // `entries.length` above zero forever and no session is ever promoted
      // again, which is the ISS-5789 head-of-line bug re-imposed by its caller.
      const promotionStarved =
        this.promotionDeferrals >= MAX_CONSECUTIVE_PROMOTION_DEFERRALS;
      if (entries.length === 0 || promotionStarved) {
        this.promotionDeferrals = 0;
        await source.prepareInvocationSyncTarget(
          sourceKey,
          AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
          PREPARE_SESSION_LIMIT,
          this.options.getSyncIdentity?.() ?? null
        );
        // Re-load only when this tick had nothing to drain. When promotion ran
        // under the starvation escape the already-loaded `entries` are still
        // valid work, and re-loading would discard this tick's drain to favour
        // freshly promoted rows.
        if (entries.length === 0) {
          entries = await source.loadReadyInvocationSyncParts(
            sourceKey,
            now.toISOString(),
            READY_PART_LIMIT
          );
        }
      } else {
        this.promotionDeferrals += 1;
        // ISS-4710 (@whitlockk): ready parts already materialized, so skip re-running
        // the prepare `$transaction` this tick and drain them. Ready parts do NOT
        // imply the writer is contended — this is the normal backlog-drain path
        // too — so the message states only what we observed (parts present), not
        // an unmeasured writer-busy claim.
        this.options.log?.(
          "component prepare skipped this tick: ready parts already materialized"
        );
      }
      const missingParents: AgentComponentInvocationSyncOutboxEntry[] = [];
      try {
        for (const entry of entries) {
          // Re-check immediately before EVERY send: an earlier `sendPart` in this
          // same drain awaits the network, during which the gate can close or the
          // target can switch. Stop the run rather than send the next part.
          if (!this.canStillSend(computeTargetId)) {
            return;
          }
          if (await this.syncPart(source, sourceKey, computeTargetId, entry)) {
            missingParents.push(entry);
          }
        }
      } finally {
        // Report on EVERY exit, including a throw out of a later part's retry
        // write or ack cleanup. An earlier part in this same batch can already
        // have dead-lettered for exhausting its age horizon, so there is no later
        // tick that would pick it up — losing the batch's diagnostic to an
        // unrelated part's failure loses it permanently. The gate and target
        // checks inside still apply, so a readiness exit reports nothing.
        await this.reportMissingParents(
          missingParents,
          computeTargetId,
          source
        );
      }
    } finally {
      this.syncing = false;
    }
  }

  /**
   * ISS-4623 (whitlockk review): is it still safe to send for `computeTargetId`?
   * True only when the LIVE readiness gate (consent tier + transport) still says
   * yes AND the live compute target is unchanged from the one this
   * drain was scoped to. Sampled fresh on every call so a gate-close or account
   * switch that lands mid-drain halts egress before the next send.
   */
  private canStillSend(computeTargetId: string): boolean {
    return (
      this.options.isReady() &&
      this.options.getComputeTargetId() === computeTargetId
    );
  }

  private async recoverDeadLetters(
    source: AgentComponentInvocationSyncSource,
    sourceKey: string,
    nowIso: string
  ): Promise<void> {
    const recovery = await source.recoverInvocationSyncDeadLetters(
      sourceKey,
      nowIso,
      READY_PART_LIMIT
    );
    const previousCappedParts =
      this.lastRecoveryCapReport?.sourceKey === sourceKey
        ? this.lastRecoveryCapReport.cappedParts
        : 0;
    const cappedPartsChanged = recovery.cappedParts !== previousCappedParts;
    this.lastRecoveryCapReport = {
      sourceKey,
      cappedParts: recovery.cappedParts,
    };
    if (
      recovery.recoveredParts > 0 ||
      recovery.quarantinedParts > 0 ||
      cappedPartsChanged
    ) {
      this.options.log?.(
        `invocation dead-letter recovery pass: sourceKey=${sourceKey} recovered=${recovery.recoveredParts} capped=${recovery.cappedParts} quarantined=${recovery.quarantinedParts}`
      );
    }
  }

  private async syncPart(
    source: AgentComponentInvocationSyncSource,
    sourceKey: string,
    computeTargetId: string,
    entry: AgentComponentInvocationSyncOutboxEntry
  ): Promise<boolean> {
    const { part } = entry;
    const result: AgentComponentInvocationSyncClientResult = await this.options
      .sendPart(part, computeTargetId)
      .catch((error: unknown) => ({
        kind: "retry" as const,
        error: error instanceof Error ? error.message : String(error),
      }));
    if (result.kind === "unavailable") {
      await this.recordEnvironmentalRetry(
        source,
        sourceKey,
        entry,
        "protocol_unavailable",
        result.retryAfterMs
      );
      return false;
    }
    if (result.kind === "retry") {
      await this.recordEnvironmentalRetry(
        source,
        sourceKey,
        entry,
        result.error,
        result.retryAfterMs
      );
      return false;
    }
    if (!ackMatchesPart(result.ack, part)) {
      await this.recordEnvironmentalRetry(
        source,
        sourceKey,
        entry,
        INVOCATION_ACK_MISMATCH_REASON
      );
      return false;
    }
    if (!result.ack.accepted) {
      await this.handleRejectedAck(source, sourceKey, entry, result.ack.reason);
      return result.ack.reason === InvocationRejectReason.SessionMissing;
    }
    await source.clearAcknowledgedInvocationSyncPart(sourceKey, result.ack);
    return false;
  }

  private async handleRejectedAck(
    source: AgentComponentInvocationSyncSource,
    sourceKey: string,
    entry: AgentComponentInvocationSyncOutboxEntry,
    reason: AgentComponentInvocationSyncRejectReason
  ): Promise<void> {
    if (isInvocationEnvironmentalRejectionReason(reason)) {
      await this.recordEnvironmentalRetry(source, sourceKey, entry, reason);
      return;
    }
    // PLN-1562: the shared retry-vs-dead-letter fork. Only a PERMANENT
    // rejection (one the server attributes to this part's own content) may
    // exhaust the permanent budget; row-local transient races keep the ordinary
    // attempt ladder but cannot pre-spend that permanent counter.
    const nowMs = this.now().getTime();
    const budget = rejectionBudgetForRow({
      reason,
      createdAt: entry.createdAt,
      nowMs,
    });
    const attemptCount = budget.permanent
      ? entry.permanentAttemptCount
      : entry.attemptCount;
    const decision = decideOutboxFailure({
      attemptCount,
      maxAttempts: budget.maxAttempts,
      permanent: budget.permanent,
      nowMs,
      baseMs: RETRY_BASE_MS,
      maxMs: RETRY_MAX_MS,
    });
    if (decision.outcome === OutboxFailureOutcome.DeadLetter) {
      await this.quarantinePart({
        source,
        sourceKey,
        part: entry.part,
        attemptCount: entry.attemptCount,
        permanentAttemptCount: budget.permanent
          ? decision.attemptCount
          : entry.permanentAttemptCount,
        ackReason: reason,
        terminalCause: terminalCauseForRejection({
          ackReason: reason,
          horizon: budget.sessionMissingHorizon,
        }),
        corruptDurabilityField:
          budget.sessionMissingHorizon ===
          SessionMissingRetryHorizon.InvalidTimestamp
            ? "created_at"
            : null,
      });
      return;
    }
    await source.recordInvocationSyncRetry(sourceKey, entry.part, {
      attemptCount: budget.permanent
        ? entry.attemptCount
        : decision.attemptCount,
      permanentAttemptCount: budget.permanent
        ? decision.attemptCount
        : entry.permanentAttemptCount,
      nextAttemptAt: new Date(decision.nextAttemptAtMs).toISOString(),
      error: reason,
      laneStalledSince: null,
    });
  }

  /**
   * Park a part the lane has given up on, and NAME the abandonment.
   *
   * Extracted from `syncPart` (ISS-6209) so that method stays a flat sequence of
   * guard clauses: the dead-letter branch had grown a nested reporting block and
   * pushed `syncPart` past the repo's cognitive-complexity budget.
   *
   * `last_error` records the lane's own CAUSE, not the ack reason, when the row was
   * quarantined for unreadable durable bookkeeping such as `created_at` or
   * `lane_stalled_since` - an operator reading the row needs to know the local
   * store is corrupt, which `session_missing` does not say.
   */
  private async quarantinePart(input: {
    source: AgentComponentInvocationSyncSource;
    sourceKey: string;
    part: AgentComponentInvocationSyncPart;
    attemptCount: number;
    permanentAttemptCount: number;
    ackReason: string;
    terminalCause: string;
    corruptDurabilityField: "created_at" | "lane_stalled_since" | null;
  }): Promise<void> {
    const { part, sourceKey } = input;
    const deadLettered = await input.source.deadLetterInvocationSyncPart(
      sourceKey,
      part,
      {
        attemptCount: input.attemptCount,
        permanentAttemptCount: input.permanentAttemptCount,
        error: input.terminalCause,
      }
    );
    if (!deadLettered) {
      return;
    }
    this.deadLetteredParts += 1;
    // ISS-5855: `sourceKey` completes the row's PRIMARY KEY here
    // (`sourceKey, externalSessionId, externalGenerationId, partIndex`). Without
    // it the line named a part but not the row, so an operator holding this log
    // could not select the abandoned row. The cloud's ack reason and the lane's
    // own terminal cause are both printed because for `session_missing` they
    // differ, and the second is the one the store-integrity probe selects on.
    const recoveryState = isInvocationDeadLetterRecoveryCause(
      input.terminalCause
    )
      ? "eligible for in-place recovery after the durable dead-letter backoff"
      : "not eligible for in-place recovery";
    this.options.log?.(
      `invocation part dead-lettered: sourceKey=${sourceKey} session=${part.externalSessionId} generation=${part.externalGenerationId} part=${part.partIndex + 1}/${part.partCount} reason=${input.ackReason} cause=${input.terminalCause}; ${recoveryState} (dead-lettered parts this run: ${this.deadLetteredParts})`
    );
    // ISS-6209: the bad-data event, named separately from the abandonment above
    // because they are different facts and only this one says the STORE is wrong.
    // Carries the row/session context the monitored `store.integrity.*` event
    // deliberately cannot: that event is content-free by construction (see
    // `StoreIntegrityIssue`), so the alert fires from the integrity probe scanning
    // this same table (`invocation-sync-outbox-integrity.ts`) while the actionable
    // detail — WHICH row — stays in the main-process log. Main process only; the
    // client-logging ban does not reach here.
    if (input.corruptDurabilityField) {
      this.options.log?.(
        `invocation outbox row quarantined for an unreadable ${input.corruptDurabilityField}: session=${part.externalSessionId} generation=${part.externalGenerationId} part=${part.partIndex + 1}/${part.partCount} sourceKey=${sourceKey}; durable retry bookkeeping could not be evaluated honestly, so it was terminalized rather than overwritten. Reported to the monitored store-integrity event as ${AGENT_COMPONENT_INVOCATION_SYNC_OUTBOX_TABLE}.`
      );
    }
  }

  private async recordEnvironmentalRetry(
    source: AgentComponentInvocationSyncSource,
    sourceKey: string,
    entry: AgentComponentInvocationSyncOutboxEntry,
    error: string,
    retryAfterMs?: number
  ): Promise<void> {
    const nowMs = this.now().getTime();
    const stallOrigin = readLaneStallOrigin(entry.laneStalledSince);
    if (stallOrigin.kind === "invalid") {
      await this.quarantinePart({
        source,
        sourceKey,
        part: entry.part,
        attemptCount: entry.attemptCount,
        permanentAttemptCount: entry.permanentAttemptCount,
        ackReason: error,
        terminalCause:
          AgentComponentInvocationSyncLocalError.InvalidPersistedDurabilityState,
        corruptDurabilityField: "lane_stalled_since",
      });
      return;
    }
    const window = laneStallWindow({
      stalledSinceMs: stallOrigin.stalledSinceMs,
      nowMs,
    });
    if (window.expired) {
      await this.quarantinePart({
        source,
        sourceKey,
        part: entry.part,
        attemptCount: entry.attemptCount,
        permanentAttemptCount: entry.permanentAttemptCount,
        ackReason: error,
        terminalCause:
          AgentComponentInvocationSyncLocalError.EnvironmentalStallExhausted,
        corruptDurabilityField: null,
      });
      return;
    }
    const delayMs = laneStallDelayMs({
      stalledSinceMs: window.startedAtMs,
      nowMs,
      retryAfterMs,
    });
    await source.recordInvocationSyncRetry(sourceKey, entry.part, {
      attemptCount: entry.attemptCount,
      permanentAttemptCount: entry.permanentAttemptCount,
      nextAttemptAt: new Date(nowMs + delayMs).toISOString(),
      error,
      laneStalledSince: new Date(window.startedAtMs).toISOString(),
    });
  }

  private schedule(): void {
    if (!(this.started && this.options.isReady())) {
      return;
    }
    this.timer = setTimeout(() => this.refresh(), SYNC_INTERVAL_MS);
    // ISS-4758: same contract as the session lane's poll — `stop()` still
    // clears this, but the tick must not hold the event loop open, so a caller
    // that never reaches `stop()` cannot wedge the process. Electron keeps the
    // main process alive, so the poll still fires normally in production.
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
  private async reportMissingParents(
    missingParents: AgentComponentInvocationSyncOutboxEntry[],
    computeTargetId: string,
    source: AgentComponentInvocationSyncSource
  ): Promise<void> {
    if (missingParents.length > 0 && this.canStillSend(computeTargetId)) {
      try {
        await this.options.onSessionMissingParts?.(
          missingParents,
          computeTargetId,
          source,
          () => this.canStillSend(computeTargetId)
        );
      } catch {
        this.options.log?.(
          "missing-parent diagnostic reporting failed; sync retry state was already recorded"
        );
      }
    }
  }
}

/**
 * Narrow a broad {@link AgentSessionSyncSource} (whose invocation-sync methods
 * are OPTIONAL — a db host that predates the invocation outbox exposes none of
 * them) to the REQUIRED-shape {@link AgentComponentInvocationSyncSource} this
 * service consumes. Returns null when any method is missing, so the service ticks
 * as a no-op instead of crashing on a partial source. Lifted out of `app.ts` so
 * the mapping lives beside the interface it produces.
 */
export function resolveAgentComponentInvocationSyncSource(
  source: AgentSessionSyncSource | null
): AgentComponentInvocationSyncSource | null {
  if (
    !(
      source?.prepareInvocationSyncTarget &&
      source.loadReadyInvocationSyncParts &&
      source.recoverInvocationSyncDeadLetters &&
      source.recordInvocationSyncRetry &&
      source.clearAcknowledgedInvocationSyncPart &&
      source.deadLetterInvocationSyncPart
    )
  ) {
    return null;
  }
  return {
    ...(source.loadInvocationSyncParents
      ? {
          loadInvocationSyncParents: (
            sourceKey: string,
            sessionIds: string[]
          ) =>
            source.loadInvocationSyncParents?.(sourceKey, sessionIds) ??
            Promise.resolve([]),
        }
      : {}),
    prepareInvocationSyncTarget: (
      sourceKey,
      templateSourceKey,
      sessionLimit,
      identity
    ) =>
      source.prepareInvocationSyncTarget?.(
        sourceKey,
        templateSourceKey,
        sessionLimit,
        identity
      ) ?? Promise.resolve(),
    loadReadyInvocationSyncParts: (sourceKey, now, limit) =>
      source.loadReadyInvocationSyncParts?.(sourceKey, now, limit) ??
      Promise.resolve([]),
    recoverInvocationSyncDeadLetters: (sourceKey, now, limit) =>
      source.recoverInvocationSyncDeadLetters?.(sourceKey, now, limit) ??
      Promise.resolve({
        recoveredParts: 0,
        cappedParts: 0,
        quarantinedParts: 0,
      }),
    recordInvocationSyncRetry: (sourceKey, part, retry) =>
      source.recordInvocationSyncRetry?.(sourceKey, part, retry) ??
      Promise.resolve(),
    clearAcknowledgedInvocationSyncPart: (sourceKey, ack) =>
      source.clearAcknowledgedInvocationSyncPart?.(sourceKey, ack) ??
      Promise.resolve(false),
    deadLetterInvocationSyncPart: (sourceKey, part, deadLetter) =>
      source.deadLetterInvocationSyncPart?.(sourceKey, part, deadLetter) ??
      Promise.resolve(false),
  };
}
