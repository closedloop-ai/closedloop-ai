import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { mapWithDbConcurrency } from "@/lib/db-fanout";
import {
  activeRepoVerdictWhere,
  type GitHubRepoVerdictRow,
  type GitHubRepoVerdictTarget,
  hasDurableNoAccessVerdict,
} from "@/lib/github/github-capability-store";
import {
  GITHUB_REPO_SCOPE,
  normalizeGitHubName,
} from "@/lib/github/github-connection-credential";

const SYNC_STATE_LOG_PREFIX = "[github/repo-sync-state]";

/**
 * PLN-1535 M1: per-repo sync tier — the ladder that decides how (and whether) a
 * repo's PR projection is filled. Evaluated PER REPO (D2): one org can hold all
 * three tiers at once (installation `repositorySelection` subsets; user tokens
 * see different slices). String const (not a Prisma enum) so a new tier needs no
 * migration — mirrors GitHubUserConnection.healthState. Persisted to
 * GitHubRepoSyncState.tier.
 */
export const GitHubRepoSyncTier = {
  /**
   * The org's GitHub App installation covers this repo → webhooks fill the
   * projection; the reconciler only gap-repairs.
   */
  Installed: "installed",
  /**
   * No covering installation, but ≥1 connected user holds a repo-scoped OAuth
   * token → server-side pull via the sync-read pool (M2).
   */
  UserToken: "user_token",
  /**
   * Nobody can sync it → features show the connect CTA; the coverage stat names
   * the gap.
   */
  Unsyncable: "unsyncable",
} as const;
export type GitHubRepoSyncTier =
  (typeof GitHubRepoSyncTier)[keyof typeof GitHubRepoSyncTier];

/**
 * PLN-1535 M1/M2: why a due repo's sweep could not proceed this tick, stored on
 * GitHubRepoSyncState.deferredReason. Surfaced by the coverage stat as
 * `deferred: <reason>`, kept distinct from a tier-3 unsyncable gap.
 */
export const GitHubRepoSyncDeferralReason = {
  /** The tier-2 pool was all-floored/backed-off (D9) — recovers on its own. */
  Budget: "budget",
} as const;
export type GitHubRepoSyncDeferralReason =
  (typeof GitHubRepoSyncDeferralReason)[keyof typeof GitHubRepoSyncDeferralReason];

export type ClassifyRepoSyncTierInput = {
  organizationId: string;
  owner: string;
  repo: string;
  /** Pin the clock in tests; also anchors verdict expiry. */
  now?: Date;
};

/**
 * Pure ladder: installation coverage wins over a connectable user token wins
 * over nothing. Shared by the single-repo and batch paths so tier semantics
 * cannot drift between them.
 */
export function resolveRepoSyncTier(signals: {
  hasCoveringInstallation: boolean;
  hasRepoScopedConnection: boolean;
}): GitHubRepoSyncTier {
  if (signals.hasCoveringInstallation) {
    return GitHubRepoSyncTier.Installed;
  }
  if (signals.hasRepoScopedConnection) {
    return GitHubRepoSyncTier.UserToken;
  }
  return GitHubRepoSyncTier.Unsyncable;
}

/**
 * Read-only tier evaluation for one repo — no side effects and no token draw,
 * unlike the pool's getGitHubSyncClient (which claims an LRU slot and can mint a
 * token). Safe to call on a read path or inside a webhook transaction.
 */
export async function classifyRepoSyncTier(
  input: ClassifyRepoSyncTierInput
): Promise<GitHubRepoSyncTier> {
  const hasCoveringInstallation = await installationCovers(
    input.organizationId,
    input.owner,
    input.repo
  );
  // Short-circuit the connection query when already covered (tier 1 wins), but
  // let the shared ladder own the precedence so it cannot drift from the batch
  // path — resolveRepoSyncTier is the single source of the installed > token >
  // none ordering.
  const hasRepoScopedConnection = hasCoveringInstallation
    ? false
    : await orgHasCoveringRepoScopedConnection(
        input.organizationId,
        { owner: input.owner, repo: input.repo },
        input.now ?? new Date()
      );
  return resolveRepoSyncTier({
    hasCoveringInstallation,
    hasRepoScopedConnection,
  });
}

