/**
 * @file persisted-cursor-hydration-coverage.test.ts
 * @description ISS-8730 coverage for `hydratePersistedCursor`
 * (`src/main/agent-sync/persisted-cursor-hydration.ts`) — the once-per-identity
 * hydration: adopt stranded outbox rows, load the durable cursor, apply it, and
 * resume the un-acked outbox prefix and its retry counters. Exercised directly
 * against a mocked `PersistedCursorHydrationDeps` rather than through
 * `AgentSessionSyncService`. Pins CURRENT behavior only; does not fix source.
 */
import assert from "node:assert/strict";
import {
  LaneGiveUpSource,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { test } from "vitest";
import type { SessionDispositionDeps } from "../src/main/agent-sync/agent-session-sync-dispositions.js";
import type {
  AgentSessionOutboxAdoption,
  AgentSessionSyncSource,
  PersistedSyncState,
  SessionOutboxEngineState,
  SyncContractCapabilities,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  type HydrationRetryCounters,
  hydratePersistedCursor,
  type PersistedCursorHydrationDeps,
} from "../src/main/agent-sync/persisted-cursor-hydration.js";
import { OutboxResumeOutcome } from "../src/main/agent-sync/session-outbox-engine-state.js";
import type { PersistedLaneRunRead } from "../src/main/sync/lane-run-policy.js";
import type { SignedInUserIdentity } from "../src/main/util/user-identity.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";

const NO_CAPABILITIES: SyncContractCapabilities = {
  spanExtent: false,
  humanTurnTimestamps: false,
  agentTurnTimestamps: false,
  tokenEventOwner: false,
};

const SYNC_STATE_UNAVAILABLE_ERROR = /sync_state unavailable/;

/** A mutable field with call recording, so CAS discards can be asserted precisely. */
function makeField(initial: string | null) {
  let value = initial;
  const calls: (string | null)[] = [];
  return {
    read: () => value,
    write: (next: string | null) => {
      calls.push(next);
      value = next;
    },
    calls,
    current: () => value,
  };
}

/**
 * A call-counted `isCurrentSourceState` gate: true for the first `trueForCalls`
 * calls, false afterward. `onFirstFalse` fires exactly once, at the moment the
 * gate first flips false — used to simulate a superseding pass writing its own
 * marker in the window between the guard check and the discard it triggers.
 */
function makeGate(trueForCalls: number, onFirstFalse?: () => void) {
  let calls = 0;
  let fired = false;
  return () => {
    calls += 1;
    const isTrue = calls <= trueForCalls;
    if (!(isTrue || fired)) {
      fired = true;
      onFirstFalse?.();
    }
    return isTrue;
  };
}

type SourceOverrides = {
  adoptOutboxRowsFromRetiredComputeTargets?: (
    sourceKey: string,
    identity: SignedInUserIdentity,
    environmentKey: string | null
  ) => Promise<AgentSessionOutboxAdoption>;
  loadSyncState?: (
    sourceKey: string,
    contract?: SyncContractCapabilities
  ) => Promise<PersistedSyncState | null>;
  loadPendingOutboxIds?: (sourceKey: string) => Promise<string[]>;
  loadPendingSessionOutboxEngineState?: (
    sourceKey: string
  ) => Promise<SessionOutboxEngineState[]>;
  loadPendingOutboxRetryState?: (
    sourceKey: string
  ) => Promise<SessionOutboxEngineState[]>;
};

function makeSource(overrides: SourceOverrides = {}): AgentSessionSyncSource {
  return {
    listAllSessionCursorRows: () => [],
    adoptOutboxRowsFromRetiredComputeTargets:
      overrides.adoptOutboxRowsFromRetiredComputeTargets,
    loadSyncState: overrides.loadSyncState,
    loadPendingOutboxIds: overrides.loadPendingOutboxIds,
    loadPendingSessionOutboxEngineState:
      overrides.loadPendingSessionOutboxEngineState,
    loadPendingOutboxRetryState: overrides.loadPendingOutboxRetryState,
  } as unknown as AgentSessionSyncSource;
}

function makeRetryCounters(): HydrationRetryCounters {
  return {
    ackOmitted: new Map(),
    ackTimeout: new Map(),
    unknownAckReason: new Map(),
    ingestionFailed: new Map(),
    rateLimited: new Map(),
    validationFailed: new Map(),
    nextRetryAfterMs: new Map(),
    laneStalledSinceMsById: new Map(),
    deadLetterRecoveryCountById: new Map(),
    ackOmittedCycleById: new Map(),
  };
}

type Harness = {
  deps: PersistedCursorHydrationDeps;
  hydratedField: ReturnType<typeof makeField>;
  derivedField: ReturnType<typeof makeField>;
  logs: string[];
  applyResumedCursorCalls: Array<{
    topUpdatedAt: string;
    ids: readonly string[];
  }>;
  clearSourceDerivedStateCalls: { count: number };
  enforceDeadLetterCapCalls: { count: number };
  feedIntoBackfillQueueCalls: string[][];
  onDurableWorkQueuedCalls: { count: number };
  dispositionIsCurrentSourceState: { value: boolean };
  /** PLN-2028: every lane-run record the hydration handed the lane. */
  adoptLaneRunCalls: (PersistedLaneRunRead | null | undefined)[];
};

type HarnessOverrides = {
  source?: AgentSessionSyncSource;
  isCurrentSourceState?: () => boolean;
  resolveLiveSourceKey?: () => string | null;
  hydratedOnEntry?: string | null;
  derivedStateOnEntry?: string | null;
  getSyncIdentity?: () => SignedInUserIdentity | null;
  getActiveEnvironmentKey?: () => string | null;
  feedIntoBackfillQueueReturns?: number;
};

function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const logs: string[] = [];
  const hydratedField = makeField(overrides.hydratedOnEntry ?? null);
  const derivedField = makeField(overrides.derivedStateOnEntry ?? null);
  const applyResumedCursorCalls: Array<{
    topUpdatedAt: string;
    ids: readonly string[];
  }> = [];
  const clearSourceDerivedStateCalls = { count: 0 };
  const enforceDeadLetterCapCalls = { count: 0 };
  const feedIntoBackfillQueueCalls: string[][] = [];
  const onDurableWorkQueuedCalls = { count: 0 };
  const dispositionIsCurrentSourceState = { value: true };
  const adoptLaneRunCalls: (PersistedLaneRunRead | null | undefined)[] = [];

  const dispositionDeps: SessionDispositionDeps = {
    nextRetryAfterMs: new Map(),
    clearFailureStateForId: () => undefined,
    markDeadLettered: () => undefined,
    dequeue: () => undefined,
    queueSizes: () => ({ incremental: 0, backfill: 0, deadLettered: 0 }),
    logWarn: (message) => logs.push(message),
    logInfo: (message) => logs.push(message),
    emitDeadLetterTelemetry: () => undefined,
    persistCursorIfCaughtUp: () => undefined,
    scheduleImmediateDrainIfReadyWorkRemains: () => undefined,
    isTracked: () => false,
    feedIntoBackfillQueue: (ids) => {
      feedIntoBackfillQueueCalls.push(ids);
      return overrides.feedIntoBackfillQueueReturns ?? ids.length;
    },
    onDurableWorkQueued: () => {
      onDurableWorkQueuedCalls.count += 1;
    },
    parkForeignOutboxRows: () => undefined,
    markOutboxWithheld: () => undefined,
    isCurrentSourceState: () => dispositionIsCurrentSourceState.value,
    readSourceKey: () => hydratedField.read(),
  };

  const deps: PersistedCursorHydrationDeps = {
    source: overrides.source ?? makeSource(),
    isCurrentSourceState: overrides.isCurrentSourceState ?? (() => true),
    resolveLiveSourceKey: overrides.resolveLiveSourceKey ?? (() => "key-A"),
    readContract: () => NO_CAPABILITIES,
    readHydratedSourceKey: hydratedField.read,
    setHydratedSourceKey: hydratedField.write,
    readSourceDerivedStateKey: derivedField.read,
    setSourceDerivedStateKey: derivedField.write,
    clearSourceDerivedState: () => {
      clearSourceDerivedStateCalls.count += 1;
    },
    syncOptions: {
      getSyncIdentity: overrides.getSyncIdentity,
      getActiveEnvironmentKey: overrides.getActiveEnvironmentKey,
    },
    applyResumedCursor: (topUpdatedAt, ids) => {
      applyResumedCursorCalls.push({ topUpdatedAt, ids });
    },
    adoptLaneRun: (persisted) => {
      adoptLaneRunCalls.push(persisted);
    },
    deadLetteredIds: new Map(),
    enforceDeadLetterCap: () => {
      enforceDeadLetterCapCalls.count += 1;
    },
    dispositionDeps: () => dispositionDeps,
    retryCounters: makeRetryCounters(),
    logInfo: (message) => logs.push(message),
    logWarn: (message) => logs.push(message),
  };

  return {
    deps,
    hydratedField,
    derivedField,
    logs,
    applyResumedCursorCalls,
    clearSourceDerivedStateCalls,
    enforceDeadLetterCapCalls,
    feedIntoBackfillQueueCalls,
    onDurableWorkQueuedCalls,
    dispositionIsCurrentSourceState,
    adoptLaneRunCalls,
  };
}

