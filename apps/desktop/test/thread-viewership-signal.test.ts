/**
 * @file thread-viewership-signal.test.ts
 * @description ISS-7830 — the capability the dynamic headless ruling needs:
 * capture a thread view, keep it, and let the classification read it.
 *
 * Four properties, each with a sibling that fails independently.
 *
 *  1. THE RULE, BOTH DIRECTIONS, ON ONE FIXTURE. The same agent-spawned metadata
 *     classifies headless unviewed and attended viewed, through the production
 *     `buildSessionAutonomyInputFromTrace` — which also proves the persisted
 *     launch facet is read off `metadata` and composed, not just that the leaf
 *     predicate works. Either direction alone is satisfied by an implementation
 *     that always answers that way.
 *  2. MONOTONIC. A second view of the same thread cannot move the recorded
 *     instant, and there is no path that retracts it. A single-write fixture
 *     cannot observe the hazard, which is a session flipping classification
 *     across rebuilds with no user action in between.
 *  3. IT SURVIVES A `DATA_REVISION` REBUILD. This is the one most likely to be
 *     quietly broken: the rebuild re-imports every session and rewrites
 *     `sessions.metadata` wholesale, so a signal stored there would be erased by
 *     the very pass that recomputes the classification reading it. Driven through
 *     the REAL `runDataRevisionRebuild`, not a hand-written UPDATE.
 *  4. THE GATE FAILS CLOSED. Unregistered, and when its resolver throws, the
 *     capture is off — which is the pre-ISS-7830 classification.
 *  5. A SESSION THIS DEVICE HOLDS NO ROW FOR IS REFUSED, NOT THROWN AT. The
 *     table has a foreign key and every connection runs `foreign_keys=ON`, and
 *     the detail view captures on mount precisely so a not-found session is not
 *     dropped — so the un-guarded insert raised SQLITE_CONSTRAINT on the one
 *     path the feature says it protects.
 *  6. A FIRST VIEW RE-QUEUES ITS SESSION FOR CLOUD SYNC. Sync selection walks
 *     `sessions.updated_at` and viewership is written outside `importSession`,
 *     so without the bump a session already uploaded as headless would keep that
 *     stale classification on the cloud forever. It must fire ONCE — a re-open
 *     that bumped again would be exactly the cursor churn the repo refuses.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { buildSessionAutonomyInputFromTrace } from "../src/main/database/session-trace-autonomy-input.js";
import {
  recordThreadViewed,
  selectViewedSessionIds,
} from "../src/main/database/session-viewership-store.js";
import {
  isThreadViewershipSignalEnabled,
  setThreadViewershipSignalResolver,
} from "../src/main/session/thread-viewership-gate.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  fakeCollector,
  makePopulatedSession,
} from "./normalized-session-test-utils.js";

const SESSION_ID = "iss7830-subagent-thread";
const FIRST_VIEW_AT = "2026-08-24T10:00:00.000Z";
/** Strictly later than the first view — a re-open of the same thread. */
const SECOND_VIEW_AT = "2026-08-24T18:30:00.000Z";
/** Historical, already behind any realistic sync cursor. */
const STALE_WATERMARK = "2026-06-01T00:00:00.000Z";
/** Later than the view — a live session whose watermark already moved past it. */
const AHEAD_OF_VIEW = "2026-09-01T00:00:00.000Z";

/**
 * A thread the harness itself said another agent spawned, on an INTERACTIVE
 * entrypoint — so `headless` can only come from the launch facet, never from the
 * entrypoint rules, and the override is the only thing the assertions can be
 * reading. The literal is pinned here rather than built by calling the code under
 * test; the duplication IS the test.
 */
const AGENT_SPAWNED_METADATA: Record<string, unknown> = {
  entrypoint: "cli",
  messages: [{ role: "human", timestamp: "2026-08-24T09:00:00.000Z" }],
  harnessLaunchAttribution: { threadSource: "subagent" },
};

/** The negative control: the same shape, stating a person started the thread. */
const USER_STARTED_METADATA: Record<string, unknown> = {
  entrypoint: "cli",
  messages: [{ role: "human", timestamp: "2026-08-24T09:00:00.000Z" }],
  harnessLaunchAttribution: { threadSource: "user", promptSource: "typed" },
};

function classify(
  metadata: Record<string, unknown>,
  viewedByUser: boolean
): boolean {
  return buildSessionAutonomyInputFromTrace(metadata, [], [], viewedByUser)
    .headless;
}

