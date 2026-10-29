/**
 * @file agent-session-sync-pass-identity-guards.test.ts
 * @description ISS-8116 — every pass-level guard, exercised by moving the
 * IDENTITY mid-await and nothing else.
 *
 * That restriction is the whole point. Not one case here calls `stop()` or
 * `resetSourceState()`, so `sourceStateGeneration` never moves and the
 * generation-only checks that shipped before this ticket all evaluate TRUE
 * across the switch. Each assertion is therefore on state that only the live
 * source-key comparison can withhold: remove that half and the named case goes
 * red, which is the counterfactual ISS-7988 asked for after finding two of its
 * own new tests were false greens.
 *
 * No case counts event-loop turns (davetho / whitlockk review). A case whose
 * stale continuation belongs to the PUBLISHED pass awaits
 * `whenSessionSyncSettled()`, the service's own completion signal. The two
 * `stop()`/`start()` cases cannot: their continuation belongs to a pass the
 * restart already replaced, so they use `awaitStaleContinuation`, which waits on
 * a real fixture event and then crosses one macrotask barrier. Every case also
 * tears the service down, because a leaked poll/drain timer from one case writes
 * into the maps the next case asserts on (tamsinb review).
 *
 * Every fixture answers the deferred read TRUTHFULLY once and EMPTY afterwards
 * (or hangs afterwards). That is not decoration: the arriving identity is
 * entitled to enumerate the same local store, so a fixture that kept answering
 * would let a correct later pass reproduce the exact queue depth the superseded
 * one would have — and the assertion would decide on scheduling rather than on
 * the behavior under test. Same reasoning, and same shape, as
 * `DeferredResumeOutboxSource` in `agent-session-sync-stale-continuation.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import type { AgentSessionSyncBatch } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { createSyncPassIdentityGuard } from "../src/main/agent-sync/agent-session-sync-pass-identity.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type {
  AgentSessionOutboxEntry,
  AgentSessionSyncSource,
  PersistedSyncState,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { OutboxClearResult } from "../src/main/agent-sync/outbox-clear-result.js";
import type { DesktopAgentSessionsAck } from "../src/main/cloud/cloud-protocol.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  awaitEvent,
  awaitStaleContinuation,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const TARGET_A = "target-iss-8116-account-a";
const TARGET_B = "target-iss-8116-account-b";
const SOURCE_KEY_A = buildAgentSessionSyncSourceKey(TARGET_A);
const SESSION_ONE = "session-iss-8116-one";
const SESSION_TWO = "session-iss-8116-two";
const UPDATED_AT_ONE = "2026-08-20T10:00:00.000Z";
const UPDATED_AT_TWO = "2026-08-20T11:00:00.000Z";
/** A watermark BELOW both sessions, so the incremental read selects them. */
const CURSOR_AT_A = "2026-08-20T09:00:00.000Z";
/** Any value past the 256 KiB identity cap; the scan REPORTS it, nothing re-derives it. */
const OVERSIZED_PAYLOAD_BYTES = 512 * 1024;

/** A promise plus the handle to settle it from the test body. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A promise that never settles — a later pass parked where it cannot interfere. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

type CursorRow = { id: string; updated_at: string };

/** The full-corpus enumeration behind `initializeBackfillQueueIfNeeded`. */
class DeferredBackfillEnumerationSource extends FakeSyncSource {
  readonly enumerationCalled = deferred<void>();
  readonly releaseEnumeration = deferred<CursorRow[]>();
  enumerationCount = 0;

  override listAllSessionCursorRows(): CursorRow[] | Promise<CursorRow[]> {
    this.enumerationCount += 1;
    if (this.enumerationCount > 1) {
      return [];
    }
    this.enumerationCalled.resolve();
    return this.releaseEnumeration.promise;
  }
}

