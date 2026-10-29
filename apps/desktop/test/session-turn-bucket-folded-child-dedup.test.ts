/**
 * @file session-turn-bucket-folded-child-dedup.test.ts
 * @description ISS-5395 (whitlockk + closedloop-ai-stage review) — the ONE bucket row
 * per round-trip invariant on a PRE-FOLD OpenCode install.
 *
 * Revision 69 counts a folded subagent's `$.tokenSeries` round-trips on the ROOT.
 * That is only a correction while exactly one bucket row exists per round-trip,
 * and revision 62 (ISS-4544, corrected by ISS-4649 finding 1) records the shape
 * where it did not: OpenCode is a batch collector, both delete paths are gated on
 * `sessionIdForSource` + `isBurstArtifactSource`, so a standalone
 * `opencode-<childId>` row SURVIVES beside its now-folded root carrying the same
 * round-trips in its own metadata. Root and child would each derive an agent
 * bucket for the same instant, and `computeAgents` / `computeUtilization` GROUP BY
 * day across every session with no dedupe — doubling the day instead of
 * correcting it.
 *
 * `pruneFoldedChildRows` (data-revision-folded-child-prune.ts), wired into the
 * unmapped/batch path of `runDataRevisionRebuild`, deletes that stale top-level
 * row keyed on the fold's OWN emitted child set. These tests execute that
 * decision: the double-count case, the two shapes that must NOT be pruned (a
 * re-emitted orphan, a row that is not a stale terminal row), and the failure
 * path.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { deriveSessionTurnBuckets } from "../src/main/database/turn-buckets.js";
import { fakeCollector, makeSession } from "./normalized-session-test-utils.js";

const ROOT_ID = "opencode-root-1";
const CHILD_ID = "opencode-child-1";
const CHILD_RAW_ID = "child-1";
const FOLDED_INSTANT = "2026-06-07T10:00:30.000Z";
const BATCH_SOURCE = "opencode-store";

/** The root as stored AFTER the fold: the child's round-trip, subagent-marked. */
function foldedRootMetadata(): string {
  return JSON.stringify({
    entrypoint: "opencode",
    messages: [],
    tokenSeries: [
      {
        timestamp: FOLDED_INSTANT,
        model: "test-model",
        input: 100,
        output: 50,
        subagentId: CHILD_RAW_ID,
      },
    ],
  });
}

/** The pre-fold standalone child row: the SAME round-trip, unmarked. */
function preFoldChildMetadata(): string {
  return JSON.stringify({
    entrypoint: "opencode",
    messages: [],
    tokenSeries: [
      {
        timestamp: FOLDED_INSTANT,
        model: "test-model",
        input: 100,
        output: 50,
      },
    ],
  });
}

/**
 * What `computeAgents` / `computeUtilization` read: SUM(turn_count) over the
 * agent rows of every session still in the store, with no cross-session dedupe.
 */
function agentTurnsAcrossStore(store: ReadonlyMap<string, string>): number {
  let total = 0;
  for (const [sessionId, metadata] of store) {
    // Both rows here carry a real round-trip series, and the importer writes one
    // `token_events` row per series entry — so `true` is the value the
    // production caller passes for them. ISS-8259 made the agent half an if/else
    // on this flag; passing `false` would model a partial store and read the
    // sessions' `$.messages` instead of the round-trips this suite is about.
    for (const row of deriveSessionTurnBuckets(sessionId, metadata, true)) {
      if (row.turnKind === "agent") {
        total += row.turnCount;
      }
    }
  }
  return total;
}

/** The folded root the current OpenCode parser emits for `BATCH_SOURCE`. */
function foldedRootParse() {
  return makeSession({
    sessionId: ROOT_ID,
    entrypoint: "opencode",
    subagents: [
      {
        id: CHILD_RAW_ID,
        parentId: null,
        childSessionId: CHILD_ID,
        name: "worker",
        task: "worker",
        status: "completed",
        nativeSubagentId: CHILD_RAW_ID,
        toolUses: [],
        tokensByModel: {},
        tokenSeries: [],
      },
    ],
  });
}