afterEach(() => {
  // The gate is module state shared by every suite in this lane; leaving it
  // registered would let one case decide another's classification.
  setThreadViewershipSignalResolver(() => false);
});

describe("ISS-7830: viewership overrides the launch-time headless default", () => {
  test("an agent-spawned thread nobody opened classifies headless", () => {
    assert.equal(classify(AGENT_SPAWNED_METADATA, false), true);
  });

  test("the SAME agent-spawned thread, once opened, classifies attended", () => {
    // The sibling that makes the case above mean something. Without it, an
    // implementation ignoring viewership entirely stays green.
    assert.equal(classify(AGENT_SPAWNED_METADATA, true), false);
  });

  test("a thread a person started is attended whether or not it was opened", () => {
    // Viewership may only ever REMOVE the unattended verdict — never add one.
    assert.equal(classify(USER_STARTED_METADATA, false), false);
    assert.equal(classify(USER_STARTED_METADATA, true), false);
  });

  test("a session carrying no launch facet is unchanged in both directions", () => {
    const noFacet: Record<string, unknown> = { entrypoint: "cli" };
    assert.equal(classify(noFacet, false), false);
    assert.equal(classify(noFacet, true), false);
  });

  test("an SDK entrypoint stays headless even once opened", () => {
    // The override is scoped to the LAUNCH-ATTRIBUTION leg. The entrypoint rules
    // are evidenced against the signed golden dossiers and describe how the
    // process started, not who spawned the thread, so opening an `sdk-` run must
    // not reclassify it — that would silently widen a corpus-wide rule.
    const sdkLaunched: Record<string, unknown> = { entrypoint: "sdk-cli" };
    assert.equal(classify(sdkLaunched, true), true);
  });
});

describe("ISS-7830: the capture gate fails closed", () => {
  test("no registered resolver means the capture is off", () => {
    assert.equal(isThreadViewershipSignalEnabled(), false);
  });

  test("a resolver that throws is treated as off, not as an error", () => {
    setThreadViewershipSignalResolver(() => {
      throw new Error("settings store unavailable");
    });
    assert.equal(isThreadViewershipSignalEnabled(), false);
  });

  test("a registered resolver is what turns the capture on", () => {
    // The positive sibling: without it, a gate hardwired to `false` passes both
    // cases above.
    setThreadViewershipSignalResolver(() => true);
    assert.equal(isThreadViewershipSignalEnabled(), true);
  });
});

