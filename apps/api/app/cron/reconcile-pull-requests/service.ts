import { type Prisma, withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { mapWithDbConcurrency } from "@/lib/db-fanout";
import { GITHUB_SYNC_REPO_VERDICT_TTL_MS } from "@/lib/github/github-access";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import {
  GitHubRepoSyncDeferralReason,
  GitHubRepoSyncTier,
  type GitHubRepoSyncTier as GitHubRepoSyncTierType,
} from "@/lib/github/github-repo-sync-state";
import { reportGitHubDeliveryCoverageTick } from "./delivery-coverage-metrics";
import { ReconcileRepoStatus } from "./repo-reconcile-status";
import {
  persistFailureSettlement,
  RECONCILE_UNEXPECTED_FAILURE_REASON,
  type ReconcileRepoOutcome,
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
  /**
   * Deferred because a concurrent sweep held every pool connection (ISS-8270).
   * Counted apart from the budget floor on purpose: contention is a healthy
   * pool under load and clears on the next tick, while a budget deferral is
   * spend pressure an operator may need to act on. One number for both would
   * report a busy org as a throttled one.
   */
  reposDeferredContention: number;
  reposReclassified: number;
  reposFailed: number;
  pullRequestsWritten: number;
};

export type GitHubOrgReconcileSummary = GitHubReconcileSweepSummary & {
  /**
   * Repos this pass left CURRENTLY ELIGIBLE — not a backlog. `dueRepoWhere`'s
   * healthy arm matches every syncable repo regardless of when it was last
   * swept, so a large org reports a large number on a perfectly healthy day.
   * It exists to stop a capped slice from reading as full coverage, nothing
   * more.
   *
   * Approximate by construction: the sweep and the count are separate statements,
   * so a repo settled by something ELSE between them shifts it. Never used for a
   * decision. Concurrency is the only remaining term — this pass's own failures
   * used to be a second and larger one (ISS-8140).
   *
   * Null when the count itself could not be taken. Not 0 — 0 is the value that
   * reads as full coverage, which is the one claim this number exists to
   * disprove.
   */
  reposRemaining: number | null;
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

  /**
   * ISS-7721: one organization's slice of the same sweep, on demand.
   *
   * The post-connect lane needs this org's existing repo-sync candidates
   * reconciled now rather than on the next tick. Selection reuses the cron's own
   * due-repo predicate and the per-repo work reuses `reconcileRepoIsolated`, so
   * the on-demand lane cannot drift from the one that runs every tick.
   *
   * Bounded by `limit` and honest about it: `reposRemaining` reports what the
   * bound left behind — counted after the sweep and best-effort, because that
   * number is a footnote to the reconciliation and must never be able to cost
   * the org the reconciliation itself.
   */
  async runForOrganization(
    organizationId: string,
    options: { limit: number; now?: Date }
  ): Promise<GitHubOrgReconcileSummary> {
    const now = options.now ?? new Date();
    const limit = Math.max(1, Math.trunc(options.limit));
    const repos = await selectOrgDueRepos(organizationId, limit, now);
    const outcomes = await mapWithDbConcurrency(repos, (repo) =>
      reconcileRepoIsolated({ ...repo, isWakeup: false }, now)
    );
    return {
      ...summarize(repos.length, outcomes),
      reposRemaining: await countRemainingBestEffort(
        organizationId,
        repos.map((repo) => repo.repositoryFullName),
        now
      ),
    };
  },
};

type SyncStateRow = {
  organizationId: string;
  repositoryFullName: string;
  tier?: string | null;
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
      where: dueRepoWhere(now),
      // Oldest-swept first; never-swept (null) leads. Ordering provides natural
      // queueing; nextRetryAt provides the hard exclusion window for repos with
      // consecutive failures (ISS-5092). The consecutiveFailureCount=0 arm
      // handles version-skew: a rollback to old code clears the failure counter
      // but cannot clear nextRetryAt (unknown column), so a recovered repo must
      // still be eligible.
      orderBy: [{ lastSweptAt: { sort: "asc", nulls: "first" } }],
      take: RECONCILE_REPO_BATCH,
      select: SYNC_STATE_SELECT,
    })
  );
}

