/**
 * @file session-projection-promotion-gate.test.ts
 * @description ISS-8741 — the substrate driven end to end against the REAL
 * `openSqliteAgentDatabase` and the REAL `runDataRevisionRebuild`, because the
 * claim it makes is about what survives on disk.
 *
 * Before this ticket the rebuild handed whatever the parse produced straight to
 * the teardown-and-reimport transaction. A candidate that parsed but was not a
 * well-formed derived record therefore replaced a good projection with a worse
 * one, permanently: the rebuild only runs on TERMINAL sessions, which never
 * cycle back through ordinary reimport, so nothing would re-derive them until
 * the next revision bump.
 *
 * Each test below is the same sentence from a different angle — the prior
 * projection is still readable.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import {
  currentSessionProjectionRevision,
  sessionProjectionRevisionComponents,
} from "../src/main/collectors/engine/session-projection-gate.js";
import { ACTIVITY_CLASSIFIER_VERSION } from "../src/main/collectors/parsing/activity-segment-classifier.js";
import { EXTRACTOR_VERSION } from "../src/main/collectors/parsing/artifact-ref-extractor-version.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { createDbHostAgentDatabase } from "../src/main/database/db-host/db-host-agent-database.js";
import type { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import { formatDerivedProjectionRevision } from "../src/main/database/derived-projection-revision.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  type RebuildTestDb,
  readSessionEventIds,
  readSessionProjectionMarkers,
  rebuildSessionFrom,
  type SessionProjectionMarkerRow,
  setSessionDataRevision,
} from "./data-revision-rebuild-test-utils.js";
import {
  fakeCollector,
  makePopulatedSession as makeSession,
} from "./normalized-session-test-utils.js";

const SID = "iss8741-gate";
const STALE_REVISION = 0;
const GOOD_NAME = "Known good projection";
const REPLACEMENT_NAME = "Replacement projection";
/**
 * A `cwd` far past the canonical short-text bound the derived-session-record
 * schema enforces. Type-legal — this is exactly the shape of a parser regression
 * that emits an unbounded field — so only the validator can catch it. If that
 * bound is ever raised past this length the candidate stops being invalid and
 * these tests go RED on `rebuilt`, which is the right failure: they would be
 * asserting nothing otherwise.
 */
const OVERLONG_CWD = `/workspace/${"x".repeat(9000)}`;
/**
 * A stamp no build of this code can produce (`currentSessionProjectionRevision`
 * always names four components). Seeded before an interrupted run so "the stamp
 * did not advance" is an OBSERVABLE non-advance rather than the current
 * build-constant coincidentally already being in the column.
 */
const SEEDED_PRIOR_REVISION = "data=1";
/** Any C0/C1 control byte, which includes the ESC that opens an ANSI run. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control bytes are absent is the subject
const CONTROL_OR_ESCAPE_RE = /[\u0000-\u001f\u007f-\u009f]/;

type SessionMarkerRow = SessionProjectionMarkerRow;

function goodSession(): NormalizedSession {
  return makeSession({
    sessionId: SID,
    name: GOOD_NAME,
    toolUses: [
      { id: "toolu_good", name: "Read", timestamp: "2026-06-07T10:00:35.000Z" },
    ],
  });
}

function replacementSession(): NormalizedSession {
  return makeSession({
    sessionId: SID,
    name: REPLACEMENT_NAME,
    toolUses: [
      { id: "toolu_good", name: "Read", timestamp: "2026-06-07T10:00:35.000Z" },
      { id: "toolu_new", name: "Bash", timestamp: "2026-06-07T10:00:45.000Z" },
    ],
  });
}

function corruptSession(): NormalizedSession {
  return makeSession({
    sessionId: SID,
    name: REPLACEMENT_NAME,
    cwd: OVERLONG_CWD,
    toolUses: [],
  });
}

/**
 * A candidate the VALIDATOR accepts and the REPLACEMENT declines. `startedAt` is
 * nullable on `NormalizedSession` and therefore on `normalizedSessionSchema`, so
 * the gate has no basis to refuse it — but `rebuildSessionFromParse` returns
 * `{ rebuilt: false }` for it before opening a transaction, so nothing is
 * replaced and nothing is in flight (whitlockk, PR #6507).
 */
function unreplaceableSession(): NormalizedSession {
  return makeSession({
    sessionId: SID,
    name: REPLACEMENT_NAME,
    startedAt: null,
  });
}

