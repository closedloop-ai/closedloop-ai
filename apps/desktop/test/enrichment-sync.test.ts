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
       enrichment_state, enrichment_source, created_at, last_seen_at)
    VALUES
      ('art-c1','commit:gitdir:c1aaaaa','commit',100,20,5,'final','git','t1','t1'),
      ('art-c2','commit:gitdir:c2bbbbb','commit',40,10,3,'final','git','t1','t1');
  `);

  // One enriched branch artifact with branch-level LOC → branchDiffStats.
  await q(`
    INSERT INTO artifacts
      (id, identity_key, kind, branch_name, lines_added, lines_removed,
       files_changed, enrichment_state, enrichment_source, created_at, last_seen_at)
    VALUES
      ('art-b1','branch:gitdir:feat/x','branch','feat/x',200,30,9,'final','git','t1','t1');
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
      // A 'created' commit that has NOT been enriched yet: enrichment_state is
      // 'pending' and lines_added is NULL. The rollup only reads
      // provisional/final rows with non-null LOC, so no gitDiffStats forms.
      await db.run(`
        INSERT INTO artifacts
          (id, identity_key, kind, enrichment_state, created_at, last_seen_at)
        VALUES ('art-pending','commit:gitdir:pending1','commit','pending','t1','t1');
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
