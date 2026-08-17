/**
 * ISS-6451: the dashboard pull-request read's PAGE WINDOW.
 *
 * `dashboard.getPullRequests` was the last unwindowed full-corpus row read in
 * `dashboard-queries.ts`: it returned every `kind='pull_request'` artifact,
 * sorted the wide rows (title, url, head_sha, session_name) in JS, and shipped
 * the whole array across the db-host IPC boundary, through either of the two
 * entry points that reach it — the `getCoreFeatures` fan-out and the standalone
 * `desktop:db:get-pull-requests` channel. This pins the window that closed it:
 * the page size is a CEILING rather than a mere default, the ORDER is now the
 * query's (`unixepoch(observed_at) DESC NULLS LAST`, tie-broken on artifact id,
 * over a deduped join) so a `LIMIT`/`OFFSET` page is a real slice of one TOTAL
 * order, and untrusted bounds floor instead of inverting the page.
 *
 * Mirrors `dashboard-plans-window.test.ts`, its ISS-5631 sibling, and lives in
 * its own file for the same reason: `dashboard-queries-contract.test.ts` sits
 * just under the 1,000 logical-line ceiling.
 *
 * Like the sibling contract tests this runs through `openSqliteAgentDatabase`
 * (the runtime + electron load), so it is a CI guard.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT } from "../src/main/database/db-constants.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  artifactIdFromIdentityKey,
  computeIdentityKey,
} from "../src/main/enrichment/identity-key.js";

const NOW = "2026-06-22T00:00:00.000Z";
const T1 = "2026-06-20T10:00:00.000Z";
const REPO = "closedloop-ai/symphony-alpha";
const SESSION_ID = "s-many-prs";

type SeededDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

/**
 * One PR artifact plus the `created` link that puts it in the delivery
 * population the read gates on. `observedAt` is what the window orders by.
 */
async function seedPullRequest(
  db: SeededDb,
  prNumber: number,
  observedAt: string | null
): Promise<void> {
  const identityKey = computeIdentityKey({
    kind: "pull_request",
    repoFullName: REPO,
    prNumber,
  });
  const artifactId = artifactIdFromIdentityKey(identityKey);
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, pr_number, title,
        harness, observed_at, created_at, last_seen_at)
     VALUES ($1, $2, 'pull_request', $3, $4, $5, 'claude', $6, $7, $7)`,
    artifactId,
    identityKey,
    REPO,
    prNumber,
    `PR ${prNumber}`,
    observedAt,
    T1
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, is_primary,
        status, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, 'created', 'test_fixture', '{}', 0, 'candidate', 1, $4, $4)`,
    `${SESSION_ID}:${artifactId}:created`,
    SESSION_ID,
    artifactId,
    T1
  );
}

