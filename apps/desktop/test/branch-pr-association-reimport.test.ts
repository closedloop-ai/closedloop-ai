/**
 * @file branch-pr-association-reimport.test.ts
 * @description ISS-4651 — the live import's artifact-link teardown deletes every
 * `branch_pr_association` workspace link, and `propagateBranchPrLinks` re-mints
 * the ones that still hold. Nothing pinned that round trip: the two comments
 * describing it contradicted each other (write-core claimed the parser refs or
 * the PR phase re-create the method — neither does), and the existing coverage
 * drives `propagateBranchPrLinks` DIRECTLY, so the DELETE it has to survive was
 * never in the picture.
 *
 * These regressions drive the REAL importer (`db.importer.importSession`) over a
 * pre-existing association row and assert the FEA-4377 authoring-evidence rule
 * decides its fate across the teardown: an AUTHORED association is still there
 * afterwards, an UNAUTHORED one is gone, and a non-preserved parser-method link
 * is still wiped so the teardown is proven to run rather than to have been
 * disabled. The identity assertion pins the MECHANISM — survival is by
 * re-derivation, not by preservation — because that is the part the comments got
 * wrong and the part a future narrowing of the propagation predicate would break.
 *
 * Runs against the production `openSqliteAgentDatabase` importer (no Electron).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BRANCH_AUTHORING_RELATION,
  BRANCH_PR_ASSOCIATION_METHOD,
  PR_WORKSPACE_RELATION,
} from "../src/main/database/branch-pr-attribution.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  ArtifactKind,
  artifactIdFromIdentityKey,
  computeIdentityKey,
} from "../src/main/enrichment/identity-key.js";
import { makeSession } from "./normalized-session-test-utils.js";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const REPO = "owner/repo";
const SESSION_ID = "iss4651-sess";
const FEATURE_BRANCH = "feat/iss-4651";
const PR_NUMBER = 42;
const COMMIT_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const TS = "2026-07-31T12:00:00.000Z";
/** The id the fixture seeds. Propagation mints its own, so this id surviving would mean the DELETE never ran. */
const SEEDED_LINK_ID = "link-assoc";
// Derive the PR artifact's identity the way production does rather than
// rebuilding the `pr:<scope>:<n>` shape here: a change to the canonical key
// format would otherwise leave this fixture self-consistent and green while the
// real branch↔PR join broke.
const PR_IDENTITY_KEY = computeIdentityKey({
  kind: ArtifactKind.PullRequest,
  repoFullName: REPO,
  prNumber: PR_NUMBER,
});
const PR_ARTIFACT_ID = artifactIdFromIdentityKey(PR_IDENTITY_KEY);

