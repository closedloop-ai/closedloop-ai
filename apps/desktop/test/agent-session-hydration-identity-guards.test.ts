/**
 * @file agent-session-hydration-identity-guards.test.ts
 * @description ISS-7988 — the three remaining awaits in
 * `hydratePersistedCursorIfNeeded` that wrote live or durable state for a
 * possibly-superseded identity.
 *
 * `hydratePersistedCursorIfNeeded` captures `sourceKey` ONCE at the top and
 * reuses it for the whole function. A compute-target/account switch changes
 * identity WITHOUT bumping the source-state generation, so
 * `isCurrentSourceState` alone cannot see it — which is why every REFUSAL case
 * here flips the compute target mid-await and nothing else. If the generation
 * half were sufficient, those cases would be unreachable.
 *
 * Each refusal has a POSITIVE sibling on the same fixture with the switch
 * removed, so none of them can pass vacuously — the allow path must produce the
 * exact state the refusal forbids.
 *
 * Three cases deliberately break that restriction, and say so where they sit:
 * the generation-half case and the compare-and-swap's false-positive case both
 * need a `stop()` (nothing else moves the generation while leaving the key
 * alone), and the site-2 re-arm case drops the SOCKET rather than the identity.
 *
 * The suite is the ISS-6067 pattern (`agent-session-sync-stale-continuation.test.ts`)
 * applied to the three sites that PR #5920 deliberately left alone. The RE-ARM
 * cases assert the other half of each discard: ISS-8116 landed the refusal
 * (abort the pass) at all four discards but the retraction
 * (`hydratedSourceKey`) at only two, so a discard could leave a marker
 * asserting reads that never landed.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import {
  type AgentSessionOutboxAdoption,
  buildAgentSessionSyncSourceKey,
  type PersistedSyncState,
  type SessionOutboxEngineState,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  awaitStaleContinuation,
  flushAgentSessionSync,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const TARGET_A = "target-iss-7988-account-a";
const TARGET_B = "target-iss-7988-account-b";
const SOURCE_KEY_A = buildAgentSessionSyncSourceKey(TARGET_A);
const IDENTITY = { organizationId: "org-iss-7988", userId: "user-iss-7988" };

/** Present locally and never synced; only a full walk can reach it. */
const SESSION_UNDER_B = "session-present-only-under-account-b";
/** A row account A abandoned; A's persisted cursor carries it. */
const DEAD_UNDER_A = "session-dead-lettered-under-account-a";
const UPDATED_AT = "2026-08-20T03:29:06.102Z";
/** Account A's watermark, deliberately ABOVE {@link UPDATED_AT}. */
const CURSOR_AT_A = "2026-08-20T05:00:00.000Z";
/** A's persisted cursor, as its own `loadSyncState` read would answer it. */
const PERSISTED_UNDER_A: PersistedSyncState = {
  observedTopUpdatedAt: CURSOR_AT_A,
  observedIdsAtTopUpdatedAt: [DEAD_UNDER_A],
  deadLetteredIds: [DEAD_UNDER_A],
};

/** A session A had deferred behind a persisted backoff. */
const BACKED_OFF_SESSION = "session-backed-off-under-account-a";
/** Far enough ahead that `pickReadyCandidates` defers it for the whole run. */
const NEXT_ATTEMPT_AT = "2099-01-01T00:00:00.000Z";

const EMPTY_ADOPTION: AgentSessionOutboxAdoption = {
  adoptedIds: [],
  declined: 0,
  skippedAlreadyLive: 0,
  retiredSourceKeys: 0,
  parkedRows: 0,
};

/** A promise plus the handle to settle it from the test body. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Site 1 — the durable-cursor read. Only the FIRST read is deferred; a later
 * pass (under whichever identity survives) answers from the seeded map, so a
 * queue/scan assertion can never be satisfied by a second deferred read that
 * the test forgot to release.
 */
class DeferredSyncStateSource extends FakeSyncSource {
  readonly readCalled = deferred<void>();
  readonly releaseRead = deferred<PersistedSyncState | null>();
  syncStateReadCount = 0;