// --- entry guard --------------------------------------------------------------

test("hydratePersistedCursor: a sourceKey already hydrated is a full no-op", async () => {
  let adoptCalled = false;
  const source = makeSource({
    adoptOutboxRowsFromRetiredComputeTargets: () => {
      adoptCalled = true;
      return Promise.resolve({
        adoptedIds: [],
        declined: 0,
        skippedAlreadyLive: 0,
        retiredSourceKeys: 0,
        parkedRows: 0,
      });
    },
  });
  const h = makeHarness({
    source,
    hydratedOnEntry: "key-A",
    resolveLiveSourceKey: () => "key-A",
    getSyncIdentity: () => ({ organizationId: "org-1", userId: "user-1" }),
  });

  await hydratePersistedCursor(h.deps);

  assert.equal(adoptCalled, false, "already-hydrated identity never adopts");
  assert.equal(h.clearSourceDerivedStateCalls.count, 0);
});

// --- identity-change derived state clearing --------------------------------

test("hydratePersistedCursor: an identity change clears derived state carried by a different prior key", async () => {
  const h = makeHarness({
    hydratedOnEntry: null,
    derivedStateOnEntry: "old-key",
    resolveLiveSourceKey: () => "new-key",
  });

  await hydratePersistedCursor(h.deps);

  assert.equal(h.clearSourceDerivedStateCalls.count, 1);
});

