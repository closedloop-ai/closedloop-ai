import { randomUUID } from "node:crypto";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { parseRepositoryFullName } from "@repo/api/src/types/branch-repository";
import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import type {
  GitHubBundledPullRequestsObservation,
  GitHubReadModelPullRequest,
  GitHubRepositoryDefaultObservationContext,
} from "@repo/api/src/types/github-read-model";
import {
  GitHubBundledPullRequestsStopReason,
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
  queryPullRequestsByNumberWithProviderResult,
} from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  RECONCILE_SELF_HEAL_BATCH,
  RECONCILE_SELF_HEAL_DEBOUNCE_MS,
} from "@/app/cron/reconcile-pull-requests/constants";
import {
  reconcileTargetedSessionLinkedPullRequests,
  TargetedReconcileStatus,
} from "@/app/cron/reconcile-pull-requests/targeted-reconciler";
import {
  classifyRepoSyncTier,
  GitHubRepoSyncDeferralReason,
  GitHubRepoSyncTier,
} from "@/lib/github/github-repo-sync-state";
import {
  BACKOFF_MAX_MS,
  computeNextRetryAt,
} from "@/lib/github/github-retry-backoff";
import {
  recordSyncClientNoAccessIfRepoDenied,
  recordSyncClientRateLimits,
} from "@/lib/github/github-sync-client-feedback";
import {
  type GetGitHubSyncClientOptions,
  type GitHubSyncClient,
  getGitHubSyncClient,
} from "@/lib/github/github-sync-client-pool";
import { GitHubSyncRepoAccessOutcome } from "@/lib/github/github-sync-pool-observations";
import { findInstallationRepositoryId } from "@/lib/github/installation-repository-lookup";
import { fetchCredentialTypeFromKind } from "@/lib/github-fetch-provenance";
import { reportGitHubDeliveryCoverageTick } from "./delivery-coverage-metrics";
import {
  resolveReconcileTargets,
  writeReconciledPullRequest,
  writeReconciledPullRequestFailures,
} from "./reconcile-projection-write";
import {
  ReconcileRepoStatus,
  type ReconcileRepoStatus as ReconcileRepoStatusType,
} from "./repo-reconcile-status";
import { selectCoverageGapPullRequestTargets } from "./session-linked-targets";
import { selectUnverifiedPullRequestTargets } from "./unverified-pull-request-targets";

/**
 * Bounded per-tick fetch — throughput comes from cron frequency, not depth.
 *
 * ISS-7891 moved these from 3×100 to 8×25 when the page size dropped: the page
 * count absorbs the smaller page so a tick still covers 200 PRs rather than
 * collapsing to 75. Both halves are load-bearing — raising pages without
 * shrinking the page would re-cross GitHub's execution budget, and shrinking
 * the page without raising pages would quarter the backlog drain.
 *
 * ISS-7892 made this a CEILING rather than a per-tick bill: the read now carries
 * the stored watermark as a paging stop, so a steady-state tick stops at the
 * first page that reaches already-processed PRs — one round trip when nothing
 * changed, more only as the changed set grows past a page. The full budget is
 * spent only while genuinely draining a backlog.
 */
export const RECONCILE_MAX_PAGES = 8;
export const RECONCILE_MAX_ITEMS = 200;

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

export type ReconcileRepoOutcome = {
  repositoryFullName: string;
  status: ReconcileRepoStatusType;
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
 * user-token pool → tier 2), feeds the observed rate-limit budget back into the
 * pool, writes the refreshed projection onto existing rows, and advances the
 * repo's sync-state. Never throws — every failure resolves to a persisted state
 * transition so the cron sweep is durable.
 *
 * TWO READS, and the split is the part worth knowing (ISS-7892):
 *
 * 1. The WINDOW read — `queryBundledPullRequestsWithProviderResult` with NO
 *    target numbers, watermark-ordered, resuming a backlog drain from the stored
 *    cursor. This is the only read that may advance the watermark.
 * 2. The SELF-HEAL read — `queryPullRequestsByNumberWithProviderResult` over the
 *    terminal-but-missing-LOC targets the window did not already return. It is
 *    watermark-INDEPENDENT and never advances the watermark, because a
 *    by-number row can sit arbitrarily far from the window's position and
 *    claiming the span between them would assert coverage nothing read.
 *
 * A target the window already returned is settled by the window's write and
 * dropped from read 2, so it is neither refetched nor counted twice. Read 2 is
 * skipped entirely when the window stopped short on purpose (BudgetLow or
 * ProviderRateLimit), leaving those targets unstamped for the next tick rather
 * than spending a credential the budget just protected.
 */