  override loadSyncState(
    sourceKey: string
  ): PersistedSyncState | null | Promise<PersistedSyncState | null> {
    this.syncStateReadCount += 1;
    if (this.syncStateReadCount > 1) {
      return super.loadSyncState(sourceKey);
    }
    this.readCalled.resolve();
    return this.releaseRead.promise;
  }
}

/**
 * Site 1, but with the SECOND read deferred as well, so a test can hydrate one
 * identity outright and then interleave a switch inside the NEXT identity's
 * cursor read. That is the only way to reach the site-1 discard with a
 * previously-hydrated identity still sitting in `hydratedSourceKey`.
 */
class TwoDeferredSyncStateSource extends FakeSyncSource {
  readonly firstRead = deferred<void>();
  readonly releaseFirst = deferred<PersistedSyncState | null>();
  readonly secondRead = deferred<void>();
  readonly releaseSecond = deferred<PersistedSyncState | null>();
  syncStateReadCount = 0;

  override loadSyncState(
    sourceKey: string
  ): PersistedSyncState | null | Promise<PersistedSyncState | null> {
    this.syncStateReadCount += 1;
    if (this.syncStateReadCount === 1) {
      this.firstRead.resolve();
      return this.releaseFirst.promise;
    }
    if (this.syncStateReadCount === 2) {
      this.secondRead.resolve();
      return this.releaseSecond.promise;
    }
    return super.loadSyncState(sourceKey);
  }
}

/** Site 2 — the persisted retry-budget read, deferred on its first call. */
class DeferredRetryStateSource extends FakeSyncSource {
  readonly readCalled = deferred<void>();
  /** Resolved once the PARKED read has actually resumed (see `awaitStaleContinuation`). */
  readonly readResumed = deferred<void>();
  readonly releaseRead = deferred<SessionOutboxEngineState[]>();
  retryStateReadCount = 0;

  override async loadPendingSessionOutboxEngineState(
    sourceKey: string
  ): Promise<SessionOutboxEngineState[]> {
    this.retryStateReadCount += 1;
    if (this.retryStateReadCount > 1) {
      return await super.loadPendingSessionOutboxEngineState(sourceKey);
    }
    this.readCalled.resolve();
    const rows = await this.releaseRead.promise;
    this.readResumed.resolve();
    return rows;
  }
}

/**
 * Site 3 — the stranded-outbox adoption. The base fixture does not implement
 * this delegate at all (so `adoptStrandedOutboxRows` returns before its await
 * for every other suite); declaring it here is what makes the await exist.
 *
 * `loadSyncStateCalls` is the observable: the adoption is the FIRST await in
 * `hydratePersistedCursorIfNeeded`, so what a superseded continuation does next
 * is issue the durable-cursor read under the identity that just went away.
 */
class DeferredAdoptionSource extends FakeSyncSource {
  readonly adoptCalled = deferred<void>();
  readonly releaseAdopt = deferred<AgentSessionOutboxAdoption>();
  readonly loadSyncStateCalls: string[] = [];
  adoptionCount = 0;

  override loadSyncState(
    sourceKey: string
  ): PersistedSyncState | null | Promise<PersistedSyncState | null> {
    this.loadSyncStateCalls.push(sourceKey);
    return super.loadSyncState(sourceKey);
  }

  adoptOutboxRowsFromRetiredComputeTargets(): Promise<AgentSessionOutboxAdoption> {
    this.adoptionCount += 1;
    if (this.adoptionCount > 1) {
      return Promise.resolve(EMPTY_ADOPTION);
    }
    this.adoptCalled.resolve();
    return this.releaseAdopt.promise;
  }
}

function makeService(
  source: FakeSyncSource,
  getComputeTargetId: () => string,
  onBatch: (ids: string[]) => void,
  isHttpReady: () => boolean = () => true
): AgentSessionSyncService {
  return new AgentSessionSyncService({
    isHttpReady,
    getSource: () => source,
    getSyncComputeTargetId: getComputeTargetId,
    getSyncIdentity: () => IDENTITY,
    sendBatch: (batch) => {
      onBatch(batch.sessions.map((s) => s.externalSessionId));
      return Promise.resolve({ accepted: true as const });
    },
  });
}

