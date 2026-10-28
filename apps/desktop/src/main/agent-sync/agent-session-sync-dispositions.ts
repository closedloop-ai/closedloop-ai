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
 *
 * ISS-8710 added {@link applyPendingChunkDiscard}, which is a pre-send verdict
 * on a pinned chunk TAIL rather than on a candidate id, and so drives its own
 * collaborator rather than the four above. It lives here because it decides
 * what a dropped tail leaves the session owing, which is this module's subject.
 */

import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import type { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { isSealedDataRevision } from "../../shared/data-revision-contract.js";
import { errorMessage } from "../diagnostics/component-sync-diagnostics.js";
import {
  DesktopSyncBatchOutcome,
  type SessionSyncBatchEvent,
} from "../telemetry/app-otel-runtime.js";
import {
  isForeignOwnedSession,
  type SignedInUserIdentity,
} from "../util/user-identity.js";
import {
  SENTINEL_REVISION_BACKOFF_MS,
  SESSION_PAYLOAD_BYTE_CAP,
} from "./agent-session-sync-backoff-policy.js";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";
import type { PendingChunkDiscard } from "./agent-session-sync-pending-chunks.js";
import { formatBytes } from "./agent-session-sync-service-helpers.js";
import {
  applyValidationFailure,
  type ValidationFailureDeps,
} from "./agent-session-sync-validation-failure.js";
import { OutboxResumeOutcome } from "./session-outbox-engine-state.js";
import { readPendingOutboxIds } from "./sync-source-reply-boundary.js";
import { syncedSessionIsSubstantive } from "./synced-session-substantive.js";

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
  emitDeadLetterTelemetry: (input: SessionSyncBatchEvent) => void;
  /** ISS-8041: records the acked-contiguous PREFIX boundary, not only a drain. */
  persistCursorIfCaughtUp: () => void;
  scheduleImmediateDrainIfReadyWorkRemains: () => void;
  /** Already on a queue, or set aside as a dead-letter — i.e. not stranded. */
  isTracked: (id: string) => boolean;
  /** Feed ids onto the backfill lane; returns how many were newly queued. */
  feedIntoBackfillQueue: (ids: string[]) => number;
  /** New durable work to drain preempts the dead-letter revisit. */
  onDurableWorkQueued: () => void;
  /**
   * ISS-7096: fire-and-forget re-run of the outbox environment maintenance,
   * whose active-key sweep durably parks the foreign rows this pass withheld.
   */
  parkForeignOutboxRows: () => void;
  /**
   * ISS-7246: fire-and-forget durable mark for the idle rows this pass withheld,
   * so the idle-tick outbox reconciliation stops re-arming them.
   */
  markOutboxWithheld: (ids: string[]) => void;
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
  deferCandidatesBehindDeadline(
    { ids: config.ids, backoffMs: config.backoffMs },
    deps,
    () =>
      deps.logWarn(
        `withheld ${config.ids.length} agent session(s) from disposal — ${config.observation}; ` +
          `they stay queued and will be retried; ids: ${config.ids.join(", ")}; ` +
          remainingSuffix(deps)
      )
  );
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
 *
 * ISS-7246: the in-memory dequeue is not enough on its own. The durable outbox
 * row stayed `pending`, so `reconcilePendingOutboxIfIdle` re-armed the id on the
 * next idle tick and the session cycled — queued, hydrated, judged idle,
 * withheld — forever. The row is now durably marked `withheld`, which no lane
 * owes and the reconciliation cannot see; `rePendWithheldOutbox` brings it back
 * when the session gains activity.
 */
export function dropIdleCandidates(
  config: { syncMode: AgentSessionSyncMode; ids: string[] },
  deps: SessionDispositionDeps
): void {
  dropWithheldCandidates(
    config,
    deps,
    (sizes) =>
      `withheld ${config.ids.length} idle (0-turn/0-token/no-tool) agent session(s) from cloud sync — ` +
      "nothing is owed until substantive activity bumps updated_at; " +
      `remaining incremental=${sizes.incremental} backfill=${sizes.backfill}`,
    () => deps.markOutboxWithheld(config.ids)
  );
}

/**
 * FEA-3287 + ISS-7096: split one hydrated batch into uploadable and withheld.
 * Idle ("phantom") sessions — a live-hook `SessionStart` row with no real
 * turn/token/tool-use yet, judged by the FEA-3284 SSOT predicate — are
 * deferred without dead-lettering (a real event re-enqueues them via
 * `updated_at`). Foreign-owned sessions are withheld and durably parked. Both
 * dequeue by `externalSessionId` — the desktop stores the external id AS the
 * local `sessions.id`, and the queues/cursor key by it.
 *
 * ISS-7246 (cr-60883): OWNERSHIP is judged first, and the order is load-bearing.
 * Both dispositions are durable now, and they write different things: a foreign
 * row is PARKED under its owner's partition, a phantom is marked `withheld`
 * under this key. The ISS-7096 environment sweep only ever scans `pending`
 * rows, so judging idleness first would mark a foreign-owned phantom `withheld`
 * under the signed-in identity's key, where the sweep can no longer see it to
 * park it — it would sit under the wrong owner forever. Ownership is also the
 * stronger fact: whether this environment may send a session at all does not
 * depend on how substantive it is.
 */
export function withholdNonUploadableCandidates(
  config: {
    syncMode: AgentSessionSyncMode;
    sessions: SyncedAgentSession[];
    identity: SignedInUserIdentity | null;
  },
  deps: SessionDispositionDeps
): SyncedAgentSession[] {
  let retained = config.sessions;
  const identity = config.identity;
  if (identity) {
    const foreignIds: string[] = [];
    retained = retained.filter((session) => {
      if (isForeignOwnedSession(session, identity)) {
        foreignIds.push(session.externalSessionId);
        return false;
      }
      return true;
    });
    dropForeignOwnedCandidates(
      { syncMode: config.syncMode, ids: foreignIds },
      deps
    );
  }
  const idleIds: string[] = [];
  retained = retained.filter((session) => {
    if (syncedSessionIsSubstantive(session)) {
      return true;
    }
    idleIds.push(session.externalSessionId);
    return false;
  });
  dropIdleCandidates({ syncMode: config.syncMode, ids: idleIds }, deps);
  return retained;
}

/**
 * ISS-7096: dequeue sessions ANOTHER identity pair owns — a cross-tenant send
 * the server rejects. Not dead-lettered: the durable disposition is the
 * environment maintenance re-run (`parkForeignOutboxRows`), which parks the
 * rows under their owning org instead of re-resuming them every boot.
 */
export function dropForeignOwnedCandidates(
  config: { syncMode: AgentSessionSyncMode; ids: string[] },
  deps: SessionDispositionDeps
): void {
  dropWithheldCandidates(
    config,
    deps,
    (sizes) =>
      `withheld ${config.ids.length} agent session(s) owned by another account from cloud sync — ` +
      "they will sync when their own environment is active; " +
      `remaining incremental=${sizes.incremental} backfill=${sizes.backfill}`,
    () => deps.parkForeignOutboxRows()
  );
}

/**
 * cr-81036: the shared "withhold candidates without dead-lettering" shape —
 * clear transient failure state, dequeue, log, run the caller's side effect,
 * persist the advanced watermark (a drop can drain the last queued row before
 * any batch is sent — no-op unless both queues are now empty), and
 * self-continue so a withheld-dominated corpus does not throttle to one batch
 * per 5s poll (FEA-4375). The two callers differ only in their log line and in
 * the foreign path's parking side effect.
 */
function dropWithheldCandidates(
  config: { syncMode: AgentSessionSyncMode; ids: string[] },
  deps: SessionDispositionDeps,
  describe: (sizes: ReturnType<SessionDispositionDeps["queueSizes"]>) => string,
  onDequeued?: () => void
): void {
  if (config.ids.length === 0) {
    return;
  }
  for (const id of config.ids) {
    deps.clearFailureStateForId(id);
  }
  deps.dequeue(config.syncMode, config.ids);
  deps.logInfo(describe(deps.queueSizes()));
  onDequeued?.();
  deps.persistCursorIfCaughtUp();
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
  // ISS-8116 (tamsinb review): the oversize scan behind
  // `selectHydratableCandidateIds` is an AWAIT, and this is the write it
  // resolves into — a durable `dead_lettered` row plus a cursor persist, both
  // keyed to whoever is live NOW. Every other disposition in this module reads
  // the guard from the deps bag; this one took it and never read it, so an
  // identity that moved across the scan still dead-lettered the previous
  // account's session under the new key. Discarding costs nothing: the row stays
  // queued and the next pass re-detects it under its own identity.
  if (!deps.isCurrentSourceState()) {
    return;
  }
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
  // batches do not advance just three rows per 5s poll (codex / whitlockk review).
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
  loadPendingIds: () => unknown,
  isCurrentSourceState: () => boolean,
  deps: SessionDispositionDeps
): Promise<void> {
  try {
    // ISS-8135: `unknown`, not `string[]`, because the db host answers this
    // across a boundary that delivers the child's structured clone verbatim.
    // An unreadable reply is dropped exactly like a read failure — the next idle
    // tick re-reads — and must NOT be flattened to `[]`, which claims nothing is
    // owed and is the one answer this pass exists to disprove.
    const pendingIds = readPendingOutboxIds(await loadPendingIds());
    if (pendingIds === undefined) {
      deps.logWarn(
        "pending-outbox reconciliation read a reply this build cannot parse; nothing was reconciled and the next idle tick re-reads"
      );
      return;
    }
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
  loadPendingIds: (sourceKey: string) => unknown;
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

/**
 * ISS-6067: the FEA-3473 resume re-enqueue — read the durable outbox for the
 * identity just hydrated and feed the un-acked prefix onto the backfill lane —
 * guarded across its await.
 *
 * This is the THIRD call site of the use-after-reset class ISS-6031 fixed, and
 * the one it deliberately left alone. It is worse than the two that were fixed,
 * for two reasons. It is AWAITED rather than fire-and-forget, so it sits
 * directly in the resume path. And the queue it repopulates SURVIVES a `stop()`:
 * the next hydration clears source-derived state only when it had a previously
 * hydrated identity, and a stop nulls that, so ids read under the old identity
 * stay queued and upload under whatever resumes.
 *
 * Both halves of the guard are load-bearing, and neither subsumes the other:
 *
 *  - `isCurrentSourceState` carries the pass token AND the source-state
 *    generation, so it catches a `stop()` / `resetSourceState()`. The live
 *    identity is unchanged in that case, so the source-key half cannot see it.
 *  - `readLiveSourceKey` catches a compute-target/account switch, which changes
 *    the identity WITHOUT bumping the generation — nothing resets on a bare
 *    target flip. The generation half alone therefore lets exactly the
 *    wrong-account case through: ids selected under the previous target,
 *    enqueued against the newly-resolved one.
 *
 * `readLiveSourceKey` is passed in rather than reusing `deps.readSourceKey`, and
 * that difference is load-bearing: `deps.readSourceKey` reports the HYDRATED
 * identity, which this caller assigned earlier in this same pass, so comparing
 * it here compares `sourceKey` against itself and can never fire. The sibling
 * idle-tick guard can use it because its capture predates the hydration that
 * moves it. Substituting it here silently disables the account-switch half.
 *
 * Discarding never drops work, but ONLY because the caller re-arms it: this
 * answers a non-`Seeded` outcome so the caller can un-hydrate the identity. That
 * is load-bearing rather than tidy. The guard also closes over `shouldRun()` and
 * over a compute target that reads back `null` while the socket is down, so it
 * fires on a transient disconnect — no `stop()`, no identity change, nothing to
 * clear `hydratedSourceKey`. Left hydrated, the once-per-identity resume read
 * would never run again in this process, and the FEA-3473 un-acked prefix would
 * wait on `reconcilePendingOutboxIfIdle`, which is gated on
 * `historicalBackfillEnabled` and therefore absent under
 * `start({ historicalBackfill: false })`. The rows stay `pending` either way —
 * nothing here writes to the outbox — so re-arming is all that is required.
 *
 * ISS-9823 widened the answer from a boolean, because the caller could not tell
 * a FAULT from a RACE and both arrived as `false`. A superseded identity is an
 * ordinary account or compute-target switch; a thrown or unreadable reply is a
 * durable read that is failing. Reporting the second requires not reporting the
 * first, so the distinction has to survive this return rather than be inferred
 * downstream from a boolean that already lost it.
 *
 * @returns {@link OutboxResumeOutcome.Seeded} when the ids were fed under a
 * still-current identity (or there were none to feed);
 * {@link OutboxResumeOutcome.Discarded} when a superseded identity dropped the
 * read — including a read that threw or answered unreadably AFTER the identity
 * moved, since a switch can be what broke it;
 * {@link OutboxResumeOutcome.ReadFailed} when the read threw or answered a shape
 * this build cannot parse while the identity was still held. On EITHER
 * non-`Seeded` answer the caller MUST NOT treat this identity as hydrated.
 */
export async function requeueResumeOutboxIds(
  config: {
    /** The identity the ids are being read under, captured before the await. */
    sourceKey: string;
    loadPendingIds: () => unknown;
    /** The identity the service would resolve RIGHT NOW, read after the await. */
    readLiveSourceKey: () => string | null;
  },
  deps: SessionDispositionDeps
): Promise<OutboxResumeOutcome> {
  const identityHeld = () =>
    deps.isCurrentSourceState() &&
    config.readLiveSourceKey() === config.sourceKey;
  // ISS-9823 review: a failed read is classified only under an identity that is
  // STILL CURRENT. A `stop()` or compute-target switch tears down the db-host
  // channel this read is parked on, so the switch is itself a plausible cause of
  // the rejection — and answering `ReadFailed` there latches a durable fault
  // against whatever identity is now live, which is the false alarm on every
  // sign-in the widened outcome exists to prevent. Fail-safe in both directions:
  // a genuine fault re-surfaces on the next tick under the stable identity,
  // because the read keeps failing.
  const answerFailedRead = (faultMessage: string): OutboxResumeOutcome => {
    if (identityHeld()) {
      deps.logWarn(faultMessage);
      return OutboxResumeOutcome.ReadFailed;
    }
    deps.logInfo(
      "dropped a failed pending-outbox resume read taken under a superseded source state; the identity is left un-hydrated so a later pass re-reads it"
    );
    return OutboxResumeOutcome.Discarded;
  };
  let reply: unknown;
  try {
    reply = await config.loadPendingIds();
  } catch (error) {
    return answerFailedRead(
      `failed to load pending outbox on resume: ${errorMessage(error)}`
    );
  }
  // ISS-8135: an unreadable reply is a read that did not happen, and it takes
  // the SAME exit as a thrown one — a non-`Seeded` outcome, so the caller
  // un-hydrates and a later pass re-reads. It must not become `[]`: this read
  // runs at most once per identity, and an empty list is the positive claim that
  // finishes it, so flattening here strands the un-acked prefix for the life of
  // the process. The validation also has to sit BEFORE `feedIntoBackfillQueue`
  // below, which is outside the try above — a non-array reached its `for...of`
  // and threw out of hydration entirely.
  const pendingIds = readPendingOutboxIds(reply);
  if (pendingIds === undefined) {
    return answerFailedRead(
      "the durable pending outbox answered a shape this build cannot read on resume; the identity is left un-hydrated so a later pass re-reads it"
    );
  }
  if (!identityHeld()) {
    deps.logInfo(
      `discarded ${pendingIds.length} resumed outbox id(s) read under a superseded source state; the identity is left un-hydrated so a later pass re-reads them`
    );
    return OutboxResumeOutcome.Discarded;
  }
  // ISS-4546 (PR #4098 review, whitlockk): route the hydration re-enqueue through the
  // SAME `feedIntoBackfillQueue` helper the live `injectBackfillIds` path uses, so
  // the dedup discipline (skip an id already tracked on the backfill/incremental
  // queues or set aside as a dead-letter) cannot drift between the
  // restart-hydration path and the live-inject path.
  const requeued = deps.feedIntoBackfillQueue(pendingIds);
  if (requeued === 0) {
    return OutboxResumeOutcome.Seeded;
  }
  // New durable work to drain preempts dead-letter revisits.
  deps.onDurableWorkQueued();
  // FEA-3473 (AC-1): the outbox re-enqueue above recovers only the un-acked
  // prefix — the ids that were enqueued but not yet acked. It is NOT proof that
  // every earlier row is either acked or represented in the outbox. When a cursor
  // WAS persisted, `observedTopUpdatedAt` is already set (by
  // `hydratePersistedCursorIfNeeded`) and the drain-gated persist guarantees
  // everything up to that watermark was acked, so the corpus re-walk stays
  // correctly skipped. When NO cursor was persisted (a kill mid-first-backfill),
  // we deliberately leave `observedTopUpdatedAt === null` so
  // `initializeBackfillQueueIfNeeded` still runs its full enumeration. Do NOT seed
  // the watermark from the current top here: a partially-written outbox can be
  // missing sessions that were never enqueued, and those rows also fall below the
  // incremental `updated_at >= watermark` scan, so a seed would drop them
  // permanently. The full walk re-queues the whole corpus (dedup-safe against the
  // ids already queued above; the server dedupes any already-acked rows per
  // recordOutboxEnqueue), guaranteeing no locally-captured session is stranded.
  deps.logInfo(
    `re-enqueued ${requeued} un-acked agent session(s) from the durable outbox on resume`
  );
  return OutboxResumeOutcome.Seeded;
}

/**
 * ISS-8271 (PLN-1839 Step 3): defer sessions whose row still carries a local
 * mid-derivation sentinel `data_revision` (`DATA_REVISION_IMPORT_PENDING = -1`,
 * `DATA_REVISION_MAINTENANCE_STALE = 0`, or any other value below 1) so the
 * sentinel never reaches a wire payload — the session-lane twin of the
 * invocation lane's `DATA_REVISION` pin (`component-invocations.ts`, ISS-4572).
 * Sentinel revisions are local-only states (`main/sync/AGENTS.md`).
 *
 * An ISS-8271 cloud HOLDS such a session unwritten and omits it from the ack,
 * so sending is never data loss — but it burns the bounded `ack_omitted`
 * budget for a row that is not ready by definition, and a pre-ISS-8271 cloud
 * batch-400s the whole payload. Holding here instead costs nothing: every
 * session this function can see is a CANDIDATE, i.e. an outbox row already owes
 * it (the import `-1` stamp bumps `updated_at` in the same statement; the
 * maintenance `0` park writes `data_revision` alone, so such a session only
 * arrives here when a pending row from earlier activity exists) — and this
 * defer keeps the queue slot behind a retry deadline (`nextRetryAfterMs`), the
 * outbox-pending path, deliberately NOT a durable `withheld` mark, because the
 * reseal (`write-core.ts`) stamps only `data_revision` without bumping
 * `updated_at`, so nothing would ever re-pend a withheld row. After the seal
 * lands, the next ready pick re-hydrates the real revision and the session
 * ships. A session that stays parked at a sentinel is a monitored condition
 * (`import.sessions_pending_revision`) healed by the next boot's rebuild — the
 * defer stays quiet however long that takes, because an unsealed session is
 * unsendable by definition.
 *
 * `null`/`undefined` pass through: the local column is NOT NULL (default 1), so
 * an absent value is a minimal/legacy shape, not a sentinel.
 */
export function deferSentinelRevisionCandidates(
  config: { sessions: SyncedAgentSession[] },
  deps: SessionDispositionDeps
): SyncedAgentSession[] {
  const deferredIds: string[] = [];
  const retained = config.sessions.filter((session) => {
    if (isSealedDataRevision(session.dataRevision)) {
      return true;
    }
    deferredIds.push(session.externalSessionId);
    return false;
  });
  deferCandidatesBehindDeadline(
    { ids: deferredIds, backoffMs: SENTINEL_REVISION_BACKOFF_MS },
    deps,
    () =>
      deps.logInfo(
        `deferred ${deferredIds.length} agent session(s) whose data_revision is a mid-derivation sentinel (< 1) — ` +
          "they stay queued (outbox pending) and re-send once the real revision is sealed; " +
          `ids: ${deferredIds.join(", ")}; ${remainingSuffix(deps)}`
      )
  );
  return retained;
}

/**
 * FEA-3287 + ISS-7096 + ISS-8271: the whole pre-payload candidate screen, in
 * its load-bearing order — ownership and substance first
 * ({@link withholdNonUploadableCandidates}), then the sentinel-revision defer
 * ({@link deferSentinelRevisionCandidates}). One entry point so the service
 * cannot wire half the screen, and so the grandfathered service file keeps
 * shrinking (root AGENTS.md).
 */
export function screenUploadableCandidates(
  config: {
    syncMode: AgentSessionSyncMode;
    sessions: SyncedAgentSession[];
    identity: SignedInUserIdentity | null;
  },
  deps: SessionDispositionDeps
): SyncedAgentSession[] {
  const retained = withholdNonUploadableCandidates(config, deps);
  return deferSentinelRevisionCandidates({ sessions: retained }, deps);
}

/**
 * The shared "defer these ids behind a retry deadline" mechanics (cr-72087
 * design_critic_f0) — the hold-and-retry sibling of `dropWithheldCandidates`:
 * one body, per-caller log line. Ids keep their queue slots and budgets;
 * `pickReadyCandidates` skips them until the deadline passes. The rescheduler
 * only fires on a READY neighbor, so a deferred id cannot spin the pump on
 * itself.
 */
function deferCandidatesBehindDeadline(
  config: { ids: string[]; backoffMs: number },
  deps: SessionDispositionDeps,
  log: () => void
): void {
  if (config.ids.length === 0) {
    return;
  }
  const retryDeadline = Date.now() + config.backoffMs;
  for (const id of config.ids) {
    deps.nextRetryAfterMs.set(id, retryDeadline);
  }
  log();
  deps.scheduleImmediateDrainIfReadyWorkRemains();
}

/**
 * What a dead-letter decided here still owes the lane. Narrowed off
 * {@link SessionDispositionDeps} rather than taking the whole bag, so this
 * verdict cannot reach the queue/telemetry wiring it has no business touching —
 * and so a caller can satisfy it without standing up a disposition it never
 * performs.
 */
export type PendingChunkDiscardPersistence = Pick<
  SessionDispositionDeps,
  | "queueSizes"
  | "persistCursorIfCaughtUp"
  | "scheduleImmediateDrainIfReadyWorkRemains"
>;

/**
 * ISS-8710: retire a pinned chunk tail the drain is dropping without sending.
 * The caller has already cleared the tail; this decides what the session owes
 * afterwards, and the two cases differ in what invalidated the packing.
 *
 * A capability downgrade or a data-sync level change invalidates the packing
 * INPUTS, so the still-queued session re-hydrates and re-chunks under the
 * current answers on the next tick — no verdict, nothing spent.
 *
 * A part whose built batch exceeds the request cap is a verdict about the part,
 * and it is the SAME verdict the route used to return: before this ticket the
 * part reached the wire and came back a 413, which the client classifies
 * `validation_failed` and — for one session shipped as one part of a multi-part
 * sequence — folds as `ChunkEnvelope`, a bounded-but-RECOVERABLE class. That
 * class exists because the partition is not reproducible from the persisted row
 * (the negotiated cap, the encoding, the activity-chunking capability and the
 * source sizes at prepare time all vary between attempts), and production
 * proved it: a session rejected six times as three parts was accepted hours
 * later as four. Deciding it locally must not quietly take that away, so the
 * refusal folds through the identical path and spends the identical budgets.
 * What it saves is the round trip, the partial assembly the server would have
 * kept, and a rejection the client could already prove.
 */
export function applyPendingChunkDiscard(
  transition: PendingChunkDiscard,
  deps: ValidationFailureDeps,
  dispositions: PendingChunkDiscardPersistence
): void {
  if (transition.kind === "reject-oversized") {
    // ISS-8710 (tamsinb review): this verdict can spend the last of the
    // validation budget and dead-letter, and the caller returns without ever
    // reaching `handleBatchAck` — nothing is sent, so no ack persists the
    // cursor. That persist is what carries a dead-letter across a restart: the
    // dead-letter flips the outbox row to `dead_lettered`, which
    // `loadPendingOutboxIds` filters out, leaving `sync_state.dead_lettered_ids`
    // as the only durable record, which `applyResumedCursor` seeds back for the
    // idle-cycle revisit. Skip it and the next boot finds no pending row, no
    // recorded dead-letter, and a watermark already past the session —
    // `initializeBackfillQueueIfNeeded` early-returns on that resumed cursor and
    // nothing ever re-selects it. Snapshot-and-compare because only an
    // EXHAUSTED budget dead-letters; the deferring attempts before it must not
    // pay for a durable write. Both sibling dead-letter sites do the same
    // (`handleBatchAck`, `deadLetterOversizedLocalSession` above).
    const deadLetteredBefore = dispositions.queueSizes().deadLettered;
    applyValidationFailure(
      {
        syncMode: transition.syncMode,
        ids: [transition.sessionId],
        payloadBytes: transition.chunkBytes,
        multiPartEnvelope: true,
      },
      deps
    );
    if (dispositions.queueSizes().deadLettered > deadLetteredBefore) {
      dispositions.persistCursorIfCaughtUp();
      // The dead-letter dequeued its row and may have drained the last ready
      // work with no ack to reschedule off, so a corpus of over-cap tails would
      // otherwise advance one session per 5s poll.
      dispositions.scheduleImmediateDrainIfReadyWorkRemains();
    }
    return;
  }
  deps.logInfo(
    `discarding ${transition.chunkCount} sized chunk(s) for session ${transition.sessionId} after a sync capability downgrade (compression/activity-chunking) or a data-sync level change; ` +
      "re-preparing under the current capabilities and level on the next tick"
  );
}
