/**
 * @file agent-session-sync-dispositions.ts
 * @description The four ways the session-sync lane can retire a candidate id
 * BEFORE any batch is sent: it is confirmed gone from the local store, it is
 * still present but unreadable, it is idle (not yet substantive), or it is
 * locally oversized.
 *
 * They share one shape — clear failure state, mark/dequeue, log with the queue
 * counters, emit the batch telemetry, persist the watermark if that drained the
 * queues, self-continue the drain — so they share one collaborator
 * ({@link SessionDispositionDeps}) and one module. Hoisted out of
 * `agent-session-sync-service.ts` (a shrink-only grandfathered hotspot — root
 * AGENTS.md) by ISS-6031, which needed to add a fifth path to the cluster.
 *
 * Pure over the injected collaborator: the service keeps ownership of its
 * counters, queues, outbox and telemetry sink, so these stay trivially testable
 * and cannot reach anything beyond dead-lettering, dequeuing and backoff.
 */

import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import type { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  type DesktopSyncBatchEventInput,
  DesktopSyncBatchOutcome,
} from "../telemetry/app-otel-runtime.js";
import { SESSION_PAYLOAD_BYTE_CAP } from "./agent-session-sync-backoff-policy.js";
import { formatBytes } from "./agent-session-sync-service-helpers.js";

/**
 * The service state each disposition drives. Deliberately narrow, and built once
 * by the service for all of them so no two paths can drift onto different
 * queue/telemetry/persistence wiring.
 */
export type SessionDispositionDeps = {
  /** Per-session retry deadlines, keyed by id (the no-budget-burn defer). */
  nextRetryAfterMs: Map<string, number>;
  clearFailureStateForId: (id: string) => void;
  markDeadLettered: (id: string, recoverable: boolean, reason: string) => void;
  dequeue: (syncMode: AgentSessionSyncMode, ids: string[]) => void;
  /** Snapshot the queue/dead-letter sizes for the log lines. */
  queueSizes: () => {
    incremental: number;
    backfill: number;
    deadLettered: number;
  };
  logWarn: (message: string) => void;
  logInfo: (message: string) => void;
  /** One `dead_letter` batch event; no `latencyMs` — nothing was ever sent. */
  emitDeadLetterTelemetry: (input: DesktopSyncBatchEventInput) => void;
  /** No-op unless this drained BOTH queues (the acked-contiguous rule). */
  persistCursorIfCaughtUp: () => void;
  scheduleImmediateDrainIfReadyWorkRemains: () => void;
  /** Already on a queue, or set aside as a dead-letter — i.e. not stranded. */
  isTracked: (id: string) => boolean;
  /** Feed ids onto the backfill lane; returns how many were newly queued. */
  feedIntoBackfillQueue: (ids: string[]) => number;
  /** New durable work to drain preempts the dead-letter revisit. */
  onDurableWorkQueued: () => void;
  /**
   * ISS-6031 (codex review): is the pass that started this work still the
   * current one? Carries the pass token AND the source-state generation, so a
   * `stop()` or `resetSourceState()` invalidates it synchronously. Every
   * continuation that survives an `await` must re-check this — together with
   * {@link readSourceKey} — before writing anything back through these deps.
   */
  isCurrentSourceState: () => boolean;
  /**
   * The LIVE hydrated identity. Compared against the value captured before an
   * await, because `hydratePersistedCursorIfNeeded` swaps identity WITHOUT
   * bumping the generation — so the generation alone would let an account
   * switch through, and the previous target's ids would upload under the new
   * account.
   */
  readSourceKey: () => string | null;
};

/** `remaining incremental=… backfill=… deadLettered=…`, one spelling. */
function remainingSuffix(deps: SessionDispositionDeps): string {
  const sizes = deps.queueSizes();
  return `remaining incremental=${sizes.incremental} backfill=${sizes.backfill} deadLettered=${sizes.deadLettered}`;
}

/**
 * ISS-6031: hold ids whose absence was NOT proven. They keep their queue slot
 * and their budgets, are deferred behind `backoffMs`, and the warning states
 * what was OBSERVED rather than naming a cause — the line it replaced asserted a
 * local deletion that had never happened and cost an investigation.
 */
