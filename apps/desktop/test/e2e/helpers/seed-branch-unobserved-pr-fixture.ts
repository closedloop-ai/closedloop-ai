/**
 * Seed a desktop branch with one linked PR row the local store has no
 * lifecycle for (no state, merge instant or draft flag, ISS-12709), so the
 * branch derives its unobserved status.
 *
 * It lives beside `seed-branches-db.ts` rather than inside it because that file
 * is already at the edge of the 1000-line ceiling; the branch row itself is
 * seeded by composing its `seedNoPullRequestBranch`, so there is one definition
 * of what a seeded branch row is.
 */

import { createClient } from "@libsql/client";
import {
  applyDesktopSeedPragmas,
  branchesDbPath,
  waitForMigrationsApplied,
} from "./desktop-seed-core";
import { branchArtifactId, seedNoPullRequestBranch } from "./seed-branches-db";

export type UnobservedPrBranchSeed = {
  /** GitHub-style "owner/repo" stored on the branch artifact. */
  repoFullName: string;
  /** The branch name (NOT a default branch — those are hidden by the read). */
  branchName: string;
  /** External session id the branch is linked through. */
  sessionId: string;
  /** The linked session activity instant that drives the Branches row age. */
  activityAt: string;
  /** `pull_requests.pr_number`, unique per seeded branch. */
  prNumber: number;
};

/** Seed one branch carrying a single PR row with no observed lifecycle. */
export async function seedBranchWithUnobservedPullRequest(
  userDataDir: string,
  seed: UnobservedPrBranchSeed,
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  await seedNoPullRequestBranch(
    userDataDir,
    {
      activityAt: seed.activityAt,
      branchName: seed.branchName,
      repoFullName: seed.repoFullName,
      sessionId: seed.sessionId,
    },
    options
  );

  const client = createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForMigrationsApplied(client, options.schemaTimeoutMs ?? 30_000);
    await client.batch(pullRequestEvidenceFor(seed), "write");
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/** The `artifacts.id` the seeded branch is keyed by, for detail navigation. */
export function seededBranchArtifactId(sessionId: string): string {
  return branchArtifactId(sessionId);
}

function pullRequestEvidenceFor(
  seed: UnobservedPrBranchSeed
): { sql: string; args: (string | number | null)[] }[] {
  const now = new Date().toISOString();
  return [
    {
      sql: `INSERT INTO pull_requests
              (id, session_id, pr_url, pr_number, repo_full_name, branch_name,
               observed_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        `pr-${seed.sessionId}`,
        seed.sessionId,
        `https://github.com/${seed.repoFullName}/pull/${seed.prNumber}`,
        seed.prNumber,
        seed.repoFullName,
        seed.branchName,
        now,
        now,
      ],
    },
  ];
}