test("hydratePersistedCursor: a first-ever hydration (no prior derived state) never clears anything", async () => {
  const h = makeHarness({
    hydratedOnEntry: null,
    derivedStateOnEntry: null,
    resolveLiveSourceKey: () => "new-key",
  });

  await hydratePersistedCursor(h.deps);

  assert.equal(h.clearSourceDerivedStateCalls.count, 0);
});

// --- stranded-outbox adoption -----------------------------------------------

test("hydratePersistedCursor: adopts stranded outbox rows under the resolved sourceKey before hydrating", async () => {
  const adoptCalls: Array<{ sourceKey: string; envKey: string | null }> = [];
  const source = makeSource({
    adoptOutboxRowsFromRetiredComputeTargets: (
      sourceKey,
      _identity,
      envKey
    ) => {
      adoptCalls.push({ sourceKey, envKey });
      return Promise.resolve({
        adoptedIds: [],
        declined: 0,
        skippedAlreadyLive: 0,
        retiredSourceKeys: 0,
        parkedRows: 0,
      });
    },
  });
  const h = makeHarness({
    source,
    resolveLiveSourceKey: () => "key-A",
    getSyncIdentity: () => ({ organizationId: "org-1", userId: "user-1" }),
    getActiveEnvironmentKey: () => "env-1",
  });

  await hydratePersistedCursor(h.deps);

  assert.equal(adoptCalls.length, 1);
  assert.deepEqual(adoptCalls[0], { sourceKey: "key-A", envKey: "env-1" });
});

// --- ISS-8116/ISS-7988: pass-guard discard right after adopt ----------------

test("hydratePersistedCursor: a pass superseded right after adopt discards and retracts its inherited marker", async () => {
  const h = makeHarness({
    hydratedOnEntry: "old-key",
    derivedStateOnEntry: "old-key",
    resolveLiveSourceKey: () => "new-key",
    isCurrentSourceState: makeGate(0),
  });

  await hydratePersistedCursor(h.deps);

  assert.equal(
    h.hydratedField.current(),
    null,
    "the discard retracts the inherited old-identity marker"
  );
});