// Bound to this suite's session id; the statements themselves are shared so a
// sibling rebuild suite cannot drift away from what this one asserts on.
function readMarkers(db: RebuildTestDb): Promise<SessionMarkerRow | undefined> {
  return readSessionProjectionMarkers(db, SID);
}

function readEventIds(db: RebuildTestDb): Promise<string[]> {
  return readSessionEventIds(db, SID);
}

function markStale(db: RebuildTestDb): Promise<void> {
  return setSessionDataRevision(db, SID, STALE_REVISION);
}

function rebuildWith(
  db: RebuildTestDb,
  candidate: NormalizedSession,
  log?: (message: string) => void
) {
  return rebuildSessionFrom(db, SID, candidate, log);
}

describe("ISS-8741 session projection promotion gate", () => {
  test("a legacy row carries neither marker and rebuilds exactly as before", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss8741-legacy-"));
    const db = await openTestDb(dir);
    try {
      await db.importer.importSession(goodSession(), "claude");
      const imported = await readMarkers(db);
      assert.equal(
        imported?.projection_known_good_revision,
        null,
        "an ungated import must not claim a validation that never happened"
      );
      assert.equal(imported?.projection_candidate_revision, null);
      assert.equal(imported?.name, GOOD_NAME);

      await markStale(db);
      const result = await rebuildWith(db, replacementSession());

      assert.equal(result.rebuilt, 1);
      assert.equal(result.errors, 0);
      const after = await readMarkers(db);
      assert.equal(after?.name, REPLACEMENT_NAME);
      assert.equal(after?.data_revision, effectiveDataRevision());
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a candidate the session view refuses cannot retire the standing projection", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss8741-reject-"));
    const db = await openTestDb(dir);
    try {
      await db.importer.importSession(goodSession(), "claude");
      const beforeEvents = await readEventIds(db);
      assert.ok(
        beforeEvents.length > 0,
        "precondition: the session has events"
      );
      await markStale(db);

      const result = await rebuildWith(db, corruptSession());

      assert.equal(result.rebuilt, 0, "a refused candidate is never promoted");
      assert.equal(result.errors, 1, "and is reported as a retryable failure");
      const after = await readMarkers(db);
      assert.equal(
        after?.name,
        GOOD_NAME,
        "the prior projection must still be readable"
      );
      assert.notEqual(after?.cwd, OVERLONG_CWD);
      assert.deepEqual(
        await readEventIds(db),
        beforeEvents,
        "no derived row may be torn down for a candidate that was refused"
      );
      assert.equal(
        after?.data_revision,
        STALE_REVISION,
        "the stale revision stays as the durable retry marker"
      );
      assert.equal(after?.projection_known_good_revision, null);
      assert.equal(
        after?.projection_candidate_revision,
        null,
        "an abandoned attempt releases its in-flight marker"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an accepted candidate is promoted and stamped, and a replay converges", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss8741-promote-"));
    const db = await openTestDb(dir);
    const revision = currentSessionProjectionRevision();
    try {
      await db.importer.importSession(goodSession(), "claude");
      await markStale(db);

      const first = await rebuildWith(db, replacementSession());
      assert.equal(first.rebuilt, 1);
      const afterFirst = await readMarkers(db);
      const eventsAfterFirst = await readEventIds(db);
      assert.equal(afterFirst?.name, REPLACEMENT_NAME);
      assert.equal(afterFirst?.data_revision, effectiveDataRevision());
      assert.equal(afterFirst?.projection_known_good_revision, revision);
      assert.equal(afterFirst?.projection_candidate_revision, null);

      // Replay the promotion itself, rather than re-reading the stamp: the
      // durable state has to be identical afterwards.
      await markStale(db);
      const replay = await rebuildWith(db, replacementSession());
      assert.equal(replay.rebuilt, 1);
      assert.deepEqual(await readMarkers(db), afterFirst);
      assert.deepEqual(await readEventIds(db), eventsAfterFirst);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an interrupted promotion leaves the prior projection and a durable claim", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss8741-interrupt-"));
    // The subject IS a replacement transaction that fails part-way, so the
    // teardown's swallowed-import-failure assertion would fire on the very thing
    // under test.
    const db = await openTestDb(dir, undefined, { allowImportFailures: true });
    const revision = currentSessionProjectionRevision();
    try {
      await db.importer.importSession(goodSession(), "claude");
      await markStale(db);
      assert.equal((await rebuildWith(db, goodSession())).rebuilt, 1);
      const known = await readMarkers(db);
      const knownEvents = await readEventIds(db);
      assert.equal(known?.projection_known_good_revision, revision);

      // The seam: abort INSIDE the replacement transaction, after the teardown
      // and part-way through the re-insert — the exact window in which a
      // non-atomic promotion would leave a session with no derived rows.
      await markStale(db);
      // Park a stamp this build could never write, so the assertion below sees a
      // value that FAILED to advance rather than one that was already correct.
      await db.run(
        "UPDATE sessions SET projection_known_good_revision = $1 WHERE id = $2",
        SEEDED_PRIOR_REVISION,
        SID
      );
      await db.run(
        `CREATE TRIGGER iss8741_fail_event_insert
         BEFORE INSERT ON events
         WHEN NEW.session_id = '${SID}'
         BEGIN
           SELECT RAISE(ABORT, 'forced replacement interruption');
         END`
      );
      const interrupted = await rebuildWith(db, replacementSession());

      assert.equal(interrupted.rebuilt, 0);
      assert.equal(interrupted.errors, 1);
      const after = await readMarkers(db);
      assert.equal(
        after?.name,
        GOOD_NAME,
        "the prior projection must still be readable"
      );
      assert.deepEqual(
        await readEventIds(db),
        knownEvents,
        "the aborted replacement rolled its teardown back"
      );
      assert.equal(
        after?.projection_known_good_revision,
        SEEDED_PRIOR_REVISION,
        "the known-good stamp cannot advance without a complete replacement"
      );
      assert.equal(
        after?.projection_candidate_revision,
        revision,
        "the claim survives as the record that a replacement was attempted"
      );
      assert.equal(after?.data_revision, STALE_REVISION);

      await db.run("DROP TRIGGER iss8741_fail_event_insert");
      const retried = await rebuildWith(db, replacementSession());
      assert.equal(retried.rebuilt, 1);
      const converged = await readMarkers(db);
      assert.equal(converged?.name, REPLACEMENT_NAME);
      assert.equal(
        converged?.projection_known_good_revision,
        revision,
        "the completed replacement replaces the seeded stamp with its own"
      );
      assert.equal(
        converged?.projection_candidate_revision,
        null,
        "a landed replacement clears the in-flight marker"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a replacement whose stamp cannot land takes its own rows down with it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss8741-stamp-tx-"));
    // The subject IS a replacement transaction that fails on its final statement.
    const db = await openTestDb(dir, undefined, { allowImportFailures: true });
    try {
      await db.importer.importSession(goodSession(), "claude");
      const beforeEvents = await readEventIds(db);
      await markStale(db);
      // Abort the STAMP statement specifically, leaving every earlier write in
      // the replacement free to succeed. The row starts unstamped, so the claim's
      // own UPDATE (which leaves `projection_known_good_revision` NULL) does not
      // trip this; only the stamp does.
      //
      // This is the case that distinguishes a stamp INSIDE the replacement's
      // transaction from one committed separately afterwards. Move
      // `stampProjectionKnownGood` out of `runRebuildSessionTransaction` and the
      // teardown+reimport commits — `name` becomes the replacement's and
      // `data_revision` heals — while only the stamp fails. Inside the
      // transaction, the whole thing rolls back, which is what these assertions
      // pin.
      await db.run(
        `CREATE TRIGGER iss8741_fail_known_good_stamp
         BEFORE UPDATE ON sessions
         WHEN NEW.id = '${SID}' AND NEW.projection_known_good_revision IS NOT NULL
         BEGIN
           SELECT RAISE(ABORT, 'forced stamp failure');
         END`
      );

      const result = await rebuildWith(db, replacementSession());

      assert.equal(result.rebuilt, 0);
      const after = await readMarkers(db);
      assert.equal(
        after?.name,
        GOOD_NAME,
        "the replacement's rows must roll back with its stamp"
      );
      assert.deepEqual(await readEventIds(db), beforeEvents);
      assert.equal(after?.projection_known_good_revision, null);
      assert.equal(
        after?.data_revision,
        STALE_REVISION,
        "and the revision stays stale so the session is retried"
      );

      await db.run("DROP TRIGGER iss8741_fail_known_good_stamp");
      const retried = await rebuildWith(db, replacementSession());
      assert.equal(retried.rebuilt, 1);
      const converged = await readMarkers(db);
      assert.equal(converged?.name, REPLACEMENT_NAME);
      assert.equal(
        converged?.projection_known_good_revision,
        currentSessionProjectionRevision()
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the stamped revision names all four counters that decide the projection", () => {
    // The component NAMES are literals and each version is read from its own
    // canonical owner — never from the function under test. Dropping a component
    // (the `schema` axis was the tempting one) fails here instead of silently
    // making a record-schema bump stop invalidating a stamped projection.
    assert.deepEqual(sessionProjectionRevisionComponents(), [
      { name: "data", version: effectiveDataRevision() },
      { name: "classifier", version: ACTIVITY_CLASSIFIER_VERSION },
      { name: "extractor", version: EXTRACTOR_VERSION },
      { name: "schema", version: AGENT_SESSION_SYNC_SCHEMA_VERSION },
    ]);
  });

  test("bumping any one of the four counters produces a different descriptor", () => {
    const current = currentSessionProjectionRevision();
    assert.ok(current, "precondition: the current revision formats");
    for (const component of sessionProjectionRevisionComponents()) {
      const bumped = formatDerivedProjectionRevision(
        sessionProjectionRevisionComponents().map((entry) =>
          entry.name === component.name
            ? { name: entry.name, version: entry.version + 1 }
            : entry
        )
      );
      assert.notEqual(
        bumped,
        current,
        `a ${component.name} bump must make the stored descriptor compare unequal`
      );
    }
  });

  test("the gate hands the replacement the revision it will stamp", async () => {
    const calls: Array<{ sessionId: string; revision?: string | null }> = [];
    const claims: string[] = [];
    const releases: string[] = [];
    const result = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("claude", {
          sources: [`/fake/${SID}.jsonl`],
          parse: () => Promise.resolve([goodSession()]),
          sessionIdForSource: () => SID,
        }),
      ],
      db: {
        listStaleRevisionSessions: () =>
          Promise.resolve([{ id: SID, harness: "claude", status: "inactive" }]),
        rebuildSessionFromParse: (session, _harness, projectionRevision) => {
          calls.push({
            sessionId: session.sessionId,
            revision: projectionRevision,
          });
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
        claimProjectionCandidate: (sessionId, revision) => {
          claims.push(`${sessionId}:${revision}`);
          return Promise.resolve();
        },
        releaseProjectionCandidate: (sessionId) => {
          releases.push(sessionId);
          return Promise.resolve();
        },
        deleteSessionRow: () => Promise.resolve(true),
      },
    });

    assert.equal(result.rebuilt, 1);
    assert.deepEqual(calls, [
      { sessionId: SID, revision: currentSessionProjectionRevision() },
    ]);
    assert.deepEqual(claims, [`${SID}:${currentSessionProjectionRevision()}`]);
    assert.deepEqual(
      releases,
      [],
      "a landed replacement clears its own marker in-transaction, not out of band"
    );
  });

  test("the claim reaches the db host as a plain op, not a detached method", async () => {
    // The production `db` is the db-host method PROXY, whose `get` trap answers
    // `call`/`bind`/`apply` with `undefined` so a detach fails loudly rather than
    // posting the uncloneable proxy over IPC. An earlier draft of the store
    // adapter used `claimProjectionCandidate.call(db, …)`, which threw on every
    // real launch and was swallowed by the marker store's tolerant catch — so the
    // marker silently never persisted while every in-process suite stayed green.
    // Driving the real proxy is the only thing that can see that.
    const invoked: Array<{ op: string; args: unknown[] }> = [];
    const client = {
      invoke: (op: string, args: unknown[]) => {
        invoked.push({ op, args });
        if (op === "rebuildSessionFromParse") {
          return Promise.resolve({ rebuilt: true, activeRace: false });
        }
        if (op === "listStaleRevisionSessions") {
          return Promise.resolve([
            { id: SID, harness: "claude", status: "inactive" },
          ]);
        }
        return Promise.resolve(undefined);
      },
    } as unknown as DbHostClient;

    const result = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("claude", {
          sources: [`/fake/${SID}.jsonl`],
          parse: () => Promise.resolve([goodSession()]),
          sessionIdForSource: () => SID,
        }),
      ],
      db: createDbHostAgentDatabase(client),
    });

    assert.equal(result.rebuilt, 1);
    assert.deepEqual(
      invoked
        .filter((entry) => entry.op === "claimProjectionCandidate")
        .map((entry) => entry.args),
      [[SID, currentSessionProjectionRevision()]],
      "the claim must have crossed the proxy exactly once, as its own op"
    );
  });

  test("a database with no marker methods still gets the gate", async () => {
    const calls: string[] = [];
    const result = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("claude", {
          sources: [`/fake/${SID}.jsonl`],
          parse: () => Promise.resolve([corruptSession()]),
          sessionIdForSource: () => SID,
        }),
      ],
      db: {
        listStaleRevisionSessions: () =>
          Promise.resolve([{ id: SID, harness: "claude", status: "inactive" }]),
        rebuildSessionFromParse: (session) => {
          calls.push(session.sessionId);
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
        deleteSessionRow: () => Promise.resolve(true),
      },
    });

    assert.deepEqual(
      calls,
      [],
      "a refused candidate must not reach the replacement even with no marker store"
    );
    assert.equal(result.rebuilt, 0);
    assert.equal(result.errors, 1);
  });
  test("a promotion that replaced nothing does not leave a claim standing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss8741-noreplace-"));
    const db = await openTestDb(dir);
    const revision = currentSessionProjectionRevision();
    try {
      await db.importer.importSession(goodSession(), "claude");
      await markStale(db);

      // `startedAt: null` is type-legal and schema-legal, so the VALIDATOR has
      // no basis to refuse it. The replacement declines it before opening a
      // transaction, so no in-transaction release ever runs — the marker is
      // cleared only because the gate treats an unreplaceable candidate as one
      // it could not build.
      const result = await rebuildWith(db, unreplaceableSession());

      assert.equal(result.rebuilt, 0, "nothing was replaced");
      const after = await readMarkers(db);
      assert.equal(
        after?.name,
        GOOD_NAME,
        "the prior projection must still be readable"
      );
      assert.notEqual(
        after?.projection_candidate_revision,
        revision,
        "a replacement that never started must not report itself in flight"
      );
      assert.equal(after?.projection_candidate_revision, null);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an ordinary import that replaces the projection invalidates both markers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss8741-reimport-"));
    const db = await openTestDb(dir);
    const revision = currentSessionProjectionRevision();
    try {
      await db.importer.importSession(goodSession(), "claude");
      await markStale(db);
      assert.equal((await rebuildWith(db, goodSession())).rebuilt, 1);
      const stamped = await readMarkers(db);
      assert.equal(
        stamped?.projection_known_good_revision,
        revision,
        "precondition: the row carries a known-good stamp"
      );
      // Park an in-flight marker too, as an interrupted attempt would leave it.
      await db.run(
        "UPDATE sessions SET projection_candidate_revision = $1 WHERE id = $2",
        revision,
        SID
      );

      // Ordinary ingestion, NOT the gate. It replaces `metadata` with a
      // candidate no validator ever saw.
      await db.importer.importSession(replacementSession(), "claude");

      const after = await readMarkers(db);
      assert.equal(
        after?.name,
        REPLACEMENT_NAME,
        "precondition: the import did replace the projection"
      );
      assert.equal(
        after?.projection_known_good_revision,
        null,
        "an ungated replacement cannot inherit the stamp it did not earn"
      );
      assert.equal(
        after?.projection_candidate_revision,
        null,
        "and a healed row cannot keep reporting an interrupted replacement"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a rejection log sanitizes and bounds the identifier it quotes", async () => {
    // The in-process `collector.parse` fallback never crosses the worker
    // protocol boundary, so this identifier reaches the log exactly as the parse
    // spelled it.
    const hostileId = `${SID}\u001b[31m\u0007${"z".repeat(5000)}`;
    const lines: string[] = [];
    const result = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("claude", {
          sources: [`/fake/${SID}.jsonl`],
          parse: () =>
            Promise.resolve([
              makeSession({
                sessionId: hostileId,
                cwd: OVERLONG_CWD,
                toolUses: [],
              }),
            ]),
          sessionIdForSource: () => hostileId,
        }),
      ],
      db: {
        listStaleRevisionSessions: () =>
          Promise.resolve([
            { id: hostileId, harness: "claude", status: "inactive" },
          ]),
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.resolve(true),
      },
      log: (message) => lines.push(message),
    });

    assert.equal(result.rebuilt, 0, "precondition: the candidate was refused");
    const rejection = lines.find((line) =>
      line.includes("projectionRejected=")
    );
    assert.ok(rejection, "the refusal must be reported");
    assert.doesNotMatch(
      rejection,
      CONTROL_OR_ESCAPE_RE,
      "no control byte or ANSI escape may reach the log sink"
    );
    assert.ok(
      Buffer.byteLength(rejection, "utf8") < hostileId.length,
      "an oversized identifier must not be quoted whole"
    );
    assert.ok(
      rejection.includes(SID),
      "the diagnosable prefix of the identifier still survives"
    );
  });
});