/**
 * ISS-7988, SITE 1 REFUSAL — `await source.loadSyncState(sourceKey)`.
 *
 * The load is followed UNCONDITIONALLY by `hydratedSourceKey = sourceKey` and by
 * the seeding of `observedTopUpdatedAt` / `observedIdsAtTopUpdatedAt` /
 * `deadLetteredIds` — and `enqueueIncrementalUpdates` runs in the SAME pass, so
 * a superseded cursor read does not merely sit in a field: it steers the very
 * next read against the local store.
 *
 * The assertion is on that consequence rather than on a private field. Account
 * A's watermark reaching `listUpdatedSessionCursorRows` means account B's
 * incremental scan was issued at account A's position — and because
 * {@link SESSION_UNDER_B} sits BELOW that watermark, a session present in the
 * local store is skipped by the account that owns it.
 */
test("ISS-7988: a durable-cursor read that resolves after a target switch must not seed the new identity", async () => {
  gatewayLog.clear();
  const source = new DeferredSyncStateSource([
    makeSyncedSession(SESSION_UNDER_B, UPDATED_AT),
  ]);
  source.seedSyncState(SOURCE_KEY_A, PERSISTED_UNDER_A);
  let computeTargetId = TARGET_A;
  const sent: string[][] = [];
  const service = makeService(
    source,
    () => computeTargetId,
    (ids) => sent.push(ids)
  );

  service.start();
  await source.readCalled.promise;
  // The account switch lands while A's cursor read is outstanding. Nothing
  // bumps the source-state generation, so only a live source-key comparison
  // can see it.
  computeTargetId = TARGET_B;
  source.releaseRead.resolve(PERSISTED_UNDER_A);
  await service.whenSessionSyncSettled();

  assert.ok(
    !source.listUpdatedCursorCalls.some(
      (call) => call.sinceUpdatedAt === CURSOR_AT_A
    ),
    "account A's watermark must never drive an incremental scan issued under account B"
  );
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    0,
    "nor may account A's abandoned rows be set aside under account B"
  );
  service.stop();
});

/**
 * ISS-7988, SITE 1 ALLOW — the same fixture with the switch removed. This is
 * what makes the refusal above non-vacuous: the state it forbids is exactly the
 * state an unsuperseded read is REQUIRED to produce.
 */
test("ISS-7988: a durable-cursor read that resolves under an unchanged identity still seeds it", async () => {
  gatewayLog.clear();
  const source = new DeferredSyncStateSource([
    makeSyncedSession(SESSION_UNDER_B, UPDATED_AT),
  ]);
  source.seedSyncState(SOURCE_KEY_A, PERSISTED_UNDER_A);
  const sent: string[][] = [];
  const service = makeService(
    source,
    () => TARGET_A,
    (ids) => sent.push(ids)
  );

  service.start();
  await source.readCalled.promise;
  source.releaseRead.resolve(PERSISTED_UNDER_A);
  await service.whenSessionSyncSettled();

  assert.ok(
    source.listUpdatedCursorCalls.some(
      (call) => call.sinceUpdatedAt === CURSOR_AT_A
    ),
    "an unsuperseded cursor read must resume the incremental scan from the persisted watermark"
  );
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    1,
    "and must set the persisted dead-letter aside for its own identity"
  );
  service.stop();
});

/**
 * ISS-7988, SITE 1 RE-ARM — a discard must leave the identity able to hydrate
 * AGAIN, and the case that proves it is the live key coming BACK.
 *
 * Reaching the site-1 guard requires `sourceKey !== hydratedSourceKey`, so on
 * every pass after the first, `hydratedSourceKey` still names the PREVIOUS
 * identity — and this pass has already run `clearSourceDerivedState()` and
 * wiped that identity's cursor. A bare return therefore leaves a NON-NULL key
 * claiming "A is hydrated" over state that no longer exists, and the
 * top-of-function short-circuit then returns immediately on every subsequent
 * pass under A: its persisted cursor, its resumed dead-letters and its retry
 * budget are never read again for the life of the process.
 *
 * The key can return to A with no account switch at all — `sourceKey` folds the
 * `monitoredActivity` capability, so a hello-ack renegotiation moves it and
 * moves it back. The switch here is simply the cheapest way to drive that.
 */
