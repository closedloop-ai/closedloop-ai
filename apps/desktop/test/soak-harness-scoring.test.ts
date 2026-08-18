/**
 * @file soak-harness-scoring.test.ts
 * @description Regression guards for the Stage-0 soak harness's SCORING, the
 * part of it that can be exercised without a 2.1 GB profile clone or a built
 * Electron app. Every case here pins a verdict that the harness silently got
 * wrong: an invariant that failed while the cycle still reported no fail
 * reasons, a waste metric inflated by ordinary chunking, or a dead app that a
 * mode exemption let pass as recovered. A harness whose verdict under-reports
 * is worse than no harness, so these are the assertions worth owning even
 * though the battery itself is a manual CLI run.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "@repo/api/src/types/agent-session";
import type { MockCloudServer } from "./soak/mock-cloud-server.js";
import { startMockCloudServer } from "./soak/mock-cloud-server.js";
import type { ReadBackResponse } from "./soak/soak-cloud-content.js";
import { quiesceThenReadBack, sampleDrainState } from "./soak/soak-cycle.js";
import { buildCycleRecord } from "./soak/soak-cycle-record.js";
import { newPageReadStats } from "./soak/soak-page-read.js";
import type {
  CycleContext,
  CycleRecord,
  CycleState,
  LaunchedSoakApp,
  Mode,
  OutboxDepths,
  SoakOptions,
} from "./soak/soak-types.js";

const COMPUTE_TARGET_ID = "00000000-0000-4000-8000-000000000000";
const SYNC_PATH = "/desktop/agent-sessions/sync";
const REQUEST_TIMEOUT_MS = 10_000;

const startedServers: MockCloudServer[] = [];

after(async () => {
  for (const server of startedServers.splice(0)) {
    await server.close().catch(() => undefined);
  }
});

function makeOptions(overrides: Partial<SoakOptions> = {}): SoakOptions {
  return {
    cycles: 1,
    mode: "clean",
    out: "/dev/null",
    snapshot: "/dev/null",
    drainBudgetMs: 60_000,
    workRoot: "/dev/null",
    loadGateMax: 25,
    ...overrides,
  };
}

/**
 * A `LaunchedSoakApp` with only the fields the code under test reads. `app` and
 * `page` are Playwright handles no scoring path touches, and the liveness cases
 * below return before any page read, so a partial fixture is the honest shape
 * here rather than a real Electron launch.
 */
function makeLaunched(exitCode: number | null): LaunchedSoakApp {
  return {
    app: {} as LaunchedSoakApp["app"],
    page: {} as LaunchedSoakApp["page"],
    oomHits: new Set<string>(),
    child: {
      exitCode,
      signalCode: null,
      pid: 4242,
    } as LaunchedSoakApp["child"],
  };
}

function makeState(overrides: Partial<CycleState> = {}): CycleState {
  return {
    launched: makeLaunched(null),
    oomHitSets: [],
    pageReads: { ...newPageReadStats(), ok: 1, latenciesMs: [12] },
    monotonicViolations: [],
    notes: [],
    failReasons: [],
    dbHostKills: 0,
    dbHostRecovered: null,
    appKills: 0,
    appRelaunched: null,
    unexpectedAppExit: false,
    drainCompleted: true,
    lastDepth: 0,
    ...overrides,
  };
}

function makeContext(
  mock: MockCloudServer,
  baseline: string[],
  overrides: { mode?: Mode; localSessionIds?: string[] } = {}
): CycleContext {
  return {
    cycleIndex: 1,
    options: makeOptions({ mode: overrides.mode ?? "clean" }),
    mock,
    homes: {},
    workspace: {
      userDataDir: "/dev/null",
      dbPath: "/dev/null",
      artifactsDir: "/dev/null",
      stdioLogPath: "/dev/null",
      baseline,
      // ISS-6098: the population an id must belong to for delivery to be
      // legitimate is baseline ∪ local corpus. Defaulting the corpus to the
      // baseline keeps `rogue` below in NEITHER set, which is what still makes
      // it a fail.
      localSessionIds: overrides.localSessionIds ?? baseline,
      // ISS-6099: no session in these fixtures is claimed to have events, so
      // the one-directional relation cross-check has nothing to assert.
      localSessionsWithEvents: [],
      startDepths: {
        pending: baseline.length,
        deadLettered: 0,
        invocationPending: 0,
      },
    },
    startMs: Date.now() - 1000,
  };
}

