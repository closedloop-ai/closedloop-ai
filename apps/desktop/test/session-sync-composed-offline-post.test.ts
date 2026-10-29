/**
 * @file session-sync-composed-offline-post.test.ts
 * @description ISS-8691 (davetho, #6351) — the COMPOSED half of the retained
 * compute-target coverage.
 *
 * `session-sync-identity-adapter.test.ts` drives the sync service with a
 * `sendBatch` double, so it proves the service drains while offline but never
 * reaches the closure this change actually edited
 * (`desktop-sync-lane-composition.ts`) or the real HTTP client under it. That
 * suite would stay green if the retained target were never threaded into the
 * production wiring at all — the false-green shape AGENTS.md names.
 *
 * So this file composes the lane the way `app.ts` does, with the socket down,
 * and asserts against the intercepted REQUEST: the retained id has to arrive on
 * `POST /desktop/agent-sessions/sync` as its `computeTargetId`, because that
 * query parameter is the only thing that tells the server which target the batch
 * is for. The counterfactual is the strict-online wiring this change replaced,
 * which must reach the network zero times under identical conditions.
 *
 * The second acceptance criterion is the rejection this new send can earn. Its
 * two halves were already pinned separately —
 * `desktop-agent-sessions-client.test.ts` maps a coded/uncoded 403 to
 * `TargetNotOwned`, and `agent-session-sync-service.test.ts` folds that ack with
 * budgets intact — but neither reaches the case ISS-8691 CREATED, which is a
 * stale id being sent at all while the socket is down. Before this change an
 * offline lane sent nothing, so nothing offline could be refused. The last test
 * below joins them: the retained id goes out mid-reconnect, the server refuses
 * it, and the row survives past every per-reason dead-letter budget.
 *
 * ISS-9859 (review: davetho, #7113) reuses the same composed flow for the
 * PR-list pagination capability, which crosses four hops before it reaches the
 * producer: composition → service → runner → worker. The helper suites each pin
 * one hop; only this flow fails if a hop drops the argument, because a dropped
 * capability leaves a PR-heavy session on the replicated path, where it
 * dead-letters.
 *
 * ISS-10602 reuses the offline flow for the ordinary disconnection: the POST
 * itself fails at the network. Only the composed lane runs the real client that
 * types that throw, so only it fails if the type is dropped on the way to the
 * fold that defers the lane on it.
 */