test("hydratePersistedCursor: a discard right after adopt never clobbers a newer pass's own marker", async () => {
  const h = makeHarness({
    hydratedOnEntry: "old-key",
    derivedStateOnEntry: "old-key",
    resolveLiveSourceKey: () => "new-key",
    isCurrentSourceState: makeGate(0, () => {
      // Simulate a superseding pass writing ITS OWN marker in the window
      // between this pass's guard check and its discard.
      h.hydratedField.write("key-B");
    }),
  });

  await hydratePersistedCursor(h.deps);

  assert.equal(
    h.hydratedField.current(),
    "key-B",
    "a discard must never overwrite a marker a later pass already wrote"
  );
});

// --- no identity / no persistence delegate ----------------------------------

test("hydratePersistedCursor: no sourceKey yet hydrates in-memory-only with null", async () => {
  // hydratedOnEntry must differ from the resolved (null) sourceKey, or the
  // top-of-function equality guard short-circuits before this branch runs —
  // e.g. a sign-out that drops a previously hydrated identity back to none.
  const h = makeHarness({
    hydratedOnEntry: "old-key",
    resolveLiveSourceKey: () => null,
  });

  await hydratePersistedCursor(h.deps);

  assert.deepEqual(h.hydratedField.calls, [null]);
  assert.equal(h.derivedField.current(), null);
});

test("hydratePersistedCursor: a sourceKey with no loadSyncState delegate hydrates in-memory-only with the real key", async () => {
  const h = makeHarness({
    resolveLiveSourceKey: () => "key-A",
    source: makeSource(), // no loadSyncState wired
  });

  await hydratePersistedCursor(h.deps);

  assert.deepEqual(h.hydratedField.calls, ["key-A"]);
  assert.equal(h.derivedField.current(), "key-A");
});

// --- loadSyncState success paths --------------------------------------------

test("hydratePersistedCursor: a persisted cursor with a top watermark seeds the resumed cursor and dead-letters", async () => {
  const source = makeSource({
    loadSyncState: () =>
      Promise.resolve({
        observedTopUpdatedAt: "2026-01-01T00:00:00.000Z",
        observedIdsAtTopUpdatedAt: ["id-1", "id-2"],
        deadLetteredIds: ["dead-1"],
      }),
  });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });

  await hydratePersistedCursor(h.deps);

  assert.equal(h.applyResumedCursorCalls.length, 1);
  assert.deepEqual(h.applyResumedCursorCalls[0], {
    topUpdatedAt: "2026-01-01T00:00:00.000Z",
    ids: ["id-1", "id-2"],
  });
  assert.equal(h.deps.deadLetteredIds.get("dead-1"), Number.POSITIVE_INFINITY);
  assert.equal(h.enforceDeadLetterCapCalls.count, 1);
  assert.ok(
    h.logs.some((m) =>
      m.includes("resumed agent-session sync from persisted cursor")
    )
  );
});

test("hydratePersistedCursor: a persisted cursor with no top watermark never seeds the resumed cursor", async () => {
  const source = makeSource({
    loadSyncState: () =>
      Promise.resolve({
        observedTopUpdatedAt: null,
        observedIdsAtTopUpdatedAt: [],
        deadLetteredIds: [],
      }),
  });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });

  await hydratePersistedCursor(h.deps);

  assert.equal(h.applyResumedCursorCalls.length, 0);
  assert.deepEqual(h.hydratedField.calls, ["key-A"]);
});

test("hydratePersistedCursor: no persisted cursor (fresh device) still completes hydration", async () => {
  const source = makeSource({ loadSyncState: () => Promise.resolve(null) });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });

  await hydratePersistedCursor(h.deps);

  assert.equal(h.applyResumedCursorCalls.length, 0);
  assert.deepEqual(h.hydratedField.calls, ["key-A"]);
});

// --- PLN-2028 durable lane run -----------------------------------------------

test("hydratePersistedCursor: hands ALL FOUR persisted lane-run fields to the lane", async () => {
  // The relaunch half of ISS-10053 and ISS-9963. The give-up alone is what
  // ISS-9418 adopted, and it is not enough: without the ORIGIN the 24h ceiling
  // restarts on every launch, and without the cause and the producer the resumed
  // give-up cannot say why it is held or whether it is lane-wide.
  const laneRun = {
    laneStalledSince: "2026-08-02T12:00:00.000Z",
    laneGaveUpAt: "2026-08-03T12:00:00.000Z",
    laneGaveUpReason: SyncReason.Unauthenticated,
    laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
  };
  const source = makeSource({
    loadSyncState: () =>
      Promise.resolve({
        observedTopUpdatedAt: null,
        observedIdsAtTopUpdatedAt: [],
        deadLetteredIds: [],
        ...laneRun,
      }),
  });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });

  await hydratePersistedCursor(h.deps);

  assert.equal(h.adoptLaneRunCalls.length, 1);
  const adopted = h.adoptLaneRunCalls[0];
  assert.equal(adopted?.laneStalledSince, laneRun.laneStalledSince);
  assert.equal(adopted?.laneGaveUpAt, laneRun.laneGaveUpAt);
  assert.equal(adopted?.laneGaveUpReason, laneRun.laneGaveUpReason);
  assert.equal(adopted?.laneGaveUpSource, laneRun.laneGaveUpSource);
});