/** The keyset read behind `enqueueIncrementalUpdates`. */
class DeferredIncrementalReadSource extends FakeSyncSource {
  readonly readCalled = deferred<void>();
  readonly releaseRead = deferred<CursorRow[]>();
  incrementalReadCount = 0;

  override listUpdatedSessionCursorRows(
    _sinceUpdatedAt: string,
    _observedTopIds: readonly string[]
  ): CursorRow[] | Promise<CursorRow[]> {
    this.incrementalReadCount += 1;
    if (this.incrementalReadCount > 1) {
      return [];
    }
    this.readCalled.resolve();
    return this.releaseRead.promise;
  }
}

/** ISS-6031's local-presence probe, behind `resolveEmptyHydration`. */
class DeferredProbeSource extends FakeSyncSource {
  readonly probeCalled = deferred<void>();
  readonly releaseProbe = deferred<string[]>();
  probeCount = 0;

  override findExistingSessionIds(ids: string[]): string[] | Promise<string[]> {
    this.probeCount += 1;
    if (this.probeCount > 1) {
      return super.findExistingSessionIds(ids);
    }
    this.findExistingSessionIdCalls.push(ids);
    this.probeCalled.resolve();
    return this.releaseProbe.promise;
  }
}

/**
 * The FEA-3473 resume re-enqueue — the LAST await inside the hydration whose own
 * ISS-6067 guard can discard. Its discard nulls the hydrated key and returns
 * from the hydration; whether the PASS then stops is what ISS-8116 decides.
 */
class DeferredResumeOutboxSource extends FakeSyncSource {
  readonly readCalled = deferred<void>();
  /**
   * Resolved the moment the once-per-identity resume read is RE-ISSUED. That is
   * the re-arm this case asserts, published as an event rather than inferred
   * from a turn count (davetho / whitlockk review): `whenSessionSyncSettled()` is
   * the right signal for a pass that finishes, and the re-armed pass here parks
   * forever in the `never()` send by construction, so the read itself is the
   * only completion this case can honestly wait on.
   */
  readonly rereadCalled = deferred<void>();
  readonly releaseRead = deferred<string[]>();
  outboxReadCount = 0;

  override loadPendingOutboxIds(
    _sourceKey: string
  ): string[] | Promise<string[]> {
    this.outboxReadCount += 1;
    if (this.outboxReadCount > 1) {
      this.rereadCalled.resolve();
      return [];
    }
    this.readCalled.resolve();
    return this.releaseRead.promise;
  }
}

/**
 * The DURABLE OUTBOX CLEAR behind an accepted ack — the await that sits INSIDE
 * `handleBatchAck`, past the entry-level identity check (davetho / whitlockk).
 */
class DeferredOutboxClearSource extends FakeSyncSource {
  readonly clearCalled = deferred<void>();
  readonly releaseClear = deferred<OutboxClearResult | undefined>();
  clearCount = 0;

  override async clearOutboxEntries(
    sourceKey: string,
    ids: string[]
  ): Promise<OutboxClearResult | undefined> {
    this.clearCount += 1;
    // The real delete still commits on every call — the acked rows WERE acked.
    // What the guard withholds is the in-memory advance and the cursor persist
    // that follow it.
    const result = await super.clearOutboxEntries(sourceKey, ids);
    if (this.clearCount > 1) {
      return result;
    }
    this.clearCalled.resolve();
    return await this.releaseClear.promise;
  }
}

/** FEA-3473's durable backfill seed — the await the cursor persist follows. */
class DeferredOutboxSeedSource extends FakeSyncSource {
  readonly seedCalled = deferred<void>();
  /** Resolved once the PARKED seed has actually resumed (see `awaitStaleContinuation`). */
  readonly seedResumed = deferred<void>();
  readonly releaseSeed = deferred<void>();
  seedCount = 0;

