import { randomUUID } from "node:crypto";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import type {
  GitHubBundledPullRequestsObservation,
  GitHubReadModelPullRequest,
} from "@repo/api/src/types/github-read-model";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  type RepositoryDefaultProvenance,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  queryBundledPullRequestsWithProviderResult,
} from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  classifyRepoSyncTier,
  GitHubRepoSyncDeferralReason,
  GitHubRepoSyncTier,
} from "@/lib/github/github-repo-sync-state";
import {
  type GetGitHubSyncClientOptions,
  type GitHubSyncClient,
  getGitHubSyncClient,
} from "@/lib/github/github-sync-client-pool";
import { GitHubSyncRepoAccessOutcome } from "@/lib/github/github-sync-pool-observations";
import {
  writeReconciledPullRequest,
  writeReconciledPullRequestFailures,
} from "./reconcile-projection-write";

export const BACKOFF_BASE_MS = 30 * 60 * 1000;
export const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

export function computeNextRetryAt(
  consecutiveFailureCount: number,
  now: Date
): Date {
  const count = consecutiveFailureCount >= 1 ? consecutiveFailureCount : 1;
  const exponent = Math.min(count - 1, 49);
  const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
  return new Date(now.getTime() + delayMs);
}

/** Bounded per-tick fetch — throughput comes from cron frequency, not depth. */
export const RECONCILE_MAX_PAGES = 3;
export const RECONCILE_MAX_ITEMS = 300;
/** How many terminal-but-missing-LOC rows a single tick tries to self-heal. */
export const RECONCILE_SELF_HEAL_BATCH = 25;
/**
 * How long a self-heal attempt debounces a row. A merged PR whose LOC the
 * provider never returns (deleted/inaccessible merge commit) would otherwise
 * refill the fixed batch every tick forever, starving every other row behind it
 * — so we retry it at most once per window. Matches the staleness guard the
 * sibling read-repair / sync services already apply.
 */
export const RECONCILE_SELF_HEAL_DEBOUNCE_MS = 24 * 60 * 60 * 1000;

const RECONCILE_LOG_PREFIX = "[reconcile-pull-requests]";

export type ReconcileRepoInput = {
  organizationId: string;
  /** Normalized owner/name. */
  repositoryFullName: string;
  watermark: Date | null;
  /** Continuation cursor for an in-progress backlog drain; null between sweeps. */
  cursor: string | null;
  consecutiveFailureCount: number;
};

export const ReconcileRepoStatus = {
  Swept: "swept",
  Deferred: "deferred",
  Reclassified: "reclassified",
  Failed: "failed",
} as const;
export type ReconcileRepoStatus =
  (typeof ReconcileRepoStatus)[keyof typeof ReconcileRepoStatus];

export type ReconcileRepoOutcome = {
  repositoryFullName: string;
  status: ReconcileRepoStatus;
  /**
   * The tier resolved from the credential actually drawn. Present on Swept and on
   * a Failed-after-fetch (a credential was drawn, so the tier is observed, not
   * fabricated); absent when no credential was drawn — a pre-draw Deferred or a
   * denial-Failed — where persistState leaves the DB row's tier untouched.
   */
  tier?: GitHubRepoSyncTier;
  writtenCount: number;
  deferredReason: GitHubRepoSyncDeferralReason | null;
};

/**
 * PLN-1535 M2: reconcile one repo's PR projection. Draws a credential from the
 * tier-aware sync-read pool (installation → tier 1; else the org's budget-aware
 * user-token pool → tier 2), fetches recent PRs plus a bounded batch of
 * terminal-but-missing-LOC targets in one watermark-ordered read, feeds the
 * observed rate-limit budget back into the pool, writes the refreshed projection
 * onto existing rows, and advances the repo's sync-state. Never throws — every
 * failure resolves to a persisted state transition so the cron sweep is durable.
 */