test("hydratePersistedCursor: adopts a row with NO lane run too, rather than skipping", async () => {
  // Not a pedantic case. "Nothing on record" is what makes the lane's
  // change-detection able to suppress the clear a healthy lane's first accepted
  // batch issues — a hydration that skipped this would leave the belief unknown
  // and buy a redundant SQLite write on every boot.
  const source = makeSource({
    loadSyncState: () =>
      Promise.resolve({
        observedTopUpdatedAt: null,
        observedIdsAtTopUpdatedAt: [],
        deadLetteredIds: [],
      }),
  });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });

  await hydratePersistedCursor(h.deps);

  assert.equal(h.adoptLaneRunCalls.length, 1);
  const adopted = h.adoptLaneRunCalls[0];
  assert.equal(adopted?.laneStalledSince, undefined);
  assert.equal(adopted?.laneGaveUpAt, undefined);
  assert.equal(adopted?.laneGaveUpReason, undefined);
  assert.equal(adopted?.laneGaveUpSource, undefined);
});

test("hydratePersistedCursor: a rejecting loadSyncState propagates and leaves hydratedSourceKey unchanged", async () => {
  // Pinning CURRENT behavior: the await here is NOT wrapped in its own
  // try/catch, so a throw propagates out of this function. The module
  // docstring's "the next sync tick retries" story depends on a caller catching
  // it — hydratePersistedCursor itself does not. What the ISS-9823 re-review
  // added sits in `hydratePersistedCursorForPass`, which REPORTS the throw and
  // rethrows it unchanged, so this expectation is untouched by that fix.
  const source = makeSource({
    loadSyncState: () => Promise.reject(new Error("sync_state unavailable")),
  });
  const h = makeHarness({
    source,
    hydratedOnEntry: null,
    resolveLiveSourceKey: () => "key-A",
  });

  await assert.rejects(
    () => hydratePersistedCursor(h.deps),
    SYNC_STATE_UNAVAILABLE_ERROR
  );
  assert.equal(h.hydratedField.current(), null);
});

// --- ISS-8116/ISS-7988: pass-guard discard right after loadSyncState -------

test("hydratePersistedCursor: a pass superseded right after loadSyncState discards without marking hydrated", async () => {
  const source = makeSource({
    loadSyncState: () =>
      Promise.resolve({
        observedTopUpdatedAt: "2026-01-01T00:00:00.000Z",
        observedIdsAtTopUpdatedAt: [],
        deadLetteredIds: [],
      }),
  });
  const h = makeHarness({
    source,
    hydratedOnEntry: null,
    resolveLiveSourceKey: () => "key-A",
    isCurrentSourceState: makeGate(1), // true for the adopt-check, false after
  });

  await hydratePersistedCursor(h.deps);

  assert.equal(
    h.hydratedField.current(),
    null,
    "the load succeeded but the pass was superseded before it could apply"
  );
  assert.equal(h.applyResumedCursorCalls.length, 0);
});

test("hydratePersistedCursor: dead-letter ids already tracked are not reset to a new deadline", async () => {
  const source = makeSource({
    loadSyncState: () =>
      Promise.resolve({
        observedTopUpdatedAt: "2026-01-01T00:00:00.000Z",
        observedIdsAtTopUpdatedAt: [],
        deadLetteredIds: ["dead-1"],
      }),
  });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });
  h.deps.deadLetteredIds.set("dead-1", 42);

  await hydratePersistedCursor(h.deps);

  assert.equal(
    h.deps.deadLetteredIds.get("dead-1"),
    42,
    "an already-tracked id keeps its existing deadline"
  );
});

// --- resumeDurableOutboxState: outbox resume --------------------------------

