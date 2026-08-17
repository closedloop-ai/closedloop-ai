/**
 * Direct SQLite seeding for the desktop LOC/$ ("Value-per-$") E2E specs.
 *
 * Sibling of `seed-branches-db.ts`, extracted as its OWN module for the same
 * reason ISS-4896 pulled `desktop-seed-core.ts` out of that file: adding these
 * two seeders in place would have pushed `seed-branches-db.ts` past this
 * repo's 1,000-line hard ceiling (AGENTS.md "File Size and Organization").
 * This module owns two corpora neither existing seeder in `seed-branches-db.ts`
 * can produce:
 *
 * 1. `seedSharedSessionLocPerDollarBranches` (ISS-4895, fixing ISS-4689): TWO
 *    branch artifacts sharing ONE session, both fully LOC-enriched, so the
 *    Branches "LOC / $" summary card's even-split divisor
 *    (`sumEvenSplitEnrichedSpend` in `packages/app/branches/lib/
 *    filtered-branch-analytics.ts`) has a genuine multi-branch corpus to divide
 *    by the session's GLOBAL branch count rather than its in-window count.
 *    `seedMergedUnenrichedSinglePrBranch`/`seedNoPullRequestBranch` each mint
 *    exactly one branch artifact per session (keyed by
 *    `branchArtifactId(sessionId)`), which cannot express this shape.
 *
 * 2. `seedSessionDetailLocPerDollarBranch` (ISS-4667, fixing ISS-4865): a
 *    branch artifact linked via `relation IN ('created', 'workspace')` — the
 *    gate the SESSION-DETAIL LOC read (`sync-source.ts`'s ungated
 *    `branchLocRows` query) requires, which is DIFFERENT from the
 *    Branches-page read's `relation='authored'` gate every existing helper in
 *    `seed-branches-db.ts` writes. Without this relation the session detail's
 *    `branchDiffStats` never populates and the Properties pane's "LOC / $" row
 *    has no churn to divide.
 *
 * Both seeders follow the exact substrate contract `desktop-seed-core.ts`
 * documents: open a SECOND `@libsql/client` connection on the app's own
 * `agent-dashboard.sqlite` (the same file, opened in WAL mode, that supports
 * multi-process access), apply the app's own PRAGMAs, poll until the db host's
 * asynchronous post-launch migration has created the tables/columns this
 * seeder needs, write one FK-ordered batch, then checkpoint the WAL so a later
 * launch reads the rows straight from the main db file.
 */

import { createClient } from "@libsql/client";
import {
  applyDesktopSeedPragmas,
  branchesDbPath,
  type SeedClient,
  waitForMigrationsApplied,
} from "./desktop-seed-core";
import {
  pricedTokenUsageBatchItem,
  substantiveToolEventBatchItem,
} from "./seed-branches-db";

/**
 * Block until the store is FULLY migrated — the schema both LOC/$ seeders in
 * this module write into.
 *
 * Deliberately the whole migration history rather than the specific tables and
 * columns these seeders name: a proxy wait on an early table/column silently
 * under-waits and lets a caller close the app mid-history, which is how the
 * sibling Branches seeder started dying on a column that lands in `0029`. See
 * `waitForMigrationsApplied`.
 */
async function waitForLocPerDollarSchema(
  client: SeedClient,
  timeoutMs: number
): Promise<void> {
  await waitForMigrationsApplied(client, timeoutMs);
}

/** One seeded branch inside a shared-session, two-branch value-per-dollar corpus. */
export type SharedSessionBranchSeed = {
  /**
   * Distinct per-branch identity — the artifact id and PR/link row ids all
   * derive from this. Deliberately NOT `branchArtifactId(sessionId)` (from
   * `seed-branches-db.ts`), which returns a SINGLE id keyed only by session and
   * would collide when two branches share one session.
   */
  branchId: string;
  branchName: string;
  /** The branch's own PR number (a distinct `pull_requests` row per branch). */
  prNumber: number;
  /**
   * ISO merge instant for THIS branch's `pull_requests` row. This is the ONLY
   * signal (PRD-486's per-branch `eventActivity`, joined on
   * `(repo_full_name, branch_name)`, not on session) that can differentiate two
   * branches' `lastActivityAt` when both are linked through the SAME session —
   * the session-derived `updatedAt` fallback is identical for both in that case.
   */
  mergedAt: string;
};

