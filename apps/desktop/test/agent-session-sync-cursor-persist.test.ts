/**
 * @file agent-session-sync-cursor-persist.test.ts
 * @description ISS-8041 — the durable-cursor WRITES, and the one piece of state
 * that spans them (`lastPersistedTopUpdatedAt`, held in the persister's closure).
 *
 * Every case here is about that tracker rather than the boundary arithmetic —
 * `agent-session-sync-cursor-prefix.test.ts` owns the arithmetic. It matters on
 * its own because the never-move-backwards refusal READS this value: a tracker
 * that claims a position the disk never took silently refuses the lane's own
 * retry, and a tracker that inherits another identity's position refuses that
 * identity's boundaries until it climbs past a watermark it never wrote. Both
 * failures are quiet — the lane simply stops recording a cursor — so neither
 * shows up in a test that only asserts what was written.
 */
import assert from "node:assert/strict";
import { describe, it, test } from "vitest";
import { AgentSessionSyncClass } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  createSessionCursorPersister,
  type SessionCursorPersistState,
} from "../src/main/agent-sync/agent-session-sync-cursor-persist.js";
import type {
  AgentSessionSyncSource,
  PersistedSyncState,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { createDbHostAgentDatabase } from "../src/main/database/db-host/db-host-agent-database.js";
import type { DbHostClient } from "../src/main/database/db-host/db-host-client.js";

const SOURCE_KEY = "target-a";
const T1 = "2026-08-25T21:05:00.000Z";
const T2 = "2026-08-25T21:10:00.000Z";
const T3 = "2026-08-25T21:15:00.000Z";

type Harness = {
  writes: PersistedSyncState[];
  seeds: string[][];
  /** Settle the pending `advanceSyncState` call, in call order. */
  settleWrite: (index: number, outcome: "ok" | "reject") => void;
  /** Make the NEXT `advanceSyncState` throw before it returns a promise. */
  armSynchronousWriteThrow: () => void;
  settleSeed: (index: number, outcome: "ok" | "reject") => void;
  state: SessionCursorPersistState;
};

function buildHarness(): Harness {
  const writes: PersistedSyncState[] = [];
  const seeds: string[][] = [];
  const writeGates: Array<{ resolve: () => void; reject: () => void }> = [];
  const seedGates: Array<{ resolve: () => void; reject: () => void }> = [];

  function gate(
    gates: Array<{ resolve: () => void; reject: () => void }>
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      gates.push({ resolve, reject: () => reject(new Error("write failed")) });
    });
  }

  let throwNextWrite = false;
  const source = {
    advanceSyncState(_key: string, persisted: PersistedSyncState) {
      if (throwNextWrite) {
        throwNextWrite = false;
        throw new Error("write failed synchronously");
      }
      writes.push(persisted);
      return gate(writeGates);
    },
    enqueueOutboxEntries(
      _key: string,
      entries: { externalSessionId: string }[]
    ) {
      seeds.push(entries.map((entry) => entry.externalSessionId));
      return gate(seedGates);
    },
  } as unknown as AgentSessionSyncSource;

  const state: SessionCursorPersistState = {
    historicalBackfillEnabled: true,
    sourceKey: SOURCE_KEY,
    source,
    unackedIds: [],
    queuedUpdatedAtById: new Map(),
    observedTopUpdatedAt: T2,
    observedIdsAtTopUpdatedAt: new Set(),
    deadLetteredIds: [],
  };

  return {
    writes,
    seeds,
    armSynchronousWriteThrow: () => {
      throwNextWrite = true;
    },
    settleWrite: (index, outcome) => {
      const target = writeGates[index];
      if (outcome === "ok") {
        target?.resolve();
        return;
      }
      target?.reject();
    },
    settleSeed: (index, outcome) => {
      const target = seedGates[index];
      if (outcome === "ok") {
        target?.resolve();
        return;
      }
      target?.reject();
    },
    state,
  };
}