test("resumeDurableOutboxState: no loadPendingOutboxIds delegate completes hydration without erroring", async () => {
  const source = makeSource({ loadSyncState: () => Promise.resolve(null) });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });

  await hydratePersistedCursor(h.deps);

  assert.deepEqual(h.hydratedField.calls, ["key-A"]);
});

test("resumeDurableOutboxState: a successful outbox resume re-enqueues the un-acked prefix", async () => {
  const source = makeSource({
    loadSyncState: () => Promise.resolve(null),
    loadPendingOutboxIds: () => Promise.resolve(["sess-1", "sess-2"]),
  });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });

  await hydratePersistedCursor(h.deps);

  assert.deepEqual(h.feedIntoBackfillQueueCalls, [["sess-1", "sess-2"]]);
  assert.equal(h.onDurableWorkQueuedCalls.count, 1);
  assert.ok(
    h.logs.some((m) => m.includes("re-enqueued 2 un-acked agent session"))
  );
});

test("resumeDurableOutboxState: a discarded outbox resume re-arms the marker and skips retry-state seeding", async () => {
  let retryStateCalled = false;
  const source = makeSource({
    loadSyncState: () => Promise.resolve(null),
    loadPendingOutboxIds: () => Promise.resolve(["sess-1"]),
    loadPendingSessionOutboxEngineState: () => {
      retryStateCalled = true;
      return Promise.resolve([]);
    },
  });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });
  // Isolate the discard to the DISPOSITION-level guard the resume read checks
  // (`requeueResumeOutboxIds`'s own `deps.isCurrentSourceState`), leaving the
  // outer PersistedCursorHydrationDeps guard true throughout.
  h.dispositionIsCurrentSourceState.value = false;

  const hydrated = await hydratePersistedCursor(h.deps);

  // ISS-8594 CHANGED this arm rather than restating it. The harness flips only
  // the disposition-level guard, leaving the outer `PersistedCursorHydrationDeps`
  // guard true, so `isCurrentSourceState()` at the service call site still reads
  // true and the old code carried this pass on to selection. A non-`Seeded`
  // outcome abandons it.
  //
  // ISS-9823 narrowed the assertion from `false` to WHICH non-`Seeded` answer:
  // this arm is a superseded identity, so it must be `Discarded`. Answering
  // `ReadFailed` here would report a resume-blocked lane on every account switch.
  assert.equal(hydrated, OutboxResumeOutcome.Discarded);
  assert.equal(
    h.hydratedField.current(),
    null,
    "the un-acked prefix could not be confirmed, so the identity is re-armed"
  );
  assert.equal(
    retryStateCalled,
    false,
    "retry-state seeding must not run for a discarded identity"
  );
});

// --- resumeDurableOutboxState: retry-state seeding --------------------------

test("resumeDurableOutboxState: no loadPendingSessionOutboxEngineState delegate completes without seeding counters", async () => {
  const source = makeSource({
    loadSyncState: () => Promise.resolve(null),
    loadPendingOutboxIds: () => Promise.resolve([]),
  });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });

  await hydratePersistedCursor(h.deps);

  assert.equal(h.hydratedField.current(), "key-A");
  assert.equal(h.deps.retryCounters.ingestionFailed.size, 0);
});

test("resumeDurableOutboxState: legacy loadPendingOutboxRetryState delegate still seeds counters", async () => {
  const source = makeSource({
    loadSyncState: () => Promise.resolve(null),
    loadPendingOutboxIds: () => Promise.resolve([]),
    loadPendingOutboxRetryState: () =>
      Promise.resolve([
        {
          id: "sess-legacy",
          attemptCount: 4,
          permanentAttemptCount: 0,
          deadLetterRecoveryCount: 0,
          nextAttemptAt: "2026-01-01T00:10:00.000Z",
          lastError: "ingestion_failed",
          laneStalledSince: null,
        },
      ]),
  });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });

  const hydrated = await hydratePersistedCursor(h.deps);

  assert.equal(h.deps.retryCounters.ingestionFailed.get("sess-legacy"), 4);
  assert.equal(
    h.deps.retryCounters.nextRetryAfterMs.get("sess-legacy"),
    Date.parse("2026-01-01T00:10:00.000Z")
  );
  assert.equal(hydrated, OutboxResumeOutcome.Seeded);
});