test("ISS-7988: a discarded cursor read must leave the identity able to re-hydrate when the live key returns", async () => {
  gatewayLog.clear();
  const source = new TwoDeferredSyncStateSource([
    makeSyncedSession(SESSION_UNDER_B, UPDATED_AT),
  ]);
  source.seedSyncState(SOURCE_KEY_A, PERSISTED_UNDER_A);
  let computeTargetId = TARGET_A;
  const sent: string[][] = [];
  const service = makeService(
    source,
    () => computeTargetId,
    (ids) => sent.push(ids)
  );

  // Pass 1 hydrates A outright, so `hydratedSourceKey` names A from here on.
  service.start();
  await source.firstRead.promise;
  source.releaseFirst.resolve(PERSISTED_UNDER_A);
  await service.whenSessionSyncSettled();
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    1,
    "sanity: A hydrated, so its persisted dead-letter is set aside"
  );

  // Pass 2 runs under B. It clears A's derived state, then A comes BACK while
  // B's cursor read is still outstanding — so B's read is discarded, with
  // `hydratedSourceKey` still naming A over state that was just wiped.
  computeTargetId = TARGET_B;
  service.refresh();
  await source.secondRead.promise;
  computeTargetId = TARGET_A;
  source.releaseSecond.resolve(null);
  await service.whenSessionSyncSettled();
  const readsBeforeReturn = source.syncStateReadCount;

  // Pass 3, under A again. A stale `hydratedSourceKey` short-circuits this pass
  // and every later one.
  service.refresh();
  await service.whenSessionSyncSettled();

  assert.ok(
    source.syncStateReadCount > readsBeforeReturn,
    "account A must re-read its persisted cursor once the live key returns \u2014 a stale hydrated key strands it for the life of the process"
  );
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    1,
    "and the re-read must actually re-seed A's persisted dead-letter, which B's pass had cleared"
  );
  service.stop();
});

/**
 * ISS-7988, GENERATION HALF — the other half of the guard, which no
 * target-switch case can exercise.
 *
 * `stop()` bumps the source-state generation and leaves the LIVE compute target
 * untouched, so the source-key comparison cannot see it; only
 * `isCurrentSourceState()` can. Without this case, reducing
 * `createSyncPassIdentityGuard` to the key comparison alone keeps every other
 * test in this file green while letting a `stop()` that lands mid-load re-seed
 * the cursor, the dead-letters and the hydrated key into a service
 * `resetSourceState()` had just cleared — state that survives into the next
 * `start()`.
 */
test("ISS-7988: a cursor read that resolves after stop() must not seed the service it was reset out of", async () => {
  gatewayLog.clear();
  const source = new DeferredSyncStateSource([
    makeSyncedSession(SESSION_UNDER_B, UPDATED_AT),
  ]);
  source.seedSyncState(SOURCE_KEY_A, PERSISTED_UNDER_A);
  const sent: string[][] = [];
  const service = makeService(
    source,
    () => TARGET_A,
    (ids) => sent.push(ids)
  );

  service.start();
  await source.readCalled.promise;
  // No identity change whatsoever — only the generation moves.
  service.stop();
  source.releaseRead.resolve(PERSISTED_UNDER_A);
  // `stop()` clears the in-flight pass handle, so `whenSessionSyncSettled()`
  // returns BEFORE the released continuation has run and would sample the
  // service too early — green because nothing had happened yet. Pump the phases
  // the continuation actually resumes on instead.
  await flushAgentSessionSync();
  await flushAgentSessionSync();

  // A STOPPED service must hold none of what the superseded read carried.
  // `resetSourceState()` cleared the cursor and the dead-letters; the seeding
  // this read would do puts them straight back, and the same pass then promotes
  // the resumed dead-letter onto the backfill lane — queued work inside a lane
  // that was shut down. Asserted on the queues rather than on the dead-letter
  // count alone, because the promotion MOVES the id between the two and an
  // assertion on either one by itself reads as green while the other holds it.
  const progress = service.getSyncProgress();
  assert.equal(
    progress.pendingBackfillSessions,
    0,
    "a read that resolves into a reset service must not queue work in it"
  );
  assert.equal(
    progress.deadLetteredSessions,
    0,
    "nor re-seed the dead-letters that reset just cleared"
  );
});