export function retainUnprovenCandidates(
  config: { ids: string[]; observation: string; backoffMs: number },
  deps: SessionDispositionDeps
): void {
  if (config.ids.length === 0) {
    return;
  }
  const retryDeadline = Date.now() + config.backoffMs;
  for (const id of config.ids) {
    deps.nextRetryAfterMs.set(id, retryDeadline);
  }
  deps.logWarn(
    `withheld ${config.ids.length} agent session(s) from disposal — ${config.observation}; ` +
      `they stay queued and will be retried; ids: ${config.ids.join(", ")}; ` +
      remainingSuffix(deps)
  );
  // Other queued rows may still be ready; the rescheduler only fires on a READY
  // neighbor, so a deferred id here cannot spin the pump on itself.
  deps.scheduleImmediateDrainIfReadyWorkRemains();
}

/**
 * FEA-3473 (E1, AC-2): record candidate ids as dead-lettered instead of silently
 * dropping them. The old code silently `dequeue`d them and returned WITHOUT
 * recording anything or persisting: a straggler left no durable trace, and if it
 * was the last queued row the cursor never advanced this tick, forcing a full
 * re-walk on every cold start of a long-running desktop. A row with no `sessions`
 * entry would just re-fail hydration, so it is NOT live-recoverable (infinite
 * deadline); it is durably marked `dead_lettered` in the outbox with reason
 * `unhydratable`, dequeued, and — if that drained both queues — persisted.
 *
 * ISS-6031 narrowed the entry condition: reached ONLY for ids a presence probe
 * PROVED are gone from `sessions`, never on an empty read alone. The outbox /
 * telemetry reason string stays `unhydratable` — dashboards and the cross-repo
 * SLO monitor key on it, so it is a contract, not a label.
 */
export function dropAbsentCandidates(
  config: {
    syncMode: AgentSessionSyncMode;
    ids: string[];
    observation: string;
  },
  deps: SessionDispositionDeps
): void {
  if (config.ids.length === 0) {
    return;
  }
  for (const id of config.ids) {
    deps.clearFailureStateForId(id);
    deps.markDeadLettered(id, false, SyncReason.Unhydratable);
  }
  deps.dequeue(config.syncMode, config.ids);
  deps.logWarn(
    `dropped ${config.ids.length} agent session(s) with no row in the local store — ${config.observation}; ` +
      `ids: ${config.ids.join(", ")}; ${remainingSuffix(deps)}`
  );
  // FEA-3426: an unhydratable drop is a real `dead_letter`, but until that ticket
  // it emitted NO sync.* telemetry — so the SLO monitor never counted it. ONE
  // event for the drop operation, matching the per-batch semantics of every other
  // site. `payloadBytes: 0` — no batch was ever built.
  deps.emitDeadLetterTelemetry({
    outcome: DesktopSyncBatchOutcome.DeadLetter,
    payloadBytes: 0,
    reason: SyncReason.Unhydratable,
  });
  deps.persistCursorIfCaughtUp();
  // FEA-4375: dropping absent rows is forward progress — self-continue.
  deps.scheduleImmediateDrainIfReadyWorkRemains();
}

/**
 * FEA-3287: dequeue idle ("phantom") sessions withheld from cloud sync this
 * pass, WITHOUT dead-lettering them. Unlike absent/oversized rows (which are
 * permanently dead-lettered), an idle session is only *not yet* substantive: the
 * moment it gains a real turn/token/tool-use the live hook bumps
 * `sessions.updated_at`, re-enqueuing it via `enqueueIncrementalUpdates`. So it
 * must NOT enter `deadLetteredIds` (that would suppress the later, legitimate
 * sync) — a plain dequeue is exactly right. Clears any transient failure state
 * and persists the advanced watermark if this drained both queues.
 */
