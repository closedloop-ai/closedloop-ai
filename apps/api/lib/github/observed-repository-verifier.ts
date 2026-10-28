import { randomUUID } from "node:crypto";
import { parseRepositoryFullName } from "@repo/api/src/types/branch-repository";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import {
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import { RepositoryDefaultSource } from "@repo/api/src/types/repository-default-identity";
import { type Prisma, withDb } from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import { classifyGitHubRepositoryAccessProbeError } from "@repo/github/provider-error-classification";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { computeNextRetryAt } from "@/lib/github/github-retry-backoff";
import {
  type GetGitHubSyncClientOptions,
  type GitHubSyncClient,
  getGitHubSyncClient,
} from "@/lib/github/github-sync-client-pool";
import { GitHubSyncRepoAccessOutcome } from "@/lib/github/github-sync-pool-observations";
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";
import {
  mapGitHubRepositoryDefaultAuthority,
  repositoryDefaultAuthorityPersistenceData,
} from "@/lib/github/repository-default-authority";
import { fetchCredentialTypeFromKind } from "@/lib/github-fetch-provenance";

const VERIFIER_LOG_PREFIX = "[github/observed-repository-verifier]";

/**
 * How many observed repositories one org may verify per cycle.
 *
 * Verification spends the SAME user tokens the reconciler sweeps with (reserve
 * floor 0.5, window cap 1000), so an org that has just connected — whose whole
 * backlog is unverified — must not drain the budget the projection fill needs.
 * Throughput comes from cron frequency, exactly as the reconciler's own bounded
 * per-tick fetch does.
 */
export const OBSERVED_REPOSITORY_VERIFY_BATCH = 10;

/**
 * How long a repository waits when NO credential could be drawn for it.
 *
 * A pool exhaustion says nothing about the repository — the org is out of
 * budget, holds no `repo`-scoped grant, or has no connection at all. Retrying it
 * sooner cannot help, and the condition is resolved by a user reconnecting or a
 * rate window rolling over, not by us.
 */
export const OBSERVED_REPOSITORY_UNDRAWABLE_RETRY_MS = 6 * 60 * 60 * 1000;

/**
 * How long a repository waits when the draw lost the pool's claim (ISS-8270).
 *
 * Contention is the one undrawable condition that is NOT about the org's
 * credentials: a concurrent draw holds a working token this instant, and the
 * next pass draws normally. The six-hour horizon above exists because a user
 * has to act before retrying can help; here nobody does, so parking a readable
 * repository for six hours over a lost compare-and-set is pure delay. Shorter
 * than the verification pass's own cadence, so the row is simply eligible again
 * on the next run rather than waiting on a horizon of its own.
 */
export const OBSERVED_REPOSITORY_CONTENTION_RETRY_MS = 15 * 60 * 1000;

/**
 * How many repo-scoped refusals settle a repository as `denied`.
 *
 * One 404 is not proof: GitHub cloaks a repository the caller cannot see as a
 * 404, so it means "not this credential", not "not this org". Each no-access read
 * writes a repo verdict against the credential that made it, which excludes that
 * credential from the next draw — so successive attempts rotate through the
 * pool, and reaching this count means the credentials drawn so far could not
 * collectively read it.
 *
 * Counted on its OWN column, and ONLY for a 404 from `repos.get`. Sharing the
 * backoff's failure count would let two rate limits plus one 404 settle a
 * repository every credential could read; counting a generic 403 would settle
 * one behind a SAML or OAuth App restriction that is not about the repository
 * at all.
 */
export const OBSERVED_REPOSITORY_DENIAL_ATTEMPTS = 3;

/**
 * How long a denied repository waits before it is offered another rotation.
 *
 * A denial is a verdict about the credentials the org had at the time, not
 * about the repository: a user with access joining, a `repo` grant widening, or
 * the GitHub App being installed all change the answer, and none of them
 * announce themselves here. The horizon is what keeps `denied` from meaning
 * `forever` — the tally resets with the denial, so a re-check earns a full
 * rotation rather than re-denying on the first refusal. A malformed name is
 * denied with NO horizon, because that one genuinely cannot change.
 */
export const OBSERVED_REPOSITORY_DENIAL_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

export const ObservedRepositoryVerifyOutcome = {
  /** Read back from GitHub; identity and default-branch authority persisted. */
  Verified: "verified",
  /** Settled unreadable by every credential the org has. */
  Denied: "denied",
  /** Nothing was learned; the row stays a candidate and waits. */
  Deferred: "deferred",
} as const;
export type ObservedRepositoryVerifyOutcome =
  (typeof ObservedRepositoryVerifyOutcome)[keyof typeof ObservedRepositoryVerifyOutcome];

export type VerifyObservedRepositoriesSummary = {
  attempted: number;
  verified: number;
  denied: number;
  deferred: number;
};

type DueObservedRepositoryRow = {
  id: string;
  repositoryFullName: string;
  /** The state the row was READ in — the compare-and-set guard for its settle. */
  verificationState: string;
  consecutiveVerificationFailureCount: number;
  consecutiveNoAccessCount: number;
};

/**
 * PLN-1775 M2 (ISS-7403): prove — or settle — that this org can actually read
 * the repositories its sessions named.
 *
 * A desktop-reported full name is never authority. This is what turns one into
 * something a reader may trust: a `repos.get` through the org's own credential
 * (a covering installation when one exists, else a pooled Clerk user token),
 * whose response supplies the provider repository id and the default-branch
 * group branch materialization requires. Nothing else in the row is ever
 * promoted from what the desktop said.
 *
 * Never throws. Every attempt settles into a persisted state so a cron sweep is
 * durable, and a row is skipped entirely while its `nextVerificationAt` is in
 * the future.
 */
export async function verifyObservedRepositories(
  input: { organizationId: string; limit?: number },
  options: GetGitHubSyncClientOptions = {}
): Promise<VerifyObservedRepositoriesSummary> {
  const now = options.now ?? new Date();
  const rows = await selectDueObservedRepositories(
    input.organizationId,
    input.limit ?? OBSERVED_REPOSITORY_VERIFY_BATCH,
    now
  );
  const summary: VerifyObservedRepositoriesSummary = {
    attempted: rows.length,
    verified: 0,
    denied: 0,
    deferred: 0,
  };
  for (const row of rows) {
    // Sequential on purpose: concurrent draws for one org compete for the same
    // tokens and would floor the pool the reconciler shares.
    const outcome = await verifyObservedRepository(
      input.organizationId,
      row,
      options,
      now
    );
    if (outcome === ObservedRepositoryVerifyOutcome.Verified) {
      summary.verified += 1;
    } else if (outcome === ObservedRepositoryVerifyOutcome.Denied) {
      summary.denied += 1;
    } else {
      summary.deferred += 1;
    }
  }
  return summary;
}

/**
 * Due rows, heaviest evidence first: a repository many sessions worked in is the
 * one whose verification unblocks the most of the product.
 */
async function selectDueObservedRepositories(
  organizationId: string,
  limit: number,
  now: Date
): Promise<DueObservedRepositoryRow[]> {
  return await withDb((db) =>
    db.gitHubObservedRepository.findMany({
      where: {
        organizationId,
        ...dueObservedRepositoryWhere(now),
      },
      orderBy: [
        { observedSessionCount: "desc" },
        { lastObservedAt: "desc" },
        { id: "asc" },
      ],
      take: Math.max(1, limit),
      select: {
        id: true,
        repositoryFullName: true,
        verificationState: true,
        consecutiveVerificationFailureCount: true,
        consecutiveNoAccessCount: true,
      },
    })
  );
}

async function verifyObservedRepository(
  organizationId: string,
  row: DueObservedRepositoryRow,
  options: GetGitHubSyncClientOptions,
  now: Date
): Promise<ObservedRepositoryVerifyOutcome> {
  const target = parseRepositoryFullName(row.repositoryFullName);
  if (!target) {
    // A candidate that is not a repository identity can never be verified, so
    // settle it rather than re-drawing a credential for it every cycle. No
    // re-check horizon: unlike a reach denial, this cannot become readable.
    log.warn(`${VERIFIER_LOG_PREFIX} malformed repositoryFullName`, {
      organizationId,
      observedRepositoryId: row.id,
    });
    return await settleDenied(row, {
      reason: GitHubAccessDenialReason.Unavailable,
      recheckAt: null,
      now,
    });
  }

  const clientResult = await getGitHubSyncClient(
    { organizationId, target },
    options
  );
  if (!clientResult.ok) {
    await persistUndrawable(row, clientResult.error.reason, now);
    return ObservedRepositoryVerifyOutcome.Deferred;
  }

  const client = clientResult.value;
  let repository: VerifiedRepositoryPayload;
  try {
    repository = (await client.octokit.rest.repos.get(target)).data;
  } catch (error) {
    return await handleReadFailure(row, { client, error, now });
  }
  // Deliberately OUTSIDE the read's catch: the verdict write goes through the
  // capability store, which rethrows anything that is not a unique-constraint
  // race, and a bookkeeping failure AFTER a successful read must never be fed
  // to the failure classifier — a Prisma error carries no HTTP status, so it
  // would land as `unavailable`, grow a backoff, and discard a read that
  // actually succeeded.
  await recordRepoAccessBestEffort(client, GitHubSyncRepoAccessOutcome.Ok, row);
  return await settleVerified(row, { organizationId, client, now, repository });
}

/**
 * No credential could be drawn, so nothing was learned about the repository.
 *
 * A budget or scope exhaustion must NOT count as a verification failure: the
 * backoff it would grow is a statement about the repository, and this condition
 * belongs to the org's credentials. Counting it would push a perfectly readable
 * repository toward a day-long wait for a rate window that clears in an hour.
 *
 * The horizon splits by what the denial actually says: contention clears by
 * itself on the next pass, everything else waits on a user or a rate window.
 */
async function persistUndrawable(
  row: DueObservedRepositoryRow,
  reason: GitHubAccessDenialReason,
  now: Date
): Promise<void> {
  const retryMs =
    reason === GitHubAccessDenialReason.Contention
      ? OBSERVED_REPOSITORY_CONTENTION_RETRY_MS
      : OBSERVED_REPOSITORY_UNDRAWABLE_RETRY_MS;
  await updateObservedRepository(row, {
    lastVerificationAttemptAt: now,
    nextVerificationAt: new Date(now.getTime() + retryMs),
  });
  log.info(`${VERIFIER_LOG_PREFIX} no credential available`, {
    observedRepositoryId: row.id,
    reason,
  });
}

async function handleReadFailure(
  row: DueObservedRepositoryRow,
  context: { client: GitHubSyncClient; error: unknown; now: Date }
): Promise<ObservedRepositoryVerifyOutcome> {
  const classification = classifyGitHubRepositoryAccessProbeError(
    context.error,
    context.now.getTime()
  );
  const attempt = row.consecutiveVerificationFailureCount + 1;
  if (
    classification.status !== GitHubProviderResultStatus.ProviderRepoNotFound
  ) {
    // Everything else says nothing about THIS repository's reach: a rate limit,
    // a revoked token, a provider outage — and the generic 403
    // (`provider_permission_filtered`), which a SAML enforcement, an IP
    // allowlist, or an OAuth App restriction produces against a credential that
    // may well be able to read the repo. So it never teaches the pool a
    // verdict, never counts toward the denial ceiling, and never settles the
    // row. `recordNoAccessIfRepoDenied` draws the same line for the reconciler.
    await persistTransientFailure(row, attempt, context.now);
    return ObservedRepositoryVerifyOutcome.Deferred;
  }
  // A 404 from `repos.get` IS the private-repository cloak: this credential
  // cannot reach the repo. Teach the pool so the next attempt draws another.
  await recordRepoAccessBestEffort(
    context.client,
    GitHubSyncRepoAccessOutcome.NoAccess,
    row
  );
  const noAccessAttempt = row.consecutiveNoAccessCount + 1;
  if (noAccessAttempt < OBSERVED_REPOSITORY_DENIAL_ATTEMPTS) {
    await persistNoAccessAttempt(
      row,
      { attempt, noAccessAttempt },
      context.now
    );
    return ObservedRepositoryVerifyOutcome.Deferred;
  }
  return await settleDenied(row, {
    reason: GitHubAccessDenialReason.NoInstallation,
    recheckAt: new Date(
      context.now.getTime() + OBSERVED_REPOSITORY_DENIAL_RECHECK_MS
    ),
    now: context.now,
  });
}

/**
 * Teach the pool what this attempt learned, without letting the lesson cost the
 * attempt. The capability store rethrows anything that is not a unique-constraint
 * race; losing a verdict costs one extra draw next tick, while letting it
 * propagate would discard the read that produced it.
 */
async function recordRepoAccessBestEffort(
  client: GitHubSyncClient,
  outcome: GitHubSyncRepoAccessOutcome,
  row: DueObservedRepositoryRow
): Promise<void> {
  try {
    await client.recordRepoAccess(outcome);
  } catch (error) {
    log.warn(`${VERIFIER_LOG_PREFIX} failed to record repo access`, {
      observedRepositoryId: row.id,
      outcome,
      error: parseError(error),
    });
  }
}

async function persistTransientFailure(
  row: DueObservedRepositoryRow,
  attempt: number,
  now: Date
): Promise<void> {
  await updateObservedRepository(row, {
    lastVerificationAttemptAt: now,
    consecutiveVerificationFailureCount: attempt,
    nextVerificationAt: computeNextRetryAt(attempt, now),
  });
}

/**
 * A refusal that IS evidence about reach: it advances the denial ceiling on its
 * own column while still growing the shared backoff, so the next rotation onto a
 * different credential waits the same amount as any other failed attempt.
 */
async function persistNoAccessAttempt(
  row: DueObservedRepositoryRow,
  attempts: { attempt: number; noAccessAttempt: number },
  now: Date
): Promise<void> {
  await updateObservedRepository(row, {
    lastVerificationAttemptAt: now,
    consecutiveVerificationFailureCount: attempts.attempt,
    consecutiveNoAccessCount: attempts.noAccessAttempt,
    nextVerificationAt: computeNextRetryAt(attempts.attempt, now),
  });
}

async function settleDenied(
  row: DueObservedRepositoryRow,
  context: {
    reason: GitHubAccessDenialReason;
    recheckAt: Date | null;
    now: Date;
  }
): Promise<ObservedRepositoryVerifyOutcome> {
  const settled = await updateObservedRepository(row, {
    verificationState: GitHubObservedRepositoryVerificationState.Denied,
    deniedReason: context.reason,
    lastVerificationAttemptAt: context.now,
    // The denial closes its own tally, so a re-check earns a full rotation
    // through the pool instead of re-denying on the first refusal it meets.
    consecutiveNoAccessCount: 0,
    nextVerificationAt: context.recheckAt,
  });
  return settled
    ? ObservedRepositoryVerifyOutcome.Denied
    : ObservedRepositoryVerifyOutcome.Deferred;
}

/**
 * Persist the read-back identity plus the default-branch authority group.
 *
 * The authority is built through the SAME producer the installed and public
 * lanes use, so a verified observation row cannot carry a shape those readers
 * would interpret differently. `credentialType` records which lane actually read
 * it, and `credentialOwnerId` which user's token did — that provenance is the
 * whole difference between this row and the desktop's claim.
 */
async function settleVerified(
  row: DueObservedRepositoryRow,
  context: {
    organizationId: string;
    client: GitHubSyncClient;
    now: Date;
    repository: VerifiedRepositoryPayload;
  }
): Promise<ObservedRepositoryVerifyOutcome> {
  const { client, now, repository } = context;
  const authority = mapGitHubRepositoryDefaultAuthority({
    providerRepositoryId: String(repository.id),
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    source: RepositoryDefaultSource.RepositoryRest,
    mechanism: GitHubFetchMechanism.Rest,
    trigger: GitHubFetchTrigger.Backfill,
    credentialType: fetchCredentialTypeFromKind(client.kind),
    ...(client.credentialOwnerId
      ? { credentialOwnerId: client.credentialOwnerId }
      : {}),
    observationKey: randomUUID(),
    observedAt: now,
  });
  const settled = await updateObservedRepository(row, {
    verificationState: GitHubObservedRepositoryVerificationState.Verified,
    githubRepoId: String(repository.id),
    owner: repository.owner.login,
    name: repository.name,
    htmlUrl: repository.html_url,
    isPrivate: repository.private,
    lastPushedAt: parsePushedAt(repository.pushed_at),
    lastVerificationAttemptAt: now,
    consecutiveVerificationFailureCount: 0,
    consecutiveNoAccessCount: 0,
    nextVerificationAt: null,
    deniedReason: null,
    ...repositoryDefaultAuthorityPersistenceData(authority),
  });
  return settled
    ? ObservedRepositoryVerifyOutcome.Verified
    : ObservedRepositoryVerifyOutcome.Deferred;
}

/**
 * A missing or unparseable `pushed_at` is stored as unknown, never as a
 * fabricated timestamp: the column orders the repository list a reader sees.
 */
function parsePushedAt(pushedAt: string | null | undefined): Date | null {
  if (!pushedAt) {
    return null;
  }
  const parsed = new Date(pushedAt);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Settle one row under a compare-and-set on the state it was READ in, never
 * letting the write itself escape.
 *
 * The guard is what makes two overlapping sweeps safe: both can hold the same
 * row, and without it the slower one's stale denial would land on top of the
 * other's successful verification. A zero-row update therefore means the row
 * moved underneath this attempt — reported as nothing learned rather than as a
 * terminal outcome, because the outcome is the other sweep's to count.
 *
 * The caller is a cron sweep over many repositories; a failed state write on one
 * of them must not abandon the rest, and the row is re-selected next cycle
 * because its state and `nextVerificationAt` were simply not advanced.
 */
async function updateObservedRepository(
  row: DueObservedRepositoryRow,
  data: Prisma.GitHubObservedRepositoryUpdateManyMutationInput
): Promise<boolean> {
  try {
    const { count } = await withDb((db) =>
      db.gitHubObservedRepository.updateMany({
        where: { id: row.id, verificationState: row.verificationState },
        data,
      })
    );
    if (count === 0) {
      log.info(`${VERIFIER_LOG_PREFIX} row settled by a concurrent sweep`, {
        observedRepositoryId: row.id,
        verificationState: row.verificationState,
      });
    }
    return count > 0;
  } catch (error) {
    log.warn(`${VERIFIER_LOG_PREFIX} failed to persist verification state`, {
      observedRepositoryId: row.id,
      error: parseError(error),
    });
    return false;
  }
}

/** The `repos.get` fields a verified row is built from, and nothing else. */
type VerifiedRepositoryPayload = {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  html_url: string;
  private: boolean;
  default_branch?: string;
  pushed_at?: string | null;
};

/**
 * Which rows this verifier would pick up right now, WITHOUT the org scope.
 *
 * Exported because the verification org selector asks the same question one
 * level up — "is there anything here worth spending a tick on?" — and a second
 * hand-written copy of the predicate is how one lane starts selecting orgs
 * whose rows the other would not have touched.
 */
export function dueObservedRepositoryWhere(
  now: Date
): Prisma.GitHubObservedRepositoryWhereInput {
  return {
    OR: [
      {
        verificationState: GitHubObservedRepositoryVerificationState.Pending,
        OR: [
          { nextVerificationAt: null },
          { nextVerificationAt: { lte: now } },
        ],
      },
      {
        // A denied row past its re-check horizon competes for the same budget as
        // a pending one: the pool it was denied against may have gained a
        // credential since. A null horizon (the malformed-name denial) is
        // excluded by the comparison itself.
        verificationState: GitHubObservedRepositoryVerificationState.Denied,
        nextVerificationAt: { lte: now },
      },
    ],
  };
}

/**
 * ISS-7721: re-open every backed-off PENDING row for one organization.
 *
 * A `nextVerificationAt` on a pending row is a statement about the CREDENTIAL
 * that failed — an undrawable pool, a rate limit, an outage — not about the
 * repository. A connect replaces that credential, so the window the failure
 * bought is stale the moment it happens. Without this, an org that reconnects
 * with better scopes gets a post-connect pass that verifies nothing, creates no
 * sync-state rows, and sweeps nothing, on exactly the reconnect the lane exists
 * to serve.
 *
 * Pending only. A denied row's horizon is its re-check schedule rather than a
 * backoff, and {@link dueObservedRepositoryWhere}'s denied arm excludes a null
 * horizon outright — clearing one would strand the row instead of hastening it.
 *
 * The failure tallies are deliberately left intact: this re-opens the window
 * once, it does not forgive the ceiling a repeatedly-failing row has earned.
 */
export async function clearPendingVerificationBackoff(
  organizationId: string
): Promise<number> {
  const { count } = await withDb((db) =>
    db.gitHubObservedRepository.updateMany({
      where: {
        organizationId,
        verificationState: GitHubObservedRepositoryVerificationState.Pending,
        nextVerificationAt: { not: null },
      },
      data: { nextVerificationAt: null },
    })
  );
  return count;
}