/**
 * ISS-7988, SITE 2 REFUSAL — `await source.loadPendingSessionOutboxEngineState(sourceKey)`.
 *
 * `rehydrateSessionOutboxEngineState` follows it unconditionally and seeds
 * `nextRetryAfterMs` keyed by SESSION ID. Session ids are device-local and
 * shared across identities — the same local store serves both accounts — so
 * account A's persisted backoff deadline, applied under account B, withholds a
 * session B should be uploading now.
 *
 * No cursor is seeded here on purpose: with `observedTopUpdatedAt` left null the
 * corpus walk is the only thing that can queue the session, so the deferral is
 * unambiguously the rehydrated deadline rather than a watermark leaked by site 1.
 *
 * PR #5995 review: the assertion is unchanged, but B's upload is now observed on
 * B's OWN pass. The discard used to re-arm and return `true`, letting the very
 * pass that was discarded go on to scan and send — which is the defect whitlockk and
 * the Codex P1 named — so it now abandons the pass instead. `refresh()` is what
 * the real poll/readiness path does next; the contract this test owns (A's
 * persisted deadline must never withhold a session under B) is asserted exactly
 * as before, and its ALLOW sibling below still proves the withheld state is
 * reachable, so this cannot pass vacuously.
 */
test("ISS-7988: a retry-state read that resolves after a target switch must not seed the new identity's backoff", async () => {
  gatewayLog.clear();
  const source = new DeferredRetryStateSource([
    makeSyncedSession(BACKED_OFF_SESSION, UPDATED_AT),
  ]);
  source.recordOutboxRetry(
    SOURCE_KEY_A,
    BACKED_OFF_SESSION,
    3,
    NEXT_ATTEMPT_AT,
    "ingestion_failed",
    null
  );
  let computeTargetId = TARGET_A;
  const sent: string[][] = [];
  const service = makeService(
    source,
    () => computeTargetId,
    (ids) => sent.push(ids)
  );

  service.start();
  await source.readCalled.promise;
  computeTargetId = TARGET_B;
  source.releaseRead.resolve([
    {
      id: BACKED_OFF_SESSION,
      attemptCount: 3,
      permanentAttemptCount: 0,
      deadLetterRecoveryCount: 0,
      nextAttemptAt: NEXT_ATTEMPT_AT,
      lastError: "ingestion_failed",
      laneStalledSince: null,
    },
  ]);
  await service.whenSessionSyncSettled();
  // The discarded pass is abandoned, so B's upload lands on B's own next pass.
  service.refresh();
  await service.whenSessionSyncSettled();

  assert.ok(
    sent.flat().includes(BACKED_OFF_SESSION),
    "account B must upload its own session rather than inherit account A's persisted backoff"
  );
  service.stop();
});

/**
 * ISS-7988, SITE 2 ALLOW — same fixture, no switch. The persisted backoff is
 * account A's own, so it MUST be honoured: the session is queued and withheld,
 * which is the precise state the refusal above requires to be absent.
 */
test("ISS-7988: a retry-state read that resolves under an unchanged identity still honours the persisted backoff", async () => {
  gatewayLog.clear();
  const source = new DeferredRetryStateSource([
    makeSyncedSession(BACKED_OFF_SESSION, UPDATED_AT),
  ]);
  source.recordOutboxRetry(
    SOURCE_KEY_A,
    BACKED_OFF_SESSION,
    3,
    NEXT_ATTEMPT_AT,
    "ingestion_failed",
    null
  );
  const sent: string[][] = [];
  const service = makeService(
    source,
    () => TARGET_A,
    (ids) => sent.push(ids)
  );

  service.start();
  await source.readCalled.promise;
  source.releaseRead.resolve([
    {
      id: BACKED_OFF_SESSION,
      attemptCount: 3,
      permanentAttemptCount: 0,
      deadLetterRecoveryCount: 0,
      nextAttemptAt: NEXT_ATTEMPT_AT,
      lastError: "ingestion_failed",
      laneStalledSince: null,
    },
  ]);
  await service.whenSessionSyncSettled();

  assert.ok(
    !sent.flat().includes(BACKED_OFF_SESSION),
    "an unsuperseded retry-state read must defer the row its own persisted deadline covers"
  );
  assert.equal(
    service.getSyncProgress().pendingBackfillSessions,
    1,
    "and the row stays queued rather than being dropped"
  );
  service.stop();
});