describe("ISS-7830: the recorded view is durable and monotonic", () => {
  test("a session this device holds no row for is refused, not thrown at", async () => {
    // `session_viewership.session_id` is a foreign key and every connection runs
    // `PRAGMA foreign_keys=ON`, so the un-guarded insert raised
    // `SQLITE_CONSTRAINT: FOREIGN KEY constraint failed` here — on the mount the
    // detail view makes deliberately for a not-found session. The throw crossed
    // the db-host boundary, rejected the IPC handler, and was swallowed by the
    // renderer, so the capture failed invisibly on its own motivating case.
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7830-orphan-"));
    const db = await openTestDb(dir);
    try {
      const recorded = await recordThreadViewed(
        db.prisma,
        "no-such-session",
        FIRST_VIEW_AT
      );
      assert.equal(recorded, false, "the caller is told nothing was recorded");
      const rows = await db.prisma.client.$queryRawUnsafe<{ one: number }[]>(
        "SELECT 1 AS one FROM session_viewership WHERE session_id = $1",
        "no-such-session"
      );
      assert.equal(rows.length, 0, "and no orphan row was written");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a first view re-queues its session for cloud sync, and only the first", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7830-requeue-"));
    const db = await openTestDb(dir);
    try {
      await db.importer.importSession(
        makePopulatedSession({ sessionId: SESSION_ID }),
        "claude"
      );
      // Park the row below any realistic sync cursor, the way an already-uploaded
      // quiet session sits. Without the bump nothing ever re-selects it.
      await db.run(
        "UPDATE sessions SET updated_at = $1 WHERE id = $2",
        STALE_WATERMARK,
        SESSION_ID
      );

      assert.equal(
        await recordThreadViewed(db.prisma, SESSION_ID, FIRST_VIEW_AT),
        true
      );
      assert.equal(
        await readUpdatedAt(db, SESSION_ID),
        FIRST_VIEW_AT,
        "a first view moves the sync watermark, or the cloud keeps the stale classification forever"
      );

      // The convergence half. The monotonic table makes the insert a no-op, so
      // the watermark must NOT move again — a re-opened thread that re-bumped
      // would drive an endless sync-cursor churn.
      assert.equal(
        await recordThreadViewed(db.prisma, SESSION_ID, SECOND_VIEW_AT),
        true,
        "a repeat view still reports the thread as on record"
      );
      assert.equal(
        await readUpdatedAt(db, SESSION_ID),
        FIRST_VIEW_AT,
        "and re-opening it does not bump the watermark again"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the re-queue never moves a live session's watermark backwards", async () => {
    // The hazard the bump itself introduces. A live session's `updated_at` is
    // stamped with the import wall clock and can already sit AHEAD of the view;
    // writing the older instant would drop the row back BELOW the sync cursor
    // and hide the very session the bump exists to re-deliver.
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7830-forward-"));
    const db = await openTestDb(dir);
    try {
      await db.importer.importSession(
        makePopulatedSession({ sessionId: SESSION_ID }),
        "claude"
      );
      await db.run(
        "UPDATE sessions SET updated_at = $1 WHERE id = $2",
        AHEAD_OF_VIEW,
        SESSION_ID
      );

      assert.equal(
        await recordThreadViewed(db.prisma, SESSION_ID, FIRST_VIEW_AT),
        true,
        "the view is still recorded"
      );
      assert.equal(
        await readUpdatedAt(db, SESSION_ID),
        AHEAD_OF_VIEW,
        "and the watermark is left where it was, never rewound"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a second view of the same thread cannot move the recorded instant", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7830-monotonic-"));
    const db = await openTestDb(dir);
    try {
      await db.importer.importSession(
        makePopulatedSession({ sessionId: SESSION_ID }),
        "claude"
      );
      await recordThreadViewed(db.prisma, SESSION_ID, FIRST_VIEW_AT);
      await recordThreadViewed(db.prisma, SESSION_ID, SECOND_VIEW_AT);
      const [row] = await db.prisma.client.$queryRawUnsafe<
        { first_viewed_at: string }[]
      >(
        "SELECT first_viewed_at FROM session_viewership WHERE session_id = $1",
        SESSION_ID
      );
      assert.equal(
        row.first_viewed_at,
        FIRST_VIEW_AT,
        "the FIRST view is the one kept — a later write must not overwrite it"
      );
      const viewed = await db.prisma.read((reader) =>
        selectViewedSessionIds(reader, [SESSION_ID])
      );
      assert.equal(viewed.has(SESSION_ID), true);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unviewed session is reported unviewed", async () => {
    // The positive sibling's negative control: without it, a reader hardwired to
    // report every id as viewed passes the case above.
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7830-unviewed-"));
    const db = await openTestDb(dir);
    try {
      await db.importer.importSession(
        makePopulatedSession({ sessionId: SESSION_ID }),
        "claude"
      );
      const viewed = await db.prisma.read((reader) =>
        selectViewedSessionIds(reader, [SESSION_ID])
      );
      assert.equal(viewed.has(SESSION_ID), false);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the view survives a DATA_REVISION rebuild of the same session", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7830-rebuild-"));
    const db = await openTestDb(dir);
    try {
      const build = () => makePopulatedSession({ sessionId: SESSION_ID });
      await db.importer.importSession(build(), "claude");
      await recordThreadViewed(db.prisma, SESSION_ID, FIRST_VIEW_AT);
      // Stale the revision so the production rebuild actually selects this row.
      await db.run(
        "UPDATE sessions SET data_revision = 0, status = 'inactive' WHERE id = $1",
        SESSION_ID
      );
      const summary = await runDataRevisionRebuild({
        collectors: [
          fakeCollector("claude", {
            sources: [`/fake/${SESSION_ID}.jsonl`],
            sessionIdForSource: () => SESSION_ID,
            parse: () => Promise.resolve([build()]),
          }),
        ],
        db,
      });
      assert.equal(summary.rebuilt, 1, "the session was actually re-imported");
      const viewed = await db.prisma.read((reader) =>
        selectViewedSessionIds(reader, [SESSION_ID])
      );
      assert.equal(
        viewed.has(SESSION_ID),
        true,
        "a rebuild recomputes the classification, so erasing its input here would silently reclassify every opened thread"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** One session's sync watermark, read straight from the row. */
async function readUpdatedAt(
  db: Awaited<ReturnType<typeof openTestDb>>,
  sessionId: string
): Promise<string> {
  const [row] = await db.prisma.client.$queryRawUnsafe<
    { updated_at: string }[]
  >("SELECT updated_at FROM sessions WHERE id = $1", sessionId);
  return row.updated_at;
}
