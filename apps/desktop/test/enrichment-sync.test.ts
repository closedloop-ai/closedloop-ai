/**
 * @file enrichment-sync.test.ts
 * @description FEA-1899 Desktop KLOC Attribution Engine — the desktop-local real
 * boundary that assembles enriched artifact LOC into `gitDiffStats` /
 * `branchDiffStats`.
 *
 * The migration + pure-enrichment-helper tests live elsewhere
 * (fea1899-artifacts-model.test.ts, fea1899-enrichment.test.ts). This file
 * covers the missing seam: enriched `artifacts` rows flowing through SQLite
 * `loadSyncedSessions()` (via `createSqliteSessionSyncSource`) into the shared
 * `SyncedAgentSession` detail shape.
 *
 * Covers:
 *  - An authored session (a 'created' link to an enriched 'commit') gets
 *    `gitDiffStats` summed from per-commit LOC AND `branchDiffStats` from its
 *    branch artifact.
 *  - A review-only session (branch link, no 'created' commit) gets
 *    `branchDiffStats` for context but NO `gitDiffStats` (authored-LOC gate).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PR_INT_MAX } from "@repo/api/src/types/session-artifact-link";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

// The sync source takes an attribution resolver cache; a session cwd of NULL
// short-circuits resolution, so empty maps suffice for these LOC-only assertions.
function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

/**
 * Seed an enriched artifact graph into the canonical (post-migration) schema:
 *   - authored: 'created' link → enriched 'commit' (final), plus a 'created'
 *     link → 'branch' with branch-level LOC.
 *   - review:   'workspace' link → the same 'branch' (sees branch total) and a
 *     'referenced' link → 'commit' (NOT 'created', so it must not gate git LOC).
 */
async function seedEnrichedGraph(db: {
  run(sql: string, ...params: unknown[]): Promise<void>;
}): Promise<void> {
  const q = (sql: string, params: unknown[] = []) => db.run(sql, ...params);

  await q(`
    INSERT INTO sessions (id, status) VALUES
      ('authored','completed'),
      ('review','completed');
  `);

  // Two enriched commit artifacts authored by 'authored' → summed into gitDiffStats.
  await q(`
    INSERT INTO artifacts
      (id, identity_key, kind, lines_added, lines_removed, files_changed,
       created_at, last_seen_at)
    VALUES
      ('art-c1','commit:gitdir:c1aaaaa','commit',100,20,5,'t1','t1'),
      ('art-c2','commit:gitdir:c2bbbbb','commit',40,10,3,'t1','t1');
  `);

  // One enriched branch artifact with branch-level LOC → branchDiffStats.
  await q(`
    INSERT INTO artifacts
      (id, identity_key, kind, branch_name, lines_added, lines_removed,
       files_changed, created_at, last_seen_at)
    VALUES
      ('art-b1','branch:gitdir:feat/x','branch','feat/x',200,30,9,'t1','t1');
  `);

  // authored: created both commits + the branch (pure-join links).
  await q(`
    INSERT INTO session_artifact_links
      (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
    VALUES
      ('l-a-c1','authored','art-c1','created','url_match','{}',1,'t1','t1'),
      ('l-a-c2','authored','art-c2','created','url_match','{}',1,'t1','t1'),
      ('l-a-b1','authored','art-b1','created','url_match','{}',1,'t1','t2');
  `);

  // review: shares the branch (workspace) and references one commit, but did NOT
  // 'create' a commit → authored-LOC gate keeps gitDiffStats off.
  await q(`
    INSERT INTO session_artifact_links
      (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
    VALUES
      ('l-r-b1','review','art-b1','workspace','url_match','{}',1,'t1','t1'),
      ('l-r-c1','review','art-c1','referenced','url_match','{}',1,'t1','t2');
  `);
}