export async function reconcileRepo(
  input: ReconcileRepoInput,
  options: GetGitHubSyncClientOptions = {}
): Promise<ReconcileRepoOutcome> {
  const now = options.now ?? new Date();
  const [owner, repo] = input.repositoryFullName.split("/");
  if (!(owner && repo)) {
    // A malformed identity cannot be swept or classified; drop it to
    // unsyncable so it stops being selected, and surface the corruption.
    log.warn(`${RECONCILE_LOG_PREFIX} malformed repositoryFullName`, {
      organizationId: input.organizationId,
      repositoryFullName: input.repositoryFullName,
    });
    await persistState(input, {
      tier: GitHubRepoSyncTier.Unsyncable,
      deferredReason: null,
      now,
    });
    return outcome(input, ReconcileRepoStatus.Reclassified, {
      tier: GitHubRepoSyncTier.Unsyncable,
    });
  }

  const repositoryId = await resolveInstallationRepositoryId(
    input.organizationId,
    input.repositoryFullName
  );
  const selfHealNumbers = await selectSelfHealTargets(
    input.organizationId,
    repositoryId,
    input.repositoryFullName,
    now
  );

  const clientResult = await getGitHubSyncClient(
    { organizationId: input.organizationId, target: { owner, repo } },
    options
  );
  if (!clientResult.ok) {
    return await handleDenial(input, clientResult.error.reason, {
      owner,
      repo,
      now,
    });
  }

  const client = clientResult.value;
  const observations: GitHubBundledPullRequestsObservation[] = [];
  const authorityProvenance: RepositoryDefaultProvenance = {
    source: RepositoryDefaultSource.PullRequestGraphql,
    mechanism: GitHubFetchMechanism.Graphql,
    trigger: GitHubFetchTrigger.Backfill,
    credentialType:
      client.kind === GitHubCredentialKind.Installation
        ? GitHubFetchCredentialType.GitHubApp
        : GitHubFetchCredentialType.UserOAuth,
    ...(client.credentialOwnerId
      ? { credentialOwnerId: client.credentialOwnerId }
      : {}),
    observationKey: randomUUID(),
    observedAt: now.toISOString(),
  };
  const fetchResult = await queryBundledPullRequestsWithProviderResult(
    client.octokit,
    owner,
    repo,
    selfHealNumbers,
    {
      // Resume an in-progress backlog drain from the stored cursor; null starts
      // from the newest PR (steady state / a fresh sweep).
      after: input.cursor,
      targetNumbers: selfHealNumbers,
      maxItems: RECONCILE_MAX_ITEMS,
      maxPages: RECONCILE_MAX_PAGES,
    },
    (observation) => observations.push(observation),
    {
      mechanism: authorityProvenance.mechanism,
      trigger: authorityProvenance.trigger,
      credentialType: authorityProvenance.credentialType,
      ...(authorityProvenance.credentialOwnerId
        ? { credentialOwnerId: authorityProvenance.credentialOwnerId }
        : {}),
      observationKey: authorityProvenance.observationKey,
      observedAt: authorityProvenance.observedAt,
    }
  );

  await recordBudget(client, observations);

  if (fetchResult.status !== GitHubProviderResultStatus.Success) {
    // Settle each side effect independently so a transactional throw in the
    // PR-failure writer cannot block the access verdict or the failure stamp.
    try {
      await writeReconciledPullRequestFailures({
        organizationId: input.organizationId,
        repositoryId,
        repositoryFullName: input.repositoryFullName,
        pullRequestNumbers: selfHealNumbers,
        result: fetchResult,
        provenance: authorityProvenance,
      });
    } catch (error) {
      log.warn(`${RECONCILE_LOG_PREFIX} failed to write PR failure records`, {
        organizationId: input.organizationId,
        repositoryFullName: input.repositoryFullName,
        error: parseError(error),
      });
    }
    // ISS-5093: a repo-level denial is a property of this (credential, repo)
    // pair, not a transient outage, so teach the pool to stop re-drawing this
    // credential for this repo. Rate limits and provider outages fall through
    // untouched — they say nothing about reach.
    await recordNoAccessIfRepoDenied(client, fetchResult.status, input);
    // Transient/provider error (401/429 already handled inside the pool's
    // client hook). Back off; the cursor/watermark are preserved.
    await persistFailure(input, now);
    return outcome(input, ReconcileRepoStatus.Failed, {
      tier: tierFromClient(client),
    });
  }

  // The read reached the repo with this credential — record positive access so
  // the pool ranks a known-good token first next time (lazy discovery).
  await client.recordRepoAccess(GitHubSyncRepoAccessOutcome.Ok);

  // Draining a backlog (cursor was set) means these pages are OLDER than the
  // watermark on purpose — refresh every fetched row, not just fresh ones, so a
  // large first sweep of a tier-2 repo (the only refresh path — no webhooks)
  // fully catches up over successive ticks instead of stranding older PRs.
  const draining = input.cursor !== null;
  const written = await applyFetchedPullRequests(
    fetchResult.value.pullRequests,
    input.watermark,
    new Set(selfHealNumbers),
    draining,
    {
      organizationId: input.organizationId,
      repositoryId,
      repositoryFullName: input.repositoryFullName,
      credentialKind: client.kind,
      // Which user's token fetched this (tier-2) — null on the installation lane.
      credentialOwnerId: client.credentialOwnerId,
      now,
    }
  );

  const fetchedNumbers = new Set(
    fetchResult.value.pullRequests.map((pr) => pr.number)
  );
  await debounceSelfHealTargets(
    input.organizationId,
    repositoryId,
    input.repositoryFullName,
    // Only stamp targets we actually FETCHED this tick. `targetNumbers` is a
    // paging stop condition, not a fetch-by-number: a target beyond the bounded
    // window is never returned, so stamping it would falsely record an attempt
    // and delay its real refresh (performed by the backlog drain) by a full
    // debounce window.
    selfHealNumbers.filter((number) => fetchedNumbers.has(number)),
    now
  );

  // Continue the backlog drain only while there is more to drain AND we have not
  // reached already-processed territory. During a drain (cursor was set) the
  // pages are older-than-watermark on purpose, so keep going while truncated. In
  // steady state (cursor was null) a truncated top page just means the repo has
  // more than one page of PRs — NOT that there is fresh backlog — so only
  // continue if EVERY fetched PR is newer than the watermark (a genuine
  // >window burst of fresh activity). Without this guard a repo with more than
  // RECONCILE_MAX_ITEMS PRs re-drains its whole history on every steady-state
  // tick, because the truncate never stops at the watermark.
  const moreToDrain =
    fetchResult.value.truncated === true &&
    (draining ||
      pageEntirelyNewerThan(fetchResult.value.pullRequests, input.watermark));
  const nextCursor = moreToDrain
    ? (fetchResult.value.nextCursor ?? null)
    : null;
  const tier = tierFromClient(client);
  await persistState(input, {
    tier,
    watermark: maxDate(input.watermark, written.newestUpdatedAt),
    cursor: nextCursor,
    deferredReason: null,
    resetFailures: true,
    now,
  });

  return {
    repositoryFullName: input.repositoryFullName,
    status: ReconcileRepoStatus.Swept,
    tier,
    writtenCount: written.writtenCount,
    deferredReason: null,
  };
}