const ZERO_DEPTHS: OutboxDepths = {
  pending: 0,
  deadLettered: 0,
  invocationPending: 0,
};

function scoreCycle(
  mock: MockCloudServer,
  baseline: string[],
  state: CycleState,
  overrides: {
    mode?: Mode;
    localSessionIds?: string[];
    /**
     * A corpus captured EARLIER in the cycle. `buildCycleRecord` reads
     * `mock.stats()` itself, so passing this is what lets a test drive the two
     * halves of the observation pair apart in time.
     */
    readBack?: ReadBackResponse | null;
  } = {}
): CycleRecord {
  return buildCycleRecord(makeContext(mock, baseline, overrides), state, {
    startedAt: new Date().toISOString(),
    loadAvgStart: 1,
    endDepths: ZERO_DEPTHS,
    // ISS-6099: the real retained corpus, not `null` — a null read-back is
    // scored as an INCOMPLETE one, which is a fail reason in its own right.
    readBack: overrides.readBack ?? mock.readBack(),
  });
}

async function startServer(): Promise<MockCloudServer> {
  const server = await startMockCloudServer({
    computeTargetId: COMPUTE_TARGET_ID,
  });
  startedServers.push(server);
  return server;
}

/**
 * POST one sync batch exactly as the app's sync lane would.
 *
 * ISS-6099: the mock now inspects payload CONTENT, so these setup payloads
 * carry the fields the sync contract requires — the batch's `schemaVersion` and
 * the relation arrays the ingest schema declares as required. A bare
 * `{ externalSessionId }` would (correctly) be scored as a missing-required-
 * field violation and make every verdict below fail for a reason the test is
 * not about.
 */
