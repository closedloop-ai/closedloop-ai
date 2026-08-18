import type {
  AgentComponentInvocationSyncAck,
  AgentComponentInvocationSyncPart,
} from "@repo/api/src/types/agent-component-invocation";
import type { AgentComponentInvocationSyncClientResult } from "../dashboard/desktop-agent-component-invocations-client.js";
import {
  decideOutboxFailure,
  OutboxFailureOutcome,
} from "../sync/durable-outbox.js";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  buildAgentComponentInvocationSyncSourceKey,
} from "./agent-component-invocation-sync-constants.js";
import type { AgentSessionSyncSource } from "./agent-session-sync-source.js";
import {
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  rejectionBudgetForRow,
  retryDelayMs,
} from "./invocation-sync-rejection-policy.js";

const SYNC_INTERVAL_MS = 5000;
const READY_PART_LIMIT = 10;
const PROTOCOL_UNAVAILABLE_RETRY_MS = 5 * 60_000;
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
  prepareInvocationSyncTarget(
    sourceKey: string,
    templateSourceKey: string,
    sessionLimit: number
  ): Promise<void>;
  loadReadyInvocationSyncParts(
    sourceKey: string,
    now: string,
    limit: number
  ): Promise<AgentComponentInvocationSyncOutboxEntry[]>;
  recordInvocationSyncRetry(
    sourceKey: string,
    part: AgentComponentInvocationSyncPart,
    attemptCount: number,
    nextAttemptAt: string,
    error: string
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
    attemptCount: number,
    error: string
  ): Promise<boolean>;
};

export type AgentComponentInvocationSyncOutboxEntry = {
  part: AgentComponentInvocationSyncPart;
  attemptCount: number;
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
  sendPart: (
    part: AgentComponentInvocationSyncPart,
    computeTargetId: string
  ) => Promise<AgentComponentInvocationSyncClientResult>;
  waitForBackgroundSlot?: () => Promise<void>;
  now?: () => Date;
  /**
   * ISS-4710 diagnostic sink. Emits a one-line note when this tick DEFERS the
   * heavy `prepareInvocationSyncTarget` `$transaction` because ready parts are
   * already materialized — observability for the "writer busy during a rebuild,
   * component lane still draining" condition. Optional; defaults to a no-op.
   */
  log?: (message: string) => void;
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
    // ISS-5347 (wongk review): the counter and its log line both say "this run",
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
      .catch(() => {
        // The exact outbox row remains pending; the next scheduled tick retries.
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
      // ISS-4623 (wongk review): the readiness gate (which ANDs the fail-closed
      // org-sync-policy gate) and the compute target were sampled once at entry,
      // BEFORE the async prep below. A policy true→false transition or an account
      // switch can land during `waitForBackgroundSlot` / prep, so re-verify the
      // LIVE gate and that the target is unchanged before touching the outbox or
      // sending — otherwise a just-closed gate would still POST data, and a
      // switched account would send under the previous account's target.
      if (!this.canStillSend(computeTargetId)) {
        return;
      }
      const now = this.now();
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
          PREPARE_SESSION_LIMIT
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
        // ISS-4710 (@wongk): ready parts already materialized, so skip re-running
        // the prepare `$transaction` this tick and drain them. Ready parts do NOT
        // imply the writer is contended — this is the normal backlog-drain path
        // too — so the message states only what we observed (parts present), not
        // an unmeasured writer-busy claim.
        this.options.log?.(
          "component prepare skipped this tick: ready parts already materialized"
        );
      }
      for (const entry of entries) {
        // Re-check immediately before EVERY send: an earlier `sendPart` in this
        // same drain awaits the network, during which the gate can close or the
        // target can switch. Stop the run rather than send the next part.
        if (!this.canStillSend(computeTargetId)) {
          return;
        }
        await this.syncPart(source, sourceKey, computeTargetId, entry);
      }
    } finally {
      this.syncing = false;
    }
  }

  /**
   * ISS-4623 (wongk review): is it still safe to send for `computeTargetId`?
   * True only when the LIVE readiness gate (org-sync-policy + tier + transport)
   * still says yes AND the live compute target is unchanged from the one this
   * drain was scoped to. Sampled fresh on every call so a gate-close or account
   * switch that lands mid-drain halts egress before the next send.
   */
  private canStillSend(computeTargetId: string): boolean {
    return (
      this.options.isReady() &&
      this.options.getComputeTargetId() === computeTargetId
    );
  }

  private async syncPart(
    source: AgentComponentInvocationSyncSource,
    sourceKey: string,
    computeTargetId: string,
    entry: AgentComponentInvocationSyncOutboxEntry
  ): Promise<void> {
    const { part } = entry;
    const result = await this.options
      .sendPart(part, computeTargetId)
      .catch((error: unknown) => ({
        kind: "retry" as const,
        error: error instanceof Error ? error.message : String(error),
      }));
    if (result.kind === "unavailable") {
      await this.recordRetry(
        source,
        sourceKey,
        entry,
        PROTOCOL_UNAVAILABLE_RETRY_MS,
        "protocol_unavailable"
      );
      return;
    }
    if (result.kind === "retry") {
      await this.recordRetry(
        source,
        sourceKey,
        entry,
        retryDelayMs(entry.attemptCount),
        result.error
      );
      return;
    }
    if (!ackMatchesPart(result.ack, part)) {
      await this.recordRetry(
        source,
        sourceKey,
        entry,
        retryDelayMs(entry.attemptCount),
        "ack_mismatch"
      );
      return;
    }
    if (!result.ack.accepted) {
      // PLN-1562: the shared retry-vs-dead-letter fork. Only a PERMANENT
      // rejection (one the server attributes to this part's own content) may
      // exhaust the budget — a transient reason retries on the shared ladder with
      // its budget intact, so a server-side blip cannot dead-letter healthy parts.
      // ISS-5789 (codex P1 / @wongk review): the budget is resolved against the
      // ROW, not the reason alone. `session_missing` stays transient — deferring
      // on the shared ladder with the budget untouched — until the part outlives
      // its horizon, so a lane-wide outage can no longer pre-spend a
      // row-attributable budget through the shared `attempt_count` column
      // (invariant 4).
      const nowMs = this.now().getTime();
      const budget = rejectionBudgetForRow({
        reason: result.ack.reason,
        createdAt: entry.createdAt,
        nowMs,
      });
      const decision = decideOutboxFailure({
        attemptCount: entry.attemptCount,
        maxAttempts: budget.maxAttempts,
        permanent: budget.permanent,
        nowMs,
        baseMs: RETRY_BASE_MS,
        maxMs: RETRY_MAX_MS,
      });
      if (decision.outcome === OutboxFailureOutcome.DeadLetter) {
        const deadLettered = await source.deadLetterInvocationSyncPart(
          sourceKey,
          part,
          decision.attemptCount,
          result.ack.reason
        );
        // ISS-5347: this lane has no dead-letter RECOVERY path (see
        // `main/sync/AGENTS.md` invariant 3's known exception), so a part parked
        // here never arrives until a newer generation for the session supersedes
        // it. Until that gap is closed, the part must at least NAME itself —
        // previously the write's own result was discarded and the abandonment was
        // completely silent, which is why a stranded part 6-of-7 sat undetected.
        // The count increments only inside the branch where the write actually
        // took effect, so it never over-reports.
        if (deadLettered) {
          this.deadLetteredParts += 1;
          this.options.log?.(
            `invocation part dead-lettered and NOT recoverable by this lane: session=${part.externalSessionId} generation=${part.externalGenerationId} part=${part.partIndex + 1}/${part.partCount} reason=${result.ack.reason}; that session's invocation data stays incomplete in the cloud until a newer generation supersedes it (dead-lettered parts this run: ${this.deadLetteredParts})`
          );
        }
        return;
      }
      await source.recordInvocationSyncRetry(
        sourceKey,
        part,
        decision.attemptCount,
        new Date(decision.nextAttemptAtMs).toISOString(),
        result.ack.reason
      );
      return;
    }
    await source.clearAcknowledgedInvocationSyncPart(sourceKey, result.ack);
  }

  private async recordRetry(
    source: AgentComponentInvocationSyncSource,
    sourceKey: string,
    entry: AgentComponentInvocationSyncOutboxEntry,
    delayMs: number,
    error: string
  ): Promise<void> {
    const attemptCount = entry.attemptCount + 1;
    await source.recordInvocationSyncRetry(
      sourceKey,
      entry.part,
      attemptCount,
      new Date(this.now().getTime() + delayMs).toISOString(),
      error
    );
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
}

