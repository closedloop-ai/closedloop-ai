/**
 * @file pr-store-conversion.test.ts
 * @description pr-store READS run on the single DesktopPrisma client via TYPED
 * delegates: `artifact` / `sessionArtifactLink` findMany/count/groupBy, using
 * the `artifactLinks.some` and `artifact` relation filters to express the
 * `session_artifact_links` join. Only the listPrSessions OUTER query stays on
 * `$queryRawUnsafe` (a cross-table grouped aggregation —
 * MAX(observed_at)/MIN(harness) off the joined artifact + session columns — with
 * no single typed-delegate form).
 *
 * FEA-1899 moved PR reads onto the canonical `artifacts` table
 * (kind='pull_request') joined through the pure `session_artifact_links`
 * join, while `pull_requests` lives on as the PR lifecycle detail store. This
 * test therefore boots a real SQLite via `openSqliteAgentDatabase` (full
 * desktop migration chain → artifacts + link tables exist) and dual-seeds:
 * `pull_requests` for detail plus the corresponding `artifacts` and
 * `session_artifact_links` rows the converted reads actually query.
 *
 * Asserts the converted reads reproduce the prior SQL: DTO mapping, filtering,
 * ordering, COUNT(DISTINCT …) stats, GROUP BY session grouping, and — because
 * the relation filter replaces a JOIN — that a PR linked to one session by
 * multiple `relation` rows is still counted/listed exactly once.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  countPullRequests,
  countRepos,
  countSessionsWithPullRequests,
  getPrStats,
  listPrSessions,
  listPullRequests,
  sessionIdsWithPullRequests,
} from "../src/main/pull-requests/pr-store.js";

type Runner = {
  run: (sql: string, ...params: unknown[]) => Promise<void>;
};

async function seedSession(
  db: Runner,
  id: string,
  name: string,
  cwd: string
): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, name, status, cwd, started_at)
     VALUES ($1, $2, 'running', $3, '2026-06-17T00:00:00.000Z')`,
    id,
    name,
    cwd
  );
}

/**
 * Dual-store seed for one PR: the lifecycle detail row in `pull_requests`, the
 * attribution spine row in `artifacts` (kind='pull_request', keyed by
 * `pr:<repo>:<number>`), and — when attributed to a session — the pure-join
 * `session_artifact_links` row the converted reads scope on.
 */
async function seedPr(
  db: Runner,
  pr: {
    id: string;
    sessionId: string | null;
    repo: string;
    prNumber: number;
    observedAt: string;
  }
): Promise<void> {
  const prUrl = `https://github.com/${pr.repo}/pull/${pr.prNumber}`;
  await db.run(
    `INSERT INTO pull_requests
       (id, session_id, pr_url, pr_number, repo_full_name, harness,
        observed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, 'claude', $6, $6)`,
    pr.id,
    pr.sessionId,
    prUrl,
    pr.prNumber,
    pr.repo,
    pr.observedAt
  );

  const identityKey = `pr:${pr.repo}:${pr.prNumber}`;
  const artifactId = `art-${pr.id}`;
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, pr_number, harness, url,
        observed_at, created_at, last_seen_at)
     VALUES ($1, $2, 'pull_request', $3, $4, 'claude', $5, $6, $6, $6)`,
    artifactId,
    identityKey,
    pr.repo,
    pr.prNumber,
    prUrl,
    pr.observedAt
  );

  if (pr.sessionId) {
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          extractor_version, observed_at, created_at)
       VALUES ($1, $2, $3, 'created', 'url_match', '{}', 1, $4, $4)`,
      `link-${pr.id}`,
      pr.sessionId,
      artifactId,
      pr.observedAt
    );
  }
}

type Opened = {
  db: Runner;
  prisma: Awaited<ReturnType<typeof openSqliteAgentDatabase>>["prisma"];
  close: () => Promise<void>;
};

