import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { mapWithDbConcurrency } from "@/lib/db-fanout";
import { GITHUB_SYNC_REPO_VERDICT_TTL_MS } from "@/lib/github/github-access";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import { GitHubRepoSyncTier } from "@/lib/github/github-repo-sync-state";
import {
  type ReconcileRepoOutcome,
  ReconcileRepoStatus,
  reconcileRepo,
} from "./repo-reconciler";

/**
 * Repos reconciled per cron tick. Small on purpose — throughput comes from cron
 * frequency (~15m), not long-running jobs, so each tick stays inside Vercel's
 * bounded runtime.
 */
export const RECONCILE_REPO_BATCH = 25;

/**
 * Tier-3 re-checks per tick (ISS-5093). Tiny and separate from the main batch:
 * the unsyncable population is unbounded relative to it, so this is a hard
 * ceiling on what recovery can cost the sweep.
 */
export const RECONCILE_WAKEUP_BATCH = 3;

const RECONCILE_LOG_PREFIX = "[reconcile-pull-requests]";

export type GitHubReconcileSweepSummary = {
  reposSelected: number;
  reposSwept: number;
  reposDeferredBudget: number;
  reposReclassified: number;
  reposFailed: number;
  pullRequestsWritten: number;
};

export const githubPullRequestReconcilerService = {
  /**
   * One reconciler tick: pick the most-overdue syncable repos and reconcile
   * each against the tiered credential pool. Never throws — a single repo's
   * failure is isolated so the rest of the batch still runs.
   */
  async run(
    options: { now?: Date } = {}
  ): Promise<GitHubReconcileSweepSummary> {
    const now = options.now ?? new Date();
    // Wake-ups are selected SEPARATELY and appended, never merged into the main
    // selector's window. Unsyncable rows minted by the batch reclassifier carry
    // a null lastSweptAt, which `nulls: "first"` would sort ahead of every live
    // repo — merging them would let an unbounded tier-3 population crowd real
    // work out of a 25-row global batch.
    const dueRepos = await selectDueRepos(now);
    let wakeupRepos: SyncStateRow[] = [];
    try {
      wakeupRepos = await selectWakeupRepos(now);
    } catch (error) {
      log.warn(
        "[reconcile-pull-requests] wake-up query failed, continuing with main batch only",
        {
          error: parseError(error),
        }
      );
    }
    const selected: DueRepo[] = [
      ...dueRepos.map((repo) => ({ ...repo, isWakeup: false })),
      ...wakeupRepos.map((repo) => ({ ...repo, isWakeup: true })),
    ];
    const outcomes = await mapWithDbConcurrency(selected, (repo) =>
      reconcileRepoIsolated(repo, now)
    );
    return summarize(selected.length, outcomes);
  },
};

type SyncStateRow = {
  organizationId: string;
  repositoryFullName: string;
  watermark: Date | null;
  cursor: string | null;
  consecutiveFailureCount: number;
};

type DueRepo = SyncStateRow & {
  /**
   * Selected by the tier-3 wake-up rather than the main batch. Only these get
   * their `lastSweptAt` stamped when reconcileRepo throws — see
   * reconcileRepoIsolated.
   */
  isWakeup: boolean;
};

async function selectDueRepos(now: Date): Promise<SyncStateRow[]> {
  return await withDb((db) =>
    db.gitHubRepoSyncState.findMany({
      where: {
        tier: { not: GitHubRepoSyncTier.Unsyncable },
        OR: [
          { nextRetryAt: null },
          { nextRetryAt: { lte: now } },
          { consecutiveFailureCount: 0 },
        ],
      },
      // Oldest-swept first; never-swept (null) leads. Ordering provides natural
      // queueing; nextRetryAt provides the hard exclusion window for repos with
      // consecutive failures (ISS-5092). The consecutiveFailureCount=0 arm
      // handles version-skew: a rollback to old code clears the failure counter
      // but cannot clear nextRetryAt (unknown column), so a recovered repo must
      // still be eligible.
      orderBy: [{ lastSweptAt: { sort: "asc", nulls: "first" } }],
      take: RECONCILE_REPO_BATCH,
      select: {
        organizationId: true,
        repositoryFullName: true,
        watermark: true,
        cursor: true,
        consecutiveFailureCount: true,
      },
    })
  );
}