test("resumeDurableOutboxState: db-host proxy loader uses the legacy alias without .call", async () => {
  const calls: string[] = [];
  const legacyLoader = dbHostStyleLoader((sourceKey) => {
    calls.push(`legacy:${sourceKey}`);
    return Promise.resolve([
      {
        id: "sess-legacy-proxy",
        attemptCount: 2,
        permanentAttemptCount: 0,
        deadLetterRecoveryCount: 0,
        nextAttemptAt: "2026-01-01T00:15:00.000Z",
        lastError: SyncReason.IngestionFailed,
        laneStalledSince: null,
      },
    ]);
  });
  const currentLoader = dbHostStyleLoader(() => {
    throw new Error("current proxy loader should not be selected");
  });
  const source = makeSource({
    loadSyncState: () => Promise.resolve(null),
    loadPendingOutboxIds: () => Promise.resolve([]),
    loadPendingSessionOutboxEngineState: currentLoader,
    loadPendingOutboxRetryState: legacyLoader,
  });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });

  const hydrated = await hydratePersistedCursor(h.deps);

  assert.deepEqual(calls, ["legacy:key-A"]);
  assert.equal(
    h.deps.retryCounters.ingestionFailed.get("sess-legacy-proxy"),
    2
  );
  assert.equal(hydrated, OutboxResumeOutcome.Seeded);
});

test("resumeDurableOutboxState: retry-state seeding rehydrates the real per-reason counters", async () => {
  const source = makeSource({
    loadSyncState: () => Promise.resolve(null),
    loadPendingOutboxIds: () => Promise.resolve([]),
    loadPendingSessionOutboxEngineState: () =>
      Promise.resolve([
        {
          id: "sess-1",
          attemptCount: 3,
          permanentAttemptCount: 0,
          deadLetterRecoveryCount: 0,
          nextAttemptAt: "2026-01-01T00:05:00.000Z",
          lastError: "ingestion_failed",
          laneStalledSince: null,
        },
      ]),
  });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });

  const hydrated = await hydratePersistedCursor(h.deps);

  assert.equal(h.deps.retryCounters.ingestionFailed.get("sess-1"), 3);
  assert.equal(
    h.deps.retryCounters.nextRetryAfterMs.get("sess-1"),
    Date.parse("2026-01-01T00:05:00.000Z")
  );
  assert.equal(h.hydratedField.current(), "key-A", "hydration still completes");
  // ISS-8594's positive sibling at this seam: a landed read answers `Seeded`, so
  // the two failure arms above cannot pass against a hydration hard-wired off.
  assert.equal(
    hydrated,
    OutboxResumeOutcome.Seeded,
    "a read that landed lets the pass continue"
  );
});

test("resumeDurableOutboxState: dead-lettered rows seed only recovery and ack-omitted cycle counts", async () => {
  const source = makeSource({
    loadSyncState: () =>
      Promise.resolve({
        observedTopUpdatedAt: "2026-01-01T00:00:00.000Z",
        observedIdsAtTopUpdatedAt: [],
        deadLetteredIds: ["sess-dead"],
      }),
    loadPendingOutboxIds: () => Promise.resolve([]),
    loadPendingSessionOutboxEngineState: () =>
      Promise.resolve([
        {
          id: "sess-dead",
          status: OutboxStatus.DeadLettered,
          attemptCount: 5,
          permanentAttemptCount: 5,
          deadLetterRecoveryCount: 3,
          ackOmittedCycleCount: 2,
          nextAttemptAt: "2026-01-01T00:05:00.000Z",
          lastError: SyncReason.IngestionFailed,
          laneStalledSince: "2026-01-01T00:01:00.000Z",
        },
      ]),
  });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });

  const hydrated = await hydratePersistedCursor(h.deps);

  assert.equal(
    h.deps.retryCounters.deadLetterRecoveryCountById.get("sess-dead"),
    3
  );
  // ISS-9182: a set-aside row the idle promotion will re-drive resumes the
  // cycles it already spent, or this process would grant it a fresh allowance.
  assert.equal(h.deps.retryCounters.ackOmittedCycleById.get("sess-dead"), 2);
  assert.equal(
    h.deps.retryCounters.ingestionFailed.has("sess-dead"),
    false,
    "dead-lettered rows do not seed live retry budgets"
  );
  assert.equal(
    h.deps.retryCounters.nextRetryAfterMs.has("sess-dead"),
    false,
    "dead-lettered rows do not re-arm the live retry deadline"
  );
  assert.equal(
    h.deps.retryCounters.laneStalledSinceMsById.has("sess-dead"),
    false,
    "dead-lettered rows do not seed lane-stall clocks"
  );
  assert.equal(hydrated, OutboxResumeOutcome.Seeded);
});

