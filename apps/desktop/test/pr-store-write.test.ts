import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Harness } from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { upsertPullRequest } from "../src/main/pull-requests/pr-store.js";
import { makeSession } from "./normalized-session-test-utils.js";

test("upsertPullRequest uses the injected clock once and advances only for newer external observations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea-3229-pr-store-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => CREATED_AT,
  });

  try {
    await db.run(
      "INSERT INTO sessions (id, status, harness) VALUES ($1, $2, $3)",
      SESSION_ID,
      "completed",
      Harness.Claude
    );

    await writePullRequest(db, null, CREATED_AT);
    assert.deepEqual(await readTimestamps(db), {
      createdAt: CREATED_AT,
      observedAt: CREATED_AT,
    });

    for (const observedAt of [
      null,
      "not-a-timestamp",
      "2026-07-16T08:00:00.000Z",
      CREATED_AT,
    ]) {
      await writePullRequest(db, observedAt, "2026-07-16T13:00:00.000Z");
    }
    assert.deepEqual(await readTimestamps(db), {
      createdAt: CREATED_AT,
      observedAt: CREATED_AT,
    });

    await writePullRequest(
      db,
      ADVANCED_OBSERVATION,
      "2026-07-16T14:00:00.000Z"
    );
    assert.deepEqual(await readTimestamps(db), {
      createdAt: CREATED_AT,
      observedAt: ADVANCED_OBSERVATION,
    });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("session rebuild preserves PR provenance, removes stale rows, and converges in both write orders", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea-3229-pr-rebuild-"));
  let now = CREATED_AT;
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => now,
  });
  const original = makePrSession(ORIGINAL_OBSERVATION, [PR_URL, STALE_PR_URL]);
  const rebuilt = makePrSession(ORIGINAL_OBSERVATION, [PR_URL]);

  try {
    await db.importer.importSession(original, Harness.Claude);
    const initial = await readSessionPullRequests(db, REBUILD_SESSION_ID);
    assert.equal(initial.length, 2);
    assert.deepEqual(initial[0], {
      prUrl: PR_URL,
      createdAt: CREATED_AT,
      observedAt: ORIGINAL_OBSERVATION,
    });

    now = "2026-07-16T13:00:00.000Z";
    assert.deepEqual(
      await db.rebuildSessionFromParse(rebuilt, Harness.Claude),
      // FEA-3659: the re-derived payload differs (PR observation timestamp), so
      // the rebuild reports contentChanged=true (updated_at bumped; enqueued for sync).
      { rebuilt: true, activeRace: false, contentChanged: true }
    );
    assert.deepEqual(await readSessionPullRequests(db, REBUILD_SESSION_ID), [
      initial[0],
    ]);

    const newer = makePrSession(NEWER_OBSERVATION, [PR_URL]);
    await db.importer.importSession(newer, Harness.Claude);
    await db.rebuildSessionFromParse(rebuilt, Harness.Claude);
    assert.deepEqual(await readSessionPullRequests(db, REBUILD_SESSION_ID), [
      {
        prUrl: PR_URL,
        createdAt: CREATED_AT,
        observedAt: NEWER_OBSERVATION,
      },
    ]);

    const newest = makePrSession(NEWEST_OBSERVATION, [PR_URL]);
    await db.rebuildSessionFromParse(rebuilt, Harness.Claude);
    await db.importer.importSession(newest, Harness.Claude);
    assert.deepEqual(await readSessionPullRequests(db, REBUILD_SESSION_ID), [
      {
        prUrl: PR_URL,
        createdAt: CREATED_AT,
        observedAt: NEWEST_OBSERVATION,
      },
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

type TestDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

async function writePullRequest(
  db: TestDb,
  observedAt: string | null,
  now: string
): Promise<void> {
  await db.prisma.write((client) =>
    client.$transaction((tx) =>
      upsertPullRequest(
        tx,
        {
          externalSessionId: SESSION_ID,
          harness: Harness.Claude,
          prUrl: PR_URL,
          prNumber: 3229,
          repoFullName: "closedloop-ai/symphony-alpha",
          observedAt,
        },
        now
      )
    )
  );
}

async function readTimestamps(
  db: TestDb
): Promise<{ createdAt: string | null; observedAt: string | null }> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { created_at: string | null; observed_at: string | null }[]
  >(
    "SELECT created_at, observed_at FROM pull_requests WHERE session_id = $1",
    SESSION_ID
  );
  if (rows.length !== 1) {
    throw new Error(`Expected one PR row, received ${rows.length}`);
  }
  return {
    createdAt: rows[0].created_at,
    observedAt: rows[0].observed_at,
  };
}

function makePrSession(observedAt: string, prUrls: string[]) {
  return makeSession({
    sessionId: REBUILD_SESSION_ID,
    startedAt: "2026-07-16T08:00:00.000Z",
    endedAt: observedAt,
    artifacts: {
      prs: prUrls.map((url, index) => ({
        number: String(index === 0 ? 3229 : 3230),
        repo: "closedloop-ai/symphony-alpha",
        url,
      })),
      issues: [],
      repo: "closedloop-ai/symphony-alpha",
    },
  });
}

async function readSessionPullRequests(
  db: TestDb,
  sessionId: string
): Promise<
  { prUrl: string; createdAt: string | null; observedAt: string | null }[]
> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    {
      pr_url: string;
      created_at: string | null;
      observed_at: string | null;
    }[]
  >(
    `SELECT pr_url, created_at, observed_at
       FROM pull_requests WHERE session_id = $1 ORDER BY pr_url ASC`,
    sessionId
  );
  return rows.map((row) => ({
    prUrl: row.pr_url,
    createdAt: row.created_at,
    observedAt: row.observed_at,
  }));
}

const SESSION_ID = "fea-3229-pr-store-session";
const REBUILD_SESSION_ID = "fea-3229-pr-rebuild-session";
const PR_URL = "https://github.com/closedloop-ai/symphony-alpha/pull/3229";
const STALE_PR_URL =
  "https://github.com/closedloop-ai/symphony-alpha/pull/3230";
const CREATED_AT = "2026-07-16T09:00:00.000Z";
const ORIGINAL_OBSERVATION = "2026-07-16T10:00:00.000Z";
const ADVANCED_OBSERVATION = "2026-07-16T10:00:00.000Z";
const NEWER_OBSERVATION = "2026-07-16T11:00:00.000Z";
const NEWEST_OBSERVATION = "2026-07-16T12:00:00.000Z";