  override async enqueueOutboxEntries(
    sourceKey: string,
    entries: AgentSessionOutboxEntry[]
  ): Promise<void> {
    this.seedCount += 1;
    await super.enqueueOutboxEntries(sourceKey, entries);
    if (this.seedCount > 1) {
      return;
    }
    this.seedCalled.resolve();
    await this.releaseSeed.promise;
    this.seedResumed.resolve();
  }
}

/** FEA-2718's pre-hydrate oversize scan, behind `selectHydratableCandidateIds`. */
class DeferredOversizeScanSource extends FakeSyncSource {
  readonly scanCalled = deferred<void>();
  readonly releaseScan = deferred<{ id: string; payloadBytes: number }[]>();
  scanCount = 0;

  override findLocallyOversizedSessions(
    ids: string[],
    maxBytes: number
  ):
    | { id: string; payloadBytes: number }[]
    | Promise<{ id: string; payloadBytes: number }[]> {
    this.scanCount += 1;
    if (this.scanCount > 1) {
      return super.findLocallyOversizedSessions(ids, maxBytes);
    }
    this.scanCalled.resolve();
    return this.releaseScan.promise;
  }
}

/** FEA-1962's persisted-cursor load — the FIRST await inside the hydration. */
class DeferredCursorLoadSource extends FakeSyncSource {
  readonly loadCalled = deferred<void>();
  /** Resolved once the PARKED load has actually resumed (see `awaitStaleContinuation`). */
  readonly loadResumed = deferred<void>();
  readonly releaseLoad = deferred<PersistedSyncState | null>();
  loadCount = 0;

  override async loadSyncState(
    sourceKey: string
  ): Promise<PersistedSyncState | null> {
    this.loadCount += 1;
    if (this.loadCount > 1) {
      return await super.loadSyncState(sourceKey);
    }
    this.loadCalled.resolve();
    const state = await this.releaseLoad.promise;
    this.loadResumed.resolve();
    return state;
  }
}

/**
 * tamsinb review: the service owns a poll timer AND a drain timer, and the
 * `never()` park below stops the PASS, not the timers. A timer leaked from case
 * N fires during case N+1 and writes into the in-memory maps that case is
 * asserting on — the exact non-determinism the FEA-2399 rule and the
 * no-silent-poll-barrier guard exist to prevent. Registered by
 * {@link makeService} rather than at each call site so a case cannot be written
 * without a teardown, and torn down in `afterEach` so a FAILED assertion still
 * stops the service.
 */
let serviceUnderTest: AgentSessionSyncService | null = null;

afterEach(() => {
  serviceUnderTest?.stop();
  serviceUnderTest = null;
});

function makeService(
  // Typed against the SOURCE CONTRACT, not the fake: every deferred fixture here
  // widens a read to `T | Promise<T>`, which the contract declares and the
  // fake's own concrete (synchronous) return types do not.
  source: AgentSessionSyncSource,
  readComputeTargetId: () => string,
  sendBatch: (batch: AgentSessionSyncBatch) => Promise<DesktopAgentSessionsAck>
): AgentSessionSyncService {
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: readComputeTargetId,
    sendBatch,
  });
  serviceUnderTest = service;
  return service;
}

/** Rows for {@link SESSION_ONE} and {@link SESSION_TWO}, newest first. */
function bothCursorRows(): CursorRow[] {
  return [
    { id: SESSION_TWO, updated_at: UPDATED_AT_TWO },
    { id: SESSION_ONE, updated_at: UPDATED_AT_ONE },
  ];
}

function outboxIdsUnder(
  source: Pick<FakeSyncSource, "outbox">,
  sourceKey: string
): string[] {
  return [...source.outbox.values()]
    .filter((entry) => entry.sourceKey === sourceKey)
    .map((entry) => entry.id)
    .sort();
}