/**
 * The syncable-and-due predicate both selectors share. Extracted so the on-demand
 * org lane cannot answer a different question from the cron batch about which
 * repos are due.
 */
function dueRepoWhere(now: Date): Prisma.GitHubRepoSyncStateWhereInput {
  return {
    tier: { not: GitHubRepoSyncTier.Unsyncable },
    OR: [
      { nextRetryAt: null },
      { nextRetryAt: { lte: now } },
      { consecutiveFailureCount: 0 },
    ],
  };
}

const SYNC_STATE_SELECT = {
  organizationId: true,
  repositoryFullName: true,
  tier: true,
  watermark: true,
  cursor: true,
  consecutiveFailureCount: true,
} as const;

function selectOrgDueRepos(
  organizationId: string,
  limit: number,
  now: Date
): Promise<SyncStateRow[]> {
  return withDb((db) =>
    db.gitHubRepoSyncState.findMany({
      where: { organizationId, ...dueRepoWhere(now) },
      orderBy: [{ lastSweptAt: { sort: "asc", nulls: "first" } }],
      take: limit,
      select: SYNC_STATE_SELECT,
    })
  );
}

/**
 * The org's currently-due population, minus any repo the caller already handled.
 *
 * The exclusion is applied INSIDE the count, never subtracted from a wider one.
 * This runs after the sweep, so a repo the pass just failed or reclassified has
 * already dropped out of `dueRepoWhere` on its own; deducting the handled page
 * from a wider count removed those a second time, shrinking the answer by
 * exactly the failure count (ISS-8140). One statement also leaves no second
 * snapshot to disagree with the first.
 */
function countOrgDueRepos(
  organizationId: string,
  now: Date,
  handledRepositoryFullNames: string[]
): Promise<number> {
  const handled =
    handledRepositoryFullNames.length === 0
      ? {}
      : { repositoryFullName: { notIn: handledRepositoryFullNames } };
  return withDb((db) =>
    db.gitHubRepoSyncState.count({
      where: { organizationId, ...dueRepoWhere(now), ...handled },
    })
  );
}

/**
 * What the bound left eligible, or null when the count could not be taken.
 *
 * Runs after the sweep and never throws: it feeds a log line, so a transient
 * read failure must not discard — or, ahead of the sweep, prevent — the
 * reconciliation a just-connected org is waiting on.
 */
async function countRemainingBestEffort(
  organizationId: string,
  handledRepositoryFullNames: string[],
  now: Date
): Promise<number | null> {
  try {
    return await countOrgDueRepos(
      organizationId,
      now,
      handledRepositoryFullNames
    );
  } catch (error) {
    log.warn(`${RECONCILE_LOG_PREFIX} due-repo count failed`, {
      organizationId,
      error: parseError(error),
    });
    return null;
  }
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
    // so reaching here is an unexpected fault. Isolate it: the rest of the
    // batch still runs, and the row is settled so it cannot monopolise the
    // next tick.
    log.error(`${RECONCILE_LOG_PREFIX} repo reconcile threw`, {
      organizationId: repo.organizationId,
      repositoryFullName: repo.repositoryFullName,
      error: parseError(error),
    });
    if (repo.isWakeup) {
      // A wake-up row is settled by its lastSweptAt: eligibility IS
      // "lastSweptAt is stale", so leaving it unstamped would re-select it
      // every tick for as long as the fault persists and spend the whole
      // wake-up budget on one broken repo. nextRetryAt does not bound it —
      // the wake-up selector does not read that column.
      await stampSweptBestEffort(repo, now);
    } else {
      await backOffThrownRepoBestEffort(repo, now);
    }
    await reportThrownRepoCoverageBestEffort(repo, now);
    return null;
  }
}

