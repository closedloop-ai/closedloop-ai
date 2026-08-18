import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import {
  type Result as DomainResult,
  Result,
} from "@repo/api/src/types/result";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import { getUserTokenOctokit } from "@repo/github/user-token-auth";
import { log } from "@repo/observability/log";
import { z } from "zod";
import {
  extractGitHubHttpStatus,
  type GitHubAccessError,
  GitHubAccessIntent,
  GitHubCapabilityTtlMs,
  type GitHubClient,
  mapGitHubReadFailureToDenial,
  mapInstallationAcquisitionFailure,
} from "@/lib/github/github-access";
import {
  markGitHubConnectionRevoked,
  saveCapabilityVerdict,
} from "@/lib/github/github-capability-store";
import {
  GITHUB_REPO_SCOPE,
  type GitHubConnectionCredential,
  GitHubConnectionCredentialDenial,
  normalizeGitHubName,
  resolveGitHubUserConnectionCredential,
  storedGitHubCredentialKind,
} from "@/lib/github/github-connection-credential";
import { acquireInstallationClient } from "@/lib/github/installation-client";

/**
 * PLN-1525 step 2: the GitHub credential resolver. One place answers "which
 * credential should this user use against this target, and what do we tell
 * them when none works." Returns a client, not a token, so this layer
 * observes responses (401 → revoked in one transaction) centrally.
 *
 * v1 credential sources: the stored `GitHubUserConnection` token, which is
 * either a GitHub App user-to-server token (the connect flow) or a
 * Clerk-bridged OAuth App token (PLN-1368 backfill) — distinguished by the
 * stored scopes (App tokens report none). Fetching the OAuth App token from
 * Clerk at call time becomes the primary source once the Clerk GitHub
 * connection carries `repo read:org` (gated on the PRD-562 rule-5
 * amendment); it slots in as an additional source ahead of the stored token
 * without changing this contract.
 */

export type GetGitHubClientInput = {
  organizationId: string;
  /** Ignored for `manage` — that lane acts as the org's installation. */
  userId: string;
  target: { owner: string; repo?: string };
  intent: GitHubAccessIntent;
};

export type GetGitHubClientOptions = {
  /** Pin the clock in tests. */
  now?: Date;
  /** Test seam: transport override for every octokit this resolver builds. */
  fetch?: typeof fetch;
};

export async function getGitHubClient(
  input: GetGitHubClientInput,
  options: GetGitHubClientOptions = {}
): Promise<DomainResult<GitHubClient, GitHubAccessError>> {
  if (input.intent === GitHubAccessIntent.Manage) {
    return await resolveInstallationClient(input);
  }
  return await resolveUserClient(input, options);
}

const RESOLVER_LOG_PREFIX = "[github/client-resolver]";

const denialReasonSchema = z.enum(GitHubAccessDenialReason);

/** Internal cache-read outcomes that are not denial reasons. */
const CapabilityCacheOutcome = {
  Miss: "cache_miss",
  Positive: "cache_positive",
} as const;
type CapabilityCacheOutcome =
  (typeof CapabilityCacheOutcome)[keyof typeof CapabilityCacheOutcome];

/**
 * Single-flight registry for target probes: a cold cache on a 20-row branch
 * list must not fire 20 concurrent probes (PLN-1525 pool-protection rule 4).
 * Keyed per (connection, owner, repo) so distinct repos never share a
 * probe's verdict. Process-local and therefore best-effort on serverless;
 * bounded because entries are deleted as soon as the probe settles.
 */
const inflightTargetProbes = new Map<
  string,
  Promise<DomainResult<GitHubClient, GitHubAccessError>>
>();

async function resolveUserClient(
  input: GetGitHubClientInput,
  options: GetGitHubClientOptions
): Promise<DomainResult<GitHubClient, GitHubAccessError>> {
  const now = options.now ?? new Date();
  const normalizedOwner = normalizeGitHubName(input.target.owner);
  const normalizedRepo = input.target.repo
    ? normalizeGitHubName(input.target.repo)
    : null;
  const read = await withDb((db) =>
    resolveGitHubUserConnectionCredential(db, {
      organizationId: input.organizationId,
      userId: input.userId,
      now,
      capabilityScope: {
        normalizedTargetOwner: normalizedOwner,
        normalizedTargetRepo: normalizedRepo,
      },
    })
  );
  if (!read.ok) {
    return Result.err({ reason: mapConnectionDenial(read.denial, input) });
  }
  const credential = read.credential;
  const kind = storedGitHubCredentialKind(credential.scopes);
  if (
    kind === GitHubCredentialKind.OauthUser &&
    !credential.scopes.includes(GITHUB_REPO_SCOPE)
  ) {
    return Result.err({
      reason: GitHubAccessDenialReason.InsufficientScope,
    });
  }
  const client: GitHubClient = {
    octokit: buildObservedUserOctokit(credential, options),
    kind,
    actingAs: {
      githubUserId: credential.githubUserId,
      login: credential.login,
    },
    rateLimitTier: credential.rateLimitTier,
  };
  const cached = readCachedVerdict(credential.capabilities, kind, now);
  if (cached === CapabilityCacheOutcome.Positive) {
    return Result.ok(client);
  }
  if (cached !== CapabilityCacheOutcome.Miss) {
    return Result.err({ reason: cached });
  }
  const probeContext: TargetProbeContext = {
    client,
    credential,
    input,
    normalizedOwner,
    normalizedRepo,
    now,
  };
  return await singleFlightProbe(
    `${credential.connectionId}:${normalizedOwner}:${normalizedRepo ?? ""}`,
    () => probeAndCacheTargetCapability(probeContext)
  );
}