test("ISS-8116: a backfill enumeration that resolves after a target switch queues nothing", async () => {
  gatewayLog.clear();
  const source = new DeferredBackfillEnumerationSource([
    makeSyncedSession(SESSION_ONE, UPDATED_AT_ONE),
    makeSyncedSession(SESSION_TWO, UPDATED_AT_TWO),
  ]);
  let computeTargetId = TARGET_A;
  const service = makeService(
    source,
    () => computeTargetId,
    () => never<DesktopAgentSessionsAck>()
  );
  service.start();
  await source.enumerationCalled.promise;
  // The switch, and ONLY the switch: no stop(), no resetSourceState(), so the
  // pass token and the source-state generation are both untouched.
  computeTargetId = TARGET_B;
  source.releaseEnumeration.resolve(bothCursorRows());
  await service.whenSessionSyncSettled();

  assert.equal(
    service.getSyncProgress().pendingBackfillSessions,
    0,
    "a corpus enumerated under account A must not be queued after the switch to B"
  );
  assert.deepEqual(
    outboxIdsUnder(source, SOURCE_KEY_A),
    [],
    "and must not durably seed account A's outbox partition"
  );
});

test("ISS-8116: an incremental cursor read that resolves after a target switch enqueues nothing", async () => {
  gatewayLog.clear();
  const source = new DeferredIncrementalReadSource([
    makeSyncedSession(SESSION_ONE, UPDATED_AT_ONE),
  ]);
  // A persisted cursor BELOW the session, so the hydration resumes the watermark,
  // `initializeBackfillQueueIfNeeded` early-returns, and the incremental keyset
  // read is the only thing that can select the row.
  source.seedSyncState(SOURCE_KEY_A, {
    observedTopUpdatedAt: CURSOR_AT_A,
    observedIdsAtTopUpdatedAt: [],
  });
  let computeTargetId = TARGET_A;
  const service = makeService(
    source,
    () => computeTargetId,
    () => never<DesktopAgentSessionsAck>()
  );
  service.start();
  await source.readCalled.promise;
  computeTargetId = TARGET_B;
  source.releaseRead.resolve([{ id: SESSION_ONE, updated_at: UPDATED_AT_ONE }]);
  await service.whenSessionSyncSettled();

  assert.equal(
    service.getSyncProgress().pendingIncrementalSessions,
    0,
    "rows selected under account A's watermark must not reach account B's lane"
  );
  assert.deepEqual(
    outboxIdsUnder(source, SOURCE_KEY_A),
    [],
    "and the durable incremental enqueue must not land either"
  );
});

/**
 * The `isCurrentSourceState()` sites the pass already had — after the candidate
 * hydration, after the absence resolution, after the payload prep, and before
 * the send. They are one predicate evaluated at four points, so upgrading the
 * predicate upgrades all four; this drives the absence-resolution one, because
 * its continuation is the one that writes a DURABLE row (ISS-6031's dead-letter
 * of a confirmed-absent id) and therefore leaves unambiguous evidence.
 */
test("ISS-8116: a presence probe that resolves after a target switch dead-letters nothing", async () => {
  gatewayLog.clear();
  const source = new DeferredProbeSource([
    makeSyncedSession(SESSION_ONE, UPDATED_AT_ONE),
  ]);
  source.seedOutbox(SOURCE_KEY_A, SESSION_ONE);
  let computeTargetId = TARGET_A;
  const service = makeService(
    source,
    () => computeTargetId,
    () => never<DesktopAgentSessionsAck>()
  );
  service.start();
  // A real delete-after-enqueue, so the released probe takes the CONFIRMED-ABSENT
  // branch — the one that dead-letters and writes the durable row.
  source.deleteSession(SESSION_ONE);
  await source.probeCalled.promise;
  computeTargetId = TARGET_B;
  source.releaseProbe.resolve([]);
  await service.whenSessionSyncSettled();

  const row = [...source.outbox.values()].find(
    (entry) => entry.sourceKey === SOURCE_KEY_A && entry.id === SESSION_ONE
  );
  assert.equal(
    row?.status,
    OutboxStatus.Pending,
    "an absence proven under account A must not dead-letter its durable row once B is the live target"
  );
});