/** Let every already-queued microtask (and the `.catch` chained off it) run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await Promise.resolve();
  }
}

function persisterFor(harness: Harness) {
  return createSessionCursorPersister(
    () => harness.state,
    () => undefined,
    AgentSessionSyncClass.Backfill
  );
}

describe("createSessionCursorPersister — the rejected-write rollback", () => {
  it("re-attempts the same position after its write is rejected", async () => {
    const harness = buildHarness();
    const cursor = persisterFor(harness);

    cursor.persistIfAdvanced();
    harness.settleWrite(0, "reject");
    await settle();

    // Without the rollback the tracker would still claim T2, and the
    // never-move-backwards refusal would drop this retry on the floor.
    cursor.persistIfAdvanced();
    assert.equal(harness.writes.length, 2);
    assert.equal(harness.writes[1]?.observedTopUpdatedAt, T2);
  });

  it("re-attempts the same position after its write throws SYNCHRONOUSLY", () => {
    const harness = buildHarness();
    const cursor = persisterFor(harness);

    // `advanceSyncState` is declared `void | Promise<void>`, so a synchronous
    // implementation is in-contract, and the production source is the DB-host
    // method proxy whose `apply` can throw before any promise exists. Evaluated
    // as the argument to `Promise.resolve`, such a throw escaped with no
    // `.catch` attached and the tracker already advanced — so the
    // never-move-backwards refusal dropped every later write until restart.
    harness.armSynchronousWriteThrow();
    assert.doesNotThrow(() => {
      cursor.persistIfAdvanced();
    }, "the persister absorbs a synchronous write failure rather than throwing at its caller");
    assert.equal(
      harness.writes.length,
      0,
      "the throw means nothing reached the source"
    );

    cursor.persistIfAdvanced();
    assert.equal(
      harness.writes.length,
      1,
      "the retry is issued, so the tracker was rolled back"
    );
    assert.equal(harness.writes[0]?.observedTopUpdatedAt, T2);
  });

  it("does not roll a rejection back over a LATER identity's position", async () => {
    const harness = buildHarness();
    const cursor = persisterFor(harness);

    // Identity A claims T2, then the account switches and B resumes at T2 as
    // well — two identities can land on the same stamp.
    cursor.persistIfAdvanced();
    cursor.reset();
    cursor.noteResumedFrom(T2);

    // B now owes a row BELOW its resumed position, which is the state that tells
    // the two trackers apart: a boundary at T1 is refused against T2 and allowed
    // against the `null` A's rollback would have restored. (A drained lane would
    // NOT discriminate — that path deliberately rewrites the watermark every
    // time, exactly as it did before ISS-8041.)
    harness.state.unackedIds = ["owed"];
    harness.state.queuedUpdatedAtById = new Map([["owed", T1]]);
    harness.settleWrite(0, "reject");
    await settle();

    cursor.persistIfAdvanced();
    assert.equal(
      harness.writes.length,
      1,
      "B still refuses a boundary below the position its own resume proved is on disk"
    );
  });
});

describe("createSessionCursorPersister — ISS-10429: readBoundary", () => {
  function owing(harness: Harness): Harness {
    harness.state = {
      ...harness.state,
      unackedIds: ["later", "stuck"],
      queuedUpdatedAtById: new Map([
        ["later", T3],
        ["stuck", T1],
      ]),
    };
    return harness;
  }

  it("names the identity and the oldest owed stamp", () => {
    const harness = owing(buildHarness());
    assert.deepEqual(persisterFor(harness).readBoundary(), {
      sourceKey: SOURCE_KEY,
      value: T1,
    });
  });

  it("names nothing whenever persistIfAdvanced would not write", () => {
    const cases: [string, Partial<SessionCursorPersistState>][] = [
      ["backfill deferred", { historicalBackfillEnabled: false }],
      ["no identity", { sourceKey: null }],
      ["no source", { source: null }],
      [
        "no advance delegate",
        { source: {} as unknown as AgentSessionSyncSource },
      ],
    ];
    for (const [label, override] of cases) {
      const harness = owing(buildHarness());
      harness.state = { ...harness.state, ...override };
      const cursor = persisterFor(harness);
      assert.equal(cursor.readBoundary(), null, label);
      cursor.persistIfAdvanced();
      assert.equal(harness.writes.length, 0, `${label}: no write either`);
    }
  });
});

describe("createSessionCursorPersister — the initial backfill seed", () => {
  it("records the corpus maximum only AFTER the outbox seed commits", async () => {
    const harness = buildHarness();
    const cursor = persisterFor(harness);

    const pending = cursor.seedThenPersistInitialBackfill(SOURCE_KEY, ["a"]);
    assert.deepEqual(harness.seeds, [["a"]]);
    assert.equal(
      harness.writes.length,
      0,
      "the cursor is not written while the seed is still in flight"
    );

    harness.settleSeed(0, "ok");
    await settle();
    harness.settleWrite(0, "ok");
    await pending;
    assert.equal(harness.writes[0]?.observedTopUpdatedAt, T2);
  });

  it("writes nothing when the seed is rejected", async () => {
    const harness = buildHarness();
    const cursor = persisterFor(harness);

    const pending = cursor.seedThenPersistInitialBackfill(SOURCE_KEY, ["a"]);
    harness.settleSeed(0, "reject");
    await pending;
    assert.equal(
      harness.writes.length,
      0,
      "a crash mid-seed must leave the cursor unpersisted so the next start re-walks"
    );
  });

  it("writes nothing when the identity changes while the seed is in flight", async () => {
    const harness = buildHarness();
    const cursor = persisterFor(harness);

    const pending = cursor.seedThenPersistInitialBackfill(SOURCE_KEY, ["a"]);
    // The account flips and the next identity establishes its own watermark
    // before the previous identity's seed comes back.
    cursor.reset();
    harness.state.observedTopUpdatedAt = T3;
    harness.settleSeed(0, "ok");
    await pending;

    assert.equal(
      harness.writes.length,
      0,
      "the NEXT identity's watermark is never written under the previous one's key"
    );
  });
});

/**
 * The production source is the DB-host METHOD PROXY, not a plain object, and its
 * `get` trap deliberately answers `call`/`bind`/`apply` with `undefined` — that
 * detach idiom crashed the app twice, once as `syncSource.advanceSyncState.bind`
 * (ISS-4620) and again in the ISS-4818 probe. Every write in this module must
 * therefore dispatch as a MEMBER expression. The harness above is an ordinary
 * object literal, so it cannot see that; this case drives the real proxy.
 */
