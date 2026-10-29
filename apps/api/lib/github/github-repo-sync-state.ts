import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { parseRepositoryFullName } from "@repo/api/src/types/branch-repository";
import { GitHubInstallationStatus, Prisma, withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { v7 as uuidv7 } from "uuid";
import {
  activeRepoVerdictBatchWhere,
  activeRepoVerdictWhere,
  type GitHubRepoVerdictRow,
  type GitHubRepoVerdictTarget,
  hasDurableNoAccessVerdict,
} from "@/lib/github/github-capability-store";
import {
  GITHUB_REPO_SCOPE,
  normalizeGitHubName,
} from "@/lib/github/github-connection-credential";
import { findCoveringInstallation } from "@/lib/github/installation-repository-lookup";
import { listVerifiedObservedRepositoryNames } from "@/lib/github/observed-repository-discovery";
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";
import { POSTGRES_MAX_ACCEPTED_VERBATIM_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";

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
  /**
   * Every pool candidate was claimed by a concurrent sweep (ISS-8270). The
   * credential is healthy and another repo is using it right now, so the next
   * tick draws normally — nothing to reclassify and nothing to reconnect.
   */
  Contention: "contention",
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
  const covering = await findCoveringInstallation(
    organizationId,
    `${owner}/${repo}`
  );
  return covering !== null;
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
          where: activeRepoVerdictWhere(target, now),
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

/**
 * ISS-5091: select orgs that have candidate repos (installation or
 * PR-projection) but no completed bootstrap. The OR arms mirror the two repo
 * sources reconcileOrgRepoSyncStates derives.
 *
 * ISS-6590: the predicate is the durable completion marker, NOT
 * `githubRepoSyncStates: { none: {} }`. Each repo commits in its own `withDb`
 * upsert with no enclosing transaction, so any subset of a pass can be missing
 * while the rest is committed — the repos whose own upsert errored, or every
 * repo still in flight when the route hits `maxDuration`. Under the old "has ≥1
 * row" predicate a single such gap retired the org permanently, and the PR
 * reconciler selects only from that table, so those repos' projections silently
 * stopped being refreshed. The only other writer,
 * `reconcileOrgRepoSyncStatesBestEffort`, fires on a GitHub connect/disconnect
 * or installation change — the lifecycle event an established org may never see
 * again — so nothing healed it.
 *
 * Ordering is by attempt, not creation: an org that keeps failing before it can
 * write anything would otherwise sit at the head of `createdAt asc` on every
 * tick and starve the 24 orgs behind it. `markOrgRepoSyncBootstrapAttempt`
 * claims the org before the pass runs, which rotates it to the back. Inside the
 * never-attempted group the tiebreak is newest-first, because the migration
 * intentionally leaves every legacy org unmarked: under `createdAt asc` a
 * brand-new customer would queue behind that whole one-time re-sweep at 25 orgs
 * an hour, which is the opposite of the latency this cron exists to bound.
 *
 * No supporting index on `organizations`: this runs hourly over a per-customer
 * dimension table, the previous predicate was an equally unindexed anti-join
 * over the same rows, and the marker becomes selective again once the one-time
 * post-migration re-sweep drains. A partial index on
 * `(github_repo_sync_bootstrap_attempted_at, created_at) WHERE
 * github_repo_sync_bootstrapped_at IS NULL` is the scale-time follow-up.
 *
 * (Corrected on #5551: this note used to say Prisma cannot express a partial
 * index. It can — `@@index(..., where: raw("..."))` under the `partialIndexes`
 * Preview feature, which ISS-7476 enabled once every existing partial index was
 * declared. Nothing blocks that follow-up index now; it is deferred on cost, not
 * on capability.)
 */
export async function selectUnbootstrappedOrgIds(
  limit: number
): Promise<string[]> {
  const orgs = await withDb((db) =>
    db.organization.findMany({
      where: {
        githubRepoSyncBootstrappedAt: null,
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
          {
            // Verified observations queue targeted session-linked tier-2
            // reconciliation for installation-free orgs. They do not authorize
            // repository-history PR enumeration.
            githubObservedRepositories: {
              some: {
                verificationState:
                  GitHubObservedRepositoryVerificationState.Verified,
                githubRepoId: { not: null },
              },
            },
            githubUserConnections: {
              some: { revokedAt: null, scopes: { has: GITHUB_REPO_SCOPE } },
            },
          },
        ],
      },
      select: { id: true },
      orderBy: [
        { githubRepoSyncBootstrapAttemptedAt: { sort: "asc", nulls: "first" } },
        { createdAt: "desc" },
      ],
      take: limit,
    })
  );
  return orgs.map((org) => org.id);
}

/**
 * ISS-6590: claim an org for a bootstrap pass. Written BEFORE the pass so a
 * crash, a rejected read, or the platform killing the route mid-org still moves
 * the org to the back of the selector's queue instead of letting it re-head
 * every batch forever.
 */
export async function markOrgRepoSyncBootstrapAttempt(
  organizationId: string,
  now: Date
): Promise<void> {
  // updateMany, not update: the org can be deleted between selection and the
  // claim, and a missing-row throw here would be reported as a bootstrap
  // failure for an org that no longer exists.
  await withDb((db) =>
    db.organization.updateMany({
      where: { id: organizationId },
      data: { githubRepoSyncBootstrapAttemptedAt: now },
    })
  );
}

export type ReconcileOrgRepoSyncStatesResult = {
  /** Candidate repos derived for the org on this pass. */
  repoCount: number;
  /** Repos whose upsert failed; a pass with any failure is not a bootstrap. */
  failedRepoCount: number;
  /**
   * Whether this pass wrote the durable completion marker. Reported rather than
   * re-derived by the caller: a zero-candidate pass has no failures yet is
   * deliberately left unsettled, so `failedRepoCount === 0` is not the same
   * question.
   */
  settled: boolean;
};

/**
 * Re-evaluate every repo the org already has PR data or installation coverage
 * for. Called when an org-wide signal changes the ladder — a user connects or
 * disconnects GitHub, or an installation is added/removed — since those flip
 * tier for many repos at once. Coverage + connection are loaded ONCE and the
 * tier computed in memory, so the read count is fixed regardless of repo count
 * rather than 3 reads per repo. The write is likewise a fixed few round trips —
 * one chunked set-based upsert (ISS-6579), not one per repo.
 *
 * ISS-6590: the write is failure-TOLERANT and failure-COMPLETE. It used to be a
 * `mapWithDbConcurrency` fan-out, which reports fail-fast, so one transient
 * upsert error surfaced as a whole-pass rejection even though every sibling
 * upsert had already committed — the caller could not tell a total loss from a
 * one-repo gap, and settled the org either way. Failures are isolated and
 * counted, every remaining chunk is still attempted (whitlockk: a chunked write
 * that stops at the first bad chunk leaves the tail permanently unwritten), and
 * the org is stamped `githubRepoSyncBootstrappedAt` only when the whole set
 * landed; an incomplete pass stays selectable and is retried.
 */
export async function reconcileOrgRepoSyncStates(
  organizationId: string,
  options: { now?: Date } = {}
): Promise<ReconcileOrgRepoSyncStatesResult> {
  const now = options.now ?? new Date();
  // Sequential, not Promise.all: a rejection in one read must not orphan the
  // other's rejection (Node treats an unobserved rejection as fatal). This path
  // is infrequent (lifecycle events), so the serial cost is irrelevant.
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
  // Verified observations are a repo discovery source for targeted tier-2
  // reconciliation, not permission to enumerate repository PR history.
  const observedFullNames =
    await listVerifiedObservedRepositoryNames(organizationId);
  const coveredFullNames = new Set(
    installationRepos.map((row) => normalizeRepoFullName(row.fullName))
  );
  const allFullNames = new Set<string>(coveredFullNames);
  for (const row of projectionRepos) {
    if (row.repositoryFullName) {
      allFullNames.add(normalizeRepoFullName(row.repositoryFullName));
    }
  }
  for (const fullName of observedFullNames) {
    // Re-normalized rather than trusted: the column is written normalized, but
    // this set is the conflict key of a multi-row upsert that aborts outright
    // (SQLSTATE 21000) if one identity reaches it twice under two spellings.
    allFullNames.add(normalizeRepoFullName(fullName));
  }
  // Sorted, not merely deduped: the source reads carry no `orderBy`, so two
  // concurrent reconciles of the SAME org (a connect and an
  // installation_repositories webhook land together, both via `waitUntil`)
  // could hand the multi-row `ON CONFLICT DO UPDATE` the same repos in
  // different orders and deadlock (40P01) — which the best-effort wrapper would
  // then swallow. The per-row upsert this replaced held one row lock at a time
  // and could not deadlock; a total order restores that guarantee.
  const fullNames = [...allFullNames].sort();
  // Loaded AFTER the repo set is known so the verdict query can be scoped to
  // exactly these repos through the shared fragment, rather than re-deriving
  // its own owner/repo/expiry predicate.
  const coverage = await loadOrgRepoScopedCoverage(
    organizationId,
    fullNames,
    now
  );
  const failures = await upsertOrgRepoSyncStates({
    organizationId,
    fullNames,
    coveredFullNames,
    coverage,
    now,
  });

  if (failures.length > 0) {
    logIncompleteRepoSyncPass(organizationId, fullNames.length, failures);
  }

  // Only a pass that actually materialized a repo settles the org. A pass that
  // derived zero candidates raced the selector's own OR arms, and stamping it
  // complete would hide the org from the cron for good if the lifecycle webhook
  // that later gives it repos is missed.
  const settled = failures.length === 0 && fullNames.length > 0;
  if (settled) {
    await markOrgRepoSyncBootstrapComplete(organizationId, now);
  }

  return {
    repoCount: fullNames.length,
    failedRepoCount: failures.length,
    settled,
  };
}

/**
 * Bind slots one VALUES row of the tier upsert consumes: id, organization_id,
 * repository_full_name, tier, last_tier_evaluated_at, updated_at.
 */
const REPO_SYNC_TIER_BINDS_PER_ROW = 6;

/**
 * Rows per `INSERT ... ON CONFLICT` statement, DERIVED from the ceiling rather
 * than chosen, so widening the row cannot silently overflow the Bind message
 * the way a hand-picked constant would (the sibling
 * `REPO_UPSERT_CHUNK_SIZE` in `app/integrations/github/service/
 * repository-sync.ts` is the hand-picked shape this improves on).
 *
 * Halved against the exact ceiling for headroom: at the exact quotient a single
 * added column overflows on the very next row, whereas this tolerates the row
 * doubling in width before the chunk size has to move with it.
 *
 * The VERBATIM ceiling, because the write below is a `$executeRaw` assembled
 * with `Prisma.join` — Prisma passes it through without inspecting it, so it
 * meets the wire's uint16 limit rather than Prisma's own per-statement budget.
 * The ACCEPTED member of that pair, because the question here is how wide a
 * statement may be, not the width at which one is refused.
 */
export const REPO_SYNC_TIER_UPSERT_CHUNK_SIZE = Math.floor(
  POSTGRES_MAX_ACCEPTED_VERBATIM_BIND_PARAMETERS /
    REPO_SYNC_TIER_BINDS_PER_ROW /
    2
);

/**
 * Trigger a whole-org tier re-evaluation from a lifecycle seam (a GitHub
 * connect, or an installation add/remove webhook) WITHOUT letting a failure
 * break that flow. A missed reclassify self-heals on the reconciler's next
 * tick, so this fails open and only logs — never rethrows.
 */
export async function reconcileOrgRepoSyncStatesBestEffort(
  organizationId: string,
  options: { now?: Date } = {}
): Promise<void> {
  try {
    const result = await reconcileOrgRepoSyncStates(organizationId, options);
    log.info(`${SYNC_STATE_LOG_PREFIX} reconciled org repo sync tiers`, {
      organizationId,
      repoCount: result.repoCount,
      failedRepoCount: result.failedRepoCount,
      settled: result.settled,
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
        // The batch variant over-selects the owner × repo cross-product
        // (ISS-6577), which is why the rows below are never read directly:
        // `groupDenialsByRepo` re-keys every one by its exact `owner/repo` and
        // `verdictRepoKey` looks them up the same way, so a pair this org never
        // asked about is discarded before it can decide a tier.
        ...activeRepoVerdictBatchWhere(
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

/**
 * A name that is not exactly `owner/repo` yields the empty target, whose key
 * `/` matches no verdict row. It must NOT fall back to the first two segments:
 * `owner/repo/extra` would then borrow `owner/repo`'s denial rows and demote a
 * different repository to `unsyncable` (ISS-7548).
 *
 * Rejecting into the empty target leaves this predicate OPEN, because an
 * unmatched key has always meant "no denial on file". That is not the tier
 * answer for a malformed name — `batchRepoSyncTier` gates on the parse before
 * either signal is consulted, so the open verdict here can never reach the
 * ladder for a name `reconcileRepo` would retire.
 */
function verdictTargetFromFullName(
  repositoryFullName: string
): GitHubRepoVerdictTarget {
  return parseRepositoryFullName(repositoryFullName) ?? { owner: "", repo: "" };
}

/** Bound the failed repos carried in the one pass-level log line. */
export const FAILED_REPO_LOG_SAMPLE = 10;

type RepoSyncStateUpsertFailure = {
  repositoryFullName: string;
  error: string;
};

/**
 * Write the org's per-repo tiers as one set-based `INSERT ... ON CONFLICT` per
 * chunk (ISS-6579), isolating each chunk's failure (ISS-6590).
 *
 * The per-repo `upsert` this replaced was fanned out at concurrency 5, so a
 * 5,000-repo org cost ~1,000 sequential round-trip waves on a path that runs
 * from `waitUntil` behind the GitHub-connect service and the
 * installation-repositories webhook, and from the bootstrap cron under a 240s
 * deadline. `apps/api/AGENTS.md` ranks collapsing into one query above a bounded
 * fan-out for exactly this shape.
 *
 * EVERY CHUNK IS ATTEMPTED (whitlockk). `withDb` commits each chunk independently
 * with no enclosing transaction, so a loop that rethrew on the first bad chunk
 * would leave the chunks BEFORE it committed and the ones after it never tried
 * — a silent tail, on a table whose only other writer is a lifecycle event an
 * established org may never see again.
 *
 * A REJECTED CHUNK FALLS BACK TO PER-REPO UPSERTS, and that is not belt-and-
 * braces. The statement is all-or-nothing, so chunk-granular accounting would
 * charge one transient error to all 5,461 of its repos and, for an org already
 * carrying `githubRepoSyncBootstrappedAt`, nothing would ever retry them —
 * the bootstrap cron selects only unstamped orgs and no per-repo reclassifier
 * survives to retry one. The fan-out this replaced lost only the repos that actually
 * failed, and the retry restores exactly that: the fast path stays one
 * statement, the slow path runs only over a chunk that already failed, and the
 * returned failures name real repos again — which also keeps
 * `logIncompleteRepoSyncPass`'s partial (`warn`) and total (`error`) levels
 * telling apart a blip from an outage.
 *
 * The `DO UPDATE` touches only `tier` + `last_tier_evaluated_at` (plus the
 * `updated_at` Prisma's `@updatedAt` wrote implicitly), preserving the
 * watermark, cursor, failure count, and deferral the reconciler owns.
 *
 * Every timestamp is BOUND from `now`, never `NOW()`: the columns are
 * `TIMESTAMP(3)` (no zone), so a server-side `NOW()` would land a `timestamptz`
 * converted through the session `TimeZone` GUC while the Prisma writers on the
 * same table store UTC — two clocks in one column on any non-UTC server.
 *
 * Not wrapped in a transaction: the fan-out it replaces was not atomic either
 * (each upsert stood alone, so a mid-way failure already left partial progress),
 * and a multi-chunk transaction would pin one connection across every chunk
 * inside Prisma's 5s interactive window.
 *
 * `fullNames` must already be deduplicated. That matters here in a way it did
 * not for the per-row loop: a single multi-row `ON CONFLICT DO UPDATE` aborts
 * with SQLSTATE 21000 if the same conflict key appears twice in one VALUES
 * list, where the per-row loop tolerated a repeat.
 */
async function upsertOrgRepoSyncStates(input: {
  organizationId: string;
  fullNames: readonly string[];
  coveredFullNames: ReadonlySet<string>;
  coverage: (repositoryFullName: string) => boolean;
  now: Date;
}): Promise<RepoSyncStateUpsertFailure[]> {
  const { organizationId, now } = input;
  const rows = input.fullNames.map((repositoryFullName) => ({
    repositoryFullName,
    tier: batchRepoSyncTier(repositoryFullName, input),
  }));
  const failures: RepoSyncStateUpsertFailure[] = [];
  const fallbacks: { chunkSize: number; error: string }[] = [];
  for (
    let start = 0;
    start < rows.length;
    start += REPO_SYNC_TIER_UPSERT_CHUNK_SIZE
  ) {
    const chunk = rows.slice(start, start + REPO_SYNC_TIER_UPSERT_CHUNK_SIZE);
    const values = Prisma.join(
      chunk.map(
        (row) => Prisma.sql`(
          ${uuidv7()}::uuid,
          ${organizationId}::uuid,
          ${row.repositoryFullName},
          ${row.tier},
          ${now},
          ${now}
        )`
      )
    );
    try {
      await withDb((db) =>
        db.$executeRaw(Prisma.sql`
          INSERT INTO "github_repo_sync_state" (
            "id",
            "organization_id",
            "repository_full_name",
            "tier",
            "last_tier_evaluated_at",
            "updated_at"
          )
          VALUES ${values}
          ON CONFLICT ("organization_id", "repository_full_name") DO UPDATE SET
            "tier" = EXCLUDED."tier",
            "last_tier_evaluated_at" = EXCLUDED."last_tier_evaluated_at",
            "updated_at" = EXCLUDED."updated_at"
        `)
      );
    } catch (error) {
      // Logged, not swallowed: a DETERMINISTIC statement error (a renamed
      // column, a dropped conflict index, a duplicate conflict key) makes every
      // pass pay one doomed round trip plus a full per-repo fan-out while the
      // fallback still returns a clean, settled result. That is the ISS-6579
      // win silently reverted, and nothing else would ever say so.
      fallbacks.push({ chunkSize: chunk.length, error: parseError(error) });
      failures.push(
        ...(await upsertRepoSyncTiersPerRepo(organizationId, chunk, now))
      );
    }
  }
  if (fallbacks.length > 0) {
    log.warn(
      `${SYNC_STATE_LOG_PREFIX} bulk tier upsert fell back to per-repo writes`,
      {
        organizationId,
        chunkCount: fallbacks.length,
        repoCount: fallbacks.reduce((sum, entry) => sum + entry.chunkSize, 0),
        error: fallbacks[0].error,
      }
    );
  }
  return failures;
}

/**
 * Failed per-repo upserts a fallback will absorb before it gives up on the rest
 * of its chunk.
 *
 * The fallback exists for a TRANSIENT statement error, where nearly every repo
 * still lands and the isolation is what keeps a bootstrapped org's tiers from
 * going stale with nothing to retry them. Under a pool outage the same code
 * would turn one rejected statement into a full chunk of doomed round trips —
 * up to 5,461 of them — and the bootstrap cron only checks its deadline BETWEEN
 * orgs, so one large org could burn the whole route and starve the 24 behind
 * it. Past this many failures the outage is the more likely explanation, so the
 * rest of the chunk is charged as failed without being tried.
 */
const MAX_REPO_UPSERT_FALLBACK_FAILURES = 5;

/**
 * The fallback a rejected chunk takes: one Prisma `upsert` per repo, each
 * isolated, returning only the repos that really could not be written.
 *
 * Same row contract as the bulk statement — `create` on a miss, and an update
 * that touches only `tier` + `lastTierEvaluatedAt` — so a repo written through
 * this path is indistinguishable from one written through the other.
 *
 * Sequential rather than fanned out, because the give-up rule above is only
 * meaningful in order: a concurrent wave would have several more queries in
 * flight past the point the budget was spent. The happy path never reaches
 * here, and the unhappy one is bounded by the budget rather than by the chunk.
 */
async function upsertRepoSyncTiersPerRepo(
  organizationId: string,
  rows: readonly { repositoryFullName: string; tier: GitHubRepoSyncTier }[],
  now: Date
): Promise<RepoSyncStateUpsertFailure[]> {
  const failures: RepoSyncStateUpsertFailure[] = [];
  for (const { repositoryFullName, tier } of rows) {
    if (failures.length >= MAX_REPO_UPSERT_FALLBACK_FAILURES) {
      failures.push({
        repositoryFullName,
        error: "skipped: repo-upsert fallback budget exhausted",
      });
      continue;
    }
    try {
      await withDb((db) =>
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
    } catch (error) {
      failures.push({ repositoryFullName, error: parseError(error) });
    }
  }
  return failures;
}

/**
 * One line per pass, not per repo: a pool outage fails every repo at once, and
 * 500 identical lines would bury the summary that names the scale. A total loss
 * keeps the error level the whole pass used to reject at, so alerting that
 * watched for a failed bootstrap does not go quiet through an outage now that
 * the fan-out swallows each repo's error.
 */
function logIncompleteRepoSyncPass(
  organizationId: string,
  repoCount: number,
  failures: readonly RepoSyncStateUpsertFailure[]
): void {
  const detail = {
    organizationId,
    repoCount,
    failedRepoCount: failures.length,
    failedRepoSample: failures.slice(0, FAILED_REPO_LOG_SAMPLE),
  };
  if (failures.length === repoCount) {
    log.error(
      `${SYNC_STATE_LOG_PREFIX} org repo sync tier pass failed`,
      detail
    );
    return;
  }
  log.warn(
    `${SYNC_STATE_LOG_PREFIX} org repo sync tier pass incomplete`,
    detail
  );
}

/**
 * ISS-6590: settle the org's bootstrap. Written strictly AFTER every repo row
 * has committed, so the marker can only ever lag the rows it attests to — the
 * safe direction, since a lost marker just re-runs an idempotent pass.
 */
async function markOrgRepoSyncBootstrapComplete(
  organizationId: string,
  now: Date
): Promise<void> {
  await withDb((db) =>
    db.organization.updateMany({
      where: { id: organizationId },
      data: { githubRepoSyncBootstrappedAt: now },
    })
  );
}

/**
 * Un-settle the org's bootstrap after an observed repository becomes verified.
 *
 * The next reconcile pass can then materialize the repo-sync state row that
 * queues targeted session-linked tier-2 reconciliation. A lost marker just
 * re-runs an idempotent pass; a lost un-settle strands the newly verified row
 * until another lifecycle event touches the org.
 */
export async function markOrgRepoSyncBootstrapStale(
  organizationId: string
): Promise<void> {
  await withDb((db) =>
    db.organization.updateMany({
      where: { id: organizationId },
      data: { githubRepoSyncBootstrappedAt: null },
    })
  );
}

/**
 * The batch's tier for one name, behind the same parse gate `reconcileRepo`
 * applies to the same input.
 *
 * A name that is not exactly `owner/repo` identifies no repository, so there is
 * nothing for an installation or a repo-scoped connection to cover: both ladder
 * signals are false and `resolveRepoSyncTier` retires it to `unsyncable` — the
 * tier `reconcileRepo` writes for it.
 *
 * THE TWO WRITERS MUST AGREE HERE, which is why the gate is not left to the
 * `coverage` predicate. That predicate fails open on an unmatched verdict key,
 * so an ungated malformed name was stamped `user_token` while the next
 * reconciler tick stamped `unsyncable`; because `selectDueRepos` excludes
 * tier 3, every lifecycle event resurrected a name the reconciler had just
 * retired and the pair alternated indefinitely. That is exactly the fight
 * `loadOrgRepoScopedCoverage`'s contract above exists to prevent, arriving
 * through a structural key rather than a drifted predicate (ISS-7548).
 */
function batchRepoSyncTier(
  repositoryFullName: string,
  signals: {
    coveredFullNames: ReadonlySet<string>;
    coverage: (repositoryFullName: string) => boolean;
  }
): GitHubRepoSyncTier {
  if (!parseRepositoryFullName(repositoryFullName)) {
    return GitHubRepoSyncTier.Unsyncable;
  }
  return resolveRepoSyncTier({
    hasCoveringInstallation: signals.coveredFullNames.has(repositoryFullName),
    hasRepoScopedConnection: signals.coverage(repositoryFullName),
  });
}