test("ISS-8116: an ack that lands after a target switch does not clear the old partition", async () => {
  gatewayLog.clear();
  const source = new FakeSyncSource([
    makeSyncedSession(SESSION_ONE, UPDATED_AT_ONE),
  ]);
  source.seedOutbox(SOURCE_KEY_A, SESSION_ONE);
  let computeTargetId = TARGET_A;
  const sendCalled = deferred<void>();
  const releaseSend = deferred<DesktopAgentSessionsAck>();
  let sendCount = 0;
  const service = makeService(
    source,
    () => computeTargetId,
    () => {
      sendCount += 1;
      if (sendCount > 1) {
        return never<DesktopAgentSessionsAck>();
      }
      sendCalled.resolve();
      return releaseSend.promise;
    }
  );
  service.start();
  await sendCalled.promise;
  computeTargetId = TARGET_B;
  releaseSend.resolve({ accepted: true });
  await service.whenSessionSyncSettled();

  const row = [...source.outbox.values()].find(
    (entry) => entry.sourceKey === SOURCE_KEY_A && entry.id === SESSION_ONE
  );
  assert.equal(
    row?.status,
    OutboxStatus.Pending,
    "an ack for account A's batch must not clear its row once B is the live target"
  );
});

test("ISS-8116: a hydration whose identity moved abandons the pass and re-arms", async () => {
  gatewayLog.clear();
  const source = new DeferredResumeOutboxSource([
    makeSyncedSession(SESSION_ONE, UPDATED_AT_ONE),
  ]);
  source.seedOutbox(SOURCE_KEY_A, SESSION_ONE);
  let computeTargetId = TARGET_A;
  const service = makeService(
    source,
    () => computeTargetId,
    () => never<DesktopAgentSessionsAck>()
  );
  service.start();
  await source.readCalled.promise;
  computeTargetId = TARGET_B;
  source.releaseRead.resolve([SESSION_ONE]);
  await service.whenSessionSyncSettled();

  assert.equal(
    source.listAllCursorCallCount,
    0,
    "the pass must ABORT after a superseded hydration, not fall through to the enumeration that repopulates the watermark under no identity"
  );

  // The other half of the acceptance criterion: abandoning must also leave the
  // identity re-readable. The hydration's own discard nulls the hydrated key;
  // this proves the next pass therefore re-runs the once-per-identity resume
  // read rather than short-circuiting on a stale marker.
  service.refresh();
  await awaitEvent(
    source.rereadCalled.promise,
    "the resume outbox read to be re-issued on a later pass"
  );
  assert.ok(
    source.outboxReadCount >= 2,
    "and the identity must be re-read on a later pass rather than wedged as hydrated"
  );
});

/**
 * The seam itself, against synthetic inputs — the reason the predicate was
 * hoisted out of the service rather than written inline. These two cases pin the
 * asymmetry the service cannot cheaply isolate: `isCurrentSourceIdentity` must
 * NOT consult `shouldRun()` (the ack fold depends on that omission), and
 * `isCurrentSourceState` must.
 */
test("ISS-8116: the pass guard reads the live key, and only the state half consults readiness", () => {
  let liveSourceKey: string | null = SOURCE_KEY_A;
  let ready = true;
  const guard = createSyncPassIdentityGuard({
    isActivePass: () => true,
    shouldRun: () => ready,
    readLiveSourceKey: () => liveSourceKey,
  });

  assert.equal(guard.capturedSourceKey, SOURCE_KEY_A);
  assert.equal(guard.isCurrentSourceIdentity(), true);
  assert.equal(guard.isCurrentSourceState(), true);

  ready = false;
  assert.equal(
    guard.isCurrentSourceIdentity(),
    true,
    "a readiness drop is not an identity change — the ack fold still runs"
  );
  assert.equal(
    guard.isCurrentSourceState(),
    false,
    "but the pass-wide guard does stand down on it"
  );

  ready = true;
  liveSourceKey = buildAgentSessionSyncSourceKey(TARGET_B);
  assert.equal(
    guard.isCurrentSourceIdentity(),
    false,
    "an identity move is caught with the generation untouched"
  );
  assert.equal(guard.isCurrentSourceState(), false);
});

