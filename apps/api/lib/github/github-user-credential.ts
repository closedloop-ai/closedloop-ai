import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { getUserTokenOctokit } from "@repo/github/user-token-auth";
import { resolveClerkGitHubCredential } from "@/lib/github/clerk-github-credential";
import {
  markClerkRegistryUnlinked,
  syncClerkRegistryConnection,
} from "@/lib/github/github-clerk-registry";
import type { GitHubCapabilityRecord } from "@/lib/github/github-connection-credential";
import type { OrganizationWriteOutcome } from "@/lib/organization-write-receipt";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/**
 * PLN-1742: the ONE acquisition of a usable GitHub user credential.
 *
 * Four modules used to read `access_token_encrypted` independently — the
 * interactive resolver, the comment-write identity adapter, the sync pool, and
 * the webhook sync lane — each with its own revocation, expiry and scope
 * policy. M2 put them on one path; the M5 tail removed the stored half, so
 * Clerk is now the ONLY user-credential source and a Clerk denial is the
 * answer rather than a reason to look elsewhere.
 *
 * That makes the denial vocabulary the wire one: a Clerk outage surfaces as
 * `unavailable` instead of being flattened into `not_connected` by a stored
 * lookup that was never going to find anything.
 */

export type GitHubUserCredential = {
  /**
   * The registry row this credential belongs to, or null when the registry
   * write could not be confirmed. Capability verdicts hang off it, so a null
   * one means "do not cache a verdict", never "cache it somewhere else".
   */
  connectionId: string | null;
  organizationId: string;
  userId: string;
  githubUserId: string;
  login: string;
  scopes: string[];
  rateLimitTier: number | null;
  token: string;
  /** Populated only when `capabilityScope` was requested; otherwise empty. */
  capabilities: GitHubCapabilityRecord[];
};

export type GitHubUserCredentialResult =
  | { ok: true; credential: GitHubUserCredential }
  | { ok: false; denial: GitHubAccessDenialReason };

export type GitHubUserIdentityResult =
  | { ok: true; identity: { githubUserId: string; login: string } }
  | { ok: false; denial: GitHubAccessDenialReason };

export type GitHubUserTokenResult =
  | { ok: true; token: string }
  | { ok: false; denial: GitHubAccessDenialReason };

export type ResolveGitHubUserCredentialInput = {
  organizationId: string;
  userId: string;
  now: Date;
  capabilityScope?: {
    normalizedTargetOwner: string;
    normalizedTargetRepo: string | null;
  };
  /** Test seam: transport for the registry's first-write `GET /user`. */
  fetch?: typeof fetch;
};

export async function resolveGitHubUserCredential(
  input: ResolveGitHubUserCredentialInput
): Promise<GitHubUserCredentialResult> {
  const clerk = await resolveClerkGitHubCredential({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  if (!clerk.ok) {
    return { ok: false, denial: await recordClerkDenial(input, clerk.reason) };
  }
  const registry = await syncClerkRegistryConnection({
    organizationId: input.organizationId,
    userId: input.userId,
    scopes: clerk.credential.scopes,
    octokit: getUserTokenOctokit(clerk.credential.token, {
      fetch: input.fetch,
    }),
    now: input.now,
    ...(input.capabilityScope
      ? { capabilityScope: input.capabilityScope }
      : {}),
  });
  if (!registry) {
    // Clerk served a token but GitHub would not confirm whose it is. That is
    // an unreachable identity, not a missing link — saying `not_connected`
    // here would send a linked user to connect an account they already have.
    return { ok: false, denial: GitHubAccessDenialReason.Unavailable };
  }
  return {
    ok: true,
    credential: {
      connectionId: registry.connection?.connectionId ?? null,
      organizationId: input.organizationId,
      userId: input.userId,
      githubUserId: registry.githubUserId,
      login: registry.login,
      scopes: clerk.credential.scopes,
      rateLimitTier: registry.connection?.rateLimitTier ?? null,
      token: clerk.credential.token,
      capabilities: registry.connection?.capabilities ?? [],
    },
  };
}

/**
 * Token acquisition ALONE, for a lane that already holds its own registry row
 * and its own selection policy — the sync pool, whose draw and budget
 * accounting are unchanged by where the bytes come from.
 *
 * The denial travels with the miss rather than collapsing to a bare null: the
 * pool's exhaustion reason is what the reconcile cron branches on, and a Clerk
 * outage answered as `not_connected` would re-tier every repo in the org
 * instead of backing off.
 */
export async function acquireGitHubUserToken(input: {
  organizationId: string;
  userId: string;
  now: Date;
}): Promise<GitHubUserTokenResult> {
  const clerk = await resolveClerkGitHubCredential({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  if (!clerk.ok) {
    return { ok: false, denial: await recordClerkDenial(input, clerk.reason) };
  }
  return { ok: true, token: clerk.credential.token };
}

/**
 * The same credential DECISION as `resolveGitHubUserCredential`, answered
 * without materializing the token: no `lastUsedAt` sample beyond the
 * registry's own.
 *
 * A caller that only needs to know which GitHub account the user holds (the
 * Clerk link flow in `clerk-link-service.ts`) uses this. Its answer must agree
 * with what a write would actually do: a "connect GitHub" answer while the
 * credential path resolves fine misstates the user's state. But it must not
 * spend the credential to say so.
 */
export async function resolveGitHubUserIdentity(input: {
  organizationId: string;
  userId: string;
  now: Date;
  /**
   * ISS-12552: runs on the registry row's create, refresh or unlink-marker
   * transaction, after the Clerk and GitHub reads. Only the Clerk link route
   * passes it.
   */
  recordRegistryWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>;
}): Promise<GitHubUserIdentityResult> {
  const clerk = await resolveClerkGitHubCredential({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  if (!clerk.ok) {
    return { ok: false, denial: await recordClerkDenial(input, clerk.reason) };
  }
  const registry = await syncClerkRegistryConnection({
    organizationId: input.organizationId,
    userId: input.userId,
    scopes: clerk.credential.scopes,
    octokit: getUserTokenOctokit(clerk.credential.token),
    now: input.now,
    ...(input.recordRegistryWrite
      ? { recordWrite: input.recordRegistryWrite }
      : {}),
  });
  if (!registry) {
    return { ok: false, denial: GitHubAccessDenialReason.Unavailable };
  }
  return {
    ok: true,
    identity: { githubUserId: registry.githubUserId, login: registry.login },
  };
}

/**
 * Persist what a Clerk denial means for the registry row, then hand the reason
 * back unchanged.
 *
 * `not_connected` is the one denial that is a statement about the LINK rather
 * than about this attempt: Clerk has no GitHub external account for the user,
 * so the row it left behind is stale and every surface reading it — the
 * integration status card, insights provenance, the sync pool — must stop
 * claiming a working connection. `insufficient_scope` and `unavailable` are
 * deliberately excluded: a narrow grant is still a grant, and an outage is not
 * evidence of anything.
 */
async function recordClerkDenial(
  input: {
    organizationId: string;
    userId: string;
    now: Date;
    recordRegistryWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>;
  },
  denial: GitHubAccessDenialReason
): Promise<GitHubAccessDenialReason> {
  if (denial === GitHubAccessDenialReason.NotConnected) {
    await markClerkRegistryUnlinked({
      organizationId: input.organizationId,
      userId: input.userId,
      now: input.now,
      ...(input.recordRegistryWrite
        ? { recordWrite: input.recordRegistryWrite }
        : {}),
    });
  }
  return denial;
}
