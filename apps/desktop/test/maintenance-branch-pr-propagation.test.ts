/**
 * @file maintenance-branch-pr-propagation.test.ts
 * @description Electron-free coverage for the FEA-4377 branch→PR
 * authoring-evidence gate shared by the three propagators
 * (`propagateBranchPrLinks` per-import, `propagateAllBranchPrLinks` boot
 * maintenance, `linkBranchSessionsToPr` enrichment) and the
 * `removeUnauthoredBranchPrLinks` upgrade sweep. Split out of
 * maintenance-write-txs.test.ts (which owns the sweep/heal write-tx tests) to
 * keep each file under the size ceiling. Runs over the shared
 * {@link openTestPrisma} harness so it runs locally and in CI.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  linkBranchSessionsToPr,
  propagateBranchPrLinks,
  removeUnauthoredBranchPrLinks,
} from "../src/main/database/branch-pr-attribution.js";
import { propagateAllBranchPrLinks } from "../src/main/database/pr-link-maintenance.js";
import {
  assertNarrowedTo,
  recordDesktopWrites,
} from "./discarded-write-narrowing-utils.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

const NOW = "2026-06-22T12:00:00.000Z";
type Store = OpenTestPrisma["db"];
const noopLog = () => {
  /* no log output expected */
};

// Seed a completed session row the propagation gate can attach to.
async function seedSession(
  store: Store,
  id: string,
  status: string,
  updatedAt: string
): Promise<void> {
  await store.query(
    "INSERT INTO sessions (id, status, updated_at, last_activity_at, data_revision) VALUES ($1, $2, $3, $3, $4)",
    [id, status, updatedAt, 1]
  );
}

// --- FEA-4377: branch→PR propagation must gate on authoring evidence ---
// A session whose branch-link carries only relation='workspace' (the stale CWD
// gitBranch captured at session start, method='start_branch') must NOT be
// attributed to a PR whose head ref happens to equal that branch — the FEA-2531
// invariant that gitBranch is not attribution data. Only a relation='created'
// branch-link (git_push / git_commit / gh_pr_create) may drive the join.

const REPO = "closedloop-ai/symphony-alpha";
const BRANCH = "fix/desktop-sessions-loading-stall";
const PR_NUMBER = 3837;
const BRANCH_ARTIFACT_ID = "art-branch-1";
const PR_ARTIFACT_ID = "art-pr-1";
const PR_IDENTITY_KEY = `pull_request:${REPO}#${PR_NUMBER}`;

async function seedBranchPrFixture(
  store: Store,
  sessionId: string,
  linkRelation: string,
  linkMethod: string,
  // FEA-4377 (wongk review): the branch-link's extractor_version. Defaults to the
  // post-v7 world (7) where authored links carry relation='created'. A pre-v7
  // value (<7) exercises the source-gone compat fallback: those authored links
  // were stored as relation='workspace' and can no longer be re-derived once the
  // transcript is gone, so a write-method workspace row must still attribute.
  extractorVersion = 7,
  branchName = BRANCH
): Promise<void> {
  await seedSession(store, sessionId, "active", NOW);
  // Branch artifact for the session's CWD branch.
  await store.query(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
     VALUES ($1, $2, 'branch', $3, $4, $5, $5)`,
    [BRANCH_ARTIFACT_ID, `branch:${REPO}#${branchName}`, REPO, branchName, NOW]
  );
  // Session→branch link: relation/method decide whether it is authoring
  // evidence ('created') or a mere workspace read ('workspace'/'start_branch').
  await store.query(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, is_primary,
        status, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, '{}', 0, 'candidate', $6, $7, $7)`,
    [
      `link-branch-${sessionId}`,
      sessionId,
      BRANCH_ARTIFACT_ID,
      linkRelation,
      linkMethod,
      extractorVersion,
      NOW,
    ]
  );
  // pull_requests lifecycle row: the head-ref==branch mapping the join follows.
  await store.query(
    `INSERT INTO pull_requests (id, pr_url, pr_number, repo_full_name, branch_name)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      "pr-row-1",
      `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      PR_NUMBER,
      REPO,
      branchName,
    ]
  );
  // PR artifact, unenriched (pr_state NULL ⇒ treated as open) — the exact window
  // in which the maintenance pass would mint the link before enrichment lands.
  await store.query(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, pr_number, branch_name,
        created_at, last_seen_at)
     VALUES ($1, $2, 'pull_request', $3, $4, $5, $6, $6)`,
    [PR_ARTIFACT_ID, PR_IDENTITY_KEY, REPO, PR_NUMBER, branchName, NOW]
  );
}

async function countSessionPrLinks(
  store: Store,
  sessionId: string
): Promise<number> {
  const result = await store.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM session_artifact_links WHERE session_id = $1 AND artifact_id = $2",
    [sessionId, PR_ARTIFACT_ID]
  );
  return Number(result.rows[0]?.n ?? 0);
}