import assert from "node:assert/strict";
import type { Worker } from "node:worker_threads";
import { SyncLane } from "@closedloop-ai/telemetry-contract/sync";
import {
  DesktopAgentSessionsSyncErrorCode,
  SessionPrLifecycleStatus,
} from "@repo/api/src/types/agent-session";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { SessionPrRelationType } from "@repo/api/src/types/session-artifact-link";
import { PARENT_AGENT_EXTERNAL_ID } from "@repo/api/src/types/token-event-agent-owner";
import { afterEach, test, vi } from "vitest";
import { SESSION_PAYLOAD_CONTENT_BYTE_CAP } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import type {
  AgentSessionSyncBatch,
  SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import { prepareAgentSessionPayload } from "../src/main/agent-sync/agent-session-sync-payload.js";
import type { PayloadWorkerRequest } from "../src/main/agent-sync/agent-session-sync-payload-worker.js";
import type {
  AgentSessionSyncSource,
  LocallyOversizedSessionRow,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { createDesktopSyncLanes } from "../src/main/agent-sync/desktop-sync-lane-composition.js";
import { createSessionSyncIdentityAdapter } from "../src/main/agent-sync/retained-compute-target-identity.js";
import { PARSE_POLICY_BASE } from "../src/main/parse-policy/parse-policy.js";
import {
  type DesktopOtelRuntime,
  type DesktopSyncBatchEventInput,
  DesktopSyncBatchOutcome,
} from "../src/main/telemetry/app-otel-runtime.js";
import type { SignedInUserIdentity } from "../src/main/util/user-identity.js";
import { CloudSocketState } from "../src/shared/cloud-socket-error.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";
import { RendererOtelExportFailureReason } from "../src/shared/renderer-otel-bridge-constants.js";
import {
  PAST_ANY_LANE_ENVIRONMENTAL_RUNG_MS,
  pumpSyncDrainTurn,
  ROUNDS_PAST_EVERY_FAILURE_BUDGET,
  runWithMockedNow,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";
import { withParsePolicy } from "./support/attribution-parse-policy.js";

/**
 * The ONE thing this file replaces, and only because it cannot be reached from a
 * test: payload preparation is offloaded to a `worker_threads` Worker whose
 * entry is a BUILT artifact (`vite.main.config.ts` emits
 * `agent-session-sync-payload-worker.js`), so off a packaged app the composed
 * lane throws `Cannot find module` before it ever reaches the network.
 *
 * The substitute keeps the REAL runner and hands it an in-process worker that
 * answers with the worker's own exported request → producer hop, so the real
 * `prepareAgentSessionPayload` still produces the body and the runner's
 * serialization of every request field is still under test. Only the thread
 * boundary is gone; the composition closure this change edited and the real
 * HTTP client underneath it are untouched, which is the whole point of the file.
 */
vi.mock(
  "../src/main/agent-sync/agent-session-sync-payload-worker-runner.js",
  async (importOriginal) => {
    const runner =
      await importOriginal<
        typeof import("../src/main/agent-sync/agent-session-sync-payload-worker-runner.js")
      >();
    const { preparePayloadWorkerResponse } = await import(
      "../src/main/agent-sync/agent-session-sync-payload-worker.js"
    );
    const { EventEmitter } = await import("node:events");
    // Replies on a later microtask, as a real worker replies on a later turn,
    // so the runner's pending-request bookkeeping runs exactly as in production.
    class InProcessPayloadWorker extends EventEmitter {
      postMessage(message: PayloadWorkerRequest): void {
        const response = preparePayloadWorkerResponse(message);
        queueMicrotask(() => this.emit("message", response));
      }
      unref(): this {
        return this;
      }
      terminate(): Promise<number> {
        return Promise.resolve(0);
      }
    }
    return {
      ...runner,
      createAgentSessionPayloadWorkerPreparer: () =>
        runner.createAgentSessionPayloadWorkerPreparer(
          () => new InProcessPayloadWorker() as unknown as Worker
        ),
    };
  }
);

const API_ORIGIN = "https://api.example.test";
const SYNC_PATH = "/desktop/agent-sessions/sync";
const RETAINED_TARGET = "iss8691-retained-target";
const ACCOUNT: SignedInUserIdentity = {
  organizationId: "org-1",
  userId: "user-1",
};

/** How many drain turns to pump before declaring the lane wedged. */
const DRAIN_TURNS = 200;

/**
 * Every case here pumps real event-loop turns against a composed lane, so a
 * wedged drain has to fail as THIS scenario rather than as an unbounded runner
 * default. The longest case spends up to TWO `DRAIN_TURNS` pumps per round for
 * {@link ROUNDS_PAST_EVERY_FAILURE_BUDGET} rounds, plus one more of each for the
 * recovery: `requireNoResendBeforeBackoff` burns its whole bound
 * unconditionally, where the positive pump exits at the first new request. That
 * still measures ~3s for the whole file, so this only ever fires on a hang.
 */
const COMPOSED_LANE_TEST_TIMEOUT_MS = 30_000;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A telemetry sink that records nothing — this file asserts on the wire. */
function silentOtelRuntime(): DesktopOtelRuntime {
  return {
    start: () => Promise.resolve(),
    emitAppLifecycleEvent: () => undefined,
    emitAppExceptionEvent: () => undefined,
    emitSanitizedAppExceptionEvent: () => undefined,
    emitIpcPerfEvent: () => undefined,
    emitSyncBatchEvent: () => undefined,
    emitImportHealthEvent: () => undefined,
    emitAuthFailureEvent: () => false,
    emitDeadEndEvent: () => true,
    emitGenAiRequestEvent: () => undefined,
    emitOnboardingEvent: () => undefined,
    emitOnboardingDiscardEvent: () => undefined,
    emitUpdateEvent: () => true,
    flush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    getBufferedRecords: () => [],
    resetBuffer: () => undefined,
    exportExternalRecords: () => ({
      ok: false as const,
      reason: RendererOtelExportFailureReason.Unavailable,
    }),
  };
}

/** The accepted envelope the sync route's `.strict()` validator requires. */
const acceptedSyncResponse = () =>
  Response.json({ success: true, data: { synced: true } });

/**
 * Intercept every request the composed lane makes, answering the sync route
 * through `respondToSync` and everything else (the org-policy identity read)
 * with a benign empty body. Sync bodies are recorded too: the lane never
 * negotiates compression here, so each one is the batch's plain JSON.
 */
function interceptSyncRequests(respondToSync: () => Response): {
  requested: URL[];
  syncBatches: AgentSessionSyncBatch[];
} {
  const requested: URL[] = [];
  const syncBatches: AgentSessionSyncBatch[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requested.push(url);
    if (url.pathname === SYNC_PATH) {
      syncBatches.push(JSON.parse(String(init?.body)) as AgentSessionSyncBatch);
      return Promise.resolve(respondToSync());
    }
    return Promise.resolve(Response.json({ success: true, data: {} }));
  }) as typeof fetch;
  return { requested, syncBatches };
}

/**
 * Compose the session lane exactly as `app.ts` does and drain it, returning the
 * sync requests that reached the network. `getSyncComputeTargetId` and
 * `isHttpAgentSessionSyncReady` are the two deps this change rewired, so a
 * caller supplies both and nothing else differs between the arms below.
 */
async function drainComposedLane(wiring: {
  getSyncComputeTargetId: () => string | null;
  isHttpAgentSessionSyncReady: () => boolean;
  isInitialSessionProjectionReady?: () => boolean;
}): Promise<URL[]> {
  const lane = composeLane(wiring, acceptedSyncResponse);
  lane.service.start();
  for (
    let turn = 0;
    turn < DRAIN_TURNS && lane.syncRequests().length === 0;
    turn++
  ) {
    await pumpSyncDrainTurn();
  }
  lane.service.stop();
  return lane.syncRequests();
}

/**
 * Compose the lane and hand back the service plus the intercepted requests.
 * `prLane` swaps in the queued session and the PR-list capability for the
 * ISS-9859 cases; omitted, the lane is exactly the ISS-8691 one.
 */
function composeLane(
  wiring: {
    getSyncComputeTargetId: () => string | null;
    isHttpAgentSessionSyncReady: () => boolean;
    isInitialSessionProjectionReady?: () => boolean;
  },
  respondToSync: () => Response,
  prLane: {
    session?: SyncedAgentSession;
    prRefChunkingSupported?: boolean;
    /** ISS-12552: whether the server accepts token-event owners. */
    tokenEventOwnerSupported?: boolean;
    /** ISS-11427: a source whose own oversize scan abandons every candidate. */
    source?: AgentSessionSyncSource;
    /** ISS-11427: a recording telemetry sink, for the lane-1 span assertions. */
    appOtelRuntime?: DesktopOtelRuntime;
  } = {}
) {
  const { requested, syncBatches } = interceptSyncRequests(respondToSync);
  const source: AgentSessionSyncSource =
    prLane.source ??
    (prLane.session
      ? new RelationFreeProbeSource([prLane.session])
      : new FakeSyncSource([
          makeSyncedSession(
            "iss8691-composed-session",
            "2026-08-31T13:00:00.000Z"
          ),
        ]));
  const lanes = createDesktopSyncLanes({
    desktopSessionManager: {
      getAccessToken: () => Promise.resolve("session-token"),
      getAccountAdmission: () => ({ ...ACCOUNT, generation: 1 }),
      getIdentity: () => ACCOUNT,
      invalidateAccessToken: () => undefined,
    },
    getApiKey: () => null,
    getApiOrigin: () => API_ORIGIN,
    getDataSyncLevel: () => DataSyncLevel.Full,
    // The component lanes stay strict-online, and the socket is DOWN, so any
    // request this test sees belongs to the session lane.
    getTranscriptComputeTargetId: () => null,
    getSyncComputeTargetId: wiring.getSyncComputeTargetId,
    getComputeTargetRefusal: () => null,
    isSessionMetadataSyncTierAllowed: () => true,
    hasSyncObservabilityTierBeenSet: () => true,
    hasRecordedSyncConsent: () => true,
    isHttpAgentSessionSyncReady: wiring.isHttpAgentSessionSyncReady,
    isInitialSessionProjectionReady:
      wiring.isInitialSessionProjectionReady ?? (() => true),
    isSyncCompressionSupported: () => false,
    isSyncActivityChunkingSupported: () => false,
    isSyncPrRefChunkingSupported: () => prLane.prRefChunkingSupported === true,
    isSyncTokenEventOwnerSupported: () =>
      prLane.tokenEventOwnerSupported === true,
    getSyncSource: () => source,
    waitForBackgroundSlot: () => Promise.resolve(),
    appOtelRuntime: prLane.appOtelRuntime ?? silentOtelRuntime(),
    isTranscriptSyncRunning: () => false,
  });

  return {
    service: lanes.agentSessionSync,
    syncRequests: () => requested.filter((url) => url.pathname === SYNC_PATH),
    /** Every session part the sync POSTs carried, in send order. */
    postedSessions: () => syncBatches.flatMap((batch) => batch.sessions),
  };
}

test(
  "ISS-11610: initial session uploads wait until import retiling has settled",
  async () => {
    const { adapter } = offlineAdapterWithRetainedTarget();
    let projectionReady = false;
    const lane = composeLane(
      {
        getSyncComputeTargetId: () => adapter.computeTargetId(),
        isHttpAgentSessionSyncReady: () => adapter.isHttpReady(),
        isInitialSessionProjectionReady: () => projectionReady,
      },
      acceptedSyncResponse
    );

    lane.service.start();
    try {
      for (let turn = 0; turn < DRAIN_TURNS; turn++) {
        await pumpSyncDrainTurn();
      }
      assert.deepEqual(
        lane.syncRequests(),
        [],
        "a session selected before artifact/activity retiling must not upload"
      );

      projectionReady = true;
      lane.service.refresh();
      await pumpUntilSyncRequests(lane.syncRequests, 1);
      assert.equal(
        lane.postedSessions()[0]?.externalSessionId,
        "iss8691-composed-session",
        "the same pending session must upload once the final projection is stable"
      );
    } finally {
      lane.service.stop();
    }
  },
  COMPOSED_LANE_TEST_TIMEOUT_MS
);

type ComposedLane = ReturnType<typeof composeLane>;

/** An adapter holding a target bound to {@link ACCOUNT} with the socket down. */
function offlineAdapterWithRetainedTarget() {
  let onlineTargetId: string | null = RETAINED_TARGET;
  const adapter = createSessionSyncIdentityAdapter({
    getIdentity: () => ACCOUNT,
    getAuthStatus: () => DesktopAuthStatus.Authenticated,
    getApiOrigin: () => API_ORIGIN,
    getCloudStatus: () =>
      onlineTargetId
        ? { state: CloudSocketState.Online, targetId: onlineTargetId }
        : { state: CloudSocketState.Idle },
  });
  adapter.remember({ targetId: RETAINED_TARGET });
  onlineTargetId = null;
  return {
    adapter,
    /** The strict-online arm reads THIS, which is null once the socket drops. */
    onlineTargetId: () => onlineTargetId,
  };
}

test(
  "ISS-8691: the retained offline target reaches the real /desktop/agent-sessions/sync POST",
  async () => {
    const { adapter } = offlineAdapterWithRetainedTarget();

    const requests = await drainComposedLane({
      getSyncComputeTargetId: () => adapter.computeTargetId(),
      isHttpAgentSessionSyncReady: () => adapter.isHttpReady(),
    });

    assert.ok(
      requests.length > 0,
      "the composed lane must POST the queued session while the socket is down"
    );
    // Every request, not just the first: the drain loop stops at the first one it
    // sees, but a tick already in flight can land a second, and a test that read
    // only `[0]` would not notice a retry addressed somewhere else.
    assert.deepEqual(
      [
        ...new Set(
          requests.map((url) => url.searchParams.get("computeTargetId"))
        ),
      ],
      [RETAINED_TARGET],
      "the retained id must be the target the server is told the batch is for"
    );
    assert.deepEqual(
      [...new Set(requests.map((url) => url.origin))],
      [API_ORIGIN]
    );
  },
  COMPOSED_LANE_TEST_TIMEOUT_MS
);

test(
  "ISS-8691: the strict-online wiring reaches the network zero times in the same window",
  async () => {
    const { onlineTargetId } = offlineAdapterWithRetainedTarget();

    // The pre-fix composition: both deps derived strictly from socket liveness.
    const requests = await drainComposedLane({
      getSyncComputeTargetId: onlineTargetId,
      isHttpAgentSessionSyncReady: () => onlineTargetId() !== null,
    });

    assert.deepEqual(
      requests,
      [],
      "a POST here would mean the arm above proves the lane runs, not that this change is what makes it run"
    );
  },
  COMPOSED_LANE_TEST_TIMEOUT_MS
);

/** The coded 403 the route returns when the sent target is not the caller's. */
const targetNotOwnedResponse = () =>
  Response.json(
    {
      success: false,
      error: "Forbidden",
      code: DesktopAgentSessionsSyncErrorCode.TargetNotOwned,
    },
    { status: 403 }
  );

/**
 * Pump until `expected` sync requests have landed. Throws rather than falling
 * through, so a lane that stops re-sending fails here with its own count instead
 * of surviving to a later assertion that reads a stale one.
 */
async function pumpUntilSyncRequests(
  syncRequests: () => URL[],
  expected: number
): Promise<void> {
  for (
    let turn = 0;
    turn < DRAIN_TURNS && syncRequests().length < expected;
    turn++
  ) {
    await pumpSyncDrainTurn();
  }
  if (syncRequests().length < expected) {
    throw new Error(
      `composed lane sent ${syncRequests().length} sync request(s), expected ${expected}`
    );
  }
}

/**
 * The negative half of the deferral, paired with the positive one below it: the
 * SAME refresh-and-pump that produces the next attempt once the clock has moved
 * past the current rung must produce none while it has not. Without it
 * `pumpUntilSyncRequests` is satisfied by any count at or above the one it waits
 * for, so a lane that re-sent immediately after the 403 would clear every round
 * of the loop with the deferral never taken.
 *
 * Pumps the same `DRAIN_TURNS` bound the positive arm is allowed, so the arms
 * differ only by the clock. Throws rather than asserting, matching
 * {@link pumpUntilSyncRequests} — an assertion outside a `test()` body trips
 * Biome's `noMisplacedAssertion`.
 */
async function requireNoResendBeforeBackoff(
  lane: ComposedLane,
  sent: number
): Promise<void> {
  lane.service.refresh();
  for (let turn = 0; turn < DRAIN_TURNS; turn++) {
    await pumpSyncDrainTurn();
  }
  await lane.service.whenSessionSyncSettled();
  if (lane.syncRequests().length !== sent) {
    throw new Error(
      `a refused row must stay deferred for the full backoff, but with the clock held the lane went from ${sent} to ${lane.syncRequests().length} sync request(s)`
    );
  }
}

test(
  "ISS-8691: a stale retained target refused mid-reconnect defers with budgets intact and never dead-letters",
  async () => {
    const { adapter } = offlineAdapterWithRetainedTarget();
    let targetOwned = false;

    const lane = composeLane(
      {
        getSyncComputeTargetId: () => adapter.computeTargetId(),
        isHttpAgentSessionSyncReady: () => adapter.isHttpReady(),
      },
      () => (targetOwned ? acceptedSyncResponse() : targetNotOwnedResponse())
    );

    await runWithMockedNow(async ({ advance }) => {
      lane.service.start();
      try {
        await pumpUntilSyncRequests(lane.syncRequests, 1);
        // Settle the pass before counting: `requested` is pushed when the request
        // is ISSUED, so without this the 403 may not be folded into the backoff
        // yet and an exact count would be racing the fold rather than pinning it.
        await lane.service.whenSessionSyncSettled();
        assert.equal(lane.syncRequests().length, 1);
        for (
          let round = 2;
          round <= ROUNDS_PAST_EVERY_FAILURE_BUDGET;
          round += 1
        ) {
          await requireNoResendBeforeBackoff(lane, round - 1);
          // ISS-8610 CHANGED THIS ADVANCE, deliberately: a 403 is now a staged
          // LANE-wide environmental run rather than a flat 30s per-row defer, so
          // clearing "one more rung" means advancing past the ladder's per-delay
          // cap. The deferral being TAKEN is still pinned, by the negative half
          // on the line above.
          advance(PAST_ANY_LANE_ENVIRONMENTAL_RUNG_MS);
          lane.service.refresh();
          await pumpUntilSyncRequests(lane.syncRequests, round);
          await lane.service.whenSessionSyncSettled();
          assert.equal(
            lane.syncRequests().length,
            round,
            "one elapsed backoff must buy exactly one more attempt"
          );
        }

        assert.equal(
          lane.service.getSyncProgress().caughtUp,
          false,
          "a refused row is still owed: it must not read as caught up"
        );

        // The stale id is what actually went on the wire every time — without
        // this the rounds above could be a lane retrying under some other target,
        // which is not the case ISS-8691 created.
        assert.deepEqual(
          [
            ...new Set(
              lane
                .syncRequests()
                .map((url) => url.searchParams.get("computeTargetId"))
            ),
          ],
          [RETAINED_TARGET],
          "every refused attempt must carry the retained target the socket drop left behind"
        );
        assert.equal(
          lane.service.getSyncProgress().deadLetteredSessions,
          0,
          "target_not_owned must burn no budget: the id is wrong, not the row"
        );

        // The last refusal's deferral is owed the same negative half every
        // round above got: without it the recovery below could be a lane that
        // never deferred at all, since `pumpUntilSyncRequests` is satisfied by a
        // send that arrived before the clock moved.
        await requireNoResendBeforeBackoff(
          lane,
          ROUNDS_PAST_EVERY_FAILURE_BUDGET
        );

        // Identity re-resolves (a fresh hello, or the target re-owned): the batch
        // was queued the whole time, so it drains. A dead-lettered row could not.
        targetOwned = true;
        advance(PAST_ANY_LANE_ENVIRONMENTAL_RUNG_MS);
        lane.service.refresh();
        await pumpUntilSyncRequests(
          lane.syncRequests,
          ROUNDS_PAST_EVERY_FAILURE_BUDGET + 1
        );
        // `pumpUntilSyncRequests` returns on the request being ISSUED, with the
        // 2xx still in flight, so the recovery has to be awaited before it can be
        // asserted — and it is asserted POSITIVELY. `deadLetteredSessions` was
        // already 0 on every line above, so a broken accepted-ack path leaves it
        // 0 too; only the queue actually draining distinguishes them.
        await lane.service.whenSessionSyncSettled();
        assert.equal(
          lane.service.getSyncProgress().caughtUp,
          true,
          "the row queued through every refusal must drain once the target is owned again"
        );
        assert.equal(lane.service.getSyncProgress().deadLetteredSessions, 0);
      } finally {
        lane.service.stop();
      }
    });
  },
  COMPOSED_LANE_TEST_TIMEOUT_MS
);

test(
  "ISS-10602: a POST that fails at the network defers the lane with budgets intact, and the row drains when the network returns",
  async () => {
    const { adapter } = offlineAdapterWithRetainedTarget();
    let networkUp = false;

    const lane = composeLane(
      {
        getSyncComputeTargetId: () => adapter.computeTargetId(),
        isHttpAgentSessionSyncReady: () => adapter.isHttpReady(),
      },
      () => {
        if (!networkUp) {
          throw new TypeError("fetch failed");
        }
        return acceptedSyncResponse();
      }
    );

    await runWithMockedNow(async ({ advance }) => {
      lane.service.start();
      try {
        await pumpUntilSyncRequests(lane.syncRequests, 1);
        await lane.service.whenSessionSyncSettled();
        for (
          let round = 2;
          round <= ROUNDS_PAST_EVERY_FAILURE_BUDGET;
          round += 1
        ) {
          // The per-row budget this throw used to spend re-sent on the very
          // next tick; the lane gate holds until its rung elapses.
          await requireNoResendBeforeBackoff(lane, round - 1);
          advance(PAST_ANY_LANE_ENVIRONMENTAL_RUNG_MS);
          lane.service.refresh();
          await pumpUntilSyncRequests(lane.syncRequests, round);
          await lane.service.whenSessionSyncSettled();
        }
        assert.equal(
          lane.service.getSyncProgress().deadLetteredSessions,
          0,
          "a dropped connection is the lane's, so no row may be dead-lettered for it"
        );

        networkUp = true;
        advance(PAST_ANY_LANE_ENVIRONMENTAL_RUNG_MS);
        lane.service.refresh();
        await pumpUntilSyncRequests(
          lane.syncRequests,
          ROUNDS_PAST_EVERY_FAILURE_BUDGET + 1
        );
        await lane.service.whenSessionSyncSettled();
        assert.equal(
          lane.service.getSyncProgress().caughtUp,
          true,
          "the row held through the outage must drain once the network returns"
        );
      } finally {
        lane.service.stop();
      }
    });
  },
  COMPOSED_LANE_TEST_TIMEOUT_MS
);

test(
  "ISS-9859: a capable composed lane posts page 0 marked false, then continuations marked true, and every PR once",
  async () => {
    const session = sessionWithOverflowingPrLists();
    const lane = composeLane(PR_LANE_WIRING, acceptedSyncResponse, {
      session,
      prRefChunkingSupported: true,
    });

    // Read before `stop()`, which clears the dead-letter set with the rest of
    // the source state.
    let deadLettered = Number.NaN;
    lane.service.start();
    try {
      await pumpUntil(
        () => finalPartPosted(prListSessionParts(lane)),
        "posted the final part of the PR-heavy session"
      );
      await lane.service.whenSessionSyncSettled();
      deadLettered = lane.service.getSyncProgress().deadLetteredSessions;
    } finally {
      lane.service.stop();
    }

    const parts = prListSessionParts(lane);
    assert.deepEqual(
      parts.map((part) => part.chunk?.index),
      parts.map((_, index) => index),
      "each part went out once, in index order, so page 0 lands before the merges"
    );
    const pages = parts.filter(
      (part) => Object.hasOwn(part, "prRefs") || Object.hasOwn(part, "prs")
    );
    assert.ok(pages.length > 1, "the PR lists really did paginate on the wire");
    const [pageZero, ...continuations] = pages;
    assert.equal(
      pageZero.prRefsPaginated,
      false,
      "page 0 says false explicitly, so the cloud admits its REPLACE at the freshness tie"
    );
    assert.ok(
      Object.hasOwn(pageZero, "prRefs"),
      "page 0 states prRefs, so its Replace covers the links"
    );
    for (const page of continuations) {
      assert.equal(page.prRefsPaginated, true, "every later part MERGES");
    }
    assert.deepEqual(
      pages.flatMap((page) => (page.prRefs ?? []).map((ref) => ref.prNumber)),
      (session.prRefs ?? []).map((ref) => ref.prNumber),
      "every ref reached the network exactly once"
    );
    assert.deepEqual(
      pages.flatMap((page) => (page.prs ?? []).map((pr) => pr.num)),
      (session.prs ?? []).map((pr) => pr.num),
      "every prs entry reached the network exactly once"
    );
    assert.equal(deadLettered, 0);
  },
  COMPOSED_LANE_TEST_TIMEOUT_MS
);

test(
  "ISS-9859: without the capability the same composed lane dead-letters the session and posts no marked part",
  async () => {
    const lane = composeLane(PR_LANE_WIRING, acceptedSyncResponse, {
      session: sessionWithOverflowingPrLists(),
      prRefChunkingSupported: false,
    });

    let deadLettered = Number.NaN;
    lane.service.start();
    try {
      await pumpUntil(
        () => lane.service.getSyncProgress().deadLetteredSessions > 0,
        "dead-lettered the session it could not replicate"
      );
      await lane.service.whenSessionSyncSettled();
      deadLettered = lane.service.getSyncProgress().deadLetteredSessions;
    } finally {
      lane.service.stop();
    }

    assert.deepEqual(
      prListSessionParts(lane),
      [],
      "an old server REPLACES the links with each part's slice, so no part may go out at all"
    );
    assert.equal(deadLettered, 1, "the producer, not the probe, refused it");
  },
  COMPOSED_LANE_TEST_TIMEOUT_MS
);

/** Wiring with a live target, so every difference below is the capability. */
const PR_LANE_WIRING = {
  getSyncComputeTargetId: () => "iss9859-composed-target",
  isHttpAgentSessionSyncReady: () => true,
};

const PR_HEAVY_SESSION_ID = "iss9859-composed-pr-heavy";

/**
 * Enough PRs that each list alone spans more than one part at the real content
 * cap, so the two lists replicated whole into every part can never fit.
 */
const OVERFLOWING_PR_COUNT = Math.ceil(SESSION_PAYLOAD_CONTENT_BYTE_CAP / 50);

/** Production shape: the producer emits `prs` beside `prRefs`, both uncapped. */
function sessionWithOverflowingPrLists(): SyncedAgentSession {
  return {
    ...makeSyncedSession(PR_HEAVY_SESSION_ID, "2026-08-31T13:00:00.000Z"),
    prRefs: Array.from({ length: OVERFLOWING_PR_COUNT }, (_, index) => ({
      repositoryFullName: "acme/web",
      prNumber: index + 1,
      relationType: SessionPrRelationType.Created,
    })),
    prs: Array.from({ length: OVERFLOWING_PR_COUNT }, (_, index) => ({
      num: index + 1,
      title: `Refactor the sync lane, part ${index + 1}`,
      status: SessionPrLifecycleStatus.Open,
    })),
  };
}

function prListSessionParts(lane: ComposedLane): SyncedAgentSession[] {
  return lane
    .postedSessions()
    .filter((part) => part.externalSessionId === PR_HEAVY_SESSION_ID);
}

function finalPartPosted(parts: SyncedAgentSession[]): boolean {
  return parts.some(
    (part) =>
      part.chunk !== undefined &&
      part.chunk !== null &&
      part.chunk.index === part.chunk.total - 1
  );
}

/**
 * Pump until `done` holds. Throws rather than falling through, so a lane that
 * stalls fails here with what it never did instead of at a later assertion
 * reading a stale snapshot.
 */
async function pumpUntil(done: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < DRAIN_TURNS && !done(); turn++) {
    await pumpSyncDrainTurn();
  }
  if (!done()) {
    throw new Error(`composed lane never ${what} in ${DRAIN_TURNS} turns`);
  }
}

/**
 * `FakeSyncSource` runs its pre-hydrate oversize probe over the WHOLE session,
 * relations included. Production probes a relation-free projection
 * (`buildMinimalSyncSession`: no events, agents, token usage or PR lists), so
 * the fake would dead-letter a PR-heavy session before hydration that
 * production hydrates and hands to the capability-aware prepare. This source
 * probes that same projection, so the verdict under test is the producer's.
 */
class RelationFreeProbeSource extends FakeSyncSource {
  private readonly probed: Map<string, SyncedAgentSession>;

  constructor(sessions: SyncedAgentSession[]) {
    super(sessions);
    this.probed = new Map(
      sessions.map((session) => [session.externalSessionId, session])
    );
  }

  override findLocallyOversizedSessions(
    ids: string[],
    maxBytes: number
  ): LocallyOversizedSessionRow[] {
    return ids.flatMap((id) => {
      const session = this.probed.get(id);
      if (!session) {
        return [];
      }
      const { prRefs: _refs, prs: _prs, ...head } = session;
      const prepared = prepareAgentSessionPayload(
        { ...head, agents: [], events: [], tokenUsageByModel: [] },
        maxBytes
      );
      return prepared.kind === "dead-letter"
        ? [{ id, payloadBytes: prepared.payloadBytes }]
        : [];
    });
  }
}

/**
 * ISS-11427: the composed lane-1 telemetry adapter must put the lane's own DLQ
 * depth on a dead-letter span.
 *
 * Driven through the SAME composition `app.ts` builds (not the service alone),
 * because the adapter that reads the depth lives in
 * `desktop-sync-lane-composition.ts` and a service-level drive would not reach
 * it. The one-pass dead-letter is the local oversize scan: a source method in
 * production, overridden on the fake here, with the service, the disposition,
 * the composed adapter and the `sessionMetadataBatchEvent` mapper all real.
 */
class OversizedScanSource extends FakeSyncSource {
  scanCalls = 0;
  override findLocallyOversizedSessions(ids: string[]) {
    this.scanCalls += 1;
    return ids.map((id) => ({ id, payloadBytes: 9_999_999 }));
  }
}

test(
  "ISS-11427: a lane-1 dead-letter span carries the lane's DLQ depth",
  async () => {
    const { adapter } = offlineAdapterWithRetainedTarget();
    const events: DesktopSyncBatchEventInput[] = [];
    const source = new OversizedScanSource([
      makeSyncedSession("iss11427-oversized", "2026-08-31T13:00:00.000Z"),
    ]);
    const lane = composeLane(
      {
        getSyncComputeTargetId: () => adapter.computeTargetId(),
        isHttpAgentSessionSyncReady: () => adapter.isHttpReady(),
      },
      acceptedSyncResponse,
      {
        source,
        appOtelRuntime: {
          ...silentOtelRuntime(),
          emitSyncBatchEvent: (event) => events.push(event),
        },
      }
    );

    lane.service.start();
    for (let turn = 0; turn < DRAIN_TURNS && source.scanCalls === 0; turn++) {
      await pumpSyncDrainTurn();
    }
    lane.service.stop();

    // POSITIVE CONTROL: an empty event list below would otherwise be
    // indistinguishable from a lane that never ran.
    assert.ok(
      source.scanCalls > 0,
      "the composed lane must run the oversize scan"
    );
    const deadLetters = events.filter(
      (event) =>
        event.lane === SyncLane.SessionMetadata &&
        event.outcome === DesktopSyncBatchOutcome.DeadLetter
    );
    assert.ok(deadLetters.length > 0, "expected a lane-1 dead-letter span");
    // The wiring this ticket adds. Before it, every lane-1 arm emitted none —
    // which is why `@sync.dead_lettered_count` was unpopulated on the only lane
    // that was abandoning sessions.
    assert.equal(deadLetters[0].deadLetteredCount, 1);
  },
  COMPOSED_LANE_TEST_TIMEOUT_MS
);

test(
  "ISS-12552: the composed lane sends token-event owners only to a server that accepts them",
  async () => {
    const postedOwners = async (tokenEventOwnerSupported: boolean) => {
      const lane = composeLane(PR_LANE_WIRING, acceptedSyncResponse, {
        session: {
          ...makeSyncedSession("iss12552-owned", "2026-10-19T12:00:00.000Z"),
          tokenEvents: [
            {
              externalEventId: "event-parent",
              agentExternalId: PARENT_AGENT_EXTERNAL_ID,
              model: "claude-opus-5-5",
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              createdAt: "2026-10-19T12:00:00.000Z",
            },
          ],
        },
        tokenEventOwnerSupported,
      });
      lane.service.start();
      try {
        await pumpUntilSyncRequests(lane.syncRequests, 1);
      } finally {
        lane.service.stop();
      }
      return lane
        .postedSessions()
        .flatMap((session) => session.tokenEvents ?? [])
        .map((event) => event.agentExternalId);
    };

    assert.deepEqual(await postedOwners(true), [PARENT_AGENT_EXTERNAL_ID]);
    assert.deepEqual(await postedOwners(false), [undefined]);
    // PRD-800: with the attribution policy off not even the parent marker.
    assert.deepEqual(
      await withParsePolicy(PARSE_POLICY_BASE, () => postedOwners(true)),
      [undefined]
    );
  },
  COMPOSED_LANE_TEST_TIMEOUT_MS
);
