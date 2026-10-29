/**
 * @file write-dispatch-mirror.ts
 * @description ISS-7256 (whitlockk review) — the DISPATCHER's readable snapshot of
 * the store thread's write queue.
 *
 * ## Why a mirror and not a query
 *
 * `importSessionBounded` asks, at its deadline, whether this session's write ever
 * dispatched. The queue that knows lives on the STORE thread
 * (`db-store-host.ts` → `openSqliteAgentDatabase` → `createWriteQueue`), and the
 * proxy path reaches it as an ordinary `Execute` on the inner port, picked up
 * only when that thread's loop turns. The deadline fires precisely BECAUSE that
 * thread is inside a long synchronous libSQL call, so the pull cannot be
 * answered: it waits out `IMPORT_EVICTION_CLASSIFY_TIMEOUT_MS`, resolves to no
 * evidence, and the bound takes the old expiry path. The probe's own precondition
 * is what makes the probe unanswerable.
 *
 * So the state is PUSHED instead. `createWriteQueue`'s observer reports each
 * tokened task's `queued` / `dispatched` / `settled` transition as it happens —
 * `dispatched` posted BEFORE the task's `fn` runs, which is before the thread can
 * block — the store host forwards it as {@link DbStoreResponseKind.WriteTask},
 * and this mirror holds it. The dispatcher then answers `importer.hasUndispatchedWrite`
 * from memory, with no store round trip, in the window where the store answers
 * nothing at all.
 *
 * This is the same shape as `latestStoreMemory()` (PLN-1837 §Q3): store-thread
 * state published outward on its own transitions and read locally by the
 * dispatcher. The difference that matters is the trigger — the heap sampler is a
 * store-thread TIMER, so it stops firing during exactly the blocked window, while
 * these notices are emitted by the transitions themselves and are therefore
 * already in the dispatcher's hands when the block begins.
 *
 * ## Absent is not "waiting"
 *
 * A token this mirror has never seen reports {@link WriteDispatchState.Absent},
 * the same state the in-process queue reports for an owner with no live task, and
 * the bound treats it exactly as ISS-6115's
 * {@link WriteQueueCancelOutcome.None} — no re-arm, unchanged timeout path. It
 * deliberately does NOT report `Queued`. A session whose `Execute` has not been
 * picked up yet and a session burning its deadline on its own pre-queue work
 * (parse, attribution) are indistinguishable from here, and guessing `Queued`
 * would hand extra deadline windows to the second on the strength of the first.
 * Conservative in the same direction as every other unknown on this path: a
 * missing answer never extends a bound.
 *
 * ## Bounded by construction
 *
 * Entries outlive their task on purpose — a token that dispatched and settled
 * must keep reading `Dispatched`, or the bound would re-arm a session that DID
 * do its own work the moment its last task settled. That retention is capped two
 * ways (a TTL and a hard entry ceiling, both swept on write), because the token
 * is an externally-supplied session id and an unbounded map keyed on one is the
 * growth this repo forbids.
 */

import {
  type WriteDispatchProbe,
  WriteDispatchState,
  WriteQueueTaskPhase,
  type WriteQueueTaskToken,
} from "../write-queue.js";

/**
 * How long a token's last known state stays readable after its task settled.
 *
 * It only has to outlive the bound that consults it: `importSessionBounded` runs
 * a 120 s deadline plus at most {@link MAX_UNDISPATCHED_IMPORT_BOUND_REARMS}
 * further windows, so ten minutes covers the whole life of a probe with room to
 * spare. Past that the entry is stale evidence about a session nothing is still
 * waiting on, and dropping it costs only a fall back to `Absent`.
 */
export const WRITE_DISPATCH_MIRROR_TTL_MS = 600_000;

/**
 * Hard ceiling on retained tokens, enforced by evicting the oldest.
 *
 * The live population is small — five concurrent boot-import loops over one
 * queue — so this is a backstop against a pathological producer, not a working
 * limit. Generous enough that ordinary operation never reaches it, finite so the
 * map cannot grow with the session corpus.
 */
