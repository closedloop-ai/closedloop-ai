/**
 * @file session-turn-bucket-folded-child-dedup.test.ts
 * @description ISS-5395 (wongk + closedloop-ai-stage review) — the ONE bucket row
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
import { describe, test } from "node:test";
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
    for (const row of deriveSessionTurnBuckets(sessionId, metadata)) {
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
          return Promise.resolve();
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
          return Promise.resolve();
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
          return Promise.resolve();
        },
      },
    });

    assert.deepEqual(deleted, []);
    assert.equal(summary.skippedActive, 1);
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
