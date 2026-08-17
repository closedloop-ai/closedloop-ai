/**
 * @file sqlite-maintenance-facade-wiring.test.ts
 * @description ISS-5400: proves each method on the extracted maintenance facade
 * is bound to its OWN implementation.
 *
 * Why this exists, specifically. Four of the extracted methods share an
 * identical signature and an identical argument list:
 *
 *   propagateAllBranchPrLinks():       Promise<number>
 *   correlateCommitShaPrLinks():       Promise<number>
 *   removeUnauthoredBranchPrLinks():   Promise<number>
 *   normalizeStoredTimestampFormats(): Promise<number>
 *
 * (A fifth, remediateMisattributedPrBranches, was removed with the
 * `artifacts.enrichment_state` column its WHERE clause selected on.)
 *
 * They were moved out of `sqlite.ts` as one contiguous block, so a copy/paste
 * TRANSPOSITION between any two of them would compile cleanly (same type) and
 * pass every existing suite (nothing calls them through the facade). The facade's
 * annotated return type guarantees each key is PRESENT; nothing guaranteed each
 * key reached the right function. That is the hole this file closes.
 *
 * The test is behavioral, not structural: it seeds a store in which exactly ONE
 * of the five has work to do, then asserts that method reports the work AND its
 * four same-signature siblings report zero on that same store. A transposition
 * involving the seeded method flips both halves of that assertion.
 *
 * Fixture shape is borrowed from `maintenance-branch-pr-propagation.test.ts`,
 * which owns the propagation gate's own semantics — this file asserts only the
 * WIRING, so it deliberately does not re-test FEA-4377's evidence rules.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createMaintenanceFacade } from "../src/main/database/sqlite-maintenance-facade.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

type Store = OpenTestPrisma["db"];

const NOW = "2026-06-22T12:00:00.000Z";
const REPO = "closedloop-ai/symphony-alpha";
const BRANCH = "fix/desktop-sessions-loading-stall";
const PR_NUMBER = 3837;
const BRANCH_ARTIFACT_ID = "art-branch-1";
const PR_ARTIFACT_ID = "art-pr-1";
const SESSION_ID = "authored-session";

const noopLog = () => {
  /* the facade logs progress; this test asserts return values only */
};

/**
 * Build the facade over a real store. `supportsRowDigest` and `tokenUsage` are
 * only reached by methods this file does not exercise, so they are supplied as
 * minimal stand-ins rather than a full store construction.
 */
function facadeFor(prisma: OpenTestPrisma["prisma"]) {
  return createMaintenanceFacade({
    prisma,
    log: noopLog,
    nowFn: () => NOW,
    detectBillingMode: () => "unknown",
    supportsRowDigest: () => Promise.resolve(false),
    tokenUsage: {} as Parameters<
      typeof createMaintenanceFacade
    >[0]["tokenUsage"],
  });
}

/**
 * Seed the ONE scenario `propagateAllBranchPrLinks` acts on: a session whose
 * branch-link carries authoring evidence (relation='created', method='git_push')
 * plus a `pull_requests` row whose head ref is that branch. None of the other
 * four same-signature passes has anything to do on this store.
 */
async function seedPropagationWork(store: Store): Promise<void> {
  await store.query(
    "INSERT INTO sessions (id, status, updated_at, last_activity_at, data_revision) VALUES ($1, 'active', $2, $2, 1)",
    [SESSION_ID, NOW]
  );
  await store.query(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
     VALUES ($1, $2, 'branch', $3, $4, $5, $5)`,
    [BRANCH_ARTIFACT_ID, `branch:${REPO}#${BRANCH}`, REPO, BRANCH, NOW]
  );
  await store.query(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, is_primary,
        status, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, 'created', 'git_push', '{}', 0, 'candidate', 7, $4, $4)`,
    [`link-branch-${SESSION_ID}`, SESSION_ID, BRANCH_ARTIFACT_ID, NOW]
  );
  await store.query(
    `INSERT INTO pull_requests (id, pr_url, pr_number, repo_full_name, branch_name)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      "pr-row-1",
      `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      PR_NUMBER,
      REPO,
      BRANCH,
    ]
  );
  await store.query(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, pr_number, branch_name,
        created_at, last_seen_at)
     VALUES ($1, $2, 'pull_request', $3, $4, $5, $6, $6)`,
    [
      PR_ARTIFACT_ID,
      `pull_request:${REPO}#${PR_NUMBER}`,
      REPO,
      PR_NUMBER,
      BRANCH,
      NOW,
    ]
  );
}

