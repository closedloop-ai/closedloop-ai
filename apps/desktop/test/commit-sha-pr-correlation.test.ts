/**
 * @file commit-sha-pr-correlation.test.ts
 * @description FEA-4379 — behavioral coverage for `correlateCommitShaPrLinks`,
 * the commit-SHA → PR content correlation that mints a `created` session→PR link
 * when a commit SHA the session authored is byte-identical to a PR's head or
 * merge-commit SHA. Runs against a real libSQL DB via the shared
 * {@link openTestPrisma} harness (no Electron), so it exercises the production
 * write path and asserts the persisted rows — not source text.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { correlateCommitShaPrLinks } from "../src/main/database/pr-link-maintenance.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

const NOW = "2026-07-28T12:00:00.000Z";
const REPO = "closedloop-ai/symphony-alpha";
// 40-hex commit SHAs — the content identity the correlation matches on.
const SESSION_COMMIT_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OTHER_SHA = "ffffffffffffffffffffffffffffffffffffffff";
const MERGE_SHA = "0123456789abcdef0123456789abcdef01234567";

type Store = OpenTestPrisma["db"];

const RELATION_CREATED = "created";
const RELATION_REFERENCED = "referenced";
const RELATION_WORKSPACE = "workspace";
const KIND_COMMIT = "commit";
const KIND_PR = "pull_request";
// The abbreviated form `git commit` output prints (a 7-hex prefix of the full
// OID). Production stores this verbatim on the commit artifact while gh
// enrichment stores the full OID on the PR — the correlation must still match.
const ABBREV_COMMIT_SHA = SESSION_COMMIT_SHA.slice(0, 7);
const FORK_REPO = "someone-else/symphony-alpha";

function noopLog(): void {
  // The correlation logs progress/failures; behavior is asserted from the DB.
}

async function seedSession(store: Store, id: string): Promise<void> {
  await store.query(
    "INSERT INTO sessions (id, status, updated_at, data_revision) VALUES ($1, $2, $3, $4)",
    [id, "completed", NOW, 1]
  );
}

async function seedArtifact(
  store: Store,
  fields: {
    id: string;
    identityKey: string;
    kind: string;
    repoFullName?: string | null;
    sha?: string | null;
    headSha?: string | null;
    mergeCommitSha?: string | null;
    prNumber?: number | null;
  }
): Promise<void> {
  await store.query(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, sha, head_sha, merge_commit_sha,
        pr_number, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [
      fields.id,
      fields.identityKey,
      fields.kind,
      fields.repoFullName ?? null,
      fields.sha ?? null,
      fields.headSha ?? null,
      fields.mergeCommitSha ?? null,
      fields.prNumber ?? null,
      NOW,
    ]
  );
}

async function seedLink(
  store: Store,
  fields: {
    id: string;
    sessionId: string;
    artifactId: string;
    relation: string;
  }
): Promise<void> {
  await store.query(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, is_primary,
        status, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, $4, 'git_commit', '{}', 0, 'confirmed', 1, $5, $5)`,
    [fields.id, fields.sessionId, fields.artifactId, fields.relation, NOW]
  );
}

async function readPrLinks(
  store: Store,
  sessionId: string
): Promise<{ artifact_id: string; relation: string; method: string }[]> {
  const result = (await store.query(
    `SELECT sal.artifact_id, sal.relation, sal.method
       FROM session_artifact_links sal
       JOIN artifacts a ON sal.artifact_id = a.id AND a.kind = 'pull_request'
      WHERE sal.session_id = $1`,
    [sessionId]
  )) as {
    rows: { artifact_id: string; relation: string; method: string }[];
  };
  return result.rows;
}

async function readSessionUpdatedAt(
  store: Store,
  sessionId: string
): Promise<string> {
  const result = (await store.query(
    "SELECT updated_at FROM sessions WHERE id = $1",
    [sessionId]
  )) as { rows: { updated_at: string }[] };
  return result.rows[0].updated_at;
}

test("mints a created session→PR link when a session commit SHA equals the PR head_sha", async () => {
  const h = await openTestPrisma();
  try {
    await seedSession(h.db, "sess-1");
    await seedArtifact(h.db, {
      id: "commit-art-1",
      identityKey: `commit:${REPO}:${SESSION_COMMIT_SHA}`,
      kind: KIND_COMMIT,
      repoFullName: REPO,
      sha: SESSION_COMMIT_SHA,
    });
    await seedArtifact(h.db, {
      id: "pr-art-1",
      identityKey: `pr:${REPO}:101`,
      kind: KIND_PR,
      repoFullName: REPO,
      prNumber: 101,
      headSha: SESSION_COMMIT_SHA,
    });
    await seedLink(h.db, {
      id: "link-commit-1",
      sessionId: "sess-1",
      artifactId: "commit-art-1",
      relation: RELATION_CREATED,
    });

    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(minted, 1);

    const prLinks = await readPrLinks(h.db, "sess-1");
    assert.equal(prLinks.length, 1);
    assert.equal(prLinks[0].artifact_id, "pr-art-1");
    assert.equal(prLinks[0].relation, RELATION_CREATED);
    assert.equal(prLinks[0].method, "commit_sha_correlation");
  } finally {
    await h.close();
  }
});

test("mints when a session commit SHA equals the PR merge_commit_sha", async () => {
  const h = await openTestPrisma();
  try {
    await seedSession(h.db, "sess-2");
    await seedArtifact(h.db, {
      id: "commit-art-2",
      identityKey: `commit:${REPO}:${MERGE_SHA}`,
      kind: KIND_COMMIT,
      repoFullName: REPO,
      sha: MERGE_SHA,
    });
    await seedArtifact(h.db, {
      id: "pr-art-2",
      identityKey: `pr:${REPO}:102`,
      kind: KIND_PR,
      repoFullName: REPO,
      prNumber: 102,
      headSha: OTHER_SHA,
      mergeCommitSha: MERGE_SHA,
    });
    await seedLink(h.db, {
      id: "link-commit-2",
      sessionId: "sess-2",
      artifactId: "commit-art-2",
      relation: RELATION_CREATED,
    });

    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(minted, 1);
    const prLinks = await readPrLinks(h.db, "sess-2");
    assert.equal(prLinks.length, 1);
    assert.equal(prLinks[0].artifact_id, "pr-art-2");
    assert.equal(prLinks[0].relation, RELATION_CREATED);
  } finally {
    await h.close();
  }
});

test("does NOT mint when no session commit SHA overlaps any PR SHA", async () => {
  const h = await openTestPrisma();
  try {
    await seedSession(h.db, "sess-3");
    await seedArtifact(h.db, {
      id: "commit-art-3",
      identityKey: `commit:${REPO}:${SESSION_COMMIT_SHA}`,
      kind: KIND_COMMIT,
      repoFullName: REPO,
      sha: SESSION_COMMIT_SHA,
    });
    // PR references an entirely different commit — no content overlap.
    await seedArtifact(h.db, {
      id: "pr-art-3",
      identityKey: `pr:${REPO}:103`,
      kind: KIND_PR,
      repoFullName: REPO,
      prNumber: 103,
      headSha: OTHER_SHA,
      mergeCommitSha: MERGE_SHA,
    });
    await seedLink(h.db, {
      id: "link-commit-3",
      sessionId: "sess-3",
      artifactId: "commit-art-3",
      relation: RELATION_CREATED,
    });

    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(minted, 0);
    const prLinks = await readPrLinks(h.db, "sess-3");
    assert.equal(prLinks.length, 0);
  } finally {
    await h.close();
  }
});

test("does NOT mint from a referenced (non-created) commit link — the authoring gate holds", async () => {
  const h = await openTestPrisma();
  try {
    await seedSession(h.db, "sess-4");
    await seedArtifact(h.db, {
      id: "commit-art-4",
      identityKey: `commit:${REPO}:${SESSION_COMMIT_SHA}`,
      kind: KIND_COMMIT,
      repoFullName: REPO,
      sha: SESSION_COMMIT_SHA,
    });
    await seedArtifact(h.db, {
      id: "pr-art-4",
      identityKey: `pr:${REPO}:104`,
      kind: KIND_PR,
      repoFullName: REPO,
      prNumber: 104,
      headSha: SESSION_COMMIT_SHA,
    });
    // The commit link is `referenced`, not `created` — a mention, not authorship.
    await seedLink(h.db, {
      id: "link-commit-4",
      sessionId: "sess-4",
      artifactId: "commit-art-4",
      relation: RELATION_REFERENCED,
    });

    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(minted, 0);
    const prLinks = await readPrLinks(h.db, "sess-4");
    assert.equal(prLinks.length, 0);
  } finally {
    await h.close();
  }
});

test("does NOT mint when a SHA maps to multiple PRs (ambiguous — evidence not tight)", async () => {
  const h = await openTestPrisma();
  try {
    await seedSession(h.db, "sess-5");
    await seedArtifact(h.db, {
      id: "commit-art-5",
      identityKey: `commit:${REPO}:${SESSION_COMMIT_SHA}`,
      kind: KIND_COMMIT,
      repoFullName: REPO,
      sha: SESSION_COMMIT_SHA,
    });
    // Two distinct PRs both carry the same head SHA — ambiguous attribution.
    await seedArtifact(h.db, {
      id: "pr-art-5a",
      identityKey: `pr:${REPO}:105`,
      kind: KIND_PR,
      repoFullName: REPO,
      prNumber: 105,
      headSha: SESSION_COMMIT_SHA,
    });
    await seedArtifact(h.db, {
      id: "pr-art-5b",
      identityKey: `pr:${REPO}:106`,
      kind: KIND_PR,
      repoFullName: REPO,
      prNumber: 106,
      headSha: SESSION_COMMIT_SHA,
    });
    await seedLink(h.db, {
      id: "link-commit-5",
      sessionId: "sess-5",
      artifactId: "commit-art-5",
      relation: RELATION_CREATED,
    });

    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(minted, 0);
    const prLinks = await readPrLinks(h.db, "sess-5");
    assert.equal(prLinks.length, 0);
  } finally {
    await h.close();
  }
});

test("is idempotent — a second run mints nothing new", async () => {
  const h = await openTestPrisma();
  try {
    await seedSession(h.db, "sess-6");
    await seedArtifact(h.db, {
      id: "commit-art-6",
      identityKey: `commit:${REPO}:${SESSION_COMMIT_SHA}`,
      kind: KIND_COMMIT,
      repoFullName: REPO,
      sha: SESSION_COMMIT_SHA,
    });
    await seedArtifact(h.db, {
      id: "pr-art-6",
      identityKey: `pr:${REPO}:107`,
      kind: KIND_PR,
      repoFullName: REPO,
      prNumber: 107,
      headSha: SESSION_COMMIT_SHA,
    });
    await seedLink(h.db, {
      id: "link-commit-6",
      sessionId: "sess-6",
      artifactId: "commit-art-6",
      relation: RELATION_CREATED,
    });

    const first = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(first, 1);
    const second = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(second, 0);
    const prLinks = await readPrLinks(h.db, "sess-6");
    assert.equal(prLinks.length, 1);
  } finally {
    await h.close();
  }
});

test("mints when the session commit SHA is git-abbreviated but the PR head_sha is the full OID", async () => {
  const h = await openTestPrisma();
  try {
    await seedSession(h.db, "sess-7");
    // Commit artifact carries the ABBREVIATED SHA (as `git commit` prints it).
    await seedArtifact(h.db, {
      id: "commit-art-7",
      identityKey: `commit:${REPO}:${ABBREV_COMMIT_SHA}`,
      kind: KIND_COMMIT,
      repoFullName: REPO,
      sha: ABBREV_COMMIT_SHA,
    });
    // PR carries the FULL 40-hex OID from gh enrichment.
    await seedArtifact(h.db, {
      id: "pr-art-7",
      identityKey: `pr:${REPO}:108`,
      kind: KIND_PR,
      repoFullName: REPO,
      prNumber: 108,
      headSha: SESSION_COMMIT_SHA,
    });
    await seedLink(h.db, {
      id: "link-commit-7",
      sessionId: "sess-7",
      artifactId: "commit-art-7",
      relation: RELATION_CREATED,
    });

    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(minted, 1);
    const prLinks = await readPrLinks(h.db, "sess-7");
    assert.equal(prLinks.length, 1);
    assert.equal(prLinks[0].artifact_id, "pr-art-7");
    assert.equal(prLinks[0].relation, RELATION_CREATED);
  } finally {
    await h.close();
  }
});

test("mints the created link even when a non-created (workspace) link to the PR already exists", async () => {
  const h = await openTestPrisma();
  try {
    await seedSession(h.db, "sess-8");
    await seedArtifact(h.db, {
      id: "commit-art-8",
      identityKey: `commit:${REPO}:${SESSION_COMMIT_SHA}`,
      kind: KIND_COMMIT,
      repoFullName: REPO,
      sha: SESSION_COMMIT_SHA,
    });
    await seedArtifact(h.db, {
      id: "pr-art-8",
      identityKey: `pr:${REPO}:109`,
      kind: KIND_PR,
      repoFullName: REPO,
      prNumber: 109,
      headSha: SESSION_COMMIT_SHA,
    });
    await seedLink(h.db, {
      id: "link-commit-8",
      sessionId: "sess-8",
      artifactId: "commit-art-8",
      relation: RELATION_CREATED,
    });
    // A prior branch→PR propagation pass (FEA-4377) already stamped a
    // `workspace` link to the SAME PR. The natural key is
    // (session, artifact, relation), so this must NOT suppress the created mint.
    await seedLink(h.db, {
      id: "link-workspace-8",
      sessionId: "sess-8",
      artifactId: "pr-art-8",
      relation: RELATION_WORKSPACE,
    });

    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(minted, 1);
    const prLinks = await readPrLinks(h.db, "sess-8");
    // Both the pre-existing workspace link and the newly minted created link.
    assert.equal(prLinks.length, 2);
    const created = prLinks.find((l) => l.relation === RELATION_CREATED);
    assert.ok(created, "expected a created link to be minted");
    assert.equal(created?.artifact_id, "pr-art-8");
    assert.equal(created?.method, "commit_sha_correlation");
  } finally {
    await h.close();
  }
});

test("does NOT re-mint when a created link to the PR already exists (created-scoped suppression)", async () => {
  const h = await openTestPrisma();
  try {
    await seedSession(h.db, "sess-9");
    await seedArtifact(h.db, {
      id: "commit-art-9",
      identityKey: `commit:${REPO}:${SESSION_COMMIT_SHA}`,
      kind: KIND_COMMIT,
      repoFullName: REPO,
      sha: SESSION_COMMIT_SHA,
    });
    await seedArtifact(h.db, {
      id: "pr-art-9",
      identityKey: `pr:${REPO}:110`,
      kind: KIND_PR,
      repoFullName: REPO,
      prNumber: 110,
      headSha: SESSION_COMMIT_SHA,
    });
    await seedLink(h.db, {
      id: "link-commit-9",
      sessionId: "sess-9",
      artifactId: "commit-art-9",
      relation: RELATION_CREATED,
    });
    // A real gh_pr_create created link already attributes this PR to the session.
    await seedLink(h.db, {
      id: "link-created-9",
      sessionId: "sess-9",
      artifactId: "pr-art-9",
      relation: RELATION_CREATED,
    });

    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(minted, 0);
    const prLinks = await readPrLinks(h.db, "sess-9");
    assert.equal(prLinks.length, 1);
  } finally {
    await h.close();
  }
});

test("mints for a same-repo PR even when a fork PR in another repo shares the head SHA (ambiguity is repo-scoped)", async () => {
  const h = await openTestPrisma();
  try {
    await seedSession(h.db, "sess-10");
    await seedArtifact(h.db, {
      id: "commit-art-10",
      identityKey: `commit:${REPO}:${SESSION_COMMIT_SHA}`,
      kind: KIND_COMMIT,
      repoFullName: REPO,
      sha: SESSION_COMMIT_SHA,
    });
    // The same-repo PR — the correct attribution target.
    await seedArtifact(h.db, {
      id: "pr-art-10-upstream",
      identityKey: `pr:${REPO}:111`,
      kind: KIND_PR,
      repoFullName: REPO,
      prNumber: 111,
      headSha: SESSION_COMMIT_SHA,
    });
    // A fork PR in a DIFFERENT repo carrying the identical head object. The
    // global ambiguity count would see 2 PRs; the repo-scoped count sees 1.
    await seedArtifact(h.db, {
      id: "pr-art-10-fork",
      identityKey: `pr:${FORK_REPO}:1`,
      kind: KIND_PR,
      repoFullName: FORK_REPO,
      prNumber: 1,
      headSha: SESSION_COMMIT_SHA,
    });
    await seedLink(h.db, {
      id: "link-commit-10",
      sessionId: "sess-10",
      artifactId: "commit-art-10",
      relation: RELATION_CREATED,
    });

    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(minted, 1);
    const prLinks = await readPrLinks(h.db, "sess-10");
    assert.equal(prLinks.length, 1);
    assert.equal(prLinks[0].artifact_id, "pr-art-10-upstream");
  } finally {
    await h.close();
  }
});

test("does NOT mint when a repo-less commit shares the SHA with a repo-bearing PR (shared fork history)", async () => {
  const h = await openTestPrisma();
  try {
    await seedSession(h.db, "sess-11");
    // A purely local commit whose owning repo we never captured (repo_full_name
    // null). The same object may live in many repos via shared/fork history.
    await seedArtifact(h.db, {
      id: "commit-art-11",
      identityKey: `commit::${SESSION_COMMIT_SHA}`,
      kind: KIND_COMMIT,
      repoFullName: null,
      sha: SESSION_COMMIT_SHA,
    });
    // A PR in a KNOWN repository carrying the identical head object. Attributing
    // the repo-less commit to it would be a cross-fork false attribution.
    await seedArtifact(h.db, {
      id: "pr-art-11",
      identityKey: `pr:${REPO}:112`,
      kind: KIND_PR,
      repoFullName: REPO,
      prNumber: 112,
      headSha: SESSION_COMMIT_SHA,
    });
    await seedLink(h.db, {
      id: "link-commit-11",
      sessionId: "sess-11",
      artifactId: "commit-art-11",
      relation: RELATION_CREATED,
    });

    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(minted, 0);
    const prLinks = await readPrLinks(h.db, "sess-11");
    assert.equal(prLinks.length, 0);
  } finally {
    await h.close();
  }
});

test("does NOT mint when a repo-bearing commit shares the SHA with a repo-less PR", async () => {
  const h = await openTestPrisma();
  try {
    await seedSession(h.db, "sess-12");
    await seedArtifact(h.db, {
      id: "commit-art-12",
      identityKey: `commit:${REPO}:${SESSION_COMMIT_SHA}`,
      kind: KIND_COMMIT,
      repoFullName: REPO,
      sha: SESSION_COMMIT_SHA,
    });
    // A repo-less PR carrying the same object — the mirror of sess-11. The repos
    // disagree (one named, one null), so this must not attribute either.
    await seedArtifact(h.db, {
      id: "pr-art-12",
      identityKey: "pr::113",
      kind: KIND_PR,
      repoFullName: null,
      prNumber: 113,
      headSha: SESSION_COMMIT_SHA,
    });
    await seedLink(h.db, {
      id: "link-commit-12",
      sessionId: "sess-12",
      artifactId: "commit-art-12",
      relation: RELATION_CREATED,
    });

    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(minted, 0);
    const prLinks = await readPrLinks(h.db, "sess-12");
    assert.equal(prLinks.length, 0);
  } finally {
    await h.close();
  }
});

test("advances sessions.updated_at when a link is minted so the sync cursor re-picks it", async () => {
  const h = await openTestPrisma();
  try {
    // Seed the session with an OLD updated_at the sync cursor has already passed.
    await h.db.query(
      "INSERT INTO sessions (id, status, updated_at, data_revision) VALUES ($1, $2, $3, $4)",
      ["sess-touch", "completed", "2020-01-01T00:00:00.000Z", 1]
    );
    await seedArtifact(h.db, {
      id: "commit-art-touch",
      identityKey: `commit:${REPO}:${SESSION_COMMIT_SHA}`,
      kind: KIND_COMMIT,
      repoFullName: REPO,
      sha: SESSION_COMMIT_SHA,
    });
    await seedArtifact(h.db, {
      id: "pr-art-touch",
      identityKey: `pr:${REPO}:115`,
      kind: KIND_PR,
      repoFullName: REPO,
      prNumber: 115,
      headSha: SESSION_COMMIT_SHA,
    });
    await seedLink(h.db, {
      id: "link-commit-touch",
      sessionId: "sess-touch",
      artifactId: "commit-art-touch",
      relation: RELATION_CREATED,
    });

    const before = await readSessionUpdatedAt(h.db, "sess-touch");
    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(minted, 1);
    const afterMint = await readSessionUpdatedAt(h.db, "sess-touch");
    assert.ok(
      afterMint > before,
      `expected updated_at to advance past ${before}, got ${afterMint}`
    );

    // A second (idempotent) run mints nothing and must NOT churn updated_at.
    const second = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(second, 0);
    const afterNoop = await readSessionUpdatedAt(h.db, "sess-touch");
    assert.equal(afterNoop, afterMint);
  } finally {
    await h.close();
  }
});

test("mints when BOTH the commit and the PR are repo-less (a purely local match)", async () => {
  const h = await openTestPrisma();
  try {
    await seedSession(h.db, "sess-13");
    await seedArtifact(h.db, {
      id: "commit-art-13",
      identityKey: `commit::${SESSION_COMMIT_SHA}`,
      kind: KIND_COMMIT,
      repoFullName: null,
      sha: SESSION_COMMIT_SHA,
    });
    await seedArtifact(h.db, {
      id: "pr-art-13",
      identityKey: "pr::114",
      kind: KIND_PR,
      repoFullName: null,
      prNumber: 114,
      headSha: SESSION_COMMIT_SHA,
    });
    await seedLink(h.db, {
      id: "link-commit-13",
      sessionId: "sess-13",
      artifactId: "commit-art-13",
      relation: RELATION_CREATED,
    });

    const minted = await correlateCommitShaPrLinks(h.prisma, noopLog);
    assert.equal(minted, 1);
    const prLinks = await readPrLinks(h.db, "sess-13");
    assert.equal(prLinks.length, 1);
    assert.equal(prLinks[0].artifact_id, "pr-art-13");
  } finally {
    await h.close();
  }
});
