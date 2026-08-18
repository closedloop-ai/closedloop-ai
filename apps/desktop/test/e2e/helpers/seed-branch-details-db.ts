/**
 * Focused local-Desktop seed for the ISS-4473 Branch Details E2E.
 *
 * The fixture deliberately stops at the local persistence boundary: two
 * associated pull requests and their LOC are real SQLite rows, while provider
 * checks, files/diffs, comments, and explicit PRODUCES relationships remain
 * absent. The launched page must describe those lanes as unavailable or
 * incomplete instead of fabricating cloud parity.
 */

import { applyDesktopSeedPragmas, openSeedClient } from "./desktop-seed-core";
import { seedMergedUnenrichedSinglePrBranch } from "./seed-branches-db";

export type BranchDetailsSeed = {
  repoFullName: string;
  branchName: string;
  sessionId: string;
  mergedPullRequest: {
    number: number;
    title: string;
    mergedAt: string;
    additions: number;
    deletions: number;
    filesChanged: number;
  };
  activePullRequest: {
    number: number;
    title: string;
    openedAt: string;
    additions: number;
    deletions: number;
    filesChanged: number;
  };
};

/** Seed one branch with an active PR and a selectable merged predecessor. */
export async function seedBranchDetails(
  userDataDir: string,
  seed: BranchDetailsSeed
): Promise<void> {
  await seedMergedUnenrichedSinglePrBranch(
    userDataDir,
    {
      repoFullName: seed.repoFullName,
      branchName: seed.branchName,
      sessionId: seed.sessionId,
      prNumber: seed.mergedPullRequest.number,
      mergedAt: seed.mergedPullRequest.mergedAt,
    },
    { linkPullRequestArtifact: true }
  );

  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopSeedPragmas(client);

    const mergedArtifactId = `artifact-pr-${seed.sessionId}`;
    const activeArtifactId = `artifact-pr-${seed.sessionId}-active`;
    const activeUrl = pullRequestUrl(
      seed.repoFullName,
      seed.activePullRequest.number
    );

    await client.batch(
      [
        {
          sql: `UPDATE artifacts
                SET title = ?, lines_added = ?, lines_removed = ?, files_changed = ?
                WHERE id = ?`,
          args: [
            seed.mergedPullRequest.title,
            seed.mergedPullRequest.additions,
            seed.mergedPullRequest.deletions,
            seed.mergedPullRequest.filesChanged,
            mergedArtifactId,
          ],
        },
        {
          sql: "UPDATE pull_requests SET title = ? WHERE id = ?",
          args: [seed.mergedPullRequest.title, `pr-${seed.sessionId}`],
        },
        {
          sql: `INSERT INTO pull_requests
                  (id, session_id, pr_url, pr_number, repo_full_name, branch_name,
                   state, opened_at, title, observed_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
          args: [
            `pr-${seed.sessionId}-active`,
            seed.sessionId,
            activeUrl,
            seed.activePullRequest.number,
            seed.repoFullName,
            seed.branchName,
            seed.activePullRequest.openedAt,
            seed.activePullRequest.title,
            seed.activePullRequest.openedAt,
            seed.activePullRequest.openedAt,
          ],
        },
        {
          sql: `INSERT INTO artifacts
                  (id, identity_key, kind, repo_full_name, branch_name, pr_number,
                   pr_state, url, title, lines_added, lines_removed, files_changed,
                   created_at, last_seen_at, observed_at)
                VALUES (?, ?, 'pull_request', ?, ?, ?, 'open', ?, ?, ?, ?, ?,
                        ?, ?, ?)`,
          args: [
            activeArtifactId,
            `pull_request:${seed.repoFullName}:${seed.activePullRequest.number}`,
            seed.repoFullName,
            seed.branchName,
            seed.activePullRequest.number,
            activeUrl,
            seed.activePullRequest.title,
            seed.activePullRequest.additions,
            seed.activePullRequest.deletions,
            seed.activePullRequest.filesChanged,
            seed.activePullRequest.openedAt,
            seed.activePullRequest.openedAt,
            seed.activePullRequest.openedAt,
          ],
        },
        {
          sql: `INSERT INTO session_artifact_links
                  (id, session_id, artifact_id, relation, method, evidence,
                   is_primary, status, extractor_version, observed_at, created_at)
                VALUES (?, ?, ?, 'created', 'harness_pr_link', '{}',
                        0, 'confirmed', 1, ?, ?)`,
          args: [
            `link-pr-${seed.sessionId}-active`,
            seed.sessionId,
            activeArtifactId,
            seed.activePullRequest.openedAt,
            seed.activePullRequest.openedAt,
          ],
        },
      ],
      "write"
    );
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

function pullRequestUrl(repoFullName: string, number: number): string {
  return `https://github.com/${repoFullName}/pull/${number}`;
}
