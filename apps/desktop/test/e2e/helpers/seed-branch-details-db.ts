/**
 * Focused local-Desktop seed for the ISS-4473 Branch Details E2E.
 *
 * The fixture deliberately stops at the local persistence boundary: two
 * associated pull requests are real SQLite rows, while provider
 * checks, files/diffs, comments, and explicit PRODUCES relationships remain
 * absent. The launched page must describe those lanes as unavailable or
 * incomplete instead of fabricating cloud parity.
 */

import { applyDesktopSeedPragmas, openSeedClient } from "./desktop-seed-core";
import { seedClosedAtOnlySinglePrBranch } from "./seed-branches-db";

/** Raw `summary` of the seeded `TurnDuration` row; the trace must not render it. */
export const SEEDED_TURN_DURATION_MS = "52900";

export type BranchDetailsSeed = {
  repoFullName: string;
  branchName: string;
  sessionId: string;
  mergedPullRequest: {
    number: number;
    title: string;
    mergedAt: string;
  };
  activePullRequest: {
    number: number;
    title: string;
    openedAt: string;
  };
};

/** Seed one branch with an active PR and a selectable merged predecessor. */
export async function seedBranchDetails(
  userDataDir: string,
  seed: BranchDetailsSeed
): Promise<void> {
  await seedClosedAtOnlySinglePrBranch(
    userDataDir,
    {
      repoFullName: seed.repoFullName,
      branchName: seed.branchName,
      sessionId: seed.sessionId,
      prNumber: seed.mergedPullRequest.number,
      closedAt: seed.mergedPullRequest.mergedAt,
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
          sql: "UPDATE artifacts SET title = ? WHERE id = ?",
          args: [seed.mergedPullRequest.title, mergedArtifactId],
        },
        {
          sql: `INSERT INTO pull_requests
                  (id, session_id, pr_url, pr_number, repo_full_name, branch_name,
                   opened_at, observed_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            `pr-${seed.sessionId}-active`,
            seed.sessionId,
            activeUrl,
            seed.activePullRequest.number,
            seed.repoFullName,
            seed.branchName,
            seed.activePullRequest.openedAt,
            seed.activePullRequest.openedAt,
            seed.activePullRequest.openedAt,
          ],
        },
        {
          sql: `INSERT INTO artifacts
                  (id, identity_key, kind, repo_full_name, branch_name, pr_number,
                   url, title, created_at, last_seen_at, observed_at)
                VALUES (?, ?, 'pull_request', ?, ?, ?, ?, ?,
                        ?, ?, ?)`,
          args: [
            activeArtifactId,
            `pull_request:${seed.repoFullName}:${seed.activePullRequest.number}`,
            seed.repoFullName,
            seed.branchName,
            seed.activePullRequest.number,
            activeUrl,
            seed.activePullRequest.title,
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
        turnDurationEventBatchItem(seed.sessionId),
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

/**
 * ISS-12467: the end-of-turn `TurnDuration` row the importer writes for every
 * completed turn (`write-core-import-phases-events.ts`), with the duration in
 * `summary`. Stamped at seed time, at or after the seeded tool event's "now".
 */
function turnDurationEventBatchItem(sessionId: string): {
  sql: string;
  args: string[];
} {
  return {
    sql: `INSERT INTO events
            (id, session_id, event_type, tool_name, summary, created_at)
          VALUES (?, ?, 'TurnDuration', NULL, ?, ?)`,
    args: [
      `event-turn-duration-${sessionId}`,
      sessionId,
      SEEDED_TURN_DURATION_MS,
      new Date().toISOString(),
    ],
  };
}
