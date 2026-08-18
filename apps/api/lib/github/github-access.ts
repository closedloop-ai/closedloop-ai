import {
  GitHubAccessDenialReason,
  type GitHubCredentialKind,
} from "@repo/api/src/types/github";
import {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
} from "@repo/github";
import { classifyGitHubProviderError } from "@repo/github/provider-error-classification";
import type { Octokit } from "@repo/github/user-token-auth";
import { z } from "zod";

/**
 * PLN-1525 resolver contract types. Backend-only by design: the client wraps
 * an Octokit, so these cannot live in `packages/api`. Routes translate
 * `GitHubAccessError.reason` (a shared contract const) for the frontend.
 */

/** Which credential should this caller use, expressed as an intent. */
export const GitHubAccessIntent = {
  ReadAsUser: "read-as-user",
  WriteAsUser: "write-as-user",
  Manage: "manage",
} as const;
export type GitHubAccessIntent =
  (typeof GitHubAccessIntent)[keyof typeof GitHubAccessIntent];

/**
 * Who a resolved client acts as. For user lanes this names the GitHub user —
 * required for the 401 → "reconnect prompt to that user" path; for the
 * installation lane it names the installation.
 */
export type GitHubActingAs =
  | { githubUserId: string; login: string }
  | { installationId: string };

/**
 * A resolved GitHub client. The resolver returns a client, not a token, so
 * the layer can observe responses centrally (401 → revoked) and account rate
 * limits in one place. `kind` is exposed deliberately: a credential fallback
 * can return less data for the same request, and callers/logs need to be
 * able to say so.
 */
export type GitHubClient = {
  octokit: Octokit;
  kind: GitHubCredentialKind;
  actingAs: GitHubActingAs;
  rateLimitTier: number | null;
};

/** Typed denial; the reason code maps 1:1 to remediation UX (PLN-1525). */
export type GitHubAccessError = {
  reason: GitHubAccessDenialReason;
  /** Present on `rate_limited` denials when GitHub supplied an ETA. */
  retryAfterSeconds?: number | null;
};

/**
 * TTLs for cached GitHub access-capability verdicts (PLN-1525). The negative
 * TTL is deliberately short: org approval of an OAuth App fires no webhook,
 * so TTL expiry and an explicit "Recheck access" control are the only
 * recovery paths from a cached denial. Backend cache policy — deliberately
 * NOT in `packages/api`, which excludes auth-policy internals.
 */
export const GitHubCapabilityTtlMs = {
  Positive: 15 * 60 * 1000,
  Negative: 5 * 60 * 1000,
} as const;
export type GitHubCapabilityTtlMs =
  (typeof GitHubCapabilityTtlMs)[keyof typeof GitHubCapabilityTtlMs];

/**
 * How long a sync-lane repo access discovery is trusted (PLN-1535 D9). Must
 * outlive several ~15m reconciler ticks or lazy discovery buys nothing.
 *
 * Lives beside the interactive TTLs above because the two lanes share one
 * `GitHubAccessCapability` row per (connection, owner, repo) and the SPREAD
 * between them is load-bearing: ISS-5093 uses `expiresAt - checkedAt >= this`
 * to tell a durable sync verdict from a 5-minute interactive denial, so the
 * repo-sync tier never demotes a repo on an interactive blip. Keeping both
 * numbers in one file is what makes that comparison reviewable.
 */
export const GITHUB_SYNC_REPO_VERDICT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Health of a pooled sync-lane credential (PLN-1525 v3 / PLN-1535 D9),
 * persisted on `GitHubUserConnection.healthState`:
 *
 * - `healthy` — qualifies for pool selection.
 * - `backoff` — temporarily excluded until `backoffUntil` (rate-limit or 5xx
 *   observed); re-qualifies automatically.
 * - `unhealthy` — 401 observed; excluded until the user reconnects, which
 *   resets pool state (`persistGitHubUserConnection`).
 *
 * Persistence-internal — mirrors a database column, so it lives with the
 * owning implementation rather than in `packages/api`.
 */
export const GitHubSyncHealthState = {
  Healthy: "healthy",
  Backoff: "backoff",
  Unhealthy: "unhealthy",
} as const;
export type GitHubSyncHealthState =
  (typeof GitHubSyncHealthState)[keyof typeof GitHubSyncHealthState];

const httpStatusErrorSchema = z.object({ status: z.number() });

/** Narrow an unknown thrown value (Octokit RequestError) to its HTTP status. */
export function extractGitHubHttpStatus(error: unknown): number | undefined {
  const parsed = httpStatusErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.status : undefined;
}

/**
 * Restate a failed installation-client acquisition in the denial taxonomy the
 * resolver lanes speak. The acquisition itself is classified once, by
 * `acquireInstallationClient`; this only translates vocabularies. Transient by
 * nature: rate limits carry their ETA; everything else is `unavailable`.
 */
export function mapInstallationAcquisitionFailure(
  failure: Exclude<
    GitHubProviderResult<unknown>,
    { status: typeof GitHubProviderResultStatus.Success }
  >
): GitHubAccessError {
  if (failure.status === GitHubProviderResultStatus.ProviderRateLimit) {
    return {
      reason: GitHubAccessDenialReason.RateLimited,
      retryAfterSeconds: failure.retryAfterSeconds,
    };
  }
  return { reason: GitHubAccessDenialReason.Unavailable };
}

/**
 * Classify a failed GitHub read as an access denial. Shared by the resolver's
 * target probe and by request-time failures on an already-resolved user client,
 * so the same provider error yields the same reason wherever it surfaces.
 *
 * `401` is `revoked`: every octokit the resolver hands out carries an error
 * hook that has already marked the connection revoked by the time this runs.
 * `403`/`404` collapse to `no_installation` — GitHub cloaks a no-access private
 * repo as a 404, so "gone" and "never visible to you" are indistinguishable
 * from here. Rate limits are classified first because GitHub also reports them
 * as `403`.
 */
export function mapGitHubReadFailureToDenial(
  error: unknown,
  nowMs: number
): GitHubAccessError {
  const status = extractGitHubHttpStatus(error);
  if (status === 401) {
    return { reason: GitHubAccessDenialReason.Revoked };
  }
  const classification = classifyGitHubProviderError(error, nowMs);
  if (classification.status === GitHubProviderResultStatus.ProviderRateLimit) {
    return {
      reason: GitHubAccessDenialReason.RateLimited,
      retryAfterSeconds: classification.retryAfterSeconds,
    };
  }
  if (status === 403 || status === 404) {
    return { reason: GitHubAccessDenialReason.NoInstallation };
  }
  return { reason: GitHubAccessDenialReason.Unavailable };
}