export type SharedSessionLocPerDollarSeed = {
  /** GitHub-style "owner/repo", shared by both branches. */
  repoFullName: string;
  /** The ONE session both branches are linked through. */
  sessionId: string;
  /** ISS-4895/ISS-4689: the shared session's single priced cost — the even-split numerator's spend. */
  costUsd: number;
  /** Fully LOC-enriched churn (`isLocEnrichedRow` requires all three) applied identically to both branches. */
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  branches: readonly [SharedSessionBranchSeed, SharedSessionBranchSeed];
};

/**
 * Seed ONE session linked to TWO fully LOC-enriched branch artifacts straight
 * into the launched app's real SQLite store, so the app's real
 * `getSharedBranchAnalytics` -> `deriveFilteredBranchAnalytics` path (ISS-4895,
 * fixing ISS-4689) projects the even-split LOC/$ divisor over a genuine
 * multi-branch, single-session corpus. See the module docstring for why
 * neither existing `seed-branches-db.ts` helper can express this shape.
 */
export async function seedSharedSessionLocPerDollarBranches(
  userDataDir: string,
  seed: SharedSessionLocPerDollarSeed,
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const dbPath = branchesDbPath(userDataDir);
  const client = createClient({ url: `file:${dbPath}`, intMode: "number" });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForLocPerDollarSchema(client, options.schemaTimeoutMs ?? 30_000);

    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - 60 * 60 * 1000);
    const startedAtIso = startedAt.toISOString();
    const observedAt = endedAt.toISOString();
    await client.batch(
      [
        {
          sql: `INSERT INTO sessions
                  (id, status, started_at, ended_at, updated_at,
                   last_activity_at, data_revision)
                VALUES (?, 'completed', ?, ?, ?, ?, 1)`,
          args: [
            seed.sessionId,
            startedAtIso,
            observedAt,
            observedAt,
            observedAt,
          ],
        },
        // Two trace instants make the detail timeline chartable without adding
        // the missing LOC event-time evidence this list test intentionally pins.
        substantiveToolEventBatchItem(seed.sessionId, startedAtIso, "start"),
        substantiveToolEventBatchItem(seed.sessionId, observedAt, "end"),
        ...seed.branches.flatMap((branch) =>
          sharedSessionBranchBatchItems(seed, branch, observedAt)
        ),
        pricedTokenUsageBatchItem(seed.sessionId, seed.costUsd),
      ],
      "write"
    );

    // Fold the committed rows out of the -wal into the main db file so a later
    // launch reads them straight from the main db (same convention as every
    // seeder in `seed-branches-db.ts`).
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/** The three FK-ordered rows one seeded branch needs, for a shared-session corpus. */
function sharedSessionBranchBatchItems(
  seed: SharedSessionLocPerDollarSeed,
  branch: SharedSessionBranchSeed,
  observedAt: string
): Array<{ sql: string; args: Array<string | number> }> {
  const artifactId = `artifact-branch-${branch.branchId}`;
  return [
    {
      sql: `INSERT INTO artifacts
              (id, identity_key, kind, repo_full_name, branch_name,
               lines_added, lines_removed, files_changed,
               created_at, last_seen_at, observed_at)
            VALUES (?, ?, 'branch', ?, ?,
                    ?, ?, ?,
                    ?, ?, ?)`,
      args: [
        artifactId,
        `branch:${seed.repoFullName}:${branch.branchName}`,
        seed.repoFullName,
        branch.branchName,
        seed.linesAdded,
        seed.linesRemoved,
        seed.filesChanged,
        observedAt,
        observedAt,
        observedAt,
      ],
    },
    {
      // FEA-2531: `git_push` (write + push evidence) — same convention as
      // `seedMergedUnenrichedSinglePrBranch` in `seed-branches-db.ts` — so both
      // seeded rows pass the Branches display gate.
      sql: `INSERT INTO session_artifact_links
              (id, session_id, artifact_id, relation, method, evidence,
               is_primary, status, extractor_version, observed_at, created_at)
            VALUES (?, ?, ?, 'authored', 'git_push', '{}',
                    1, 'confirmed', 1, ?, ?)`,
      args: [
        `link-${branch.branchId}`,
        seed.sessionId,
        artifactId,
        observedAt,
        observedAt,
      ],
    },
    {
      // A distinct `pull_requests` row per branch, keyed by
      // `(repo_full_name, branch_name)` (not by session) — this is what lets two
      // branches sharing one session still get genuinely different
      // `lastActivityAt` values via each branch's own `merged_at`.
      sql: `INSERT INTO pull_requests
              (id, session_id, pr_url, pr_number, repo_full_name, branch_name,
               state, closed_at, merged_at, title, observed_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?,
                    'closed', ?, ?, ?, ?, ?)`,
      args: [
        `pr-${branch.branchId}`,
        seed.sessionId,
        `https://github.com/${seed.repoFullName}/pull/${branch.prNumber}`,
        branch.prNumber,
        seed.repoFullName,
        branch.branchName,
        branch.mergedAt,
        branch.mergedAt,
        `Seeded merged PR #${branch.prNumber}`,
        observedAt,
        observedAt,
      ],
    },
  ];
}