/**
 * ISS-7988, SITE 2 RE-ARM — and the case that proves it is a DROPPED SOCKET,
 * not an identity change.
 *
 * `isCurrentSourceState()` closes over `shouldRun()`, so it goes false while the
 * identity is untouched and nothing clears the hydrated key on its own. Because
 * every other case in this file supersedes by flipping the compute target, the
 * next pass re-hydrates anyway and the re-arm is never the reason — deleting
 * `setHydratedSourceKey(null)` at the site-2 discard leaves them all green. What
 * it strands is the once-per-identity persisted retry budget, for the life of
 * the process. Mirrors the ISS-6067 reconnect case that exists for the resume
 * re-enqueue and had no counterpart for the retry read.
 */
test("ISS-7988: a retry-state read discarded on a dropped socket is re-read after reconnect", async () => {
  gatewayLog.clear();
  const source = new DeferredRetryStateSource([
    makeSyncedSession(BACKED_OFF_SESSION, UPDATED_AT),
  ]);
  source.recordOutboxRetry(
    SOURCE_KEY_A,
    BACKED_OFF_SESSION,
    3,
    NEXT_ATTEMPT_AT,
    "ingestion_failed",
    null
  );
  let httpReady = true;
  const sent: string[][] = [];
  const service = makeService(
    source,
    () => TARGET_A,
    (ids) => sent.push(ids),
    () => httpReady
  );

  service.start();
  await source.readCalled.promise;
  // The socket drops while the retry-state read is outstanding. No stop(), no
  // identity change — only `shouldRun()` flips.
  httpReady = false;
  source.releaseRead.resolve([
    {
      id: BACKED_OFF_SESSION,
      attemptCount: 3,
      permanentAttemptCount: 0,
      deadLetterRecoveryCount: 0,
      nextAttemptAt: NEXT_ATTEMPT_AT,
      lastError: "ingestion_failed",
      laneStalledSince: null,
    },
  ]);
  await service.whenSessionSyncSettled();
  assert.equal(
    source.retryStateReadCount,
    1,
    "sanity: while the socket is down no further pass reads the retry state"
  );

  httpReady = true;
  service.refresh();
  await service.whenSessionSyncSettled();

  assert.ok(
    source.retryStateReadCount >= 2,
    "the discarded retry-state read must be retried once the socket returns, not skipped for the life of the process"
  );
  assert.ok(
    !sent.flat().includes(BACKED_OFF_SESSION),
    "and the re-read budget must be honoured \u2014 the row stays deferred behind its persisted deadline"
  );
  service.stop();
});

/**
 * ISS-7988, SITE 3 REFUSAL — `await adoptStrandedOutboxRows(...)`.
 *
 * The adoption is the FIRST await in the function, so the captured key is live
 * at the moment the durable re-key is ISSUED; what a superseded continuation
 * does is carry that dead key onward. The observable is therefore the read it
 * would issue next: a `loadSyncState` for account A's key, taken while account B
 * is the live identity.
 */
test("ISS-7988: a stranded-outbox adoption that resolves after a target switch must not continue under the old key", async () => {
  gatewayLog.clear();
  const source = new DeferredAdoptionSource([
    makeSyncedSession(SESSION_UNDER_B, UPDATED_AT),
  ]);
  source.seedSyncState(SOURCE_KEY_A, PERSISTED_UNDER_A);
  let computeTargetId = TARGET_A;
  const sent: string[][] = [];
  const service = makeService(
    source,
    () => computeTargetId,
    (ids) => sent.push(ids)
  );

  service.start();
  await source.adoptCalled.promise;
  computeTargetId = TARGET_B;
  source.releaseAdopt.resolve(EMPTY_ADOPTION);
  await service.whenSessionSyncSettled();

  assert.ok(
    !source.loadSyncStateCalls.includes(SOURCE_KEY_A),
    "a hydration whose identity moved during the adoption must not go on to read the superseded key's cursor"
  );
  service.stop();
});

