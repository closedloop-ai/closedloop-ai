/**
 * @file agent-session-sync-dead-letter-fixtures.ts
 * @description ISS-7564 shared harness for the dead-letter lifecycle suites.
 *
 * The five exports of `agent-session-sync-dead-letter-lifecycle.ts` are one
 * mechanism, so they share one hand-built `DeadLetterLifecycleDeps` — plain
 * Maps, arrays and recording stubs, in the same style as
 * `agent-session-sync-service-fixtures.ts`. The suites that drive it are split
 * by concern (`-stamping`, `-cap`, `-doors`) per `apps/desktop/test/AGENTS.md`;
 * this module is the setup they hold in common.
 *
 * The clock is pinned because `markDeadLettered` reads the real `Date.now()`
 * while its sibling `recoverExpiredDeadLetters` takes an explicit `nowMs`; the
 * retry windows are therefore asserted exactly, not observed. Every policy
 * number comes from `agent-session-sync-backoff-policy.js` rather than being
 * restated here.
 */

import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { afterEach, beforeEach, vi } from "vitest";
import type { DeadLetterLifecycleDeps } from "../src/main/agent-sync/agent-session-sync-dead-letter-lifecycle.js";

/** The pinned wall clock every `markDeadLettered` stamp is derived from. */
export const FIXED_NOW_MS = Date.UTC(2026, 7, 22, 12, 0, 0);

/** A recoverable class that charges neither per-class allowance. */
export const TRANSIENT_REASON = SyncReason.RateLimited;
/** A deterministic class: infinite deadline, no escalation counter. */
export const DETERMINISTIC_REASON = SyncReason.LocallyOversized;

export type OutboxDeadLetterCall = {
  id: string;
  reason: string;
  attemptCount: number;
};

/**
 * The service-owned scalars the lifecycle threads as accessors. Held in one
 * mutable object so a test can both open a gate and read back whether the
 * module flipped the idle-cycle guard.
 */
export type LifecycleScalars = {
  pendingChunks: boolean;
  backfillEnabled: boolean;
  revisited: boolean;
};

export type Harness = {
  deps: DeadLetterLifecycleDeps;
  scalars: LifecycleScalars;
  cleared: string[];
  outboxDeadLetters: OutboxDeadLetterCall[];
  outboxReEnqueues: string[];
  warnings: string[];
  /**
   * Every value written to the idle-cycle guard, in order. Reading the scalar
   * back cannot tell "the gate blocked the write" from "the write happened and
   * stored the value already there", and the re-arm door writes `false` onto a
   * guard that may already be `false` — so the WRITES are what the gate tests
   * assert, not the resulting boolean.
   */
  guardWrites: boolean[];
  /**
   * What the durable re-pend REPORTS back, replaceable per test.
   *
   * ISS-7216 made `enforceDeadLetterCap` release an id only once this resolves
   * `true`, so a harness that could not deny confirmation could not exercise
   * the gate at all — every cap assertion would be reading the happy path and
   * calling it the contract.
   */
  handoff: { respond: (id: string) => Promise<boolean> };
};

/**
 * Pin the clock for a suite. Registered as hooks here rather than copied into
 * each sibling file, so the three suites cannot drift to three different
 * "now"s and disagree about the same retry window.
 */
export function pinLifecycleClock(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}