test("resumeDurableOutboxState: a retry read that THROWS re-arms the marker and fails the hydration", async () => {
  const source = makeSource({
    loadSyncState: () => Promise.resolve(null),
    loadPendingOutboxIds: () => Promise.resolve([]),
    loadPendingSessionOutboxEngineState: () =>
      Promise.reject(new Error("sync_state unavailable")),
  });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });

  const hydrated = await hydratePersistedCursor(h.deps);

  // ISS-8594. The marker was WRITTEN by this pass (the cursor load succeeded),
  // so re-arming it is a genuine retraction, not a no-op — and a non-`Seeded`
  // answer is what makes the service abandon the pass. Un-hydrating alone left
  // the identity unchanged, so nothing else abandoned it and it uploaded on
  // empty budgets.
  //
  // ISS-9823: `ReadFailed` specifically, not merely not-`Seeded`. This is the
  // fault half of the split — the half that is allowed to set the resume-blocked
  // level — and a `Discarded` here would silently un-report the whole condition.
  assert.equal(
    hydrated,
    OutboxResumeOutcome.ReadFailed,
    "a failed budget read fails the hydration"
  );
  assert.equal(h.hydratedField.current(), null, "the marker is re-armed");
  assert.equal(h.deps.retryCounters.ingestionFailed.size, 0);
  assert.equal(h.deps.retryCounters.nextRetryAfterMs.size, 0);
});

test("resumeDurableOutboxState: an UNREADABLE retry reply re-arms the marker and fails the hydration", async () => {
  const source = makeSource({
    // The arm that never throws: the peer answers, and the shape is one this
    // build cannot parse. Before ISS-8594 the boundary flattened it to `[]`,
    // which is indistinguishable from a healthy outbox with nothing owed.
    loadPendingSessionOutboxEngineState: () =>
      Promise.resolve({ rows: [] } as unknown as SessionOutboxEngineState[]),
    loadSyncState: () => Promise.resolve(null),
    loadPendingOutboxIds: () => Promise.resolve([]),
  });
  const h = makeHarness({ source, resolveLiveSourceKey: () => "key-A" });

  const hydrated = await hydratePersistedCursor(h.deps);

  // ISS-9823: the second door into the FAULT class, and it must answer the same
  // as the throwing one — a reply this build cannot parse is a read that did not
  // happen, not a superseded identity.
  assert.equal(
    hydrated,
    OutboxResumeOutcome.ReadFailed,
    "an unreadable budget fails the hydration"
  );
  assert.equal(h.hydratedField.current(), null, "the marker is re-armed");
});

test("resumeDurableOutboxState: a pass superseded only at the final check re-arms despite a successful inner seed", async () => {
  const source = makeSource({
    loadSyncState: () => Promise.resolve(null),
    loadPendingOutboxIds: () => Promise.resolve([]),
    loadPendingSessionOutboxEngineState: () =>
      Promise.resolve([
        {
          id: "sess-1",
          attemptCount: 2,
          permanentAttemptCount: 0,
          deadLetterRecoveryCount: 0,
          nextAttemptAt: null,
          lastError: "rate_limited",
          laneStalledSince: null,
        },
      ]),
  });
  const h = makeHarness({
    source,
    resolveLiveSourceKey: () => "key-A",
    // true for: adopt-check(1), loadSyncState-check(2), the inner
    // resumeSessionOutboxEngineState gate(3) — false only on the outer final check(4).
    isCurrentSourceState: makeGate(3),
  });

  await hydratePersistedCursor(h.deps);

  assert.equal(
    h.deps.retryCounters.rateLimited.get("sess-1"),
    2,
    "the inner seed still landed before the final check failed"
  );
  assert.equal(
    h.hydratedField.current(),
    null,
    "the outer marker is still re-armed on the final post-seed check"
  );
});

function dbHostStyleLoader(
  delegate: (sourceKey: string) => Promise<SessionOutboxEngineState[]>
): (sourceKey: string) => Promise<SessionOutboxEngineState[]> {
  return new Proxy(delegate, {
    get(target, property, receiver) {
      if (property === "call") {
        return undefined;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