async function installationCovers(
  organizationId: string,
  owner: string,
  repo: string
): Promise<boolean> {
  const fullName = `${owner}/${repo}`;
  const installation = await withDb((db) =>
    db.gitHubInstallation.findUnique({
      where: { organizationId },
      select: {
        status: true,
        repositories: {
          where: {
            fullName: { equals: fullName, mode: "insensitive" },
            removedAt: null,
          },
          select: { id: true },
          take: 1,
        },
      },
    })
  );
  return (
    installation?.status === GitHubInstallationStatus.ACTIVE &&
    installation.repositories.length > 0
  );
}

/**
 * A tier-2 candidate is a non-revoked OAuth-family connection carrying the
 * `repo` scope. App-family (empty-scope) user tokens are deliberately excluded:
 * without a covering installation the App is not installed, so such a token can
 * never reach the repo — it would only ever record no-access in the pool.
 *
 * ISS-5093: "exists" is not enough. A connection the sync lane has already
 * proven cannot reach THIS repo does not cover it, or the repo sits at
 * `user_token` being swept and failing forever. Only a sync-durable verdict
 * disqualifies a connection — see `hasDurableNoAccessVerdict`.
 */
async function orgHasCoveringRepoScopedConnection(
  organizationId: string,
  target: GitHubRepoVerdictTarget,
  now: Date
): Promise<boolean> {
  const connections = await withDb((db) =>
    db.gitHubUserConnection.findMany({
      where: {
        organizationId,
        revokedAt: null,
        scopes: { has: GITHUB_REPO_SCOPE },
      },
      select: {
        scopes: true,
        capabilities: {
          where: activeRepoVerdictWhere([target], now),
          select: REPO_VERDICT_SELECT,
        },
      },
    })
  );
  return connections.some(
    (connection) =>
      !hasDurableNoAccessVerdict(connection.capabilities, connection.scopes)
  );
}

export type ReclassifyRepoSyncStateInput = ClassifyRepoSyncTierInput & {
  /** Pin the clock in tests. */
  now?: Date;
};

/**
 * Classify one repo's tier and upsert its GitHubRepoSyncState row. The upsert
 * touches only `tier` + `lastTierEvaluatedAt`, preserving the watermark, cursor,
 * failure count, and deferral the reconciler owns. Returns the resolved tier.
 */
export async function reclassifyRepoSyncState(
  input: ReclassifyRepoSyncStateInput
): Promise<GitHubRepoSyncTier> {
  const tier = await classifyRepoSyncTier(input);
  const repositoryFullName = normalizeRepoFullName(
    `${input.owner}/${input.repo}`
  );
  const now = input.now ?? new Date();
  await withDb((db) =>
    db.gitHubRepoSyncState.upsert({
      where: {
        organizationId_repositoryFullName: {
          organizationId: input.organizationId,
          repositoryFullName,
        },
      },
      create: {
        organizationId: input.organizationId,
        repositoryFullName,
        tier,
        lastTierEvaluatedAt: now,
      },
      update: { tier, lastTierEvaluatedAt: now },
    })
  );
  return tier;
}

/**
 * ISS-5091: select orgs that have candidate repos (installation or PR-projection)
 * but zero GitHubRepoSyncState rows. The OR arms mirror the two repo sources
 * reconcileOrgRepoSyncStates derives — a selected org always produces ≥1 row,
 * so it leaves this set on the next evaluation (termination invariant).
 */