export const WRITE_DISPATCH_MIRROR_MAX_TOKENS = 1024;

type MirrorEntry = {
  state: WriteDispatchState;
  taskSeq: number;
  touchedAtMs: number;
};

export type WriteDispatchMirror = {
  /** Record one transition reported by the store thread. */
  observe(
    token: WriteQueueTaskToken,
    phase: WriteQueueTaskPhase,
    taskSeq: number
  ): void;
  /** Answer for `token` from mirrored state alone — never asks the store. */
  probe(token: WriteQueueTaskToken): WriteDispatchProbe;
  /** Drop everything (the store thread died; its queue died with it). */
  reset(): void;
  /** Retained token count, for the bound's own test. */
  size(): number;
};

export function createWriteDispatchMirror(options?: {
  now?: () => number;
  ttlMs?: number;
  maxTokens?: number;
}): WriteDispatchMirror {
  const now = options?.now ?? Date.now;
  const ttlMs = options?.ttlMs ?? WRITE_DISPATCH_MIRROR_TTL_MS;
  const maxTokens = options?.maxTokens ?? WRITE_DISPATCH_MIRROR_MAX_TOKENS;
  // Insertion-ordered, and re-inserted on every update, so the first key is
  // always the least recently touched — which is what `sweep` evicts.
  const entries = new Map<WriteQueueTaskToken, MirrorEntry>();

  const sweep = (nowMs: number): void => {
    for (const [token, entry] of entries) {
      if (nowMs - entry.touchedAtMs < ttlMs) {
        break;
      }
      entries.delete(token);
    }
    while (entries.size > maxTokens) {
      const oldest = entries.keys().next();
      if (oldest.done) {
        break;
      }
      entries.delete(oldest.value);
    }
  };

  return {
    observe(
      token: WriteQueueTaskToken,
      phase: WriteQueueTaskPhase,
      taskSeq: number
    ): void {
      const previous = entries.get(token);
      const state = nextState(phase, previous, taskSeq);
      if (state === null) {
        // An unrecognised phase changes nothing. The wire check upstream only
        // proves `phase` is a string, and inventing a state from one we do not
        // know is how a corrupt message would reach the bound's decision.
        return;
      }
      const nowMs = now();
      // Delete-then-set keeps insertion order equal to recency.
      entries.delete(token);
      entries.set(token, { state, taskSeq, touchedAtMs: nowMs });
      sweep(nowMs);
    },

    probe(token: WriteQueueTaskToken): WriteDispatchProbe {
      const entry = entries.get(token);
      if (!entry) {
        return { state: WriteDispatchState.Absent, taskSeq: null };
      }
      return { state: entry.state, taskSeq: entry.taskSeq };
    },

    reset(): void {
      entries.clear();
    },

    size(): number {
      return entries.size;
    },
  };
}

/**
 * The state one notice leaves the token in, or `null` to record nothing.
 *
 * - `dispatched` is the fact the bound turns on and always wins.
 * - `queued` for a NEWER task than the one recorded is a fresh waiter. For the
 *   SAME (or an older, out-of-order) task it must not downgrade a `Dispatched`
 *   entry back to `Queued`.
 * - `settled` never changes the state at all. A token that dispatched and
 *   settled has to keep reading `Dispatched` until it ages out — that is exactly
 *   the session which DID burn its deadline on its own work, and forgetting it
 *   the moment the task settles is what would hand it an extra window.
 * - Anything else is not a phase this build emits; record nothing.
 */
function nextState(
  phase: WriteQueueTaskPhase,
  previous: MirrorEntry | undefined,
  taskSeq: number
): WriteDispatchState | null {
  if (phase === WriteQueueTaskPhase.Dispatched) {
    return WriteDispatchState.Dispatched;
  }
  if (phase === WriteQueueTaskPhase.Queued) {
    if (!previous || taskSeq > previous.taskSeq) {
      return WriteDispatchState.Queued;
    }
    return previous.state;
  }
  if (phase === WriteQueueTaskPhase.Settled) {
    return previous?.state ?? WriteDispatchState.Dispatched;
  }
  return null;
}