async function setup(): Promise<Opened> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pr-store-conv-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const database = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-18T00:00:00.000Z",
  });
  const db = database;
  await seedSession(db, "session-1", "Session One", "/tmp/one");
  await seedSession(db, "session-2", "Session Two", "/tmp/two");
  // session-1: two PRs in the same repo; session-2: one; one orphan (no session).
  await seedPr(db, {
    id: "pr-a1",
    sessionId: "session-1",
    repo: "acme/repo",
    prNumber: 12,
    observedAt: "2026-06-17T10:00:00.000Z",
  });
  await seedPr(db, {
    id: "pr-a2",
    sessionId: "session-1",
    repo: "acme/repo",
    prNumber: 13,
    observedAt: "2026-06-17T11:00:00.000Z",
  });
  await seedPr(db, {
    id: "pr-b1",
    sessionId: "session-2",
    repo: "other/repo",
    prNumber: 1,
    observedAt: "2026-06-17T09:00:00.000Z",
  });
  await seedPr(db, {
    id: "pr-orphan",
    sessionId: null,
    repo: "acme/repo",
    prNumber: 99,
    observedAt: "2026-06-17T08:00:00.000Z",
  });
  return {
    db,
    prisma: database.prisma,
    close: async () => {
      await database.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("getPrStats aggregates COUNT and COUNT(DISTINCT …)", async () => {
  const { prisma, close } = await setup();
  try {
    const stats = await getPrStats(prisma);
    // 4 PR artifacts; 2 distinct repos (acme/repo, other/repo); 2 distinct
    // sessions linked to a PR artifact (the orphan has no link row).
    assert.deepEqual(stats, { totalPrs: 4, repos: 2, sessionsWithPrs: 2 });
  } finally {
    await close();
  }
});

test("listPullRequests maps DTO fields, orders by observed_at desc, filters", async () => {
  const { prisma, close } = await setup();
  try {
    const all = await listPullRequests(prisma);
    assert.deepEqual(
      all.map((p) => p.id),
      ["art-pr-a2", "art-pr-a1", "art-pr-b1", "art-pr-orphan"]
    );
    assert.equal(all[0]?.prUrl, "https://github.com/acme/repo/pull/13");
    assert.equal(all[0]?.repoFullName, "acme/repo");
    assert.equal(all[0]?.prNumber, 13);

    assert.deepEqual(
      (await listPullRequests(prisma, { sessionId: "session-1" })).map(
        (p) => p.id
      ),
      ["art-pr-a2", "art-pr-a1"]
    );
    assert.deepEqual(
      (await listPullRequests(prisma, { repo: "other/repo" })).map((p) => p.id),
      ["art-pr-b1"]
    );
  } finally {
    await close();
  }
});

test("count helpers: countPullRequests (with filter), countRepos", async () => {
  const { prisma, close } = await setup();
  try {
    assert.equal(await countPullRequests(prisma), 4);
    assert.equal(
      await countPullRequests(prisma, { sessionId: "session-1" }),
      2
    );
    assert.equal(await countPullRequests(prisma, { repo: "other/repo" }), 1);
    assert.equal(await countRepos(prisma), 2);
  } finally {
    await close();
  }
});

test("listPrSessions groups by session; unlinked orphan PR forms no group", async () => {
  const { prisma, close } = await setup();
  try {
    const groups = await listPrSessions(prisma);
    const bySession = new Map(groups.map((g) => [g.sessionId, g]));

    // session-1 has both its PRs (newest first — the per-session list runs
    // through findPrArtifacts, which orders by observedAt desc).
    assert.deepEqual(
      bySession.get("session-1")?.prs.map((p) => p.id),
      ["art-pr-a2", "art-pr-a1"]
    );
    assert.equal(bySession.get("session-1")?.sessionName, "Session One");
    assert.deepEqual(
      bySession.get("session-2")?.prs.map((p) => p.id),
      ["art-pr-b1"]
    );

    // The orphan PR has no link row, so no session group forms for it; only the
    // two linked sessions appear.
    assert.equal(bySession.has("unknown"), false);

    // Pagination: limit/offset bind to the outer GROUP BY query as $1/$2.
    // 2 groups total (session-1, session-2), ordered last_pr_at desc.
    assert.equal((await listPrSessions(prisma, { limit: 1 })).length, 1);
    const page2 = await listPrSessions(prisma, { limit: 1, offset: 1 });
    assert.equal(page2.length, 1);
    assert.equal(page2[0]?.sessionId, "session-2");
  } finally {
    await close();
  }
});

test("countSessionsWithPullRequests / sessionIdsWithPullRequests over GROUP BY", async () => {
  const { prisma, close } = await setup();
  try {
    // Two link-bearing sessions (the orphan PR has no link row).
    assert.equal(await countSessionsWithPullRequests(prisma), 2);

    // Per-session counts. Production normalizes c to a number, so assert that
    // contract directly (no defensive Number() wrap here — a bigint regression
    // from the raw adapter path must fail the test).
    const ids = await sessionIdsWithPullRequests(prisma);
    assert.equal(typeof ids[0]?.c, "number");
    const counts = new Map(ids.map((r) => [r.session_id, r.c]));
    assert.equal(counts.size, 2);
    assert.equal(counts.get("session-1"), 2);
    assert.equal(counts.get("session-2"), 1);
  } finally {
    await close();
  }
});

test("relation filter dedups a PR linked to one session by multiple relations", async () => {
  const { db, prisma, close } = await setup();
  try {
    // session-1 already links art-pr-a1 via relation='created'. Add a SECOND
    // link for the SAME (session, artifact) with a different relation. The prior
    // `listPrSessions` inner JOIN (no DISTINCT) would have surfaced art-pr-a1
    // twice; the converted `artifactLinks.some` relation filter returns it once.
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          extractor_version, observed_at, created_at)
       VALUES ('link-pr-a1-2', 'session-1', 'art-pr-a1', 'mentioned', 'url_match',
               '{}', 1, '2026-06-17T10:00:00.000Z', '2026-06-17T10:00:00.000Z')`
    );

    // Session-scoped artifact reads dedup to the two distinct PRs.
    assert.deepEqual(
      (await listPullRequests(prisma, { sessionId: "session-1" })).map(
        (p) => p.id
      ),
      ["art-pr-a2", "art-pr-a1"]
    );
    assert.equal(
      await countPullRequests(prisma, { sessionId: "session-1" }),
      2
    );
    const session1 = (await listPrSessions(prisma)).find(
      (g) => g.sessionId === "session-1"
    );
    assert.deepEqual(
      session1?.prs.map((p) => p.id),
      ["art-pr-a2", "art-pr-a1"]
    );

    // sessionIdsWithPullRequests counts LINK rows by design (matching the prior
    // COUNT(*)), so the extra relation bumps session-1 to 3 links over 2 PRs —
    // pinning the link-vs-artifact distinction the relation filter introduces.
    const counts = new Map(
      (await sessionIdsWithPullRequests(prisma)).map((r) => [r.session_id, r.c])
    );
    assert.equal(counts.get("session-1"), 3);
  } finally {
    await close();
  }
});