function tierFromClient(client: GitHubSyncClient): GitHubRepoSyncTier {
  return client.kind === GitHubCredentialKind.Installation
    ? GitHubRepoSyncTier.Installed
    : GitHubRepoSyncTier.UserToken;
}

async function handleDenial(
  input: ReconcileRepoInput,
  reason: GitHubAccessDenialReason,
  ctx: { owner: string; repo: string; now: Date }
): Promise<ReconcileRepoOutcome> {
  // Floored/backed-off pool → recover on its own. Preserve watermark + cursor,
  // mark the coverage stat, do NOT touch tier or the failure counter.
  if (reason === GitHubAccessDenialReason.BudgetDeferred) {
    await persistState(input, {
      deferredReason: GitHubRepoSyncDeferralReason.Budget,
      now: ctx.now,
    });
    return outcome(input, ReconcileRepoStatus.Deferred, {
      deferredReason: GitHubRepoSyncDeferralReason.Budget,
    });
  }
  // Transient provider outage → back off without reclassifying.
  if (
    reason === GitHubAccessDenialReason.RateLimited ||
    reason === GitHubAccessDenialReason.Unavailable
  ) {
    await persistFailure(input, ctx.now);
    return outcome(input, ReconcileRepoStatus.Failed, {});
  }
  // NotConnected / NoInstallation / InsufficientScope / Revoked / OrgRestricted
  // are all "no usable credential for this repo right now" — the ladder may have
  // changed under us. Re-classify (often to unsyncable) so the coverage stat is
  // honest and the repo stops being swept until a credential returns.
  const tier = await classifyRepoSyncTier({
    organizationId: input.organizationId,
    owner: ctx.owner,
    repo: ctx.repo,
    // Verdict expiry is evaluated against the tick's clock, not the wall clock,
    // so a reclassify decision is reproducible under a pinned clock.
    now: ctx.now,
  });
  await persistState(input, {
    tier,
    deferredReason: null,
    resetFailures: true,
    now: ctx.now,
  });
  return outcome(input, ReconcileRepoStatus.Reclassified, { tier });
}