test("ISS-8116: an identity arriving mid-pass is a change, not a no-op", () => {
  let liveSourceKey: string | null = null;
  const guard = createSyncPassIdentityGuard({
    isActivePass: () => true,
    shouldRun: () => true,
    readLiveSourceKey: () => liveSourceKey,
  });

  assert.equal(guard.isCurrentSourceState(), true);
  liveSourceKey = SOURCE_KEY_A;
  assert.equal(
    guard.isCurrentSourceState(),
    false,
    "state seeded while no identity was attached is state the arriving identity would inherit"
  );
});

/**
 * davetho / whitlockk review — the ack's POST-await half. The identity check
 * before `handleBatchAck` protects ENTRY only; the tiling-debt record and the
 * durable outbox clear are both awaits INSIDE it, and the post-clear guard that
 * follows them read the generation alone, which a compute-target switch never
 * moves.
 *
 * The durable delete itself is deliberately NOT the assertion: it commits before
 * the guard and is still correct (those rows WERE acked). What the guard
 * withholds is everything keyed to whoever is live NOW — the dequeue and the
 * cursor persist it can trigger. `advanceCalls` is that persist, under A's key.
 */
test("ISS-8116: an ack whose durable clear resolves after a target switch advances no cursor", async () => {
  gatewayLog.clear();
  const source = new DeferredOutboxClearSource([
    makeSyncedSession(SESSION_ONE, UPDATED_AT_ONE),
  ]);
  source.seedSyncState(SOURCE_KEY_A, {
    observedTopUpdatedAt: CURSOR_AT_A,
    observedIdsAtTopUpdatedAt: [],
  });
  let computeTargetId = TARGET_A;
  let sendCount = 0;
  const service = makeService(
    source,
    () => computeTargetId,
    () => {
      sendCount += 1;
      return sendCount > 1
        ? never<DesktopAgentSessionsAck>()
        : Promise.resolve({ accepted: true });
    }
  );
  service.start();
  await source.clearCalled.promise;
  // The switch lands while the durable clear is outstanding — strictly after the
  // pre-`handleBatchAck` check has already passed.
  computeTargetId = TARGET_B;
  source.releaseClear.resolve({ deletedRowCount: 1 });
  await service.whenSessionSyncSettled();

  assert.deepEqual(
    source.advanceCalls.filter((call) => call.sourceKey === SOURCE_KEY_A),
    [],
    "an ack folded after the switch must not advance account A's durable cursor"
  );
});

/**
 * davetho review — the initial walk's post-seed cursor persist across a
 * `stop()` → `start()`, which is the interleaving the removed guard's rationale
 * did not survive. `stop()` clears the single-flight `syncing` flag, so B's pass
 * runs to completion and RESEEDS `observedTopUpdatedAt` while A's durable seed
 * is still outstanding; A's continuation then finds a non-null watermark again
 * and persists B's cursor state under A's captured key.
 */
test("ISS-8116: a seed that resolves after stop()/start() under a new identity persists no cursor for the old one", async () => {
  gatewayLog.clear();
  const source = new DeferredOutboxSeedSource([
    makeSyncedSession(SESSION_ONE, UPDATED_AT_ONE),
    makeSyncedSession(SESSION_TWO, UPDATED_AT_TWO),
  ]);
  let computeTargetId = TARGET_A;
  const service = makeService(
    source,
    () => computeTargetId,
    // B's pass must RUN TO COMPLETION while A's seed is parked, so its send
    // resolves rather than hanging; A never reaches a send at all.
    () => Promise.resolve({ accepted: true })
  );
  service.start();
  await source.seedCalled.promise;
  // The lifecycle A's continuation must survive: stopped, re-identified,
  // restarted. B's pass re-walks the same local corpus and reseeds the
  // watermark A's continuation is about to read.
  service.stop();
  computeTargetId = TARGET_B;
  service.start();
  await service.whenSessionSyncSettled();
  source.releaseSeed.resolve();
  await awaitStaleContinuation(
    source.seedResumed.promise,
    "account A's parked outbox seed to resume"
  );

  assert.deepEqual(
    source.advanceCalls.filter((call) => call.sourceKey === SOURCE_KEY_A),
    [],
    "B's cursor state must never be persisted under A's captured source key"
  );
});