test("FEA-1899: enriched artifacts flow through loadSyncedSessions into gitDiffStats/branchDiffStats", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1899-sync-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-06-18T00:00:00.000Z",
    });
    try {
      await seedEnrichedGraph(db);

      const sessions = await db.syncSource.loadSyncedSessions(
        ["authored", "review"],
        emptyAttributionCache()
      );
      const byId = new Map(sessions.map((s) => [s.externalSessionId, s]));

      // --- authored session: real git LOC summed across its two commits ---
      const authored = byId.get("authored");
      assert.ok(authored, "authored session hydrated");
      assert.deepEqual(
        authored.gitDiffStats,
        { linesAdded: 140, linesRemoved: 30, filesChanged: 8, source: "git" },
        "gitDiffStats summed from the two enriched 'created' commits"
      );
      assert.deepEqual(
        authored.branchDiffStats,
        { linesAdded: 200, linesRemoved: 30, filesChanged: 9, source: "git" },
        "branchDiffStats taken from the branch artifact"
      );

      // --- review-only session: branch context but no authored git LOC ---
      const review = byId.get("review");
      assert.ok(review, "review session hydrated");
      assert.equal(
        review.gitDiffStats,
        undefined,
        "review session has no 'created' commit → no gitDiffStats (authored-LOC gate)"
      );
      assert.deepEqual(
        review.branchDiffStats,
        { linesAdded: 200, linesRemoved: 30, filesChanged: 9, source: "git" },
        "review session still sees the shared branch total for context"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-1899: unenriched commit artifacts yield no gitDiffStats (state gate)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1899-sync-unenriched-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-06-18T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('pending','completed')"
      );
      // A 'created' commit that carries no LOC: lines_added is NULL. The rollup
      // only sums commits with non-null LOC, so no gitDiffStats forms.
      await db.run(`
        INSERT INTO artifacts
          (id, identity_key, kind, created_at, last_seen_at)
        VALUES ('art-pending','commit:gitdir:pending1','commit','t1','t1');
      `);
      await db.run(`
        INSERT INTO session_artifact_links
          (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
        VALUES ('l-pending','pending','art-pending','created','url_match','{}',1,'t1','t1');
      `);

      const [session] = await db.syncSource.loadSyncedSessions(
        ["pending"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      assert.equal(
        session.gitDiffStats,
        undefined,
        "pending (unenriched) commit contributes no LOC"
      );
      assert.equal(
        session.branchDiffStats,
        undefined,
        "no branch artifact → no branchDiffStats"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3633: the branch/PR-total FALLBACK tags gitDiffStats.source = 'branch_fallback' (commit-authored stays 'git')", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3633-sync-fallback-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-06-18T00:00:00.000Z",
    });
    try {
      await db.run(`
        INSERT INTO sessions (id, status) VALUES
          ('fallback-a','completed'),
          ('fallback-b','completed');
      `);
      // A branch artifact with branch-level LOC (the shared branch total).
      await db.run(`
        INSERT INTO artifacts
          (id, identity_key, kind, branch_name, lines_added, lines_removed,
           files_changed, created_at, last_seen_at)
        VALUES
          ('art-br','branch:gitdir:feat/shared','branch','feat/shared',
           500,100,7,'t1','t1');
      `);
      // Each session 'created' a commit with no LOC (→ priority-1 empty), so the
      // authored-LOC gate passes but LOC falls back to the branch total.
      await db.run(`
        INSERT INTO artifacts
          (id, identity_key, kind, created_at, last_seen_at)
        VALUES
          ('art-ca','commit:gitdir:penda','commit','t1','t1'),
          ('art-cb','commit:gitdir:pendb','commit','t1','t1');
      `);
      // Both sessions 'created' their commit AND 'created' the shared branch.
      await db.run(`
        INSERT INTO session_artifact_links
          (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
        VALUES
          ('l-a-c','fallback-a','art-ca','created','url_match','{}',1,'t1','t1'),
          ('l-a-b','fallback-a','art-br','created','url_match','{}',1,'t1','t1'),
          ('l-b-c','fallback-b','art-cb','created','url_match','{}',1,'t1','t1'),
          ('l-b-b','fallback-b','art-br','created','url_match','{}',1,'t1','t1');
      `);

      const sessions = await db.syncSource.loadSyncedSessions(
        ["fallback-a", "fallback-b"],
        emptyAttributionCache()
      );
      const byId = new Map(sessions.map((s) => [s.externalSessionId, s]));
      for (const id of ["fallback-a", "fallback-b"]) {
        const s = byId.get(id);
        assert.ok(s, `${id} hydrated`);
        // Fallback: the branch total, tagged so the cloud dedups it per branch.
        assert.deepEqual(
          s.gitDiffStats,
          {
            linesAdded: 500,
            linesRemoved: 100,
            filesChanged: 7,
            source: "branch_fallback",
          },
          `${id} authored LOC fell back to the branch total, tagged branch_fallback`
        );
        // branchDiffStats is the branch total BY CONSTRUCTION → stays "git".
        assert.deepEqual(s.branchDiffStats, {
          linesAdded: 500,
          linesRemoved: 100,
          filesChanged: 7,
          source: "git",
        });
      }
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3267: an out-of-int4 session LOC sum drops the diff-stats block (would overflow SessionDetail int4 and abort the batch) while in-range LOC survives", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3267-sync-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-06-18T00:00:00.000Z",
    });
    try {
      await db.run(`
        INSERT INTO sessions (id, status) VALUES
          ('overflow','completed'),
          ('inrange','completed');
      `);

      // 'overflow' created a commit whose lines_added overflows int4 (a 64-bit
      // SQLite value). Without the boundedNonNegativeInt() clamp the desktop would
      // pass it straight through and the cloud SessionDetail.lines_added INTEGER
      // write would 22003-overflow, aborting the whole-session (and batch) upsert.
      // 'inrange' sits exactly at the int4 ceiling and must survive unchanged.
      await db.run(
        `INSERT INTO artifacts
           (id, identity_key, kind, lines_added, lines_removed, files_changed,
            created_at, last_seen_at)
         VALUES
           ('art-of','commit:gitdir:ofaaaaa','commit',?,20,5,'t1','t1'),
           ('art-ir','commit:gitdir:iraaaaa','commit',?,20,5,'t1','t1')`,
        PR_INT_MAX + 1,
        PR_INT_MAX
      );
      await db.run(`
        INSERT INTO session_artifact_links
          (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
        VALUES
          ('l-of','overflow','art-of','created','url_match','{}',1,'t1','t1'),
          ('l-ir','inrange','art-ir','created','url_match','{}',1,'t1','t1');
      `);

      const sessions = await db.syncSource.loadSyncedSessions(
        ["overflow", "inrange"],
        emptyAttributionCache()
      );
      const byId = new Map(sessions.map((s) => [s.externalSessionId, s]));

      const overflow = byId.get("overflow");
      assert.ok(overflow, "overflow session still hydrates (sync not lost)");
      assert.equal(
        overflow.gitDiffStats,
        undefined,
        "the out-of-int4 LOC sum drops gitDiffStats before the wire"
      );

      const inrange = byId.get("inrange");
      assert.ok(inrange, "in-range session hydrated");
      assert.deepEqual(
        inrange.gitDiffStats,
        {
          linesAdded: PR_INT_MAX,
          linesRemoved: 20,
          filesChanged: 5,
          source: "git",
        },
        "a LOC sum exactly at the int4 ceiling passes through unchanged"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3267: an out-of-int4 metadata.diffStats LOC scalar drops that field (would overflow SessionDetail int4 and abort the batch) while in-range LOC survives", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3267-flat-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-06-18T00:00:00.000Z",
    });
    try {
      // The flat linesAdded/linesRemoved/filesChanged scalars come straight from
      // harness-supplied session metadata, so they need the same int4 bound the
      // summed artifact path gets: an overflowed or negative value would fail the
      // cloud's single batch parse and reject every session in the batch.
      await db.run(
        `INSERT INTO sessions (id, status, metadata) VALUES ('overflow','completed',?), ('inrange','completed',?)`,
        JSON.stringify({
          diffStats: {
            linesAdded: PR_INT_MAX + 1,
            linesRemoved: -3,
            filesChanged: 5,
          },
        }),
        JSON.stringify({
          diffStats: {
            linesAdded: PR_INT_MAX,
            linesRemoved: 20,
            filesChanged: 5,
          },
        })
      );

      const sessions = await db.syncSource.loadSyncedSessions(
        ["overflow", "inrange"],
        emptyAttributionCache()
      );
      const byId = new Map(sessions.map((s) => [s.externalSessionId, s]));

      const overflow = byId.get("overflow");
      assert.ok(overflow, "overflow session still hydrates (sync not lost)");
      assert.equal(
        overflow.linesAdded,
        undefined,
        "the out-of-int4 scalar drops linesAdded before the wire"
      );
      assert.equal(
        overflow.linesRemoved,
        undefined,
        "a negative scalar drops linesRemoved before the wire"
      );
      assert.equal(
        overflow.filesChanged,
        5,
        "an in-range sibling scalar is unaffected by its neighbours"
      );

      const inrange = byId.get("inrange");
      assert.ok(inrange, "in-range session hydrated");
      assert.equal(
        inrange.linesAdded,
        PR_INT_MAX,
        "a scalar exactly at the int4 ceiling passes through unchanged"
      );
      assert.equal(inrange.linesRemoved, 20);
      assert.equal(inrange.filesChanged, 5);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