/**
 * ISS-7988, SITE 3 ALLOW — same fixture, no switch. The continuation is exactly
 * the read the refusal forbids, so an unsuperseded adoption must produce it.
 */
test("ISS-7988: a stranded-outbox adoption that resolves under an unchanged identity continues the hydration", async () => {
  gatewayLog.clear();
  const source = new DeferredAdoptionSource([
    makeSyncedSession(SESSION_UNDER_B, UPDATED_AT),
  ]);
  source.seedSyncState(SOURCE_KEY_A, PERSISTED_UNDER_A);
  const sent: string[][] = [];
  const service = makeService(
    source,
    () => TARGET_A,
    (ids) => sent.push(ids)
  );

  service.start();
  await source.adoptCalled.promise;
  source.releaseAdopt.resolve(EMPTY_ADOPTION);
  await service.whenSessionSyncSettled();

  assert.ok(
    source.loadSyncStateCalls.includes(SOURCE_KEY_A),
    "an unsuperseded adoption must go on to hydrate its own identity's cursor"
  );
  service.stop();
});

/**
 * ISS-7988, SITE 2 REFUSAL — THE REST OF THE PASS (PR #5995 review: whitlockk, and
 * the same root cause the Codex P1 raised).
 *
 * The site-2 refusal above deliberately seeds NO cursor, so it proves only that
 * the superseded BUDGET is not applied. It cannot see the larger half: re-arming
 * `hydratedSourceKey` says nothing about the pass that is still running. By the
 * time the retry read resolves, `applyResumedCursor` has already put account
 * A's watermark and dead-letters in memory — so a discard that merely re-armed
 * without also aborting the pass handed the caller straight on to
 * `initializeBackfillQueueIfNeeded` (which short-circuits on any non-null
 * `observedTopUpdatedAt`), `enqueueIncrementalUpdates` and
 * `promoteDeadLetterIfIdle`. Account B then skipped its full walk and scanned at
 * account A's position.
 *
 * The assertion is on that consequence: A's watermark reaching
 * `listUpdatedSessionCursorRows` after the target has moved to B means B's
 * incremental scan was issued at A's position, and {@link SESSION_UNDER_B} sits
 * BELOW that watermark. That the NEXT pass clears A's derived state does not
 * un-run this one.
 */
test("ISS-7988: a retry-state read discarded after the cursor seeded must abandon the pass, not just re-arm", async () => {
  gatewayLog.clear();
  const source = new DeferredRetryStateSource([
    makeSyncedSession(SESSION_UNDER_B, UPDATED_AT),
  ]);
  // The cursor the site-2 refusal above leaves empty. Seeded under A, it is in
  // memory before the retry read is even issued.
  source.seedSyncState(SOURCE_KEY_A, PERSISTED_UNDER_A);
  let computeTargetId = TARGET_A;
  const sent: string[][] = [];
  const service = makeService(
    source,
    () => computeTargetId,
    (ids) => sent.push(ids)
  );

  service.start();
  await source.readCalled.promise;
  computeTargetId = TARGET_B;
  source.releaseRead.resolve([]);
  await service.whenSessionSyncSettled();

  assert.ok(
    !source.listUpdatedCursorCalls.some(
      (call) => call.sinceUpdatedAt === CURSOR_AT_A
    ),
    "account A's watermark must never drive an incremental scan issued under account B"
  );
  service.stop();
});

/**
 * ISS-7988, SITE 2 ALLOW (rest-of-pass sibling) — the same fixture with the
 * switch removed. This is what makes the refusal above non-vacuous: resuming the
 * incremental scan at the persisted watermark is exactly what an unsuperseded
 * hydration is REQUIRED to do, so the refusal is forbidding a state the code can
 * demonstrably reach rather than one it never produces.
 */
