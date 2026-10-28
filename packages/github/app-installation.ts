import "server-only";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { boundedFetch } from "./bounded-fetch";
import { extractGitHubErrorStatus } from "./error-status";
import { keys } from "./keys";

/**
 * App-JWT installation lookup (PLN-1742 M5).
 *
 * The installation-claim flow verifies a callback's `installation_id` against
 * GitHub through the App's own credential (`GET /app/installations/{id}`),
 * replacing the retired OAuth-token `GET /user/installations` check: without
 * a code exchange there is no user token to ask with, and a Clerk-sourced
 * OAuth App token cannot list THIS GitHub App's installations. CSRF state on
 * the callback plus the claim-ownership validation carry the anti-forgery
 * protection.
 */

export const GitHubAppInstallationLookupStatus = {
  Found: "found",
  NotFound: "not_found",
  /** The installation exists but has no user/org account we can claim. */
  Unsupported: "unsupported",
  Error: "error",
} as const;
export type GitHubAppInstallationLookupStatus =
  (typeof GitHubAppInstallationLookupStatus)[keyof typeof GitHubAppInstallationLookupStatus];

export type GitHubAppInstallation = {
  id: number;
  account: { id: number; login: string; type: string };
  permissions: Record<string, unknown>;
  events: string[];
  repositorySelection: string | null;
};

export type GitHubAppInstallationLookup =
  | {
      status: typeof GitHubAppInstallationLookupStatus.Found;
      installation: GitHubAppInstallation;
    }
  | {
      status: Exclude<
        GitHubAppInstallationLookupStatus,
        typeof GitHubAppInstallationLookupStatus.Found
      >;
    };

/**
 * Wire-boundary schema for the fields we persist. `account` is
 * `SimpleUser | Enterprise | null` upstream, so it is parsed permissively
 * here and narrowed below: an Enterprise account (no `login`/`type`) is an
 * ordinary unclaimable installation and must map to `Unsupported`, NOT to
 * the `Error` status this schema's failure branch reserves for a GitHub
 * wire-format regression. The claim flow only supports user/org
 * installations, exactly like the retired OAuth path.
 */
const appInstallationSchema = z.object({
  id: z.number().int().positive(),
  account: z.record(z.string(), z.unknown()).nullable(),
  permissions: z.record(z.string(), z.unknown()).optional(),
  events: z.array(z.string()).optional(),
  repository_selection: z.string().optional(),
});

/** The `SimpleUser` subset a claim needs; an Enterprise account has none of it. */
const claimableAccountSchema = z.object({
  id: z.number(),
  login: z.string().min(1),
  type: z.string().min(1),
});

type FetchAppInstallation = (installationId: number) => Promise<unknown>;

export async function getAppInstallation(
  installationId: string,
  deps: { fetchInstallation?: FetchAppInstallation } = {}
): Promise<GitHubAppInstallationLookup> {
  const numericId = Number.parseInt(installationId, 10);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    log.warn("[github/app] Non-numeric installation id in lookup", {
      installationId,
    });
    return { status: GitHubAppInstallationLookupStatus.NotFound };
  }
  const fetchInstallation =
    deps.fetchInstallation ?? fetchAppInstallationFromGitHub;
  let data: unknown;
  try {
    data = await fetchInstallation(numericId);
  } catch (error) {
    if (extractGitHubErrorStatus(error) === 404) {
      return { status: GitHubAppInstallationLookupStatus.NotFound };
    }
    log.error("[github/app] Failed to fetch installation", {
      installationId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return { status: GitHubAppInstallationLookupStatus.Error };
  }
  const parsed = appInstallationSchema.safeParse(data);
  if (!parsed.success) {
    // A schema-parse failure is a wire-format regression, not an ordinary
    // unclaimable installation — keep it loud and distinguishable.
    log.error("[github/app] Installation payload failed schema parse", {
      installationId,
      issues: parsed.error.issues,
    });
    return { status: GitHubAppInstallationLookupStatus.Error };
  }
  const account = parsed.data.account
    ? claimableAccountSchema.safeParse(parsed.data.account)
    : null;
  if (!account?.success) {
    log.warn("[github/app] Installation has no claimable account", {
      installationId,
      // An Enterprise account is the expected shape here; anything else is
      // worth seeing without raising the wire-regression error above.
      accountKeys: parsed.data.account ? Object.keys(parsed.data.account) : [],
    });
    return { status: GitHubAppInstallationLookupStatus.Unsupported };
  }
  return {
    status: GitHubAppInstallationLookupStatus.Found,
    installation: {
      id: parsed.data.id,
      account: account.data,
      permissions: parsed.data.permissions ?? {},
      events: parsed.data.events ?? [],
      repositorySelection: parsed.data.repository_selection ?? null,
    },
  };
}

async function fetchAppInstallationFromGitHub(
  installationId: number
): Promise<unknown> {
  const config = keys();
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.GITHUB_APP_ID,
      privateKey: config.GITHUB_APP_PRIVATE_KEY,
    },
    // Same discipline as installation-auth.ts: never an unbounded GitHub call.
    request: { fetch: boundedFetch },
  });
  const { data } = await appOctokit.apps.getInstallation({
    installation_id: installationId,
  });
  return data;
}