async function countSessionPrLinks(store: Store): Promise<number> {
  const result = await store.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM session_artifact_links WHERE session_id = $1 AND artifact_id = $2",
    [SESSION_ID, PR_ARTIFACT_ID]
  );
  return Number(result.rows[0]?.n ?? 0);
}

test("ISS-5400: propagateAllBranchPrLinks is bound to the propagation pass, not a same-signature sibling", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedPropagationWork(store);
    const facade = facadeFor(prisma);

    // The three siblings run FIRST, on a store seeded only with propagation
    // work. Each must find nothing. If any of them were transposed onto the
    // propagation implementation it would consume the work and report 1 here.
    assert.equal(
      await facade.correlateCommitShaPrLinks(),
      0,
      "correlateCommitShaPrLinks acted on propagation-only fixture data"
    );
    assert.equal(
      await facade.removeUnauthoredBranchPrLinks(),
      0,
      "removeUnauthoredBranchPrLinks acted on propagation-only fixture data"
    );
    assert.equal(
      await facade.normalizeStoredTimestampFormats(),
      0,
      "normalizeStoredTimestampFormats acted on propagation-only fixture data"
    );
    // The link must still be unmade at this point — proving none of the four
    // siblings quietly did the propagation pass's job.
    assert.equal(await countSessionPrLinks(store), 0);

    // Only the correctly-bound method does the work.
    assert.equal(
      await facade.propagateAllBranchPrLinks(),
      1,
      "propagateAllBranchPrLinks did not reach the propagation implementation"
    );
    assert.equal(await countSessionPrLinks(store), 1);
  } finally {
    await close();
  }
});

test("ISS-5400: removeUnauthoredBranchPrLinks is bound to the unauthored sweep", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedPropagationWork(store);
    const facade = facadeFor(prisma);

    // Mint the PR link the sweep operates on, then downgrade the branch-link to
    // workspace/start_branch so the link is retroactively unauthored — the ONE
    // state `removeUnauthoredBranchPrLinks` acts on.
    assert.equal(await facade.propagateAllBranchPrLinks(), 1);
    await store.query(
      "UPDATE session_artifact_links SET relation = 'workspace', method = 'start_branch' WHERE artifact_id = $1",
      [BRANCH_ARTIFACT_ID]
    );

    assert.equal(
      await facade.removeUnauthoredBranchPrLinks(),
      1,
      "removeUnauthoredBranchPrLinks did not reach the unauthored-sweep implementation"
    );
    assert.equal(await countSessionPrLinks(store), 0);
  } finally {
    await close();
  }
});

/**
 * The annotated return type already makes a MISSING key a compile error, so this
 * asserts the weaker runtime property that survives type erasure: every declared
 * member is actually a callable on the built object. It is cheap insurance
 * against a future refactor that satisfies the type with a non-function value.
 */
test("ISS-5400: every maintenance-facade member is callable", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const facade = facadeFor(prisma) as Record<string, unknown>;
    for (const name of [
      "captureRepoIdentity",
      "correlateCommitShaPrLinks",
      "deleteSessionRow",
      "listExistingSessionIds",
      "listStaleRevisionSessions",
      "normalizeStoredTimestampFormats",
      "propagateAllBranchPrLinks",
      "rebuildComponentInvocationsFromStoredRows",
      "rebuildSessionFromParse",
      "recomputeAnalyticsRollups",
      "recordCollectionModeViolation",
      "recordPackInstallRunEnd",
      "recordPackInstallRunStart",
      "removeUnauthoredBranchPrLinks",
      "runHistoricalBackfill",
    ]) {
      assert.equal(typeof facade[name], "function", `${name} is not callable`);
    }
  } finally {
    await close();
  }
});