test("getPullRequests caps the page at MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT and honors limit/offset", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-pr-window-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $1, 'inactive', $2, $2, 'claude')`,
      SESSION_ID,
      T1
    );

    // More PRs than the ceiling. PR `i` is observed one minute later than
    // PR `i - 1`, so the newest-first order is known exactly at any offset.
    const prCount = MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT + 20;
    for (let i = 0; i < prCount; i++) {
      await seedPullRequest(
        db,
        i + 1,
        new Date(Date.parse(T1) + i * 60_000).toISOString()
      );
    }
    // Newest-first: PR `prCount` leads, descending by one each step.
    const expectedNumberAt = (rank: number) => prCount - rank;

    // Default window: bounded by the ceiling, NOT the full corpus.
    const defaulted = await db.dashboard.getPullRequests();
    assert.equal(defaulted.length, MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT);
    assert.equal(defaulted[0]?.prNumber, expectedNumberAt(0));

    // An over-large limit is CLAMPED to the ceiling — this is what stops the
    // whole corpus from crossing IPC on one call.
    const greedy = await db.dashboard.getPullRequests({ limit: prCount * 10 });
    assert.equal(greedy.length, MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT);

    // A window is the slice of that same order, so page 2 continues page 1 —
    // no artifact appears on both pages and none is skipped between them.
    const firstPage = await db.dashboard.getPullRequests({ limit: 5 });
    const secondPage = await db.dashboard.getPullRequests({
      limit: 5,
      offset: 5,
    });
    assert.deepEqual(
      firstPage.map((pr) => pr.prNumber),
      [0, 1, 2, 3, 4].map(expectedNumberAt)
    );
    assert.deepEqual(
      secondPage.map((pr) => pr.prNumber),
      [5, 6, 7, 8, 9].map(expectedNumberAt)
    );
    // The wide row still rides the page — the cap bounds the row COUNT, and
    // narrowing the selected columns is not part of this contract.
    assert.equal(firstPage[0]?.title, `PR ${expectedNumberAt(0)}`);
    assert.equal(firstPage[0]?.repoFullName, REPO);

    // Untrusted bounds floor instead of inverting the page: a negative limit
    // must not read from the end, and a negative offset must not shift it.
    const floored = await db.dashboard.getPullRequests({
      limit: -1,
      offset: -5,
    });
    assert.deepEqual(
      floored.map((pr) => pr.prNumber),
      [expectedNumberAt(0)]
    );

    // A FRACTIONAL bound truncates toward what the caller asked for. Falling
    // back to the default here would turn a malformed NARROW request into the
    // full page — a clamp that widens is not a clamp.
    const fractional = await db.dashboard.getPullRequests({
      limit: 3.7,
      offset: 1.9,
    });
    assert.deepEqual(
      fractional.map((pr) => pr.prNumber),
      [1, 2, 3].map(expectedNumberAt)
    );

    // Only a bound that carries no window at all may default.
    const notANumber = await db.dashboard.getPullRequests({
      limit: Number.NaN,
      offset: Number.POSITIVE_INFINITY,
    });
    assert.equal(notANumber.length, MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT);
    assert.equal(notANumber[0]?.prNumber, expectedNumberAt(0));

    // An offset past the corpus is an empty page, never a wrapped one.
    const beyond = await db.dashboard.getPullRequests({ offset: prCount });
    assert.deepEqual(beyond, []);

    // Unlike `limit`, `offset` has no domain ceiling of its own, and it now
    // reaches SQL directly: past `Number.MAX_SAFE_INTEGER` the driver rejects
    // with a message-less error that would surface out of the IPC handler, so
    // the clamp has to degrade an absurd offset to that same empty page.
    const absurd = await db.dashboard.getPullRequests({
      offset: Number.MAX_VALUE,
    });
    assert.deepEqual(absurd, []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("getPullRequests orders by observed_at DESC in SQL, keeping an unstamped PR at the tail", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-pr-order-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $1, 'inactive', $2, $2, 'claude')`,
      SESSION_ID,
      T1
    );
    // Seeded oldest-last so insertion order cannot be mistaken for the result
    // order, plus one artifact with NO observed_at: the JS `compareIsoDesc` fold
    // this read replaced treated an absent timestamp as the epoch and put it
    // last, and the query has to keep it there. (SQLite already sorts NULL last
    // under a bare `DESC` — NULL is its smallest value — so the explicit
    // `NULLS LAST` states the requirement rather than creating it. What DOES
    // create it is the `unixepoch` sort key, which folds an unparseable
    // timestamp into that same NULL; the case below covers that one.)
    await seedPullRequest(db, 11, "2026-06-20T10:02:00.000Z");
    await seedPullRequest(db, 12, null);
    await seedPullRequest(db, 13, "2026-06-20T10:09:00.000Z");
    await seedPullRequest(db, 14, "2026-06-20T10:05:00.000Z");

    const prs = await db.dashboard.getPullRequests();
    assert.deepEqual(
      prs.map((pr) => pr.prNumber),
      [13, 14, 11, 12]
    );

    // The page boundary respects that same order: the unstamped PR is on the
    // LAST page, so a caller reading page 1 never sees it in place of a real one.
    const firstPage = await db.dashboard.getPullRequests({ limit: 3 });
    assert.deepEqual(
      firstPage.map((pr) => pr.prNumber),
      [13, 14, 11]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("getPullRequests orders by INSTANT, so a legacy non-canonical observed_at cannot jump the page", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-pr-legacy-ts-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $1, 'inactive', $2, $2, 'claude')`,
      SESSION_ID,
      T1
    );
    // ISS-5427 canonicalizes every writer of `artifacts.observed_at`, but rows
    // written before it were never backfilled and a session whose transcript is
    // gone is skipped by the DATA_REVISION re-derive, so both shapes below can
    // still be in a live store. Each sorts one way by BYTES and the other way by
    // INSTANT — which is what the JS `compareIsoDesc` fold this read replaced
    // compared, and what the query must keep comparing now that a `LIMIT` makes
    // the order decide what the caller can see at all.
    await seedPullRequest(db, 21, "2026-06-20T09:00:00.000Z");
    // Really 08:00Z — EARLIER than PR 21, though its digits sort later.
    await seedPullRequest(db, 22, "2026-06-20T10:00:00+02:00");
    // Unparseable: `Date.parse` gave NaN and the fold put it last. A byte-wise
    // `DESC` would instead rank it above every real timestamp, at the head of
    // page 1.
    await seedPullRequest(db, 23, "unknown");

    assert.deepEqual(
      (await db.dashboard.getPullRequests()).map((pr) => pr.prNumber),
      [21, 22, 23]
    );

    // The single-row page proves the ordering decides the page CONTENTS, not
    // just the arrangement of a page that happened to hold everything.
    assert.deepEqual(
      (await db.dashboard.getPullRequests({ limit: 1 })).map(
        (pr) => pr.prNumber
      ),
      [21]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("getPullRequests keeps one row per artifact when a session has two pull_requests rows for the same PR", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-pr-fanout-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $1, 'inactive', $2, $2, 'claude')`,
      SESSION_ID,
      T1
    );
    await seedPullRequest(db, 31, "2026-06-20T10:00:00.000Z");
    await seedPullRequest(db, 32, "2026-06-20T09:00:00.000Z");

    // `pull_requests` is keyed on a hash of the RAW pr_url and carries no
    // uniqueness on (session_id, repo_full_name, pr_number), so one session that
    // saw both `/pull/31` and `/pull/31/files` stores two rows for PR 31. The
    // dashboard join must still emit ONE row for that artifact — a duplicate
    // would break the one-row-per-artifact contract AND, now that the read is
    // windowed, eat a page slot and drop PR 32 off a one-row page entirely.
    for (const [id, url, branch, observedAt] of [
      [
        "pr-row-canonical",
        "https://github.com/closedloop-ai/symphony-alpha/pull/31",
        "head-canonical",
        "2026-06-20T10:00:00.000Z",
      ],
      [
        "pr-row-files-suffix",
        "https://github.com/closedloop-ai/symphony-alpha/pull/31/files",
        "head-files-suffix",
        "2026-06-20T09:30:00.000Z",
      ],
    ]) {
      await db.run(
        `INSERT INTO pull_requests
           (id, session_id, pr_url, pr_number, repo_full_name, branch_name,
            harness, observed_at, created_at)
         VALUES ($1, $2, $3, 31, $4, $5, 'claude', $6, $6)`,
        id,
        SESSION_ID,
        url,
        REPO,
        branch,
        observedAt
      );
    }

    const prs = await db.dashboard.getPullRequests();
    assert.deepEqual(
      prs.map((pr) => pr.prNumber),
      [31, 32]
    );
    // The dedupe is deterministic, not arbitrary: newest observed row wins.
    assert.equal(prs[0]?.branchName, "head-canonical");

    // The window is a real slice of that order — PR 32 is on page 2, not lost
    // behind a duplicate of PR 31.
    assert.deepEqual(
      (await db.dashboard.getPullRequests({ limit: 1, offset: 1 })).map(
        (pr) => pr.prNumber
      ),
      [32]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