test("propagateAllBranchPrLinks does NOT link a workspace/start_branch branch-link to a PR (FEA-4377)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedBranchPrFixture(
      store,
      "workspace-only",
      "workspace",
      "start_branch"
    );

    const linked = await propagateAllBranchPrLinks(prisma, noopLog);

    // The workspace link carries no authoring evidence, so the session must not
    // be attributed to the PR.
    assert.equal(linked, 0);
    assert.equal(await countSessionPrLinks(store, "workspace-only"), 0);
  } finally {
    await close();
  }
});

test("propagateAllBranchPrLinks links a created/git_push branch-link to its PR (FEA-4377)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedBranchPrFixture(store, "authored", "created", "git_push");

    const linked = await propagateAllBranchPrLinks(prisma, noopLog);

    // The created link IS authoring evidence, so the session is linked to the PR.
    assert.equal(linked, 1);
    assert.equal(await countSessionPrLinks(store, "authored"), 1);
  } finally {
    await close();
  }
});

// Seed the stale-link shape an OLD propagation pass minted BEFORE the gate: a
// `branch_pr_association` workspace link from the session to the PR artifact,
// which the artifact-link backfill preserves (NON_REDERIVED_LINK_METHODS) and so
// no other pass removes. `removeUnauthoredBranchPrLinks` is the upgrade sweep.
async function seedStaleBranchPrLink(
  store: Store,
  sessionId: string
): Promise<void> {
  await store.query(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, is_primary,
        status, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, 'workspace', 'branch_pr_association', '{}', 0,
             'candidate', 1, $4, $4)`,
    [`stale-pr-link-${sessionId}`, sessionId, PR_ARTIFACT_ID, NOW]
  );
}

test("removeUnauthoredBranchPrLinks deletes a pre-gate link when the session has no authoring branch link (FEA-4377)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // Workspace-only branch link (no authoring evidence) PLUS a stale
    // branch_pr_association PR link an older pass minted before the gate.
    await seedBranchPrFixture(store, "upgraded", "workspace", "start_branch");
    await seedStaleBranchPrLink(store, "upgraded");
    assert.equal(await countSessionPrLinks(store, "upgraded"), 1);

    const removed = await removeUnauthoredBranchPrLinks(prisma, noopLog);

    // No authoring branch link exists, so the false attribution is swept.
    assert.equal(removed, 1);
    assert.equal(await countSessionPrLinks(store, "upgraded"), 0);

    // Idempotent: a second pass finds nothing.
    assert.equal(await removeUnauthoredBranchPrLinks(prisma, noopLog), 0);
  } finally {
    await close();
  }
});

test("removeUnauthoredBranchPrLinks preserves a pre-gate link backed by an authoring branch link (FEA-4377)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // The session DID author the branch (created/git_push), so its PR link is
    // real evidence and must survive the sweep.
    await seedBranchPrFixture(store, "real-author", "created", "git_push");
    await seedStaleBranchPrLink(store, "real-author");

    const removed = await removeUnauthoredBranchPrLinks(prisma, noopLog);

    assert.equal(removed, 0);
    assert.equal(await countSessionPrLinks(store, "real-author"), 1);
  } finally {
    await close();
  }
});

// --- FEA-4377 (wongk review): the PER-IMPORT propagator gates identically ---
// The three propagators share one gate (branchAuthoringEvidenceSql). The boot
// maintenance copy (propagateAllBranchPrLinks) is covered above; drive the
// per-import copy (propagateBranchPrLinks, called inside the import tx from
// persistArtifactLinks) with BOTH relations so the shared predicate can't drift
// in one propagator without a regression here.

async function runPropagateBranchPrLinks(
  prisma: OpenTestPrisma["prisma"],
  sessionId: string
): Promise<void> {
  await prisma.write((client) =>
    client.$transaction((tx) => propagateBranchPrLinks(tx, sessionId, NOW))
  );
}

test("propagateBranchPrLinks (per-import) does NOT link a workspace/start_branch branch-link to a PR (FEA-4377)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedBranchPrFixture(
      store,
      "import-workspace",
      "workspace",
      "start_branch"
    );

    await runPropagateBranchPrLinks(prisma, "import-workspace");

    assert.equal(await countSessionPrLinks(store, "import-workspace"), 0);
  } finally {
    await close();
  }
});

test("propagateBranchPrLinks (per-import) links a created/git_push branch-link to its PR (FEA-4377)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedBranchPrFixture(store, "import-authored", "created", "git_push");

    await runPropagateBranchPrLinks(prisma, "import-authored");

    assert.equal(await countSessionPrLinks(store, "import-authored"), 1);
  } finally {
    await close();
  }
});

test("both propagators preserve links for default-looking observed branch evidence", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedBranchPrFixture(
      store,
      "default-looking-author",
      "created",
      "git_push",
      7,
      "main"
    );
    assert.equal(await propagateAllBranchPrLinks(prisma, noopLog), 1);
    assert.equal(await countSessionPrLinks(store, "default-looking-author"), 1);

    await store.query(
      "DELETE FROM session_artifact_links WHERE session_id = $1 AND artifact_id = $2",
      ["default-looking-author", PR_ARTIFACT_ID]
    );
    await runPropagateBranchPrLinks(prisma, "default-looking-author");
    assert.equal(await countSessionPrLinks(store, "default-looking-author"), 1);
  } finally {
    await close();
  }
});

// --- FEA-4377 (wongk review): pre-v7 source-gone compat fallback ------------
// Before EXTRACTOR_VERSION 7 (FEA-2531) authored branch links (git_push /
// git_commit / gh_pr_create) were stored as relation='workspace' — there was no
// 'created' relation. The artifact-link backfill rewrites those to 'created'
// once the extractor version bumps, but ONLY while the source transcript still
// exists. A session whose transcript is gone keeps its frozen pre-v7 row, so a
// strict relation='created'-only gate would silently drop a legitimately-
// authored old session if its PR mapping arrives later. The
// version-and-method-qualified fallback (extractor_version < 7 AND a write
// method) keeps them attributable across all three propagators + the sweep,
// WITHOUT re-admitting pre-v7 READ links (git_checkout / start_branch).

test("pre-v7 write-method workspace link IS attributed across all propagators (source-gone fallback, FEA-4377)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // v6 authored row: relation='workspace' (no 'created' existed pre-v7),
    // method='git_push' (a write method), extractor_version=6.
    await seedBranchPrFixture(store, "v6-authored", "workspace", "git_push", 6);

    // Boot maintenance propagator links it.
    assert.equal(await propagateAllBranchPrLinks(prisma, noopLog), 1);
    assert.equal(await countSessionPrLinks(store, "v6-authored"), 1);

    // The upgrade sweep must PRESERVE it (backed by pre-v7 authoring evidence).
    assert.equal(await removeUnauthoredBranchPrLinks(prisma, noopLog), 0);
    assert.equal(await countSessionPrLinks(store, "v6-authored"), 1);
  } finally {
    await close();
  }
});

test("pre-v7 write-method workspace link IS attributed by the per-import propagator (FEA-4377)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedBranchPrFixture(
      store,
      "v6-import-authored",
      "workspace",
      "git_commit",
      6
    );

    await runPropagateBranchPrLinks(prisma, "v6-import-authored");

    assert.equal(await countSessionPrLinks(store, "v6-import-authored"), 1);
  } finally {
    await close();
  }
});

test("pre-v7 READ-method workspace link is NOT attributed (fallback stays method-qualified, FEA-4377)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // v6 READ row: relation='workspace', method='git_checkout' (NOT a write
    // method). The stale-CWD mis-attribution FEA-2531 closes must stay closed
    // even for old rows — the fallback admits only write methods.
    await seedBranchPrFixture(store, "v6-read", "workspace", "git_checkout", 6);

    assert.equal(await propagateAllBranchPrLinks(prisma, noopLog), 0);
    assert.equal(await countSessionPrLinks(store, "v6-read"), 0);
  } finally {
    await close();
  }
});

/**
 * ISS-6321 (batch 5/6): the `sessionArtifactLink.upsert` inside
 * `linkBranchSessionsToPr` discards its row, so it RETURNINGs the link's
 * primary key instead of all 13 columns. Asserted here rather than in a new
 * suite because the branch/PR authoring fixture this needs already lives in
 * this file.
 *
 * It stays an `upsert`: Prisma ships no `upsertMany`, and the create branch is
 * what mints a link for a session the PR did not yet have. `SessionArtifactLink`
 * is one of only three desktop models with a real `id` column.
 */
test("ISS-6321: the branch→PR link upsert RETURNINGs only the link id", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedBranchPrFixture(store, "authored", "created", "git_push");
    const recorded = recordDesktopWrites(prisma);

    await linkBranchSessionsToPr(
      recorded.prisma,
      { id: BRANCH_ARTIFACT_ID, branch_name: BRANCH, git_dir: null },
      PR_NUMBER,
      REPO
    );

    // `linkBranchSessionsToPr` derives the PR artifact id from the identity key
    // rather than reusing the fixture's `art-pr-1`, so count the link by the
    // method it stamps instead of by artifact id.
    const minted = await store.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM session_artifact_links
       WHERE session_id = $1 AND method = 'branch_pr_association'`,
      ["authored"]
    );
    assert.equal(
      Number(minted.rows[0]?.n ?? 0),
      1,
      "the fixture must actually drive the upsert"
    );
    assertNarrowedTo(
      recorded.only("sessionArtifactLink", "upsert"),
      { id: true },
      "linkBranchSessionsToPr"
    );
  } finally {
    await close();
  }
});