test("dispatches its writes through the real DB-host proxy, not a detached function", async () => {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const client = {
    invoke: (op: string, args: unknown[]) => {
      calls.push({ op, args });
      return Promise.resolve(undefined);
    },
  } as unknown as DbHostClient;
  const source = createDbHostAgentDatabase(client)
    .syncSource as unknown as AgentSessionSyncSource;

  const cursor = createSessionCursorPersister(
    () => ({
      historicalBackfillEnabled: true,
      sourceKey: SOURCE_KEY,
      source,
      unackedIds: [],
      queuedUpdatedAtById: new Map(),
      observedTopUpdatedAt: T2,
      observedIdsAtTopUpdatedAt: new Set(),
      deadLetteredIds: [],
    }),
    () => undefined,
    AgentSessionSyncClass.Backfill
  );

  await cursor.seedThenPersistInitialBackfill(SOURCE_KEY, ["a"]);
  cursor.persistIfAdvanced();
  await settle();

  // A `.call`/`.bind` dispatch reads `undefined` off the proxy: the seed would
  // throw into its own catch and report a FAILED seed, so no cursor write would
  // follow it at all, and `persistIfAdvanced` would throw outright.
  assert.deepEqual(
    calls.map((entry) => entry.op),
    [
      "syncSource.enqueueOutboxEntries",
      "syncSource.advanceSyncState",
      "syncSource.advanceSyncState",
    ]
  );
});