test("ISS-7988: a retry-state read that resolves unsuperseded still resumes at the persisted watermark", async () => {
  gatewayLog.clear();
  const source = new DeferredRetryStateSource([
    makeSyncedSession(SESSION_UNDER_B, UPDATED_AT),
  ]);
  source.seedSyncState(SOURCE_KEY_A, PERSISTED_UNDER_A);
  const sent: string[][] = [];
  const service = makeService(
    source,
    () => TARGET_A,
    (ids) => sent.push(ids)
  );

  service.start();
  await source.readCalled.promise;
  source.releaseRead.resolve([]);
  await service.whenSessionSyncSettled();

  assert.ok(
    source.listUpdatedCursorCalls.some(
      (call) => call.sinceUpdatedAt === CURSOR_AT_A
    ),
    "an unsuperseded hydration must resume the incremental scan from its own persisted watermark"
  );
  service.stop();
});

/**
 * ISS-7988, THE COMPARE-AND-SWAP'S ONE FALSE POSITIVE — bounded here rather
 * than left as a belief.
 *
 * The re-arm is a compare-and-swap on `hydratedSourceKey` so a discard can only
 * retract the marker it is responsible for. One ordering defeats the comparison
 * honestly: `stop()` nulls the marker AND bumps the generation, so a `start()`
 * under the SAME key re-hydrates and stamps that key afresh while the first
 * pass is still parked. The parked continuation then reads back a marker equal
 * to the one it owned and re-arms a hydration that did land.
 *
 * It is reachable — this test reaches it — and the cost is bounded to exactly
 * one redundant re-hydration. That is the assertion: the seeded state SURVIVES
 * (the false-positive re-arm clears the marker, never the derived state), the
 * persisted backoff is still honoured, and the next pass re-reads rather than
 * being stranded. Every step of that re-read is idempotent, which is why this
 * is bounded waste and not a defect. Contrast the two alternatives: a bare
 * return strands the identity for the life of the process, and an unconditional
 * null clears a DIFFERENT identity's marker (`agent-session-sync-pass-identity-guards.test.ts`,
 * the stop()/start()-under-B case).
 */
test("ISS-7988: a re-arm that fires against a same-key re-hydration costs one redundant read and no state", async () => {
  gatewayLog.clear();
  const source = new DeferredRetryStateSource([
    makeSyncedSession(BACKED_OFF_SESSION, UPDATED_AT),
  ]);
  source.recordOutboxRetry(
    SOURCE_KEY_A,
    BACKED_OFF_SESSION,
    3,
    NEXT_ATTEMPT_AT,
    "ingestion_failed",
    null
  );
  const sent: string[][] = [];
  const service = makeService(
    source,
    () => TARGET_A,
    (ids) => sent.push(ids)
  );

  // Pass 1 parks in the retry read, having already stamped A's marker.
  service.start();
  await source.readCalled.promise;

  // `stop()` nulls the marker and bumps the generation; `start()` under the SAME
  // target re-hydrates A outright, stamping the very key pass 1 still owns.
  service.stop();
  service.start();
  await service.whenSessionSyncSettled();
  assert.equal(
    source.retryStateReadCount,
    2,
    "sanity: the restart re-hydrated the same identity rather than short-circuiting"
  );
  const readsBeforeReArm = source.retryStateReadCount;

  // Pass 1 resumes and re-arms — the comparison holds, but the marker it clears
  // is pass 2's.
  source.releaseRead.resolve([
    {
      id: BACKED_OFF_SESSION,
      attemptCount: 3,
      permanentAttemptCount: 0,
      deadLetterRecoveryCount: 0,
      nextAttemptAt: NEXT_ATTEMPT_AT,
      lastError: "ingestion_failed",
      laneStalledSince: null,
    },
  ]);
  await awaitStaleContinuation(
    source.readResumed.promise,
    "the parked retry-state read to resume"
  );

  assert.ok(
    !sent.flat().includes(BACKED_OFF_SESSION),
    "a false-positive re-arm clears the MARKER, never the derived state — the budget pass 2 seeded still defers the row"
  );

  service.refresh();
  await service.whenSessionSyncSettled();

  assert.ok(
    source.retryStateReadCount > readsBeforeReArm,
    "and the cost is a redundant re-read on the next pass, which is idempotent — not a stranded identity"
  );
  assert.ok(
    !sent.flat().includes(BACKED_OFF_SESSION),
    "the re-read re-seeds the same persisted deadline, so the row stays deferred across it"
  );
  service.stop();
});