/**
 * tamsinb review — `deadLetterOversizedLocalSession` took the pass guard in its
 * deps bag and never read it, so an identity that moved across the oversize scan
 * still wrote a durable `dead_lettered` row under the previous account's key.
 */
test("ISS-8116: an oversize scan that resolves after a target switch dead-letters nothing", async () => {
  gatewayLog.clear();
  const source = new DeferredOversizeScanSource([
    makeSyncedSession(SESSION_ONE, UPDATED_AT_ONE),
  ]);
  source.seedOutbox(SOURCE_KEY_A, SESSION_ONE);
  let computeTargetId = TARGET_A;
  const service = makeService(
    source,
    () => computeTargetId,
    () => never<DesktopAgentSessionsAck>()
  );
  service.start();
  await source.scanCalled.promise;
  computeTargetId = TARGET_B;
  source.releaseScan.resolve([
    { id: SESSION_ONE, payloadBytes: OVERSIZED_PAYLOAD_BYTES },
  ]);
  await service.whenSessionSyncSettled();

  const row = [...source.outbox.values()].find(
    (entry) => entry.sourceKey === SOURCE_KEY_A && entry.id === SESSION_ONE
  );
  assert.equal(
    row?.status,
    OutboxStatus.Pending,
    "an oversize proven under account A must not dead-letter its durable row once B is the live target"
  );
});

/**
 * davetho review — the hydration applied its OWN results unguarded. The
 * caller's post-hydration check cannot see this: `stop()` clears the
 * single-flight `syncing` flag, so B's pass hydrates and runs while A's cursor
 * load is parked, and A's continuation then writes A's watermark, A's
 * dead-letter set and A's `hydratedSourceKey`/`sourceDerivedStateKey` markers
 * over B's live ones.
 */
test("ISS-8116: a cursor load that resolves after stop()/start() seeds nothing into the new identity", async () => {
  gatewayLog.clear();
  const source = new DeferredCursorLoadSource([
    makeSyncedSession(SESSION_ONE, UPDATED_AT_ONE),
  ]);
  let computeTargetId = TARGET_A;
  const service = makeService(
    source,
    () => computeTargetId,
    // As above: B's pass must settle, so its send resolves. A's pass never gets
    // past the parked cursor load.
    () => Promise.resolve({ accepted: true })
  );
  service.start();
  await source.loadCalled.promise;
  service.stop();
  computeTargetId = TARGET_B;
  service.start();
  await service.whenSessionSyncSettled();
  // A's persisted cursor arrives with a dead-letter set attached — the state
  // that used to land in the maps B's pass is already reading from.
  source.releaseLoad.resolve({
    observedTopUpdatedAt: CURSOR_AT_A,
    observedIdsAtTopUpdatedAt: [],
    deadLetteredIds: [SESSION_TWO],
  });
  await awaitStaleContinuation(
    source.loadResumed.promise,
    "account A's parked cursor load to resume"
  );

  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    0,
    "account A's dead-letter set must not be seeded into account B's live lane"
  );
  assert.notEqual(
    service.getSyncProgress().readyIncrementalSessions,
    null,
    "and a discarded hydration must not stamp A's marker over B's — the counts go null the moment the live key and the hydrated one disagree"
  );
});