async function resolveInstallationClient(
  input: GetGitHubClientInput
): Promise<DomainResult<GitHubClient, GitHubAccessError>> {
  const normalizedOwner = normalizeGitHubName(input.target.owner);
  const installation = await withDb((db) =>
    db.gitHubInstallation.findUnique({
      where: { organizationId: input.organizationId },
      select: { installationId: true, accountLogin: true, status: true },
    })
  );
  const usable =
    installation &&
    installation.status === GitHubInstallationStatus.ACTIVE &&
    normalizeGitHubName(installation.accountLogin) === normalizedOwner;
  if (!usable) {
    return Result.err({ reason: GitHubAccessDenialReason.NoInstallation });
  }
  const acquired = await acquireInstallationClient(installation.installationId);
  if (acquired.status !== GitHubProviderResultStatus.Success) {
    return Result.err(mapInstallationAcquisitionFailure(acquired));
  }
  return Result.ok({
    octokit: acquired.value,
    kind: GitHubCredentialKind.Installation,
    actingAs: { installationId: installation.installationId },
    rateLimitTier: null,
  });
}

type TargetProbeContext = {
  client: GitHubClient;
  credential: GitHubConnectionCredential;
  input: GetGitHubClientInput;
  normalizedOwner: string;
  /** null for owner-only targets; verdicts persist at this granularity. */
  normalizedRepo: string | null;
  now: Date;
};

async function probeAndCacheTargetCapability(
  context: TargetProbeContext
): Promise<DomainResult<GitHubClient, GitHubAccessError>> {
  try {
    await runTargetProbe(context.client, context.input.target);
  } catch (error) {
    return await mapTargetProbeFailure(context, error);
  }
  await persistTargetVerdictBestEffort(
    context,
    null,
    GitHubCapabilityTtlMs.Positive
  );
  return Result.ok(context.client);
}

/**
 * Verdict persistence is best-effort: the probe already produced the
 * authoritative answer, and a cache-write hiccup must not turn a usable
 * client (or a definitive denial) into a 500 — read paths fail open.
 */
async function persistTargetVerdictBestEffort(
  context: TargetProbeContext,
  denialReason: GitHubAccessDenialReason | null,
  ttlMs: number
): Promise<void> {
  try {
    await persistTargetVerdictThrowing(context, denialReason, ttlMs);
  } catch {
    log.warn(`${RESOLVER_LOG_PREFIX} failed to persist capability verdict`, {
      organizationId: context.input.organizationId,
      userId: context.input.userId,
      targetOwner: context.input.target.owner,
      targetRepo: context.input.target.repo ?? null,
    });
  }
}

async function runTargetProbe(
  client: GitHubClient,
  target: GetGitHubClientInput["target"]
): Promise<void> {
  if (target.repo) {
    await client.octokit.rest.repos.get({
      owner: target.owner,
      repo: target.repo,
    });
    return;
  }
  // Owner-only callers (no repo in hand) get a weaker liveness/visibility
  // probe; reach denials for listing surfaces come from the list call
  // itself. Repo-bearing targets — every step-3 call path — probe reach
  // precisely above.
  await client.octokit.rest.users.getByUsername({ username: target.owner });
}

async function mapTargetProbeFailure(
  context: TargetProbeContext,
  error: unknown
): Promise<DomainResult<GitHubClient, GitHubAccessError>> {
  // Shared with the request-time read path so one provider error cannot map to
  // two different reasons depending on where it was observed. Only the caching
  // and logging below are probe-specific; `revoked` (already handled by the
  // octokit error hook) and `rate_limited` are transient and never cached.
  const denial = mapGitHubReadFailureToDenial(error, context.now.getTime());
  if (denial.reason === GitHubAccessDenialReason.NoInstallation) {
    // GitHub App user tokens are immune to OAuth App restrictions, so an
    // unreachable target means the App is not installed there (404 is
    // GitHub's private-repo cloak for no-access). `org_restricted` becomes
    // distinguishable once the OAuth App (Clerk) source lands.
    await persistTargetVerdictBestEffort(
      context,
      GitHubAccessDenialReason.NoInstallation,
      GitHubCapabilityTtlMs.Negative
    );
  }
  if (denial.reason === GitHubAccessDenialReason.Unavailable) {
    log.warn(`${RESOLVER_LOG_PREFIX} target probe failed`, {
      organizationId: context.input.organizationId,
      userId: context.input.userId,
      targetOwner: context.input.target.owner,
      status: extractGitHubHttpStatus(error),
    });
  }
  return Result.err(denial);
}