async function recordBudget(
  client: GitHubSyncClient,
  observations: GitHubBundledPullRequestsObservation[]
): Promise<void> {
  // Feed EVERY page's observed cost back into the drawn token's pool state so
  // windowSpend accounts for a multi-page sweep, not just the last page.
  for (const observation of observations) {
    const { cost, remaining, resetAt } = observation.rateLimit;
    if (typeof cost === "number" && typeof remaining === "number") {
      await client.recordRateLimit({ cost, remaining, resetAt });
    }
  }
}

async function applyFetchedPullRequests(
  pullRequests: GitHubReadModelPullRequest[],
  watermark: Date | null,
  selfHealNumbers: Set<number>,
  draining: boolean,
  context: {
    organizationId: string;
    repositoryId: string | null;
    repositoryFullName: string;
    credentialKind: GitHubCredentialKind;
    credentialOwnerId: string | null;
    now: Date;
  }
): Promise<{ writtenCount: number; newestUpdatedAt: Date | null }> {
  let writtenCount = 0;
  let newestUpdatedAt: Date | null = null;
  for (const pullRequest of pullRequests) {
    const updatedAt = pullRequest.updatedAt
      ? new Date(pullRequest.updatedAt)
      : null;
    newestUpdatedAt = maxDate(newestUpdatedAt, updatedAt);
    // Write when draining a backlog (every fetched row), when the PR changed
    // since our watermark (the recency sweep), or when it is a terminal-missing-
    // LOC self-heal target (watermark-independent).
    const isFresh = !watermark || (updatedAt !== null && updatedAt > watermark);
    const isSelfHeal = selfHealNumbers.has(pullRequest.number);
    if (!(draining || isFresh || isSelfHeal)) {
      continue;
    }
    const wrote = await writeReconciledPullRequest(pullRequest, {
      organizationId: context.organizationId,
      repositoryId: context.repositoryId,
      repositoryFullName: context.repositoryFullName,
      credentialKind: context.credentialKind,
      credentialOwnerId: context.credentialOwnerId,
      now: context.now,
    });
    if (wrote) {
      writtenCount += 1;
    }
  }
  return { writtenCount, newestUpdatedAt };
}