async function reportThrownRepoCoverageBestEffort(
  repo: SyncStateRow,
  now: Date
): Promise<void> {
  try {
    await reportGitHubDeliveryCoverageTick({
      organizationId: repo.organizationId,
      repositoryId: null,
      repositoryFullName: repo.repositoryFullName,
      status: ReconcileRepoStatus.Failed,
      tier: syncTierForCoverage(repo.tier),
      writtenCount: 0,
      deferredReason: null,
      fetchFailureCount: 0,
      targetFetchFailureWriteCount: 0,
      budgetDeferralCount: 0,
      now,
    });
  } catch (error) {
    log.warn(`${RECONCILE_LOG_PREFIX} failed to report throw coverage`, {
      organizationId: repo.organizationId,
      repositoryFullName: repo.repositoryFullName,
      error: parseError(error),
    });
  }
}

function syncTierForCoverage(
  tier: string | null | undefined
): GitHubRepoSyncTierType | undefined {
  if (
    tier === GitHubRepoSyncTier.Installed ||
    tier === GitHubRepoSyncTier.UserToken ||
    tier === GitHubRepoSyncTier.Unsyncable
  ) {
    return tier;
  }
  return undefined;
}

/**
 * Settle a main-batch repo whose reconcile threw, with the same failure backoff
 * the handled paths inside reconcileRepo write (ISS-5092) — that write is owned
 * by persistFailureSettlement, so the two lanes stay in step.
 *
 * `lastSweptAt` is deliberately not stamped: moving it would silently reorder
 * the oldest-swept-first queue. Ordering alone is no settlement though — with
 * no exclusion window the row keeps its stale (or null) stamp and re-heads
 * every 25-row batch forever, so 25 such repos would zero the reconciler out
 * (ISS-6589).
 *
 * Best-effort: this runs on a path that has already failed, and a bookkeeping
 * error must not escape the isolation it lives inside.
 */
async function backOffThrownRepoBestEffort(
  repo: SyncStateRow,
  now: Date
): Promise<void> {
  try {
    await persistFailureSettlement(repo, now, {
      stampSwept: false,
      reason: RECONCILE_UNEXPECTED_FAILURE_REASON,
    });
  } catch (error) {
    log.warn(`${RECONCILE_LOG_PREFIX} failed to record throw backoff`, {
      organizationId: repo.organizationId,
      repositoryFullName: repo.repositoryFullName,
      error: parseError(error),
    });
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
    reposDeferredContention: 0,
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
      summary[deferralSummaryField(result.deferredReason)] += 1;
    } else if (result.status === ReconcileRepoStatus.Reclassified) {
      summary.reposReclassified += 1;
    } else {
      summary.reposFailed += 1;
    }
  }
  return summary;
}

/**
 * Which tally a deferral lands in. Exhaustive over the deferral vocabulary, so
 * a third reason fails `tsc` here instead of silently joining the budget count.
 */
const DEFERRAL_SUMMARY_FIELD = {
  [GitHubRepoSyncDeferralReason.Budget]: "reposDeferredBudget",
  [GitHubRepoSyncDeferralReason.Contention]: "reposDeferredContention",
} as const satisfies Record<
  GitHubRepoSyncDeferralReason,
  "reposDeferredBudget" | "reposDeferredContention"
>;

function deferralSummaryField(
  reason: GitHubRepoSyncDeferralReason | null
): "reposDeferredBudget" | "reposDeferredContention" {
  // Every producer of a Deferred outcome states its reason; a missing one is
  // still counted rather than dropped, so the tallies keep summing to the
  // selected population.
  return reason ? DEFERRAL_SUMMARY_FIELD[reason] : "reposDeferredBudget";
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
      select: SYNC_STATE_SELECT,
    })
  );
}