export async function reconcileRepo(
  input: ReconcileRepoInput,
  options: GetGitHubSyncClientOptions = {}
): Promise<ReconcileRepoOutcome> {
  const now = options.now ?? new Date();
  const identity = parseRepositoryFullName(input.repositoryFullName);
  if (!identity) {
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
    await reportGitHubDeliveryCoverageTick({
      ...input,
      repositoryId: null,
      status: ReconcileRepoStatus.Reclassified,
      tier: GitHubRepoSyncTier.Unsyncable,
      writtenCount: 0,
      deferredReason: null,
      fetchFailureCount: 0,
      targetFetchFailureWriteCount: 0,
      budgetDeferralCount: 0,
      now,
    });
    return outcome(input, ReconcileRepoStatus.Reclassified, {
      tier: GitHubRepoSyncTier.Unsyncable,
    });
  }
  const { owner, repo } = identity;

  const repositoryId = await findInstallationRepositoryId(
    input.organizationId,
    input.repositoryFullName
  );

  const clientResult = await getGitHubSyncClient(
    { organizationId: input.organizationId, target: { owner, repo } },
    options
  );
  if (!clientResult.ok) {
    return await handleDenial(input, clientResult.error.reason, {
      owner,
      repo,
      repositoryId,
      now,
    });
  }

  const client = clientResult.value;
  const observations: GitHubBundledPullRequestsObservation[] = [];
  const authorityProvenance: RepositoryDefaultProvenance = {
    source: RepositoryDefaultSource.PullRequestGraphql,
    mechanism: GitHubFetchMechanism.Graphql,
    trigger: GitHubFetchTrigger.Backfill,
    credentialType: fetchCredentialTypeFromKind(client.kind),
    ...(client.credentialOwnerId
      ? { credentialOwnerId: client.credentialOwnerId }
      : {}),
    observationKey: randomUUID(),
    observedAt: now.toISOString(),
  };
  const observationContext = {
    mechanism: authorityProvenance.mechanism,
    trigger: authorityProvenance.trigger,
    credentialType: authorityProvenance.credentialType,
    ...(authorityProvenance.credentialOwnerId
      ? { credentialOwnerId: authorityProvenance.credentialOwnerId }
      : {}),
    observationKey: authorityProvenance.observationKey,
    observedAt: authorityProvenance.observedAt,
  };

  const tier = tierFromClient(client);
  if (tier === GitHubRepoSyncTier.UserToken) {
    return await handleTargetedReconciliation(input, {
      authorityProvenance,
      client,
      now,
      owner,
      repo,
      repositoryId,
      tier,
    });
  }

  const selfHealNumbers = await selectSelfHealTargets(
    input.organizationId,
    repositoryId,
    input.repositoryFullName,
    now
  );
  // ISS-12034: the installed tier's second by-number arm. `selectSelfHealTargets`
  // above cannot reach a row the delivery-coverage numerator is missing — it
  // requires `is_current`, which that numerator already counts as covered — so
  // without this the two populations are disjoint and an uncovered row is
  // unreachable from here. The selector documents the whole argument.
  const coverageGapNumbers = (
    await selectCoverageGapPullRequestTargets({
      organizationId: input.organizationId,
      repositoryId,
      repositoryFullName: input.repositoryFullName,
      now,
    })
  ).map((target) => target.number);
  // ISS-12272: the third by-number arm, for OPEN rows no GitHub read has ever
  // reached. The selector documents why neither arm above nor the window can.
  const unverifiedNumbers = await selectUnverifiedPullRequestTargets({
    organizationId: input.organizationId,
    repositoryId,
    repositoryFullName: input.repositoryFullName,
    now,
  });
  // One by-number read serves every arm, so they are deduped into one list
  // before it: a row two arms select must be fetched, written and stamped once.
  const refreshNumbers = [
    ...new Set([
      ...selfHealNumbers,
      ...coverageGapNumbers,
      ...unverifiedNumbers,
    ]),
  ];
  const fetchResult = await queryBundledPullRequestsWithProviderResult(
    client.octokit,
    owner,
    repo,
    [],
    {
      // Resume an in-progress backlog drain from the stored cursor; null starts
      // from the newest PR (steady state / a fresh sweep).
      after: input.cursor,
      maxItems: RECONCILE_MAX_ITEMS,
      maxPages: RECONCILE_MAX_PAGES,
      // This lane never persists check state (`writeReconciledPullRequest` is
      // detail-only and `buildPullRequestDetailUpdate` has no checks field), so
      // the query's most expensive selection is pure cost here.
      includeStatusCheckRollup: false,
      // Only in steady state. A drain deliberately reads pages OLDER than the
      // watermark, so carrying it there would stop the drain on its first page.
      ...(input.cursor === null && input.watermark
        ? { stopAtUpdatedAt: input.watermark.toISOString() }
        : {}),
    },
    (observation) => observations.push(observation),
    observationContext
  );

  await recordSyncClientRateLimits(client, observations, {
    logPrefix: RECONCILE_LOG_PREFIX,
    organizationId: input.organizationId,
    repositoryFullName: input.repositoryFullName,
  });

  if (fetchResult.status !== GitHubProviderResultStatus.Success) {
    let targetFetchFailureWriteCount = 0;
    // Settle each side effect independently so a transactional throw in the
    // PR-failure writer cannot block the access verdict or the failure stamp.
    try {
      targetFetchFailureWriteCount = await writeReconciledPullRequestFailures({
        organizationId: input.organizationId,
        repositoryId,
        repositoryFullName: input.repositoryFullName,
        pullRequestNumbers: refreshNumbers,
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
    await recordSyncClientNoAccessIfRepoDenied(client, fetchResult.status, {
      logPrefix: RECONCILE_LOG_PREFIX,
      organizationId: input.organizationId,
      repositoryFullName: input.repositoryFullName,
    });
    // Transient/provider error (401/429 already handled inside the pool's
    // client hook). Back off; the cursor/watermark are preserved.
    await persistFailure(input, now, fetchResult.status);
    await reportGitHubDeliveryCoverageTick({
      ...input,
      repositoryId,
      status: ReconcileRepoStatus.Failed,
      tier: tierFromClient(client),
      writtenCount: 0,
      deferredReason: null,
      resultReason: fetchResult.status,
      fetchFailureCount: 1,
      targetFetchFailureWriteCount,
      budgetDeferralCount: 0,
      now,
    });
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
  const writeContext = {
    organizationId: input.organizationId,
    repositoryId,
    repositoryFullName: input.repositoryFullName,
    credentialKind: client.kind,
    // Which user's token fetched this (tier-2) — null on the installation lane.
    credentialOwnerId: client.credentialOwnerId,
    now,
  };
  // A by-number target the window ALREADY RETURNED is settled by this write.
  // Passing it here makes that write watermark-independent (the whole point of
  // every by-number arm), and dropping it from the by-number read below stops the same row
  // being fetched, rewritten, and counted a second time — the monotonic guard
  // admits an equal `githubUpdatedAt`, so the duplicate was silent (whitlockk
  // review).
  const windowNumbers = new Set(
    fetchResult.value.pullRequests.map((pullRequest) => pullRequest.number)
  );
  const refreshInWindow = refreshNumbers.filter((number) =>
    windowNumbers.has(number)
  );
  const refreshRemaining = refreshNumbers.filter(
    (number) => !windowNumbers.has(number)
  );

  const written = await applyFetchedPullRequests(
    fetchResult.value.pullRequests,
    input.watermark,
    new Set(refreshInWindow),
    draining,
    writeContext
  );

  // Stamp the ones the window resolved, so the debounce reflects every target
  // actually attempted this tick and not just the by-number half.
  await stampRefreshAttempts(
    input.organizationId,
    repositoryId,
    input.repositoryFullName,
    refreshInWindow,
    now
  );

  // A Success carrying BudgetLow or ProviderRateLimit means the window stopped
  // ON PURPOSE, short of its own limits. Starting a second read on the same
  // Octokit would spend a credential the budget just protected, or immediately
  // retry the request the provider rate-limited. Skip it and leave the targets
  // UNSTAMPED so the next tick retries them rather than debouncing an attempt
  // that never happened (whitlockk review).
  const stoppedShort =
    fetchResult.value.stopReason ===
      GitHubBundledPullRequestsStopReason.BudgetLow ||
    fetchResult.value.stopReason ===
      GitHubBundledPullRequestsStopReason.ProviderRateLimit;

  const refreshedByNumber = stoppedShort
    ? 0
    : await refreshTargetsByNumber(client, {
        owner,
        repo,
        numbers: refreshRemaining,
        input,
        repositoryId,
        provenance: authorityProvenance,
        observationContext,
        writeContext,
        now,
      });

  if (stoppedShort && refreshRemaining.length > 0) {
    log.info(
      `${RECONCILE_LOG_PREFIX} skipped by-number refresh; window stopped short`,
      {
        organizationId: input.organizationId,
        repositoryFullName: input.repositoryFullName,
        stopReason: fetchResult.value.stopReason,
        deferredTargets: refreshRemaining.length,
      }
    );
  }

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
  await persistState(input, {
    tier,
    // Window read ONLY. A by-number self-heal row can be arbitrarily far from
    // the window's position, so advancing the recency boundary from it would
    // claim coverage of PRs between the two that nothing has read.
    watermark: maxDate(input.watermark, written.newestUpdatedAt),
    cursor: nextCursor,
    deferredReason: null,
    resetFailures: true,
    now,
  });
  await reportGitHubDeliveryCoverageTick({
    ...input,
    repositoryId,
    status: ReconcileRepoStatus.Swept,
    tier,
    // ISS-12034: the by-number writes count too. This reported the window's
    // writes alone while the outcome below returned both, so a tick that wrote
    // only through `refreshTargetsByNumber` told the monitor `writtenCount: 0`
    // and could raise `actionableZeroWriteWithSessionLinkedTargets` on a tick
    // that had in fact written.
    writtenCount: written.writtenCount + refreshedByNumber,
    deferredReason: null,
    fetchFailureCount: 0,
    targetFetchFailureWriteCount: 0,
    budgetDeferralCount: 0,
    now,
  });

  return {
    repositoryFullName: input.repositoryFullName,
    status: ReconcileRepoStatus.Swept,
    tier,
    writtenCount: written.writtenCount + refreshedByNumber,
    deferredReason: null,
  };
}

function tierFromClient(client: GitHubSyncClient): GitHubRepoSyncTier {
  return client.kind === GitHubCredentialKind.Installation
    ? GitHubRepoSyncTier.Installed
    : GitHubRepoSyncTier.UserToken;
}

async function handleTargetedReconciliation(
  input: ReconcileRepoInput,
  context: {
    authorityProvenance: RepositoryDefaultProvenance;
    client: GitHubSyncClient;
    now: Date;
    owner: string;
    repo: string;
    repositoryId: string | null;
    tier: GitHubRepoSyncTier;
  }
): Promise<ReconcileRepoOutcome> {
  const targeted = await reconcileTargetedSessionLinkedPullRequests({
    organizationId: input.organizationId,
    repositoryId: context.repositoryId,
    repositoryFullName: input.repositoryFullName,
    owner: context.owner,
    repo: context.repo,
    client: context.client,
    provenance: context.authorityProvenance,
    now: context.now,
  });
  await recordSyncClientRateLimits(context.client, targeted.observations, {
    logPrefix: RECONCILE_LOG_PREFIX,
    organizationId: input.organizationId,
    repositoryFullName: input.repositoryFullName,
  });
  if (targeted.status === TargetedReconcileStatus.FetchFailed) {
    try {
      await writeReconciledPullRequestFailures({
        organizationId: input.organizationId,
        repositoryId: context.repositoryId,
        repositoryFullName: input.repositoryFullName,
        pullRequestNumbers: targeted.targetNumbers,
        result: targeted.result,
        provenance: context.authorityProvenance,
      });
    } catch (error) {
      log.warn(`${RECONCILE_LOG_PREFIX} failed to write PR failure records`, {
        organizationId: input.organizationId,
        repositoryFullName: input.repositoryFullName,
        error: parseError(error),
      });
    }
    await recordSyncClientNoAccessIfRepoDenied(
      context.client,
      targeted.result.status,
      {
        logPrefix: RECONCILE_LOG_PREFIX,
        organizationId: input.organizationId,
        repositoryFullName: input.repositoryFullName,
      }
    );
    await persistFailure(input, context.now, targeted.result.status);
    return outcome(input, ReconcileRepoStatus.Failed, { tier: context.tier });
  }
  if (targeted.providerRead) {
    await context.client.recordRepoAccess(GitHubSyncRepoAccessOutcome.Ok);
  }
  // Targeted reads are not repository-history sweeps; leave the watermark alone.
  // The old tier-2 backlog drain cursor is obsolete once targeted refresh owns
  // user-token repos, so a successful targeted pass clears any stale cursor.
  await persistState(input, {
    tier: context.tier,
    cursor: null,
    deferredReason: null,
    resetFailures: true,
    now: context.now,
  });
  return {
    repositoryFullName: input.repositoryFullName,
    status: ReconcileRepoStatus.Swept,
    tier: context.tier,
    writtenCount: targeted.writtenCount,
    deferredReason: null,
  };
}

async function handleDenial(
  input: ReconcileRepoInput,
  reason: GitHubAccessDenialReason,
  ctx: { owner: string; repo: string; repositoryId: string | null; now: Date }
): Promise<ReconcileRepoOutcome> {
  // Floored/backed-off pool → recover on its own. Preserve watermark + cursor,
  // mark the coverage stat, do NOT touch tier or the failure counter.
  if (reason === GitHubAccessDenialReason.BudgetDeferred) {
    await persistState(input, {
      deferredReason: GitHubRepoSyncDeferralReason.Budget,
      now: ctx.now,
    });
    await reportGitHubDeliveryCoverageTick({
      ...input,
      repositoryId: ctx.repositoryId,
      status: ReconcileRepoStatus.Deferred,
      tier: GitHubRepoSyncTier.UserToken,
      writtenCount: 0,
      deferredReason: GitHubRepoSyncDeferralReason.Budget,
      resultReason: reason,
      fetchFailureCount: 0,
      targetFetchFailureWriteCount: 0,
      budgetDeferralCount: 1,
      now: ctx.now,
    });
    return outcome(input, ReconcileRepoStatus.Deferred, {
      deferredReason: GitHubRepoSyncDeferralReason.Budget,
    });
  }
  // A concurrent sweep holds every pool connection (ISS-8270). The credential
  // is healthy by construction — a peer just drew it — so this defers exactly
  // like a budget floor: watermark, cursor, tier and the failure counter all
  // stand, and the next tick draws normally. Reclassifying here re-tiered every
  // repo but the one winner, on every tick, in any org with one connection.
  if (reason === GitHubAccessDenialReason.Contention) {
    await persistState(input, {
      deferredReason: GitHubRepoSyncDeferralReason.Contention,
      now: ctx.now,
    });
    await reportGitHubDeliveryCoverageTick({
      ...input,
      repositoryId: ctx.repositoryId,
      status: ReconcileRepoStatus.Deferred,
      tier: GitHubRepoSyncTier.UserToken,
      writtenCount: 0,
      deferredReason: GitHubRepoSyncDeferralReason.Contention,
      resultReason: reason,
      fetchFailureCount: 0,
      targetFetchFailureWriteCount: 0,
      budgetDeferralCount: 0,
      now: ctx.now,
    });
    return outcome(input, ReconcileRepoStatus.Deferred, {
      deferredReason: GitHubRepoSyncDeferralReason.Contention,
    });
  }
  // Transient provider outage → back off without reclassifying.
  if (
    reason === GitHubAccessDenialReason.RateLimited ||
    reason === GitHubAccessDenialReason.Unavailable
  ) {
    await persistFailure(input, ctx.now, reason);
    await reportGitHubDeliveryCoverageTick({
      ...input,
      repositoryId: ctx.repositoryId,
      status: ReconcileRepoStatus.Failed,
      writtenCount: 0,
      deferredReason: null,
      resultReason: reason,
      fetchFailureCount: 0,
      targetFetchFailureWriteCount: 0,
      budgetDeferralCount: 0,
      now: ctx.now,
    });
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
  await reportGitHubDeliveryCoverageTick({
    ...input,
    repositoryId: ctx.repositoryId,
    status: ReconcileRepoStatus.Reclassified,
    tier,
    writtenCount: 0,
    deferredReason: null,
    resultReason: reason,
    fetchFailureCount: 0,
    targetFetchFailureWriteCount: 0,
    budgetDeferralCount: 0,
    now: ctx.now,
  });
  return outcome(input, ReconcileRepoStatus.Reclassified, { tier });
}

async function applyFetchedPullRequests(
  pullRequests: GitHubReadModelPullRequest[],
  watermark: Date | null,
  forcedNumbers: Set<number>,
  draining: boolean,
  context: ReconcileWriteContext
): Promise<{ writtenCount: number; newestUpdatedAt: Date | null }> {
  let writtenCount = 0;
  let newestUpdatedAt: Date | null = null;
  const selected: GitHubReadModelPullRequest[] = [];
  for (const pullRequest of pullRequests) {
    const updatedAt = pullRequest.updatedAt
      ? new Date(pullRequest.updatedAt)
      : null;
    newestUpdatedAt = maxDate(newestUpdatedAt, updatedAt);
    // Write when draining a backlog (every fetched row), when the PR changed
    // since our watermark (the recency sweep), or when it is a by-number refresh
    // target — self-heal, ISS-12034 coverage gap or ISS-12272 unverified — which
    // is watermark-independent by design.
    const isFresh = !watermark || (updatedAt !== null && updatedAt > watermark);
    const isForced = forcedNumbers.has(pullRequest.number);
    if (draining || isFresh || isForced) {
      selected.push(pullRequest);
    }
  }
  // ISS-8919: resolve the page's identities in one read. Selection above touches
  // no database, so hoisting it changes only how many round trips the writes
  // below cost — a draining tick selects the whole RECONCILE_MAX_ITEMS page.
  const detailTargets = await resolveReconcileTargets(
    selected.map((pullRequest) => pullRequest.number),
    context
  );
  for (const pullRequest of selected) {
    const wrote = await writeReconciledPullRequest(pullRequest, {
      organizationId: context.organizationId,
      repositoryId: context.repositoryId,
      repositoryFullName: context.repositoryFullName,
      credentialKind: context.credentialKind,
      credentialOwnerId: context.credentialOwnerId,
      now: context.now,
      detailTargets,
    });
    if (wrote) {
      writtenCount += 1;
    }
  }
  return { writtenCount, newestUpdatedAt };
}

/**
 * Terminal (merged/closed) current rows missing any LOC field — the FEA-3373
 * one-shot self-heal, ported server-side. `lastRefreshAttemptAt` debounces so a
 * PR whose LOC the provider never returns does not re-sweep every tick.
 *
 * ISS-7892: these numbers now drive a by-number read rather than a paging stop
 * condition on the window read, so a target's depth in the repository's history
 * no longer decides whether it can be refreshed at all.
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

/**
 * Stamps the reconciler-owned attempt clock for every number a tick attempted
 * by name, which is what paces every by-number arm: the self-heal debounce
 * (`RECONCILE_SELF_HEAL_DEBOUNCE_MS`), and the ISS-12034 coverage-gap and
 * ISS-12272 unverified arms' own reads of the same column.
 */
async function stampRefreshAttempts(
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

/** The row identity plus the failure count a settlement is computed against. */
export type FailureSettlementTarget = {
  organizationId: string;
  repositoryFullName: string;
  consecutiveFailureCount: number;
};

/**
 * The reason a sweep failed, as the lane that failed already spells it — the
 * provider result status for a failed read, the denial reason for a transient
 * refusal, and {@link RECONCILE_UNEXPECTED_FAILURE_REASON} for the cron's
 * throw lane. Deliberately NOT a fourth vocabulary: a reason re-spelled here
 * would drift from the classifier that produced it, and the value in the log
 * has to be greppable against the code that emitted it.
 */
export type GitHubRepoSyncFailureReason =
  | Exclude<
      GitHubProviderResultStatus,
      typeof GitHubProviderResultStatus.Success
    >
  | GitHubAccessDenialReason
  | typeof RECONCILE_UNEXPECTED_FAILURE_REASON;

/**
 * The reason for a settlement whose cause escaped classification — the cron's
 * unexpected-throw lane, which logs the stack separately.
 */
export const RECONCILE_UNEXPECTED_FAILURE_REASON = "unexpected_error";

/**
 * The single owner of "this repo failed": bump consecutiveFailureCount, push
 * nextRetryAt out exponentially (ISS-5092) so the selector's backoff window
 * excludes the row until it is due again, and say why (ISS-7875).
 *
 * The log line is the only record a handled failure leaves. `reposFailed` in
 * the sweep summary is per-tick, so once a repo backs off past the selection
 * window it stops being counted and nothing anywhere states the cause — a repo
 * sat at eight failures on stage with no recoverable reason, and the diagnosis
 * had to proceed by elimination against the DB row. Bounded by construction:
 * the selector takes RECONCILE_REPO_BATCH rows, so a total outage costs one
 * line per selected repo, not per PR.
 *
 * `atBackoffCeiling` is derived from BACKOFF_MAX_MS rather than a hand-picked
 * failure count, so a monitor gets "this repo is as stuck as it can get"
 * without a magic number that silently stops meaning that when the backoff
 * curve changes.
 *
 * `stampSwept` is the only thing that varies. Handled failures inside
 * reconcileRepo stamp lastSweptAt because the repo genuinely had its turn; the
 * cron's unexpected-throw path (ISS-6589) deliberately does not, so a fault
 * cannot silently reorder the oldest-swept-first queue. Both share this write
 * so the two lanes cannot drift apart on the next change to what settling means.
 *
 * The count in the where clause is a compare-and-set against the value this
 * caller read, so a concurrent tick that has already moved the row past it is
 * not overwritten. It cannot distinguish "untouched" from "reset to the same
 * value by a concurrent success" — accepted, and unchanged from before ISS-6589.
 */
export async function persistFailureSettlement(
  target: FailureSettlementTarget,
  now: Date,
  options: { stampSwept: boolean; reason: GitHubRepoSyncFailureReason }
): Promise<void> {
  const newCount = target.consecutiveFailureCount + 1;
  const nextRetryAt = computeNextRetryAt(newCount, now);
  await withDb((db) =>
    db.gitHubRepoSyncState.updateMany({
      where: {
        organizationId: target.organizationId,
        repositoryFullName: target.repositoryFullName,
        consecutiveFailureCount: target.consecutiveFailureCount,
      },
      data: {
        lastSweptAt: options.stampSwept ? now : undefined,
        consecutiveFailureCount: newCount,
        nextRetryAt,
      },
    })
  );
  log.warn(`${RECONCILE_LOG_PREFIX} repo sweep failed`, {
    organizationId: target.organizationId,
    repositoryFullName: target.repositoryFullName,
    reason: options.reason,
    consecutiveFailureCount: newCount,
    nextRetryAt: nextRetryAt.toISOString(),
    atBackoffCeiling: nextRetryAt.getTime() - now.getTime() >= BACKOFF_MAX_MS,
  });
}

async function persistFailure(
  input: ReconcileRepoInput,
  now: Date,
  reason: GitHubRepoSyncFailureReason
): Promise<void> {
  await persistFailureSettlement(input, now, { stampSwept: true, reason });
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
  status: ReconcileRepoStatusType,
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

type ReconcileWriteContext = {
  organizationId: string;
  repositoryId: string | null;
  repositoryFullName: string;
  credentialKind: GitHubCredentialKind;
  credentialOwnerId: string | null;
  now: Date;
};

type ByNumberRefreshInput = {
  owner: string;
  repo: string;
  numbers: number[];
  input: ReconcileRepoInput;
  repositoryId: string | null;
  provenance: RepositoryDefaultProvenance;
  observationContext: GitHubRepositoryDefaultObservationContext;
  writeContext: ReconcileWriteContext;
  now: Date;
};

/**
 * ISS-7892: refresh the by-number batch in one round trip, instead of scanning
 * the updated-at window until the targets appear.
 *
 * ISS-12034 and ISS-12272 widened what rides here. The batch is now the union
 * of three arms — the terminal-but-missing-LOC self-heal, the session-linked
 * rows the delivery-coverage numerator does not count, and the OPEN rows no
 * GitHub read has reached — deduped by the caller. All want the same thing
 * from this function (a watermark-independent read of a specific number), so
 * none is distinguished below.
 *
 * Best-effort on purpose. The recency read — the sweep's actual job — has
 * already succeeded by the time this runs, so a failure here records its
 * observation onto the targets and leaves the repo swept rather than backing
 * the whole repo off for a backfill the next tick retries anyway.
 *
 * Every requested number is stamped on success, including one the provider
 * returned nothing for. That is now an honest record of an attempt: a
 * by-number request reaches a target wherever it sits, so an empty answer means
 * the PR is gone or invisible, not that the read never got far enough — which
 * is what let an unfillable row refill the batch on every tick.
 */
async function refreshTargetsByNumber(
  client: GitHubSyncClient,
  target: ByNumberRefreshInput
): Promise<number> {
  if (target.numbers.length === 0) {
    return 0;
  }
  const observations: GitHubBundledPullRequestsObservation[] = [];
  const result = await queryPullRequestsByNumberWithProviderResult(
    client.octokit,
    target.owner,
    target.repo,
    target.numbers,
    (observation) => observations.push(observation),
    target.observationContext
  );
  await recordSyncClientRateLimits(client, observations, {
    logPrefix: RECONCILE_LOG_PREFIX,
    organizationId: target.input.organizationId,
    repositoryFullName: target.input.repositoryFullName,
  });
  if (result.status !== GitHubProviderResultStatus.Success) {
    try {
      await writeReconciledPullRequestFailures({
        organizationId: target.input.organizationId,
        repositoryId: target.repositoryId,
        repositoryFullName: target.input.repositoryFullName,
        pullRequestNumbers: target.numbers,
        result,
        provenance: target.provenance,
      });
    } catch (error) {
      log.warn(`${RECONCILE_LOG_PREFIX} failed to write PR failure records`, {
        organizationId: target.input.organizationId,
        repositoryFullName: target.input.repositoryFullName,
        error: parseError(error),
      });
    }
    return 0;
  }
  const written = await applyFetchedPullRequests(
    result.value.pullRequests,
    target.input.watermark,
    new Set(target.numbers),
    false,
    target.writeContext
  );
  await stampRefreshAttempts(
    target.input.organizationId,
    target.repositoryId,
    target.input.repositoryFullName,
    target.numbers,
    target.now
  );
  return written.writtenCount;
}