async function postSyncBatch(
  mock: MockCloudServer,
  sessions: {
    externalSessionId: string;
    dataRevision?: number;
    chunk?: { index: number; total: number };
  }[],
  batchId: string
): Promise<void> {
  const response = await fetch(`${mock.apiOrigin}${SYNC_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      batchId,
      syncMode: "full",
      sessionCount: sessions.length,
      sessions: sessions.map((session) => ({
        status: "inactive",
        startedAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T01:00:00.000Z",
        agents: [],
        events: [],
        tokenUsageByModel: [],
        ...session,
      })),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // Thrown, not asserted: this is setup, and an assertion in a helper the
  // runner does not own is exactly the kind that can quietly never run.
  if (response.status !== 200) {
    throw new Error(`mock sync ingest returned ${response.status}`);
  }
  await response.json();
}

describe("soak harness cycle verdict", () => {
  test("a monotonic violation is a fail reason, not a silent PASS", async () => {
    const mock = await startServer();
    mock.resetStats();
    await postSyncBatch(mock, [{ externalSessionId: "s1" }], "b1");
    // Depth went UP mid-drain and still reached zero: `monotonicDrain` is false
    // while nothing else about the cycle failed.
    const state = makeState({
      monotonicViolations: [{ atMs: 500, from: 10, to: 12 }],
    });

    const record = scoreCycle(mock, ["s1"], state);

    assert.equal(record.invariants.monotonicDrain, false);
    assert.ok(
      record.failReasons.includes("monotonic_violations:1"),
      `expected a monotonic fail reason, got ${JSON.stringify(record.failReasons)}`
    );
  });

  test("a clean cycle with no violation records no monotonic reason", async () => {
    const mock = await startServer();
    mock.resetStats();
    await postSyncBatch(mock, [{ externalSessionId: "s1" }], "b1");

    const record = scoreCycle(mock, ["s1"], makeState());

    assert.equal(record.invariants.monotonicDrain, true);
    assert.deepEqual(record.failReasons, []);
  });

  test("a session delivered outside the baseline is a fail reason", async () => {
    const mock = await startServer();
    mock.resetStats();
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1" }, { externalSessionId: "rogue" }],
      "b1"
    );

    const record = scoreCycle(mock, ["s1"], makeState());

    assert.equal(record.extraSyncedCount, 1);
    assert.equal(record.lostSessionCount, 0);
    assert.ok(
      record.failReasons.includes("extra_synced:1"),
      `expected an extra-synced fail reason, got ${JSON.stringify(record.failReasons)}`
    );
  });
});

describe("soak harness duplicate delivery", () => {
  test("the same payload delivered twice is still a dup violation", async () => {
    const mock = await startServer();
    mock.resetStats();
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1", dataRevision: 72 }],
      "b1"
    );
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1", dataRevision: 72 }],
      "b2"
    );

    const record = scoreCycle(mock, ["s1"], makeState());

    assert.equal(record.redeliveredSessionCount, 1);
    assert.equal(record.invariants.noDup, false);
    assert.ok(
      record.failReasons.includes("dup:1"),
      `expected a dup fail reason, got ${JSON.stringify(record.failReasons)}`
    );
  });

  test("a re-sync at a newer dataRevision is not a dup", async () => {
    const mock = await startServer();
    mock.resetStats();
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1", dataRevision: 72 }],
      "b1"
    );
    // What the boot data-revision rebuild produces: the session is re-derived
    // mid-drain, re-enqueued, and delivered again carrying the NEW revision.
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1", dataRevision: 75 }],
      "b2"
    );

    const record = scoreCycle(mock, ["s1"], makeState());

    assert.equal(record.rawSessionReceives, 2);
    assert.equal(record.syncedSessionCount, 1);
    assert.equal(
      record.redeliveredSessionCount,
      1,
      "the second delivery must stay visible as re-delivery volume"
    );
    assert.equal(record.invariants.noDup, true);
    assert.deepEqual(record.failReasons, []);
  });

  test("a re-sync alongside a genuine duplicate scores only the repeated revision", async () => {
    const mock = await startServer();
    mock.resetStats();
    // `dup` carries one session, `clean` the other, and BOTH are re-delivered —
    // so the count discriminates the two keyings. `dup` repeats revision 75, so
    // it is a genuine duplicate; `clean` is delivered once per revision, so it
    // is only the rebuild's re-sync. Scoring on the session alone reports 2.
    await postSyncBatch(
      mock,
      [
        { externalSessionId: "dup", dataRevision: 72 },
        { externalSessionId: "clean", dataRevision: 72 },
      ],
      "b1"
    );
    for (const batchId of ["b2", "b3"]) {
      await postSyncBatch(
        mock,
        [{ externalSessionId: "dup", dataRevision: 75 }],
        batchId
      );
    }
    await postSyncBatch(
      mock,
      [{ externalSessionId: "clean", dataRevision: 75 }],
      "b4"
    );

    const record = scoreCycle(mock, ["dup", "clean"], makeState());

    assert.equal(record.rawSessionReceives, 5);
    assert.equal(
      record.redeliveredSessionCount,
      2,
      "both sessions were delivered more than once"
    );
    assert.equal(record.invariants.noDup, false);
    assert.ok(
      record.failReasons.includes("dup:1"),
      `only the repeated revision is a duplicate, got ${JSON.stringify(record.failReasons)}`
    );
  });

  test("a delivery below an already-sent revision is a stale-revision fail", async () => {
    const mock = await startServer();
    mock.resetStats();
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1", dataRevision: 75 }],
      "b1"
    );
    // The real upsert is forward-only, so this send would be rejected as stale.
    // Keying dups on the revision must not make the regression invisible.
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1", dataRevision: 72 }],
      "b2"
    );

    const record = scoreCycle(mock, ["s1"], makeState());

    assert.equal(record.staleRevisionDeliveryCount, 1);
    // The whole point of keying dups on (session, revision) is that the two
    // checks are independent: a stale send is not a duplicate, and pinning
    // `noDup` here is what stops a regression from satisfying this test by
    // failing the dup check instead.
    assert.equal(record.invariants.noDup, true);
    assert.deepEqual(record.staleRevisionDeliverySample, ["s1#72"]);
    assert.ok(
      record.failReasons.includes("stale_revision:1"),
      `expected a stale-revision fail reason, got ${JSON.stringify(record.failReasons)}`
    );
  });

  test("a revision STAGED by chunk 0 already bars an older interleaved payload", async () => {
    const mock = await startServer();
    mock.resetStats();
    // Production's forward-only bar is max(committed, pendingChunkRevision), and
    // chunk 0 writes the pending marker before its sequence can complete. So the
    // rev-72 whole session landing between the two rev-75 chunks is rejected as
    // stale there — a bar that only advanced on full assembly would call this
    // cycle clean.
    await postSyncBatch(
      mock,
      [
        {
          externalSessionId: "s1",
          dataRevision: 75,
          chunk: { index: 0, total: 2 },
        },
      ],
      "b1"
    );
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1", dataRevision: 72 }],
      "b2"
    );
    await postSyncBatch(
      mock,
      [
        {
          externalSessionId: "s1",
          dataRevision: 75,
          chunk: { index: 1, total: 2 },
        },
      ],
      "b3"
    );

    const record = scoreCycle(mock, ["s1"], makeState());

    assert.equal(record.staleRevisionDeliveryCount, 1);
    assert.deepEqual(record.staleRevisionDeliverySample, ["s1#72"]);
    assert.ok(
      record.failReasons.includes("stale_revision:1"),
      `a payload under a STAGED revision is stale, got ${JSON.stringify(record.failReasons)}`
    );
  });

  test("a chunk sequence still commits over the marker its own chunk 0 staged", async () => {
    const mock = await startServer();
    mock.resetStats();
    // The counterfactual for the case above: with nothing interleaved, staging
    // must not make a sequence stale against itself.
    for (const index of [0, 1]) {
      await postSyncBatch(
        mock,
        [
          {
            externalSessionId: "s1",
            dataRevision: 75,
            chunk: { index, total: 2 },
          },
        ],
        `b${index}`
      );
    }

    const record = scoreCycle(mock, ["s1"], makeState());

    assert.equal(record.staleRevisionDeliveryCount, 0);
    assert.equal(record.syncedSessionCount, 1);
    assert.deepEqual(record.failReasons, []);
  });

  test("a re-delivery is noted on every cycle, including a passing one", async () => {
    const mock = await startServer();
    mock.resetStats();
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1", dataRevision: 72 }],
      "b1"
    );
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1", dataRevision: 75 }],
      "b2"
    );

    const record = scoreCycle(mock, ["s1"], makeState());

    assert.deepEqual(record.failReasons, []);
    assert.ok(
      record.notes.includes("redelivered:1"),
      `re-delivery volume must be recorded, got ${JSON.stringify(record.notes)}`
    );
  });

  test("a chunk sequence re-sent whole at the same revision is a dup", async () => {
    const mock = await startServer();
    mock.resetStats();
    for (const batch of ["first", "second"]) {
      for (const index of [0, 1]) {
        await postSyncBatch(
          mock,
          [
            {
              externalSessionId: "chunked",
              dataRevision: 7,
              chunk: { index, total: 2 },
            },
          ],
          `${batch}-chunk-${index}`
        );
      }
    }

    const record = scoreCycle(mock, ["chunked"], makeState());

    assert.equal(record.invariants.noDup, false);
    assert.ok(
      record.failReasons.includes("dup:1"),
      `expected a dup fail reason, got ${JSON.stringify(record.failReasons)}`
    );
  });

  test("ISS-4572 — the import-pending sentinel is NOT a stale revision", async () => {
    const mock = await startServer();
    mock.resetStats();
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1", dataRevision: 75 }],
      "b1"
    );
    // `write-core.ts` stamps DATA_REVISION_IMPORT_PENDING (-1) at the import gate
    // and seals the real revision only after every later group commits, so a
    // session genuinely reaches the sync path carrying the sentinel. Comparing it
    // against the high-water mark would score a row that is legitimately parked
    // for re-derivation as a revision REGRESSION — a false cycle failure.
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1", dataRevision: -1 }],
      "b2"
    );

    const record = scoreCycle(mock, ["s1"], makeState());

    assert.equal(record.staleRevisionDeliveryCount, 0);
    assert.ok(
      !record.failReasons.some((reason) => reason.startsWith("stale_revision")),
      `a sentinel must not fail the cycle as stale, got ${JSON.stringify(record.failReasons)}`
    );
    // Not scored, but not vanished either.
    assert.equal(record.unrevisionedDeliveryCount, 1);
  });

  test("a delivery with NO revision is neither stale nor a dup, and stays visible", async () => {
    const mock = await startServer();
    mock.resetStats();
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1", dataRevision: 75 }],
      "b1"
    );
    // Production types `dataRevision` `.nullish()`, so an absent one is legal. It
    // is UNKNOWN on the revision axis rather than the revision `null`: there is
    // no value to compare against 75, so calling it stale would invent a fact.
    await postSyncBatch(mock, [{ externalSessionId: "s1" }], "b2");

    const record = scoreCycle(mock, ["s1"], makeState());

    assert.equal(record.staleRevisionDeliveryCount, 0);
    assert.equal(record.invariants.noDup, true);
    assert.deepEqual(record.failReasons, []);
    assert.equal(record.unrevisionedDeliveryCount, 1);
  });

  test("two deliveries with NO revision are not a duplicate — they may be two revisions", async () => {
    const mock = await startServer();
    mock.resetStats();
    for (const batchId of ["b1", "b2"]) {
      await postSyncBatch(mock, [{ externalSessionId: "s1" }], batchId);
    }

    const record = scoreCycle(mock, ["s1"], makeState());

    // Both carried an unknown revision, so nothing here can tell whether this was
    // the same payload twice. Folding them onto one `s1#null` key would assert
    // sameness the payloads never declared.
    assert.equal(record.invariants.noDup, true);
    assert.deepEqual(record.failReasons, []);
    assert.equal(record.unrevisionedDeliveryCount, 2);
    // The session-level volume signal still sees both.
    assert.equal(record.redeliveredSessionCount, 1);
  });
});