async function resolveInstallationRepositoryId(
  organizationId: string,
  repositoryFullName: string
): Promise<string | null> {
  const row = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        installation: { organizationId },
        fullName: { equals: repositoryFullName, mode: "insensitive" },
        removedAt: null,
      },
      select: { id: true },
    })
  );
  return row?.id ?? null;
}

/**
 * Terminal (merged/closed) current rows missing any LOC field — the FEA-3373
 * one-shot self-heal, ported server-side. `lastRefreshAttemptAt` debounces so a
 * PR whose LOC the provider never returns does not re-sweep every tick.
 */
async function selectSelfHealTargets(
  organizationId: string,
  repositoryId: string | null,
  repositoryFullName: string,
  now: Date
): Promise<number[]> {
  const repoScope = repositoryId
    ? { repositoryId }
    : {
        repositoryId: null,
        repositoryFullName: normalizeRepoFullName(repositoryFullName),
      };
  const staleBefore = new Date(now.getTime() - RECONCILE_SELF_HEAL_DEBOUNCE_MS);
  const rows = await withDb((db) =>
    db.pullRequestDetail.findMany({
      where: {
        organizationId,
        isCurrent: true,
        ...repoScope,
        OR: [{ mergedAt: { not: null } }, { closedAt: { not: null } }],
        AND: [
          {
            OR: [
              { additions: null },
              { deletions: null },
              { changedFiles: null },
            ],
          },
          // Debounce: skip rows attempted within the window so a never-fillable
          // PR cannot re-occupy the batch every tick.
          {
            OR: [
              { lastRefreshAttemptAt: null },
              { lastRefreshAttemptAt: { lt: staleBefore } },
            ],
          },
        ],
      },
      select: { number: true },
      // `nulls: last` so brand-new-column NULL-watermark rows (old terminal PRs
      // deep in the provider's updated-at-desc list, which the bounded fetch never
      // returns and the debounce therefore never stamps) cannot monopolize the
      // batch every tick and starve the fetchable, watermarked missing-LOC rows.
      // The backlog drain fills the NULL rows over successive ticks.
      orderBy: { githubUpdatedAt: { sort: "desc", nulls: "last" } },
      take: RECONCILE_SELF_HEAL_BATCH,
    })
  );
  return rows.map((row) => row.number);
}

async function debounceSelfHealTargets(
  organizationId: string,
  repositoryId: string | null,
  repositoryFullName: string,
  numbers: number[],
  now: Date
): Promise<void> {
  if (numbers.length === 0) {
    return;
  }
  const repoScope = repositoryId
    ? { repositoryId }
    : {
        repositoryId: null,
        repositoryFullName: normalizeRepoFullName(repositoryFullName),
      };
  await withDb((db) =>
    db.pullRequestDetail.updateMany({
      where: { organizationId, ...repoScope, number: { in: numbers } },
      data: { lastRefreshAttemptAt: now },
    })
  );
}

type PersistStateUpdate = {
  tier?: GitHubRepoSyncTier;
  watermark?: Date | null;
  cursor?: string | null;
  deferredReason?: GitHubRepoSyncDeferralReason | null;
  resetFailures?: boolean;
  now: Date;
};

async function persistState(
  input: ReconcileRepoInput,
  update: PersistStateUpdate
): Promise<void> {
  // Prisma skips `undefined` fields, so an omitted watermark/tier preserves the
  // stored value (the reconciler owns those; a denial must not clobber them).
  await withDb((db) =>
    db.gitHubRepoSyncState.updateMany({
      where: {
        organizationId: input.organizationId,
        repositoryFullName: input.repositoryFullName,
      },
      data: {
        lastSweptAt: update.now,
        deferredReason: update.deferredReason ?? null,
        tier: update.tier,
        lastTierEvaluatedAt: update.tier === undefined ? undefined : update.now,
        watermark: update.watermark,
        // Undefined preserves an in-progress drain cursor (a denial must not
        // discard it); the swept path sets it to the continuation or null.
        cursor: update.cursor,
        consecutiveFailureCount: update.resetFailures ? 0 : undefined,
        nextRetryAt: update.resetFailures ? null : undefined,
      },
    })
  );
}