describe("pre-fold OpenCode child rows and the sub-agent round-trip roll-up", () => {
  test("the surviving child row is pruned, so the day is corrected and not doubled", async () => {
    // The store as an upgraded install actually holds it: the folded root AND
    // the pre-fold standalone child row, both stale at the new revision.
    const store = new Map([
      [ROOT_ID, foldedRootMetadata()],
      [CHILD_ID, preFoldChildMetadata()],
    ]);
    // Baseline: with both rows present, revision 71's rule counts the SAME
    // round-trip twice. This is the defect the reviewers described.
    assert.equal(agentTurnsAcrossStore(store), 2);

    const summary = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("opencode", {
          batch: true,
          sources: [BATCH_SOURCE],
          sessions: [foldedRootParse()],
        }),
      ],
      db: {
        listStaleRevisionSessions: () =>
          Promise.resolve([
            { id: ROOT_ID, harness: "opencode", status: "inactive" },
            { id: CHILD_ID, harness: "opencode", status: "inactive" },
          ]),
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: (sessionId) => {
          store.delete(sessionId);
          return Promise.resolve(true);
        },
      },
    });

    assert.equal(summary.deleted, 1);
    assert.equal(summary.errors, 0);
    // The child row is gone and the root is the sole carrier of the round-trip.
    assert.deepEqual([...store.keys()], [ROOT_ID]);
    assert.equal(agentTurnsAcrossStore(store), 1);
    // It must not be reported as a session whose source went missing.
    assert.equal(summary.missingSource, 0);
  });

  test("a re-emitted orphan that came back as top level is never pruned", async () => {
    // `foldOpencodeSubagents` deliberately re-emits a child whose root could not
    // be resolved. Such a child is BOTH named as a subagent's childSessionId and
    // returned as a top-level session, and deleting it would destroy a real
    // session (deleteSessionRow cascades across ~20 tables).
    const deleted: string[] = [];
    const summary = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("opencode", {
          batch: true,
          sources: [BATCH_SOURCE],
          sessions: [
            foldedRootParse(),
            makeSession({ sessionId: CHILD_ID, entrypoint: "opencode" }),
          ],
        }),
      ],
      db: {
        listStaleRevisionSessions: () =>
          Promise.resolve([
            { id: ROOT_ID, harness: "opencode", status: "inactive" },
            { id: CHILD_ID, harness: "opencode", status: "inactive" },
          ]),
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: (sessionId) => {
          deleted.push(sessionId);
          return Promise.resolve(true);
        },
      },
    });

    assert.deepEqual(deleted, []);
    assert.equal(summary.deleted, 0);
    // Both were re-derived through the ordinary parser path instead.
    assert.equal(summary.rebuilt, 2);
  });

  test("a child row that is not a stale terminal row is never pruned", async () => {
    // A RUNNING child row is excluded from the stale terminal set, so it is not
    // in `pending` — the same membership test that proves the row exists also
    // keeps a live row from being deleted underneath its writer.
    const deleted: string[] = [];
    const summary = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("opencode", {
          batch: true,
          sources: [BATCH_SOURCE],
          sessions: [foldedRootParse()],
        }),
      ],
      db: {
        listStaleRevisionSessions: () =>
          Promise.resolve([
            { id: ROOT_ID, harness: "opencode", status: "inactive" },
            { id: CHILD_ID, harness: "opencode", status: "running" },
          ]),
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: (sessionId) => {
          deleted.push(sessionId);
          return Promise.resolve(true);
        },
      },
    });

    assert.deepEqual(deleted, []);
    assert.equal(summary.skippedActive, 1);
  });

  test("ISS-8601: a WEDGED folded child is admitted, refused at the delete, and left stale", async () => {
    // The case above keeps passing only because its double omits `lastActivityAt`
    // and so fails closed. Once the age bound exists, a folded child CAN be
    // non-terminal AND in `pending` — the exact state the prune's docblock used to
    // rule out — so the guarantee it asserts needs a case that actually reaches it.
    //
    // What must hold: the store refuses the delete (a wedged row may be rebuilt,
    // never purged), the refusal is NOT counted as a deletion, and the row does
    // not fall through to the repair tail, whose stored-invocation bridge stamps
    // `data_revision` unconditionally and would seal the duplicate in place.
    const now = new Date("2026-06-07T12:00:00.000Z");
    const wedged = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
    const deleteAttempts: string[] = [];
    const logged: string[] = [];
    const summary = await runDataRevisionRebuild({
      log: (message) => logged.push(message),
      collectors: [
        fakeCollector("opencode", {
          batch: true,
          sources: [BATCH_SOURCE],
          sessions: [foldedRootParse()],
        }),
      ],
      db: {
        now: () => now.toISOString(),
        listStaleRevisionSessions: () =>
          Promise.resolve([
            {
              id: ROOT_ID,
              harness: "opencode",
              status: "inactive",
              lastActivityAt: wedged,
            },
            {
              id: CHILD_ID,
              harness: "opencode",
              status: "running",
              lastActivityAt: wedged,
            },
          ]),
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: (sessionId) => {
          deleteAttempts.push(sessionId);
          // What the real store does for a non-terminal row: refuse, and say so.
          return Promise.resolve(sessionId !== CHILD_ID);
        },
      },
    });

    assert.equal(
      summary.wedgedActiveAdmitted,
      1,
      "the wedged child is admitted by the bound"
    );
    assert.deepEqual(
      deleteAttempts,
      [CHILD_ID],
      "and it does reach the prune's delete"
    );
    assert.equal(
      summary.deleted,
      0,
      "but a refusal is never counted as a deletion"
    );
    assert.equal(
      logged.filter((m) => m.includes("deleted pre-fold subagent row")).length,
      0,
      "nor logged as one"
    );
    assert.equal(
      summary.missingSource,
      0,
      "and it is not stranded into the repair tail, which would stamp it current"
    );
  });

  test("a failed delete is counted and left stale so a later boot retries it", async () => {
    const logged: string[] = [];
    const summary = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("opencode", {
          batch: true,
          sources: [BATCH_SOURCE],
          sessions: [foldedRootParse()],
        }),
      ],
      db: {
        listStaleRevisionSessions: () =>
          Promise.resolve([
            { id: ROOT_ID, harness: "opencode", status: "inactive" },
            { id: CHILD_ID, harness: "opencode", status: "inactive" },
          ]),
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.reject(new Error("db is locked")),
      },
      log: (message) => logged.push(message),
    });

    assert.equal(summary.deleted, 0);
    assert.equal(summary.errors, 1);
    // Still stale, so the next boot's rebuild selects and retries it. The root
    // was rebuilt regardless — one failed prune never aborts the pass.
    assert.equal(summary.rebuilt, 1);
    assert.equal(summary.missingSource, 1);
    assert.ok(
      logged.some(
        (message) =>
          message.includes("folded-child cleanup failed") &&
          message.includes(CHILD_ID)
      ),
      `expected a folded-child cleanup failure log, got ${JSON.stringify(logged)}`
    );
  });
});