describe("soak harness re-send waste", () => {
  test("an N-chunk delivery with no retry reports zero waste", async () => {
    const mock = await startServer();
    mock.resetStats();
    for (const index of [0, 1, 2]) {
      await postSyncBatch(
        mock,
        [
          {
            externalSessionId: "chunked",
            dataRevision: 7,
            chunk: { index, total: 3 },
          },
        ],
        `chunk-batch-${index}`
      );
    }

    const record = scoreCycle(mock, ["chunked"], makeState());

    assert.equal(record.rawSessionReceives, 3);
    assert.equal(record.syncedSessionCount, 1);
    assert.equal(
      record.resendWaste,
      0,
      "ordinary activity chunking must not read as re-send waste"
    );
  });

  test("a genuinely re-sent chunk is counted as waste", async () => {
    const mock = await startServer();
    mock.resetStats();
    for (const index of [0, 0, 1]) {
      await postSyncBatch(
        mock,
        [
          {
            externalSessionId: "chunked",
            dataRevision: 7,
            chunk: { index, total: 2 },
          },
        ],
        `resend-batch-${index}`
      );
    }

    const record = scoreCycle(mock, ["chunked"], makeState());

    assert.equal(record.rawSessionReceives, 3);
    assert.equal(record.syncedSessionCount, 1);
    assert.equal(record.resendWaste, 1);
  });

  test("a stale delivery is waste, not a delivery that paid for itself", async () => {
    const mock = await startServer();
    mock.resetStats();
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1", dataRevision: 75 }],
      "b1"
    );
    // The forward-only upsert would reject this one, so the receive that carried
    // it bought nothing. Crediting it into `deliveredReceiveUnits` would net it
    // back out of `resendWaste` and leave the purest waste in the cycle as zero.
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1", dataRevision: 72 }],
      "b2"
    );

    const record = scoreCycle(mock, ["s1"], makeState());

    assert.equal(record.rawSessionReceives, 2);
    assert.equal(record.staleRevisionDeliveryCount, 1);
    assert.equal(record.resendWaste, 1);
  });

  test("a stale CHUNK SEQUENCE is waste for every receive it consumed", async () => {
    const mock = await startServer();
    mock.resetStats();
    await postSyncBatch(
      mock,
      [{ externalSessionId: "s1", dataRevision: 75 }],
      "b1"
    );
    // Both chunks are waste, not one: the whole sequence is what the rejected
    // delivery cost.
    for (const index of [0, 1]) {
      await postSyncBatch(
        mock,
        [
          {
            externalSessionId: "s1",
            dataRevision: 72,
            chunk: { index, total: 2 },
          },
        ],
        `stale-chunk-${index}`
      );
    }

    const record = scoreCycle(mock, ["s1"], makeState());

    assert.equal(record.rawSessionReceives, 3);
    assert.equal(record.staleRevisionDeliveryCount, 1);
    assert.equal(record.resendWaste, 2);
  });
});

