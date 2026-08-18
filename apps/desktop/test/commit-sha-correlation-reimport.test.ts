/**
 * @file commit-sha-correlation-reimport.test.ts
 * @description FEA-4379 — a `commit_sha_correlation` session→PR link is minted
 * ONLY by the post-boot maintenance pass; the parser/import path never re-derives
 * it. wongk's review flagged that a live re-import of the session deletes every
 * artifact link and rebuilds only parser-derived ones, so an active session lost
 * its correlation link until the next boot. This "correlate then re-import"
 * regression drives the REAL importer (`db.importer.importSession`) and asserts
 * the minted link SURVIVES the re-import, while a non-preserved parser-method link
 * is correctly wiped.
 *
 * Runs against the production `openSqliteAgentDatabase` importer (no Electron).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeSession } from "./normalized-session-test-utils.js";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const REPO = "owner/repo";
const HEAD_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SESSION_ID = "reimport-sess";

async function openDb(): Promise<{ db: Db; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea4379-reimport-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-07-28T12:00:00.000Z",
  });
  return {
    db,
    cleanup: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function readLinkMethods(db: Db, targetKind: string): Promise<string[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ method: string }[]>(
    `SELECT sal.method FROM session_artifact_links sal
       JOIN artifacts a ON sal.artifact_id = a.id AND a.kind = $2
      WHERE sal.session_id = $1
      ORDER BY sal.method`,
    SESSION_ID,
    targetKind
  );
  return rows.map((r) => r.method);
}

test("FEA-4379: a re-import preserves the minted commit_sha_correlation link (correlate → re-import)", async () => {
  const { db, cleanup } = await openDb();
  try {
    const session = makeSession({ sessionId: SESSION_ID });
    // First import creates the session row the links attach to.
    await db.importer.importSession(session, "claude");

    // Seed an OPEN PR artifact carrying the head SHA + a `created` commit artifact
    // the session authored with the same SHA — the content evidence the maintenance
    // pass correlates on.
    await db.run(
      `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, pr_number, head_sha, created_at, last_seen_at)
       VALUES ('pr-art', $1, 'pull_request', $2, 42, $3, 't1', 't1')`,
      `pr:${REPO}:42`,
      REPO,
      HEAD_SHA
    );
    await db.run(
      `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, sha, created_at, last_seen_at)
       VALUES ('commit-art', $1, 'commit', $2, $3, 't1', 't1')`,
      `commit:${REPO}:${HEAD_SHA}`,
      REPO,
      HEAD_SHA
    );
    // A parser-method (git_commit) `created` commit link — this is NOT in the
    // re-imported transcript, so the re-import must wipe it (proving the DELETE
    // still runs) while the correlation link below survives.
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, is_primary, status, extractor_version, observed_at, created_at)
       VALUES ('link-commit', $1, 'commit-art', 'created', 'git_commit', '{}', 0, 'confirmed', 1, 't1', 't1')`,
      SESSION_ID
    );

    // Mint the commit_sha_correlation PR link via the REAL maintenance pass.
    const minted = await db.correlateCommitShaPrLinks();
    assert.equal(minted, 1, "the maintenance pass mints the correlation link");
    assert.deepEqual(
      await readLinkMethods(db, "pull_request"),
      ["commit_sha_correlation"],
      "a commit_sha_correlation PR link exists before re-import"
    );

    // Re-import the SAME session — the delete-then-rederive artifact-links phase.
    await db.importer.importSession(session, "claude");

    // The correlation link SURVIVES (the FEA-4379 preserve guard)...
    assert.deepEqual(
      await readLinkMethods(db, "pull_request"),
      ["commit_sha_correlation"],
      "the minted correlation link survives the re-import"
    );
    // ...while the non-preserved parser-method commit link is correctly wiped
    // (it was not in the re-imported transcript), proving the DELETE still runs.
    assert.deepEqual(
      await readLinkMethods(db, "commit"),
      [],
      "the non-preserved git_commit link is deleted on re-import"
    );
  } finally {
    await cleanup();
  }
});