export async function selectUnbootstrappedOrgIds(
  limit: number
): Promise<string[]> {
  const orgs = await withDb((db) =>
    db.organization.findMany({
      where: {
        githubRepoSyncStates: { none: {} },
        OR: [
          {
            githubInstallation: {
              status: GitHubInstallationStatus.ACTIVE,
              repositories: { some: { removedAt: null } },
            },
          },
          {
            pullRequestDetails: {
              some: { repositoryFullName: { not: null } },
            },
          },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    })
  );
  return orgs.map((org) => org.id);
}

/**
 * Re-evaluate every repo the org already has PR data or installation coverage
 * for. Called when an org-wide signal changes the ladder — a user connects or
 * disconnects GitHub, or an installation is added/removed — since those flip
 * tier for many repos at once. Coverage + connection are loaded ONCE and the
 * tier computed in memory, so this is a bounded set of upserts, not 3 reads per
 * repo. Returns the number of repos reconciled.
 */
export async function reconcileOrgRepoSyncStates(
  organizationId: string,
  options: { now?: Date } = {}
): Promise<number> {
  const now = options.now ?? new Date();
  // Sequential, not Promise.all: a rejection in one read must not orphan the
  // others' rejections (Node treats an unobserved rejection as fatal). This
  // path is infrequent (lifecycle events), so the serial cost is irrelevant.
  const installationRepos = await withDb((db) =>
    db.gitHubInstallationRepository.findMany({
      // Only ACTIVE installations cover a repo for tier-1 — a suspended
      // installation cannot mint tokens, so its repos must not be classified as
      // Installed. Mirrors the per-repo classifier's ACTIVE gate.
      where: {
        installation: {
          organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
        removedAt: null,
      },
      select: { fullName: true },
    })
  );
  const projectionRepos = await withDb((db) =>
    db.pullRequestDetail.groupBy({
      by: ["repositoryFullName"],
      where: { organizationId, repositoryFullName: { not: null } },
    })
  );

  const coveredFullNames = new Set(
    installationRepos.map((row) => normalizeRepoFullName(row.fullName))
  );
  const allFullNames = new Set<string>(coveredFullNames);
  for (const row of projectionRepos) {
    if (row.repositoryFullName) {
      allFullNames.add(normalizeRepoFullName(row.repositoryFullName));
    }
  }

  const fullNames = [...allFullNames];
  // Loaded AFTER the repo set is known so the verdict query can be scoped to
  // exactly these repos through the shared fragment, rather than re-deriving
  // its own owner/repo/expiry predicate.
  const coverage = await loadOrgRepoScopedCoverage(
    organizationId,
    fullNames,
    now
  );
  await mapWithDbConcurrency(fullNames, (repositoryFullName) => {
    const tier = resolveRepoSyncTier({
      hasCoveringInstallation: coveredFullNames.has(repositoryFullName),
      hasRepoScopedConnection: coverage(repositoryFullName),
    });
    return withDb((db) =>
      db.gitHubRepoSyncState.upsert({
        where: {
          organizationId_repositoryFullName: {
            organizationId,
            repositoryFullName,
          },
        },
        create: {
          organizationId,
          repositoryFullName,
          tier,
          lastTierEvaluatedAt: now,
        },
        update: { tier, lastTierEvaluatedAt: now },
      })
    );
  });
  return fullNames.length;
}

/**
 * Trigger a whole-org tier re-evaluation from a lifecycle seam (a GitHub
 * connect, or an installation add/remove webhook) WITHOUT letting a failure
 * break that flow. A missed reclassify self-heals on the reconciler's next
 * tick, so this fails open and only logs — never rethrows.
 */
export async function reconcileOrgRepoSyncStatesBestEffort(
  organizationId: string
): Promise<void> {
  try {
    const repoCount = await reconcileOrgRepoSyncStates(organizationId);
    log.info(`${SYNC_STATE_LOG_PREFIX} reconciled org repo sync tiers`, {
      organizationId,
      repoCount,
    });
  } catch (error) {
    log.warn(
      `${SYNC_STATE_LOG_PREFIX} failed to reconcile org repo sync tiers`,
      { organizationId, error: parseError(error) }
    );
  }
}

/** The verdict columns the shared no-access predicates read. */
const REPO_VERDICT_SELECT = {
  credentialKind: true,
  denialReason: true,
  checkedAt: true,
  expiresAt: true,
} as const;

/**
 * Per-repo tier-2 coverage for a whole org, in two bounded reads.
 *
 * The batch path must answer the SAME question as `classifyRepoSyncTier` — is
 * there a repo-scoped connection that this repo has not already been proven
 * unreachable by? — or the two writers fight: the batch stamps `user_token` on
 * every lifecycle event and the next reconciler tick stamps `unsyncable`,
 * forever. Same predicate, different carrier.
 */
async function loadOrgRepoScopedCoverage(
  organizationId: string,
  repositoryFullNames: readonly string[],
  now: Date
): Promise<(repositoryFullName: string) => boolean> {
  const connections = await withDb((db) =>
    db.gitHubUserConnection.findMany({
      where: {
        organizationId,
        revokedAt: null,
        scopes: { has: GITHUB_REPO_SCOPE },
      },
      select: { id: true, scopes: true },
    })
  );
  if (connections.length === 0 || repositoryFullNames.length === 0) {
    return () => false;
  }
  const verdicts = await withDb((db) =>
    db.gitHubAccessCapability.findMany({
      where: {
        // The SAME fragment the pool and the per-repo classifier compose, so
        // the three carriers cannot drift on what "active verdict" means.
        ...activeRepoVerdictWhere(
          repositoryFullNames.map(verdictTargetFromFullName),
          now
        ),
        organizationId,
        githubUserConnectionId: { in: connections.map((row) => row.id) },
        // Denials only. A positive verdict is written on EVERY successful
        // sweep, so an unfiltered load would be O(repos x connections) and
        // would say nothing about coverage anyway.
        denialReason: { not: null },
      },
      select: {
        githubUserConnectionId: true,
        normalizedTargetOwner: true,
        targetRepo: true,
        ...REPO_VERDICT_SELECT,
      },
    })
  );
  const denialsByRepo = groupDenialsByRepo(verdicts);
  return (repositoryFullName: string) => {
    const byConnection = denialsByRepo.get(verdictRepoKey(repositoryFullName));
    if (!byConnection) {
      return true;
    }
    return connections.some(
      (connection) =>
        !hasDurableNoAccessVerdict(
          byConnection.get(connection.id) ?? [],
          connection.scopes
        )
    );
  };
}

function groupDenialsByRepo(
  verdicts: readonly (GitHubRepoVerdictRow & {
    githubUserConnectionId: string;
    normalizedTargetOwner: string;
    targetRepo: string | null;
  })[]
): Map<string, Map<string, GitHubRepoVerdictRow[]>> {
  const denialsByRepo = new Map<string, Map<string, GitHubRepoVerdictRow[]>>();
  for (const verdict of verdicts) {
    if (!verdict.targetRepo) {
      // Owner-level rows belong to the interactive lane's repo-less probes and
      // say nothing about a specific repo.
      continue;
    }
    const repoKey = `${verdict.normalizedTargetOwner}/${verdict.targetRepo}`;
    let byConnection = denialsByRepo.get(repoKey);
    if (!byConnection) {
      byConnection = new Map<string, GitHubRepoVerdictRow[]>();
      denialsByRepo.set(repoKey, byConnection);
    }
    const rows = byConnection.get(verdict.githubUserConnectionId) ?? [];
    rows.push(verdict);
    byConnection.set(verdict.githubUserConnectionId, rows);
  }
  return denialsByRepo;
}

/**
 * Verdict rows key owner and repo as separate columns under
 * `normalizeGitHubName` — NOT `normalizeRepoFullName`, which is what the batch
 * keys repos by. Split and re-normalize per part, or every lookup misses and
 * coverage silently fails open to `user_token`.
 */
function verdictRepoKey(repositoryFullName: string): string {
  const target = verdictTargetFromFullName(repositoryFullName);
  return `${normalizeGitHubName(target.owner)}/${normalizeGitHubName(target.repo)}`;
}

function verdictTargetFromFullName(
  repositoryFullName: string
): GitHubRepoVerdictTarget {
  const [owner, repo] = repositoryFullName.split("/");
  return { owner: owner ?? "", repo: repo ?? "" };
}