describe("soak harness liveness sampling", () => {
  test("a dead app in appkill mode is an unexpected exit", async () => {
    const mock = await startServer();
    const state = makeState({ launched: makeLaunched(1) });

    const alive = await sampleDrainState(
      makeContext(mock, ["s1"], { mode: "appkill" }),
      state,
      ZERO_DEPTHS
    );

    assert.equal(alive, false);
    assert.equal(state.unexpectedAppExit, true);
    assert.ok(state.failReasons.includes("app_exited_unexpectedly"));
  });

  test("a dead app in clean mode is an unexpected exit", async () => {
    const mock = await startServer();
    const state = makeState({ launched: makeLaunched(1) });

    const alive = await sampleDrainState(
      makeContext(mock, ["s1"], { mode: "clean" }),
      state,
      ZERO_DEPTHS
    );

    assert.equal(alive, false);
    assert.equal(state.unexpectedAppExit, true);
  });
});

describe("ISS-6099: the read-back and the stats snapshot describe one moment", () => {
  test("COUNTERFACTUAL — quiescing the sender first stops an in-flight POST failing a clean cycle", async () => {
    const mock = await startServer();
    mock.resetStats();
    await postSyncBatch(mock, [{ externalSessionId: "s1" }], "b1");

    // The cycle is scored from a PAIR of observations: the read-back corpus,
    // and `mock.stats()`, which `buildCycleRecord` reads afterwards. While the
    // app is still up, a POST can land between them — present in `syncedSet`,
    // absent from the corpus — and fail a healthy cycle as
    // `read_back_incomplete`.
    let senderRunning = true;
    const readBack = await quiesceThenReadBack(
      () => {
        senderRunning = false;
        return Promise.resolve();
      },
      async () => {
        const corpus = mock.readBack();
        if (senderRunning) {
          // Only reachable when the corpus is taken before the sender is
          // stopped. That ordering is the bug.
          await postSyncBatch(mock, [{ externalSessionId: "late" }], "b-late");
        }
        return corpus;
      }
    );

    const record = scoreCycle(mock, ["s1"], makeState(), { readBack });

    assert.equal(record.invariants.readBackComplete, true);
    assert.deepEqual(record.failReasons, []);
  });

  test("a session genuinely missing from the corpus is still an incomplete read-back", async () => {
    const mock = await startServer();
    mock.resetStats();
    await postSyncBatch(mock, [{ externalSessionId: "s1" }], "b1");
    // The other direction: quiescing first must not blunt the check itself.
    // Here the corpus is captured BEFORE a delivery the stats will include, and
    // that is still reported.
    const corpus = mock.readBack();
    await postSyncBatch(mock, [{ externalSessionId: "s2" }], "b2");

    const record = scoreCycle(mock, ["s1", "s2"], makeState(), {
      readBack: corpus,
    });

    assert.equal(record.invariants.readBackComplete, false);
    assert.ok(
      record.failReasons.some((reason) =>
        reason.startsWith("read_back_incomplete")
      ),
      JSON.stringify(record.failReasons)
    );
  });
});