export function dropIdleCandidates(
  config: { syncMode: AgentSessionSyncMode; ids: string[] },
  deps: SessionDispositionDeps
): void {
  if (config.ids.length === 0) {
    return;
  }
  for (const id of config.ids) {
    deps.clearFailureStateForId(id);
  }
  deps.dequeue(config.syncMode, config.ids);
  const sizes = deps.queueSizes();
  deps.logInfo(
    `deferred ${config.ids.length} idle (0-turn/0-token/no-tool) agent session(s) from cloud sync — ` +
      "will re-sync once substantive activity bumps updated_at; " +
      `remaining incremental=${sizes.incremental} backfill=${sizes.backfill}`
  );
  // A deferred-idle drop can drain the last/only queued row before any batch is
  // sent, so persist the advanced watermark here rather than full-re-walking on
  // the next restart (no-op unless both queues are now empty).
  deps.persistCursorIfCaughtUp();
  // FEA-4375: skipping idle rows is forward progress — self-continue so an
  // idle-dominated corpus does not throttle to one batch per 5s poll.
  deps.scheduleImmediateDrainIfReadyWorkRemains();
}

/**
 * FEA-1995 / FEA-3363: a payload that cannot fit the byte cap even after
 * chunking. Not live-recoverable — re-enqueueing would just re-detect and
 * re-dead-letter it — so it is retried only by a cold-restart re-backfill, in
 * case a future build raised the cap.
 */
export function deadLetterOversizedLocalSession(
  config: {
    syncMode: AgentSessionSyncMode;
    sessionId: string;
    payloadBytes: number;
  },
  deps: SessionDispositionDeps
): void {
  deps.clearFailureStateForId(config.sessionId);
  deps.markDeadLettered(config.sessionId, false, SyncReason.LocallyOversized);
  deps.dequeue(config.syncMode, [config.sessionId]);
  deps.logWarn(
    "dead-lettered 1 locally oversized agent session before cloud sync " +
      `(payload ~${formatBytes(config.payloadBytes)} exceeds ${formatBytes(SESSION_PAYLOAD_BYTE_CAP)} after chunking); ` +
      `ids: ${config.sessionId}; ${remainingSuffix(deps)}`
  );
  // FEA-1995: the >256 KiB permanent-stall wedge the PRD-482 dashboard exists to
  // surface. No `latencyMs` — the session is dropped before any send.
  deps.emitDeadLetterTelemetry({
    outcome: DesktopSyncBatchOutcome.DeadLetter,
    payloadBytes: config.payloadBytes,
    reason: SyncReason.LocallyOversized,
  });
  // This can drain the last/only queued row before any batch is sent
  // (`selectHydratableCandidateIds` / the payload loop return an empty batch, so
  // `syncOnce` exits before `handleBatchAck`), so mirror the server-ack persist
  // instead of full-re-walking on every restart.
  deps.persistCursorIfCaughtUp();
  // FEA-4375: an all-oversized batch dead-letters every candidate, so
  // `selectHydratableCandidateIds` returns [] and `syncSessionsOnce` exits before
  // the success-only reschedule; self-continue here so consecutive oversized-only
  // batches do not advance just three rows per 5s poll (codex / wongk review).
  deps.scheduleImmediateDrainIfReadyWorkRemains();
}

/**
 * ISS-6031 (selection totality): re-queue every `pending` outbox id neither
 * queue is tracking, and say so.
 *
 * The outbox is the record of what is still owed to the cloud, but it was only
 * ever re-read into the queues on RESUME. Any path that dropped an id from the
 * queues without resolving its row therefore stranded it until the next process
 * start: `pending`, `attempt_count = 0`, `next_attempt_at` and `last_error`
 * NULL, and the pump never looked at it again. Measured live — one row sat that
 * way for 11+ minutes with the backlog pinned at depth 1, emitting nothing. A
 * hang is worse than a failure precisely because it produces no signal.
 *
 * Folding the outbox back in closes the hole for EVERY such path, present and
 * future, rather than auditing each dequeue site one at a time — worth doing
 * because the failure it prevents is silent. A row re-stranded on a later pass is
 * simply re-queued again: the loop is bounded by the poll interval and by the
 * logger's consecutive-duplicate suppression, and a repeating reconcile is
 * exactly the signal that some dequeue path is still losing rows.
 */