export function makeHarness(): Harness {
  const cleared: string[] = [];
  const outboxDeadLetters: OutboxDeadLetterCall[] = [];
  const outboxReEnqueues: string[] = [];
  const warnings: string[] = [];
  const guardWrites: boolean[] = [];
  const handoff = { respond: (_id: string) => Promise.resolve(true) };
  const scalars: LifecycleScalars = {
    pendingChunks: false,
    backfillEnabled: true,
    revisited: false,
  };
  const deps: DeadLetterLifecycleDeps = {
    deadLetteredIds: new Map<string, number>(),
    deadLetterCountById: new Map<string, number>(),
    chunkValidationCycleById: new Map<string, number>(),
    ackOmittedCycleById: new Map<string, number>(),
    backfillQueue: [],
    backfillQueuedIds: new Set<string>(),
    incrementalQueue: [],
    incrementalQueuedIds: new Set<string>(),
    hasPendingChunks: () => scalars.pendingChunks,
    isHistoricalBackfillEnabled: () => scalars.backfillEnabled,
    wasDeadLetterRevisitedThisIdleCycle: () => scalars.revisited,
    setDeadLetterRevisitedThisIdleCycle: (revisited) => {
      guardWrites.push(revisited);
      scalars.revisited = revisited;
    },
    clearFailureStateForId: (id) => cleared.push(id),
    recordOutboxDeadLetter: (id, reason, attemptCount) =>
      outboxDeadLetters.push({ id, reason, attemptCount }),
    recordOutboxReEnqueue: (id) => {
      outboxReEnqueues.push(id);
      return handoff.respond(id);
    },
    // The promote door's info line is not an asserted contract (AGENTS.md on
    // log assertions). The WARN is, because a session the lane abandoned must
    // never be re-enqueued without naming it.
    logInfo: () => undefined,
    logWarn: (message) => warnings.push(message),
  };
  return {
    deps,
    scalars,
    cleared,
    outboxDeadLetters,
    outboxReEnqueues,
    warnings,
    guardWrites,
    handoff,
  };
}

/** Every map the cap must evict from, so a missed one is a named failure. */
export function allPerIdMaps(
  deps: DeadLetterLifecycleDeps
): Array<{ label: string; map: Map<string, number> }> {
  return [
    { label: "deadLetteredIds", map: deps.deadLetteredIds },
    { label: "deadLetterCountById", map: deps.deadLetterCountById },
    { label: "chunkValidationCycleById", map: deps.chunkValidationCycleById },
    { label: "ackOmittedCycleById", map: deps.ackOmittedCycleById },
  ];
}

/** Seed `count` dead-letters, each present in all four per-id maps. */
export function seedDeadLetters(harness: Harness, count: number): void {
  for (let index = 0; index < count; index++) {
    const id = `dl-${index}`;
    harness.deps.deadLetteredIds.set(id, Number.POSITIVE_INFINITY);
    harness.deps.deadLetterCountById.set(id, 1);
    harness.deps.chunkValidationCycleById.set(id, 1);
    harness.deps.ackOmittedCycleById.set(id, 1);
  }
}

/** Empty the catch-up lane so a second promotion pass sees drained queues. */
export function drainBackfillLane(deps: DeadLetterLifecycleDeps): string[] {
  const drained = [...deps.backfillQueue];
  deps.backfillQueue.length = 0;
  deps.backfillQueuedIds.clear();
  return drained;
}

/**
 * How many microtask turns `settleHandoffs` drains.
 *
 * ISS-7216 made the cap's eviction ASYNCHRONOUS — `enforceDeadLetterCap`
 * returns as soon as the hand-offs are REQUESTED, and each id leaves the maps
 * only when its own `recordOutboxReEnqueue` resolves. The whole chain is
 * promises, so a macrotask hop would be the obvious flush, except the suites
 * pin the clock and `vi.useFakeTimers()` fakes `setImmediate` — it never runs.
 * Draining the microtask queue is what is left, and it is exact rather than
 * timing-based: the chain's depth is fixed by the code, so this bound either
 * always covers it or never does. An under-drain therefore surfaces as a
 * deterministically red assertion below, never as a flake.
 */
const HANDOFF_MICROTASK_TURNS = 24;

/**
 * Let every requested eviction hand-off settle before asserting on the maps.
 * The cap's release is confirmation-gated, so an assertion made on the
 * synchronous return of `enforceDeadLetterCap` would be reading the set BEFORE
 * any eviction could have happened and would pass for the wrong reason.
 */
export async function settleHandoffs(): Promise<void> {
  for (let turn = 0; turn < HANDOFF_MICROTASK_TURNS; turn++) {
    await Promise.resolve();
  }
}