async function persistTargetVerdictThrowing(
  context: TargetProbeContext,
  denialReason: GitHubAccessDenialReason | null,
  ttlMs: number
): Promise<void> {
  await withDb((db) =>
    saveCapabilityVerdict(db, {
      organizationId: context.input.organizationId,
      githubUserConnectionId: context.credential.connectionId,
      targetOwner: context.input.target.owner,
      normalizedTargetOwner: context.normalizedOwner,
      // Verdict granularity matches probe granularity: a repos.get probe
      // persists a repo-level row; only the owner-only liveness probe may
      // write the owner-level row. One repo's denial must never mask a
      // reachable sibling under the same owner (selected-repo installs).
      targetRepo: context.normalizedRepo,
      credentialKind: context.client.kind,
      denialReason,
      installationId: null,
      checkedAt: context.now,
      expiresAt: new Date(context.now.getTime() + ttlMs),
    })
  );
}

async function singleFlightProbe(
  key: string,
  run: () => Promise<DomainResult<GitHubClient, GitHubAccessError>>
): Promise<DomainResult<GitHubClient, GitHubAccessError>> {
  const existing = inflightTargetProbes.get(key);
  if (existing) {
    return await existing;
  }
  const probe = run().finally(() => inflightTargetProbes.delete(key));
  inflightTargetProbes.set(key, probe);
  return await probe;
}

/**
 * Wire the 401 observer into every octokit this resolver hands out: a
 * revoked token is marked on the connection and its capability rows dropped
 * in one transaction the moment any call through the client sees a 401.
 */
function buildObservedUserOctokit(
  credential: GitHubConnectionCredential,
  options: GetGitHubClientOptions
): GitHubClient["octokit"] {
  const octokit = getUserTokenOctokit(credential.token, {
    fetch: options.fetch,
  });
  octokit.hook.error("request", async (error) => {
    if (extractGitHubHttpStatus(error) === 401) {
      try {
        await markGitHubConnectionRevoked({
          organizationId: credential.organizationId,
          githubUserConnectionId: credential.connectionId,
          accessTokenEncrypted: credential.accessTokenEncrypted,
          now: new Date(),
        });
      } catch {
        // Never mask the provider 401 with a bookkeeping failure; the next
        // 401 retries the revocation.
        log.warn(`${RESOLVER_LOG_PREFIX} failed to record revocation`, {
          organizationId: credential.organizationId,
        });
      }
    }
    throw error;
  });
  return octokit;
}

function readCachedVerdict(
  capabilities: GitHubConnectionCredential["capabilities"],
  resolvedKind: GitHubCredentialKind,
  now: Date
): CapabilityCacheOutcome | GitHubAccessDenialReason {
  const row = capabilities[0];
  if (!row) {
    return CapabilityCacheOutcome.Miss;
  }
  // The query already bounds rows to the 15m positive window via checkedAt;
  // negatives expire at the shorter TTL regardless of the row's expiresAt
  // (the sync lane writes 6h expiries into shared repo-level rows).
  if (
    row.denialReason !== null &&
    now.getTime() - row.checkedAt.getTime() >= GitHubCapabilityTtlMs.Negative
  ) {
    return CapabilityCacheOutcome.Miss;
  }
  // A reconnect can overwrite the stored scopes (persistGitHubUserConnection)
  // and flip the derived credential family without touching capability rows.
  // A verdict earned by the other family says nothing about this one — e.g.
  // an OAuth-restriction denial does not bind an App user token — so a
  // kind-mismatched row is a miss and the reprobe overwrites it.
  if (row.credentialKind !== resolvedKind) {
    return CapabilityCacheOutcome.Miss;
  }
  if (row.denialReason === null) {
    return CapabilityCacheOutcome.Positive;
  }
  const parsed = denialReasonSchema.safeParse(row.denialReason);
  // An unknown stored reason means a newer writer cached a code this build
  // does not know — treat as a miss and reprobe rather than fail.
  return parsed.success ? parsed.data : CapabilityCacheOutcome.Miss;
}

function mapConnectionDenial(
  denial: GitHubConnectionCredentialDenial,
  input: GetGitHubClientInput
): GitHubAccessDenialReason {
  if (denial === GitHubConnectionCredentialDenial.NotConnected) {
    return GitHubAccessDenialReason.NotConnected;
  }
  if (denial === GitHubConnectionCredentialDenial.DecryptionFailed) {
    log.warn(`${RESOLVER_LOG_PREFIX} failed to decrypt stored GitHub token`, {
      organizationId: input.organizationId,
      userId: input.userId,
    });
  }
  // Revoked, expired, and undecryptable tokens share one remedy: reconnect.
  return GitHubAccessDenialReason.Revoked;
}