function ackMatchesPart(
  ack: AgentComponentInvocationSyncAck,
  part: AgentComponentInvocationSyncPart
): boolean {
  return (
    ack.externalGenerationId === part.externalGenerationId &&
    ack.partIndex === part.partIndex &&
    ack.partHash === part.partHash
  );
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
      source.recordInvocationSyncRetry &&
      source.clearAcknowledgedInvocationSyncPart &&
      source.deadLetterInvocationSyncPart
    )
  ) {
    return null;
  }
  return {
    prepareInvocationSyncTarget: (sourceKey, templateSourceKey, sessionLimit) =>
      source.prepareInvocationSyncTarget?.(
        sourceKey,
        templateSourceKey,
        sessionLimit
      ) ?? Promise.resolve(),
    loadReadyInvocationSyncParts: (sourceKey, now, limit) =>
      source.loadReadyInvocationSyncParts?.(sourceKey, now, limit) ??
      Promise.resolve([]),
    recordInvocationSyncRetry: (
      sourceKey,
      part,
      attemptCount,
      nextAttemptAt,
      error
    ) =>
      source.recordInvocationSyncRetry?.(
        sourceKey,
        part,
        attemptCount,
        nextAttemptAt,
        error
      ) ?? Promise.resolve(),
    clearAcknowledgedInvocationSyncPart: (sourceKey, ack) =>
      source.clearAcknowledgedInvocationSyncPart?.(sourceKey, ack) ??
      Promise.resolve(false),
    deadLetterInvocationSyncPart: (sourceKey, part, attemptCount, error) =>
      source.deadLetterInvocationSyncPart?.(
        sourceKey,
        part,
        attemptCount,
        error
      ) ?? Promise.resolve(false),
  };
}
