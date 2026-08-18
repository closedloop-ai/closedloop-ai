/**
 * ISS-5271: the usage aggregate's Repository-facet fold and its durable
 * fill-back, extracted from `sync-source.ts` (a shrink-only grandfathered file).
 *
 * The fold resolves each per-(cwd, stored repo) count row to its repository
 * identity STORED-FIRST via the shared `resolveRepositoryFullNameStoredFirst`
 * (see `repository-facet.ts` for the ruled precedence) and merges rows that
 * resolve to one repo. Rows with no stored name are settled by a batched,
 * bounded-concurrency existence probe first, so a corpus dominated by deleted
 * throwaway worktrees pays microseconds per cwd instead of a doomed git spawn.
 *
 * A successful live resolution for a row with no stored name is recorded as a
 * fill-back intent; `applyRepoFullNameFillBacks` persists those AFTER the
 * caller's read has materialized, through the write queue, fill-only — so the
 * next aggregation answers from `sessions.repo_full_name` with zero spawns and
 * the sync lane's live-first per-id writer remains the only overwriter.
 */

import type { SessionAttributionResolverCache } from "../agent-sync/agent-session-attribution.js";
import { cwdExists } from "../enrichment/repo-identity.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { resolveRepositoryFullNameStoredFirst } from "./repository-facet.js";

/** One per-(cwd, stored repo) count row from the usage aggregate's SQL. */
export type UsageRepoCountRow = {
  cwd: string | null;
  repo_full_name: string | null;
  session_count: number | string | null;
};

export type UsageRepoSessionCounts = {
  repoSessionCounts: { repositoryFullName: string; sessionCount: number }[];
  /** cwd → live-resolved repo name, for rows whose stored name was empty. */
  fillBackIntents: Map<string, string>;
};

/** Existence probes run this many at a time — plenty for ~1k stat calls. */
const EXISTENCE_PROBE_CONCURRENCY = 24;

/**
 * Settle every uncovered cwd's existence verdict up front, in parallel, by
 * seeding the per-request attribution cache with `null` for gone cwds — the
 * same verdict a failed spawn produced. The fold (and any later per-row
 * consumer sharing `cache`) then never probes twice for one cwd.
 */
async function probeUncoveredCwds(
  rows: readonly UsageRepoCountRow[],
  cache: SessionAttributionResolverCache
): Promise<void> {
  const uncovered = new Set<string>();
  for (const row of rows) {
    if (row.repo_full_name?.trim()) {
      continue;
    }
    if (row.cwd && !cache.attributionByCwd.has(row.cwd)) {
      uncovered.add(row.cwd);
    }
  }
  const pending = [...uncovered];
  const workers = Array.from(
    { length: Math.min(EXISTENCE_PROBE_CONCURRENCY, pending.length) },
    async () => {
      for (;;) {
        const cwd = pending.pop();
        if (cwd === undefined) {
          return;
        }
        if (!(await cwdExists(cwd))) {
          cache.attributionByCwd.set(cwd, null);
        }
      }
    }
  );
  await Promise.all(workers);
}

/**
 * The Repository-facet fold: stored-first identity per row, merged counts per
 * resolved repo. A row resolving to no identity renders "Unknown" and is not a
 * facet option — dropped here, exactly as the live-first fold dropped it.
 */
export async function resolveUsageRepoSessionCounts(
  rows: readonly UsageRepoCountRow[],
  cache: SessionAttributionResolverCache
): Promise<UsageRepoSessionCounts> {
  await probeUncoveredCwds(rows, cache);
  const fillBackIntents = new Map<string, string>();
  const repoCountByFullName = new Map<string, number>();
  for (const row of rows) {
    const repositoryFullName = await resolveRepositoryFullNameStoredFirst(
      row.cwd,
      row.repo_full_name,
      cache,
      fillBackIntents
    );
    if (repositoryFullName === null) {
      continue;
    }
    repoCountByFullName.set(
      repositoryFullName,
      (repoCountByFullName.get(repositoryFullName) ?? 0) +
        Number(row.session_count ?? 0)
    );
  }
  const repoSessionCounts = [...repoCountByFullName.entries()].map(
    ([repositoryFullName, sessionCount]) => ({
      repositoryFullName,
      sessionCount,
    })
  );
  return { repoSessionCounts, fillBackIntents };
}

/**
 * Durably fill `sessions.repo_full_name` for cwds the fold live-resolved.
 * FILL-ONLY by construction (the WHERE admits only rows the resolver itself
 * treats as empty — NULL or blank-after-trim — mirroring the `?.trim()` guard
 * in `resolveRepositoryFullNameStoredFirst`), so a concurrent sync-lane
 * write-back of a fresher name can never be clobbered — the sync lane's per-id
 * writer stays the only overwriter. Raw SQL (SQLite dialect) because Prisma's
 * typed filter cannot express TRIM(); without it a whitespace-only stored value
 * would be treated as absent by the resolver yet never repaired here, paying
 * the live resolution on every aggregation forever.
 * Best-effort: the read result is already correct, so a failed write is
 * swallowed and the next aggregation simply retries the same fill.
 */
export async function applyRepoFullNameFillBacks(
  prisma: DesktopPrisma,
  fillBackIntents: ReadonlyMap<string, string>
): Promise<void> {
  if (fillBackIntents.size === 0) {
    return;
  }
  try {
    await prisma.write(async (writer) => {
      for (const [cwd, repoFullName] of fillBackIntents) {
        await writer.$executeRawUnsafe(
          `UPDATE sessions SET repo_full_name = ?
           WHERE cwd = ? AND (repo_full_name IS NULL OR TRIM(repo_full_name) = '')`,
          repoFullName,
          cwd
        );
      }
    });
  } catch {
    // Best-effort by design — see the doc comment.
  }
}
