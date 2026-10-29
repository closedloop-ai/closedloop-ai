/**
 * @file enrichment-sync.test.ts
 * @description The desktop-local boundary where `artifacts` rows flow through
 * SQLite `loadSyncedSessions()` (via `createSqliteSessionSyncSource`) into the
 * shared `SyncedAgentSession` detail shape.
 *
 * The desktop store holds no commit / branch / PR line counts (ISS-12709), so
 * `gitDiffStats` and `branchDiffStats` are absent whatever links a session has;
 * the flat `metadata.diffStats` scalars are the only LOC that reaches the wire.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PR_INT_MAX } from "@repo/api/src/types/session-artifact-link";
import { test } from "vitest";
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
 * Seed a commit / branch artifact graph into the canonical (post-migration)
 * schema:
 *   - authored: 'created' link → two 'commit's, plus a 'created' link → 'branch'.
 *   - review:   'workspace' link → the same 'branch' and a 'referenced' link →
 *     'commit'.
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

  await q(`
    INSERT INTO artifacts
      (id, identity_key, kind, created_at, last_seen_at)
    VALUES
      ('art-c1','commit:gitdir:c1aaaaa','commit','t1','t1'),
      ('art-c2','commit:gitdir:c2bbbbb','commit','t1','t1');
  `);

  await q(`
    INSERT INTO artifacts
      (id, identity_key, kind, branch_name, created_at, last_seen_at)
    VALUES
      ('art-b1','branch:gitdir:feat/x','branch','feat/x','t1','t1');
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

test("FEA-1899: authored and review-only sessions carry no gitDiffStats or branchDiffStats", async () => {
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

      for (const id of ["authored", "review"]) {
        const session = byId.get(id);
        assert.ok(session, `${id} session hydrated`);
        assert.equal(session.gitDiffStats, undefined);
        assert.equal(session.branchDiffStats, undefined);
      }
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-1899: a created commit artifact alone yields no gitDiffStats", async () => {
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
        "a created commit contributes no LOC"
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