async function reconcileRepoIsolated(
  repo: DueRepo,
  now: Date
): Promise<ReconcileRepoOutcome | null> {
  try {
    return await reconcileRepo(
      {
        organizationId: repo.organizationId,
        repositoryFullName: repo.repositoryFullName,
        watermark: repo.watermark,
        cursor: repo.cursor,
        consecutiveFailureCount: repo.consecutiveFailureCount,
      },
      { now }
    );
  } catch (error) {
    // reconcileRepo resolves every expected failure to a persisted transition,
    // so reaching here is an unexpected fault. Isolate it: a main-batch repo
    // keeps its prior lastSweptAt and is retried next tick.
    log.error(`${RECONCILE_LOG_PREFIX} repo reconcile threw`, {
      organizationId: repo.organizationId,
      repositoryFullName: repo.repositoryFullName,
      error: parseError(error),
    });
    if (repo.isWakeup) {
      // A wake-up row is the exception: its eligibility IS "lastSweptAt is
      // stale", so leaving it unstamped would re-select it every tick for as
      // long as the fault persists and spend the whole wake-up budget on one
      // broken repo. Main-batch rows keep their queue position — moving their
      // lastSweptAt would silently reorder the oldest-swept-first backoff.
      await stampSweptBestEffort(repo, now);
    }
    return null;
  }
}

/**
 * Record that we attempted this repo, so a throw still moves it out of the
 * wake-up window. Best-effort: this runs on a path that has already failed,
 * and a bookkeeping error must not escape the isolation it lives inside.
 */
async function stampSweptBestEffort(
  repo: SyncStateRow,
  now: Date
): Promise<void> {
  try {
    await withDb((db) =>
      db.gitHubRepoSyncState.updateMany({
        where: {
          organizationId: repo.organizationId,
          repositoryFullName: repo.repositoryFullName,
        },
        data: { lastSweptAt: now },
      })
    );
  } catch (error) {
    log.warn(`${RECONCILE_LOG_PREFIX} failed to stamp lastSweptAt`, {
      organizationId: repo.organizationId,
      repositoryFullName: repo.repositoryFullName,
      error: parseError(error),
    });
  }
}

function summarize(
  selected: number,
  outcomes: Array<ReconcileRepoOutcome | null>
): GitHubReconcileSweepSummary {
  const summary: GitHubReconcileSweepSummary = {
    reposSelected: selected,
    reposSwept: 0,
    reposDeferredBudget: 0,
    reposReclassified: 0,
    reposFailed: 0,
    pullRequestsWritten: 0,
  };
  for (const result of outcomes) {
    if (!result) {
      summary.reposFailed += 1;
      continue;
    }
    summary.pullRequestsWritten += result.writtenCount;
    if (result.status === ReconcileRepoStatus.Swept) {
      summary.reposSwept += 1;
    } else if (result.status === ReconcileRepoStatus.Deferred) {
      summary.reposDeferredBudget += 1;
    } else if (result.status === ReconcileRepoStatus.Reclassified) {
      summary.reposReclassified += 1;
    } else {
      summary.reposFailed += 1;
    }
  }
  return summary;
}

/**
 * Tier-3 repos due for a tier re-check (ISS-5093).
 *
 * A repo demoted to `unsyncable` by a no-access verdict would otherwise never
 * come back: `selectDueRepos` excludes tier-3 outright, so the 6h verdict
 * expires with nothing watching. This is the wake-up — deliberately a SEPARATE,
 * separately-capped query appended to the main batch, so re-checks can never
 * displace a syncable repo no matter how many tier-3 rows the org has.
 *
 * Narrowed to orgs holding at least one live repo-scoped connection: only those
 * can have been demoted BY A VERDICT, and only a verdict expires. An org with no
 * connection at all is unsyncable for a reason no clock changes, and waking it
 * would burn the budget on a foregone conclusion.
 *
 * Keyed on `lastSweptAt`, not `lastTierEvaluatedAt`: only the reclassify path
 * writes the latter, so a woken repo that fails again would stay eligible every
 * tick forever.
 */
async function selectWakeupRepos(now: Date): Promise<SyncStateRow[]> {
  const staleBefore = new Date(now.getTime() - GITHUB_SYNC_REPO_VERDICT_TTL_MS);
  return await withDb((db) =>
    db.gitHubRepoSyncState.findMany({
      where: {
        tier: GitHubRepoSyncTier.Unsyncable,
        organization: {
          githubUserConnections: {
            some: { revokedAt: null, scopes: { has: GITHUB_REPO_SCOPE } },
          },
        },
        OR: [{ lastSweptAt: null }, { lastSweptAt: { lt: staleBefore } }],
      },
      orderBy: [{ lastSweptAt: { sort: "asc", nulls: "first" } }],
      take: RECONCILE_WAKEUP_BATCH,
      select: {
        organizationId: true,
        repositoryFullName: true,
        watermark: true,
        cursor: true,
        consecutiveFailureCount: true,
      },
    })
  );
}