export type SessionDetailLocPerDollarSeed = {
  /** External session id the branch-derived LOC rolls onto in session detail. */
  sessionId: string;
  repoFullName: string;
  branchName: string;
  /**
   * The session-detail LOC read (`sync-source.ts`'s ungated `branchLocRows`
   * query) requires all three non-null so `buildDiffStats` populates
   * `session.branchDiffStats` — the numerator
   * `sessionLocPerDollarNumeratorLoc` reads via `Math.max(gitLoc, branchLoc)`.
   */
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  /**
   * ISS-4667/4865: omit for the "no priced cost" control (session detail then
   * renders the not-applicable placeholder instead of a ratio); pass a positive
   * value to seed an actual sub-cent ratio.
   */
  costUsd?: number;
};

/**
 * Seed ONE session linked to a fully LOC-enriched branch artifact via
 * `relation='created'`, straight into the launched app's real SQLite store, so
 * the app's real session-detail LOC read (`sync-source.ts`'s `branchLocRows`)
 * populates `session.branchDiffStats` and the Properties pane's "LOC / $" row
 * (ISS-4667, fixing ISS-4865) renders a genuine significant-digit ratio. See
 * the module docstring for why this needs a different `relation` value than
 * every Branches-page seed in `seed-branches-db.ts`.
 */
export async function seedSessionDetailLocPerDollarBranch(
  userDataDir: string,
  seed: SessionDetailLocPerDollarSeed,
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const dbPath = branchesDbPath(userDataDir);
  const client = createClient({ url: `file:${dbPath}`, intMode: "number" });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForLocPerDollarSchema(client, options.schemaTimeoutMs ?? 30_000);

    const now = new Date().toISOString();
    const artifactId = `artifact-branch-loc-${seed.sessionId}`;
    await client.batch(
      [
        {
          sql: `INSERT INTO sessions
                  (id, status, started_at, ended_at, updated_at,
                   last_activity_at, data_revision)
                VALUES (?, 'completed', ?, ?, ?, ?, 1)`,
          args: [seed.sessionId, now, now, now, now],
        },
        substantiveToolEventBatchItem(seed.sessionId, now),
        {
          sql: `INSERT INTO artifacts
                  (id, identity_key, kind, repo_full_name, branch_name,
                   lines_added, lines_removed, files_changed,
                   created_at, last_seen_at, observed_at)
                VALUES (?, ?, 'branch', ?, ?,
                        ?, ?, ?,
                        ?, ?, ?)`,
          args: [
            artifactId,
            `branch:${seed.repoFullName}:${seed.branchName}`,
            seed.repoFullName,
            seed.branchName,
            seed.linesAdded,
            seed.linesRemoved,
            seed.filesChanged,
            now,
            now,
            now,
          ],
        },
        {
          // Session-detail LOC read requires `relation IN ('created',
          // 'workspace')` — distinct from the Branches-page `relation='authored'`
          // convention. `created` is already precedented in `seed-branches-db.ts`
          // (`pullRequestArtifactBatchItems`), just feeding a different query
          // there (the session's own PR-pill link, on a `kind='pull_request'`
          // artifact with NULL LOC fields) than here (LOC churn on a
          // `kind='branch'` artifact).
          sql: `INSERT INTO session_artifact_links
                  (id, session_id, artifact_id, relation, method, evidence,
                   is_primary, status, extractor_version, observed_at, created_at)
                VALUES (?, ?, ?, 'created', 'git_push', '{}',
                        1, 'confirmed', 1, ?, ?)`,
          args: [
            `link-loc-${seed.sessionId}`,
            seed.sessionId,
            artifactId,
            now,
            now,
          ],
        },
        // ISS-4667/4865: the priced-cost row, only when the caller asked for
        // one. Same explicit-undefined convention as `seedNoPullRequestBranch`'s
        // `costUsd` in `seed-branches-db.ts`, so the "unpriced" control seeds NO
        // `token_usage` row rather than a zero one.
        ...(seed.costUsd === undefined
          ? []
          : [pricedTokenUsageBatchItem(seed.sessionId, seed.costUsd)]),
      ],
      "write"
    );

    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}