async function persistFailure(
  input: ReconcileRepoInput,
  now: Date
): Promise<void> {
  const newCount = input.consecutiveFailureCount + 1;
  await withDb((db) =>
    db.gitHubRepoSyncState.updateMany({
      where: {
        organizationId: input.organizationId,
        repositoryFullName: input.repositoryFullName,
        consecutiveFailureCount: input.consecutiveFailureCount,
      },
      data: {
        lastSweptAt: now,
        consecutiveFailureCount: newCount,
        nextRetryAt: computeNextRetryAt(newCount, now),
      },
    })
  );
}

/**
 * True when every fetched PR is strictly newer than the watermark (or there is
 * no watermark yet) — i.e. the page has not reached already-processed PRs, so a
 * truncated steady-state read may still have fresh PRs past the window. A PR
 * with no updatedAt counts as not-newer, conservatively stopping the drain.
 */
function pageEntirelyNewerThan(
  pullRequests: GitHubReadModelPullRequest[],
  watermark: Date | null
): boolean {
  if (watermark === null) {
    return true;
  }
  return pullRequests.every(
    (pr) => pr.updatedAt !== null && new Date(pr.updatedAt) > watermark
  );
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return a.getTime() >= b.getTime() ? a : b;
}

function outcome(
  input: ReconcileRepoInput,
  status: ReconcileRepoStatus,
  overrides: {
    tier?: GitHubRepoSyncTier;
    deferredReason?: GitHubRepoSyncDeferralReason | null;
  }
): ReconcileRepoOutcome {
  return {
    repositoryFullName: input.repositoryFullName,
    status,
    tier: overrides.tier,
    writtenCount: 0,
    deferredReason: overrides.deferredReason ?? null,
  };
}

/**
 * Record a no-access verdict when the read failed because this credential
 * cannot reach the repo (ISS-5093), so the pool stops re-drawing it and the
 * tier can eventually demote the repo instead of sweeping it forever.
 *
 * Best-effort by design. `recordRepoAccess` writes through the capability
 * store, which rethrows anything that is not a unique-constraint race, and the
 * caller must still `persistFailure` — losing a verdict costs one extra draw
 * next tick, while losing the failure persist would lose the backoff counter
 * entirely. Same reason the pool's own octokit hook swallows its bookkeeping
 * errors.
 *
 * No-op on the installation lane: `recordRepoAccess` is a no-op there because
 * installation reach is governed by the installation's repository list, not by
 * per-credential verdicts.
 */
async function recordNoAccessIfRepoDenied(
  client: GitHubSyncClient,
  status: GitHubProviderResultStatus,
  input: ReconcileRepoInput
): Promise<void> {
  // ONLY the two repo-scoped statuses. `ProviderPermissionFiltered` is
  // deliberately absent: the generic HTTP-403 fall-through produces it too, so
  // treating it as a repo denial would mint a 6h verdict against a healthy
  // credential on an org-level 403 (SAML, IP allowlist, OAuth App restriction)
  // or on a 403 from page 2 of a read whose page 1 already reached the repo.
  const denied =
    status === GitHubProviderResultStatus.ProviderRepoForbidden ||
    status === GitHubProviderResultStatus.ProviderRepoNotFound;
  if (!denied) {
    return;
  }
  try {
    await client.recordRepoAccess(GitHubSyncRepoAccessOutcome.NoAccess);
  } catch (error) {
    log.warn(`${RECONCILE_LOG_PREFIX} failed to record repo no-access`, {
      organizationId: input.organizationId,
      repositoryFullName: input.repositoryFullName,
      error: parseError(error),
    });
  }
}