async function openDb(): Promise<{ db: Db; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4651-reimport-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => TS,
  });
  return {
    db,
    cleanup: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A session whose transcript carries real authoring evidence for `branch`: a
 * `git push origin <branch>` shell tool use, which the extractor turns into a
 * branch ref with a WRITE method (`git_push`) and `relation='created'`. Seeding
 * that branch link by hand would prove nothing — the import's own teardown wipes
 * hand-seeded parser-method rows, and only a transcript-derived ref is
 * re-created, which is the state the FEA-4377 gate actually reads.
 */
function sessionPushing(branch: string) {
  return makeSession({
    sessionId: SESSION_ID,
    artifacts: { prs: [], issues: [], repo: REPO },
    toolUses: [
      {
        name: "Bash",
        timestamp: TS,
        input: { command: `git push -u origin ${branch}` },
      },
    ],
  });
}

/** A session that only CHECKED OUT `branch` — a read method, so no authoring evidence. */
function sessionCheckingOut(branch: string) {
  return makeSession({
    sessionId: SESSION_ID,
    artifacts: { prs: [], issues: [], repo: REPO },
    toolUses: [
      {
        name: "Bash",
        timestamp: TS,
        input: { command: `git checkout ${branch}` },
      },
    ],
  });
}

/** Seed the PR artifact, its `pull_requests` head-ref mapping, and the association link. */
async function seedAssociation(db: Db, branchName: string): Promise<void> {
  await db.run(
    `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, pr_number, branch_name, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    PR_ARTIFACT_ID,
    PR_IDENTITY_KEY,
    ArtifactKind.PullRequest,
    REPO,
    PR_NUMBER,
    branchName,
    TS
  );
  await db.run(
    `INSERT INTO pull_requests (id, pr_url, pr_number, repo_full_name, branch_name, observed_at, created_at)
     VALUES ('pr-row', $1, $2, $3, $4, $5, $5)`,
    `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    PR_NUMBER,
    REPO,
    branchName,
    TS
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, is_primary, status, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, '{}', 0, 'candidate', 1, $6, $6)`,
    SEEDED_LINK_ID,
    SESSION_ID,
    PR_ARTIFACT_ID,
    PR_WORKSPACE_RELATION,
    BRANCH_PR_ASSOCIATION_METHOD,
    TS
  );
}

async function readPrLinks(db: Db): Promise<{ id: string; method: string }[]> {
  return await db.prisma.client.$queryRawUnsafe<
    { id: string; method: string }[]
  >(
    `SELECT sal.id, sal.method FROM session_artifact_links sal
       JOIN artifacts a ON sal.artifact_id = a.id AND a.kind = $2
      WHERE sal.session_id = $1
      ORDER BY sal.method`,
    SESSION_ID,
    ArtifactKind.PullRequest
  );
}

async function readCommitLinkMethods(db: Db): Promise<string[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ method: string }[]>(
    `SELECT sal.method FROM session_artifact_links sal
       JOIN artifacts a ON sal.artifact_id = a.id AND a.kind = $2
      WHERE sal.session_id = $1
      ORDER BY sal.method`,
    SESSION_ID,
    ArtifactKind.Commit
  );
  return rows.map((r) => r.method);
}

test("ISS-4651: an AUTHORED branch↔PR association is still present after a re-import", async () => {
  const { db, cleanup } = await openDb();
  try {
    const session = sessionPushing(FEATURE_BRANCH);
    await db.importer.importSession(session, "claude");
    await seedAssociation(db, FEATURE_BRANCH);

    // A parser-method commit link that is NOT in the transcript — the re-import
    // must still wipe it, proving the teardown runs rather than being disabled.
    const commitIdentityKey = computeIdentityKey({
      kind: ArtifactKind.Commit,
      repoFullName: REPO,
      sha: COMMIT_SHA,
    });
    const commitArtifactId = artifactIdFromIdentityKey(commitIdentityKey);
    await db.run(
      `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, sha, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      commitArtifactId,
      commitIdentityKey,
      ArtifactKind.Commit,
      REPO,
      COMMIT_SHA,
      TS
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, is_primary, status, extractor_version, observed_at, created_at)
       VALUES ('link-commit', $1, $2, $3, 'git_commit', '{}', 0, 'confirmed', 1, $4, $4)`,
      SESSION_ID,
      commitArtifactId,
      BRANCH_AUTHORING_RELATION,
      TS
    );

    assert.deepEqual(
      (await readPrLinks(db)).map((r) => r.method),
      [BRANCH_PR_ASSOCIATION_METHOD],
      "the association exists before the re-import"
    );

    await db.importer.importSession(session, "claude");

    const after = await readPrLinks(db);
    assert.deepEqual(
      after.map((r) => r.method),
      [BRANCH_PR_ASSOCIATION_METHOD],
      "the authored association is still present after the re-import"
    );
    // The MECHANISM: the teardown deleted the seeded row and propagation minted a
    // fresh one with its own derived id. A surviving `SEEDED_LINK_ID` would mean
    // the DELETE silently stopped covering this method.
    assert.notEqual(
      after[0]?.id,
      SEEDED_LINK_ID,
      "the association is RE-DERIVED by propagation, not preserved through the delete"
    );
    assert.deepEqual(
      await readCommitLinkMethods(db),
      [],
      "the non-preserved git_commit link is still deleted on re-import"
    );
  } finally {
    await cleanup();
  }
});

test("ISS-4651: an UNAUTHORED branch↔PR association is cleared by a re-import", async () => {
  const { db, cleanup } = await openDb();
  try {
    // Checkout only — a workspace branch link, which FEA-4377 rejects as
    // attribution evidence. The teardown must not leave this one standing.
    const session = sessionCheckingOut(FEATURE_BRANCH);
    await db.importer.importSession(session, "claude");
    await seedAssociation(db, FEATURE_BRANCH);

    assert.deepEqual(
      (await readPrLinks(db)).map((r) => r.method),
      [BRANCH_PR_ASSOCIATION_METHOD],
      "the unauthored association exists before the re-import"
    );

    await db.importer.importSession(session, "claude");

    assert.deepEqual(
      await readPrLinks(db),
      [],
      "the unauthored association is cleared by the re-import"
    );
  } finally {
    await cleanup();
  }
});
