import type { DesktopPrisma } from "../database/prisma-client.js";
import { buildRepoResolver } from "../database/write-core.js";

/**
 * FEA-2866: repair `artifacts.repo_full_name` rows that hold a BARE directory
 * basename (no owner, i.e. no `/`) instead of a validated `owner/repo` slug.
 *
 * The parser derived a session's "repository" from the cwd's last path component
 * (extractRepoFromCwd), so worktree dirs (`agent-<hash>`), temp dirs (`nrev-*`),
 * and plain repo folders (`symphony-alpha`) were persisted as bogus repositories
 * that then polluted every repo breakdown. The write path is now hardened
 * (prepareArtifactRefRow drops unvalidated bare names), but rows imported before
 * the fix are still polluted — this one-time sweep cleans them.
 *
 * For each distinct bare value it runs the SAME `repos`-table resolver the write
 * path uses: when it resolves (e.g. `symphony-alpha` → `closedloop-ai/symphony-alpha`,
 * or a worktree dir → its primary repo) the row is upgraded to the validated
 * `owner/repo` AND its resolved `git_dir` is backfilled (only when currently NULL,
 * matching the write path's `COALESCE(git_dir, EXCLUDED.git_dir)` — first non-null
 * wins). Populating `git_dir` lets downstream enrichment (`enrichCommit`/`enrichBranch`,
 * which derive their local `cwd` solely from `art.git_dir`) use local git on these
 * repaired historical artifacts instead of falling back to `gh` only. Otherwise the
 * value is a non-repository (junk worktree/temp dir) and its `repo_full_name` is
 * nulled so it groups under "Unknown" rather than a fake repository.
 *
 * Best-effort and idempotent: the `NOT LIKE '%/%'` guard means already-repaired
 * (owner/repo) or nulled rows are never revisited, so re-running is a no-op once
 * every bare value has been resolved or dropped.
 *
 * Note: this updates `repo_full_name` in place without recomputing the artifact
 * `identity_key` (a dedup key derived at insert time) — consistent with how the
 * write path already changes identity for new imports; a future re-import
 * recomputes the canonical key.
 */
export async function repairPollutedRepoFullNames(
  prisma: DesktopPrisma,
  log: (message: string) => void
): Promise<number> {
  const resolver = await buildRepoResolver(prisma.client);

  const bareRows = await prisma.client.$queryRawUnsafe<
    { repo_full_name: string }[]
  >(
    "SELECT DISTINCT repo_full_name FROM artifacts WHERE repo_full_name IS NOT NULL AND repo_full_name NOT LIKE '%/%'"
  );

  let repaired = 0;
  for (const { repo_full_name: bare } of bareRows) {
    // A validated `owner/repo` + git_dir when the bare name maps to a known repo,
    // else null repo_full_name to drop the non-repository value. git_dir is only
    // backfilled when currently NULL (COALESCE), so a value already stored by the
    // hardened write path is never clobbered.
    const resolved = resolver(bare);
    const resolvedRepoFullName = resolved?.repoFullName ?? null;
    const resolvedGitDir = resolved?.gitDir ?? null;
    const affected = await prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE artifacts SET repo_full_name = $1, git_dir = COALESCE(git_dir, $2) WHERE repo_full_name = $3 AND repo_full_name NOT LIKE '%/%'",
        resolvedRepoFullName,
        resolvedGitDir,
        bare
      )
    );
    repaired += Number(affected ?? 0);
  }

  if (repaired > 0) {
    log(
      `boot: repaired ${repaired} artifact row(s) with a bare repo_full_name (FEA-2866)`
    );
  }
  return repaired;
}