export function requeueUntrackedOutboxIds(
  pendingIds: readonly string[],
  deps: SessionDispositionDeps
): void {
  const untracked = pendingIds.filter((id) => !deps.isTracked(id));
  if (untracked.length === 0 || deps.feedIntoBackfillQueue(untracked) === 0) {
    return;
  }
  deps.onDurableWorkQueued();
  deps.logWarn(
    `reconciled ${untracked.length} pending outbox row(s) that neither queue was tracking back onto the backfill lane — ` +
      "they were owed to the cloud and nothing was going to select them; " +
      `ids: ${untracked.join(", ")}`
  );
  deps.scheduleImmediateDrainIfReadyWorkRemains();
}

/**
 * ISS-6031: one idle-tick reconciliation pass. A read failure is reported and
 * dropped — the next idle tick tries again, and a probe that cannot answer must
 * never be mistaken for "nothing is owed".
 *
 * codex review: the read is fire-and-forget from the caller's point of view, so
 * `stop()`, an account switch, or a compute-target change can complete while it
 * is outstanding. Its ids were selected for the PREVIOUS source key, and
 * `requeueUntrackedOutboxIds` writes through the LIVE deps — so without
 * `isCurrentSourceState` a superseded read would push the old target's sessions
 * onto the new target's backfill lane, and they would upload under the wrong
 * account. Discarding is always safe here: reconciliation is idempotent and the
 * next idle tick re-reads under the current identity.
 */
export async function reconcilePendingOutbox(
  loadPendingIds: () => string[] | Promise<string[]>,
  isCurrentSourceState: () => boolean,
  deps: SessionDispositionDeps
): Promise<void> {
  try {
    const pendingIds = await loadPendingIds();
    if (!isCurrentSourceState()) {
      return;
    }
    requeueUntrackedOutboxIds(pendingIds, deps);
  } catch (error) {
    deps.logWarn(
      `pending-outbox reconciliation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * The service state the idle-tick reconciliation gate reads. Passed in rather
 * than reached for, so the gate — like every other path in this module — is
 * pure over its collaborator and testable without a service.
 */
export type OutboxReconcileGate = {
  /** Historical backfill is on; the reconciliation is part of that lane. */
  enabled: boolean;
  /** The identity the ids will be read under; `null` means not hydrated yet. */
  sourceKey: string | null;
  hasPendingChunks: boolean;
  /** Single-flight: one outstanding read at a time. */
  inFlight: boolean;
  setInFlight: (value: boolean) => void;
  /** False when the source predates the delegate (legacy/fake sources). */
  hasProbe: boolean;
  /**
   * Invoked as a MEMBER call by the caller's closure, never through a detached
   * reference: in the db-host build the source is the FEA-2038 forwarding Proxy,
   * whose `get` trap answers `call`/`apply`/`bind` with `undefined`.
   */
  loadPendingIds: (sourceKey: string) => string[] | Promise<string[]>;
};

/**
 * ISS-6031: run one reconciliation pass, but only from the IDLE state — both
 * queues drained and no chunk in flight. Cheap and self-limiting: one indexed
 * read, and `requeueUntrackedOutboxIds` skips anything already tracked.
 *
 * Hoisted out of `agent-session-sync-service.ts` with the rest of this cluster
 * (that file is a shrink-only grandfathered hotspot — root AGENTS.md).
 *
 * The guard handed to {@link reconcilePendingOutbox} is the pass guard AND the
 * captured target: the generation alone would let an account switch through,
 * because `hydratePersistedCursorIfNeeded` swaps identity without bumping it.
 */
export async function reconcilePendingOutboxIfIdle(
  gate: OutboxReconcileGate,
  deps: SessionDispositionDeps
): Promise<void> {
  // Everything up to the first `await` runs synchronously, so the idle test and
  // the single-flight claim below are as atomic as the caller's own tick.
  const sizes = deps.queueSizes();
  const sourceKey = gate.sourceKey;
  if (
    !(gate.enabled && sourceKey && gate.hasProbe) ||
    gate.inFlight ||
    gate.hasPendingChunks ||
    sizes.incremental > 0 ||
    sizes.backfill > 0
  ) {
    return;
  }
  gate.setInFlight(true);
  try {
    await reconcilePendingOutbox(
      () => gate.loadPendingIds(sourceKey),
      () => deps.isCurrentSourceState() && deps.readSourceKey() === sourceKey,
      deps
    );
  } finally {
    gate.setInFlight(false);
  }
}
