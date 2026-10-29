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
import { saveCapabilityVerdict } from "@/lib/github/github-capability-store";
import {
  type GitHubCapabilityRecord,
  normalizeGitHubName,
  storedGitHubCredentialKind,
} from "@/lib/github/github-connection-credential";
import {
  type GitHubUserCredential,
  resolveGitHubUserCredential,
} from "@/lib/github/github-user-credential";
import { acquireInstallationClient } from "@/lib/github/installation-client";

/**
 * PLN-1525 step 2: the GitHub credential resolver. One place answers "which
 * credential should this user use against this target, and what do we tell
 * them when none works." Returns a client, not a token, so target probing and
 * verdict caching stay centralized here.
 *
 * PLN-1742 M5 tail: the OAuth App token is fetched from CLERK at call time and
 * that is the ONLY user lane — there is no stored `GitHubUserConnection`
 * token left to fall through to, so a Clerk denial is the answer rather than a
 * reason to look elsewhere, and it reaches the caller in the wire vocabulary
 * (`unavailable` for a Clerk outage, not `not_connected`).
 *
 * A 401 is no longer observed here either. Revocation used to be a
 * compare-and-set on the stored cipher; Clerk's token is not ours to revoke,
 * so the marker moved to the credential lane, which retires the registry row
 * when Clerk reports the link is gone (`markClerkRegistryUnlinked`).
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
  const read = await resolveGitHubUserCredential({
    organizationId: input.organizationId,
    userId: input.userId,
    now,
    capabilityScope: {
      normalizedTargetOwner: normalizedOwner,
      normalizedTargetRepo: normalizedRepo,
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (!read.ok) {
    return Result.err({ reason: read.denial });
  }
  return await buildUserClient(read.credential, {
    input,
    options,
    now,
    normalizedOwner,
    normalizedRepo,
  });
}

type UserClientContext = {
  input: GetGitHubClientInput;
  options: GetGitHubClientOptions;
  now: Date;
  normalizedOwner: string;
  normalizedRepo: string | null;
};

async function buildUserClient(
  credential: GitHubUserCredential,
  context: UserClientContext
): Promise<DomainResult<GitHubClient, GitHubAccessError>> {
  const kind = storedGitHubCredentialKind(credential.scopes);
  const client: GitHubClient = {
    octokit: getUserTokenOctokit(credential.token, {
      fetch: context.options.fetch,
    }),
    kind,
    actingAs: {
      githubUserId: credential.githubUserId,
      login: credential.login,
    },
    rateLimitTier: credential.rateLimitTier,
  };
  const cached = readCachedVerdict(credential.capabilities, kind, context.now);
  if (cached === CapabilityCacheOutcome.Positive) {
    return Result.ok(client);
  }
  if (cached !== CapabilityCacheOutcome.Miss) {
    return Result.err({ reason: cached });
  }
  const probeContext: TargetProbeContext = {
    client,
    credential,
    input: context.input,
    normalizedOwner: context.normalizedOwner,
    normalizedRepo: context.normalizedRepo,
    now: context.now,
  };
  const probeIdentity =
    credential.connectionId ??
    `${credential.organizationId}:${credential.userId}`;
  return await singleFlightProbe(
    `${probeIdentity}:${context.normalizedOwner}:${context.normalizedRepo ?? ""}`,
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
  credential: GitHubUserCredential;
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
  // Verdict rows hang off a connection. A Clerk credential whose registry row
  // could not be established has nothing to hang one on, so it reprobes on
  // every resolution rather than caching against a row that is not its own.
  const connectionId = context.credential.connectionId;
  if (connectionId === null) {
    return;
  }
  try {
    await persistTargetVerdictThrowing(
      context,
      denialReason,
      ttlMs,
      connectionId
    );
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
  ttlMs: number,
  githubUserConnectionId: string
): Promise<void> {
  await withDb((db) =>
    saveCapabilityVerdict(db, {
      organizationId: context.input.organizationId,
      githubUserConnectionId,
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

function readCachedVerdict(
  capabilities: readonly GitHubCapabilityRecord[],
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
