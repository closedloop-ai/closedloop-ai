import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { clerkClient } from "@repo/auth/server";
import { withDb } from "@repo/database";
import { GITHUB_REQUEST_TIMEOUT_MS } from "@repo/github/bounded-fetch";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";

/**
 * PLN-1742 M1: Clerk as the GitHub credential STORE. Clerk already holds the
 * OAuth App token minted when a user links GitHub, so this module fetches it
 * at call time instead of reading our own encrypted copy — the seam the
 * resolver's docstring reserved. The token is never persisted here; the
 * `GitHubUserConnection` row survives only as a token-less registry
 * (`github-clerk-registry.ts`).
 */

export type ClerkGitHubCredential = {
  token: string;
  /** Mirrored verbatim from Clerk; the registry copy is derived from this. */
  scopes: string[];
  externalAccountId: string;
};

export type ClerkGitHubCredentialResult =
  | { ok: true; credential: ClerkGitHubCredential }
  | { ok: false; reason: GitHubAccessDenialReason };

export type ResolveClerkGitHubCredentialInput = {
  organizationId: string;
  /** Internal user UUID. The Clerk id is resolved from it. */
  userId: string;
};

const CLERK_CREDENTIAL_LOG_PREFIX = "[github/clerk-credential]";
const GITHUB_OAUTH_PROVIDER = "github";
const clerkHttpStatusSchema = z.object({ status: z.number() });

/**
 * Single-flight registry, keyed per (organization, user). A 20-row branch list
 * resolves a credential per row; without this each row fires its own Clerk
 * round-trip. Mirrors `inflightTargetProbes` in the resolver: process-local
 * and therefore best-effort on serverless, and bounded because an entry is
 * deleted as soon as its fetch settles. Deliberately NOT a TTL cache — an
 * OAuth token held in module memory past the request that needed it buys
 * little and widens the blast radius of a process compromise.
 */
const inflightClerkCredentials = new Map<
  string,
  Promise<ClerkGitHubCredentialResult>
>();

/**
 * Fetch the caller's GitHub OAuth token from Clerk and hold it to the same
 * scope floor the stored OAuth-family credential answers to.
 *
 * Every failure lands in the shared denial vocabulary so a Clerk-sourced
 * denial is indistinguishable to callers from a stored-credential one:
 * no linked GitHub account (or no Clerk identity for this user) is
 * `not_connected`, a grant without `repo` is `insufficient_scope`, and any
 * Clerk transport failure or timeout is `unavailable` — never a throw. The
 * `not_connected`/`unavailable` split is load-bearing now that there is no
 * stored token to fall through to: callers back off on the second and treat
 * only the first as evidence the link itself is gone.
 */
export async function resolveClerkGitHubCredential(
  input: ResolveClerkGitHubCredentialInput
): Promise<ClerkGitHubCredentialResult> {
  const key = `${input.organizationId}:${input.userId}`;
  const existing = inflightClerkCredentials.get(key);
  if (existing) {
    return await existing;
  }
  const inflight = fetchClerkGitHubCredential(input).finally(() =>
    inflightClerkCredentials.delete(key)
  );
  inflightClerkCredentials.set(key, inflight);
  return await inflight;
}

async function fetchClerkGitHubCredential(
  input: ResolveClerkGitHubCredentialInput
): Promise<ClerkGitHubCredentialResult> {
  const clerkUserId = await readClerkUserId(input);
  if (!clerkUserId) {
    return { ok: false, reason: GitHubAccessDenialReason.NotConnected };
  }
  let tokens: readonly {
    token: string;
    scopes?: string[] | undefined;
    externalAccountId: string;
  }[];
  try {
    tokens = await withClerkTimeout(readClerkOauthTokens(clerkUserId));
  } catch (error) {
    log.warn(`${CLERK_CREDENTIAL_LOG_PREFIX} Clerk token fetch failed`, {
      organizationId: input.organizationId,
      userId: input.userId,
      status: extractClerkHttpStatus(error),
    });
    return { ok: false, reason: mapClerkFetchFailure(error) };
  }
  const first = tokens[0];
  if (!first) {
    return { ok: false, reason: GitHubAccessDenialReason.NotConnected };
  }
  const scopes = first.scopes ?? [];
  if (!scopes.includes(GITHUB_REPO_SCOPE)) {
    return { ok: false, reason: GitHubAccessDenialReason.InsufficientScope };
  }
  return {
    ok: true,
    credential: {
      token: first.token,
      scopes: [...scopes],
      externalAccountId: first.externalAccountId,
    },
  };
}

async function readClerkOauthTokens(clerkUserId: string) {
  const client = await clerkClient();
  const response = await client.users.getUserOauthAccessToken(
    clerkUserId,
    GITHUB_OAUTH_PROVIDER
  );
  return response.data;
}

/**
 * The internal user UUID the resolver lanes speak is not Clerk's id, and
 * neither the sync pool nor the webhook-driven sync path carries an
 * `AuthContext` to thread it from — so it is read from the user row, which is
 * the one identity source every lane already has.
 */
async function readClerkUserId(
  input: ResolveClerkGitHubCredentialInput
): Promise<string | null> {
  const user = await withDb((db) =>
    db.user.findUnique({
      where: { id: input.userId, organizationId: input.organizationId },
      select: { clerkId: true },
    })
  );
  return user?.clerkId ?? null;
}

/**
 * Bound the Clerk round-trip with the same ceiling every GitHub call answers
 * to. Clerk's backend SDK exposes no per-request signal, so the timeout is
 * applied by race rather than by abort: the in-flight request is not
 * cancelled, but the caller stops waiting on it and falls back.
 */
function withClerkTimeout<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new ClerkCredentialTimeoutError()),
        GITHUB_REQUEST_TIMEOUT_MS
      ).unref?.();
    }),
  ]);
}

function mapClerkFetchFailure(error: unknown): GitHubAccessDenialReason {
  // A 404 is Clerk saying this user has no GitHub external account, which is
  // the same condition as an empty token list — not an outage.
  return extractClerkHttpStatus(error) === 404
    ? GitHubAccessDenialReason.NotConnected
    : GitHubAccessDenialReason.Unavailable;
}

function extractClerkHttpStatus(error: unknown): number | undefined {
  const parsed = clerkHttpStatusSchema.safeParse(error);
  return parsed.success ? parsed.data.status : undefined;
}

class ClerkCredentialTimeoutError extends Error {
  constructor() {
    super(`Clerk token fetch exceeded ${GITHUB_REQUEST_TIMEOUT_MS}ms`);
    this.name = "ClerkCredentialTimeoutError";
  }
}
