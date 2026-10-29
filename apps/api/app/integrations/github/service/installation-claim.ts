import { GitHubConnectErrorCode } from "@repo/api/src/types/github-clerk-link";
import type { GitHubInstallation, Prisma } from "@repo/database";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import {
  type GitHubAppInstallation,
  GitHubAppInstallationLookupStatus,
  getAppInstallation,
} from "@repo/github/app-installation";
import { extractGitHubErrorStatus } from "@repo/github/error-status";
import { getUserTokenOctokit } from "@repo/github/user-token-auth";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { resolveClerkGitHubCredential } from "@/lib/github/clerk-github-credential";
import { reconcileOrgRepoSyncStatesBestEffort } from "@/lib/github/github-repo-sync-state";
import { persistIncompleteInstallationRepositoryObservation } from "./incomplete-repository-observation";
import { fetchInstallationRepositories } from "./installation-repositories-fetch";
import {
  emitRepositoryArtifactRelinkFailedMetric,
  RepositoryArtifactRelinkFailureReason,
  RepositoryArtifactRelinkFailureStage,
} from "./repository-relink-telemetry";
import {
  bulkUpsertInstallationRepositories,
  type RepositoryInput,
  tombstoneRepositoriesAbsentFrom,
} from "./repository-sync";

/**
 * GitHub App installation claiming (PLN-1742 M5).
 *
 * Claiming used to ride on the OAuth callback: the exchanged user token both
 * proved installation access (`GET /user/installations`) and seeded the
 * stored-credential row. With the in-house OAuth client retired, the claim
 * stands alone: the installation is verified through the App's own JWT
 * (`@repo/github/app-installation`), CSRF state on the web callback plus
 * `validateInstallationClaim` carry the anti-forgery protection, and user
 * credentials come exclusively from Clerk linking — this flow persists no
 * token and no `GitHubUserConnection` row.
 *
 * The PLN-634 reconnect machinery moved here WITH the claim (it was never
 * OAuth-specific): same-account reinstalls reuse the prior row in place, and
 * different-account reinstalls still require the confirm-reset step — the
 * `@unique(organizationId)` slot makes an unconfirmed swap impossible anyway.
 */

export type InstallationClaimResult =
  | { status: "connected" }
  | { status: "error"; error: string; code?: GitHubConnectErrorCode }
  | {
      status: "requires_confirmation";
      priorAccount: { accountId: string; accountLogin: string };
      newAccount: { accountId: string; accountLogin: string };
      newInstallationId: string;
    };

const CLAIM_LOG_PREFIX = "[github/claim]";

/**
 * Outcome of the org-membership read behind the claim access proof. The
 * unavailable case is deliberately its own value: folding a GitHub outage
 * into "refused" reports an infrastructure failure as a fact about the
 * caller's permissions.
 */
const OrgMembershipReadStatus = {
  Confirmed: "confirmed",
  Refused: "refused",
  Unavailable: "unavailable",
} as const;
type OrgMembershipReadStatus =
  (typeof OrgMembershipReadStatus)[keyof typeof OrgMembershipReadStatus];

export type OrgMembershipRead =
  | {
      status: typeof OrgMembershipReadStatus.Confirmed;
      state: string;
      role: string;
    }
  | {
      status: Exclude<
        OrgMembershipReadStatus,
        typeof OrgMembershipReadStatus.Confirmed
      >;
    };

type ClaimAccessRefusal = { error: string; code?: GitHubConnectErrorCode };

const LOOKUP_FAILURE_ERRORS = {
  [GitHubAppInstallationLookupStatus.NotFound]:
    "GitHub installation not found. Please install the GitHub App first.",
  [GitHubAppInstallationLookupStatus.Unsupported]:
    "This GitHub installation has no user or organization account to connect.",
  [GitHubAppInstallationLookupStatus.Error]:
    "Failed to verify the GitHub installation",
} as const;

/**
 * Collaborators injected by `githubService.claimGitHubInstallation` — the
 * concern module must not import the composition root back (apps/api
 * AGENTS.md), so the two service methods it needs arrive as deps. The
 * optional members are test seams with production defaults.
 */
export type ClaimGitHubInstallationDeps = {
  findInstallationByInstallationId: (
    installationId: string
  ) => Promise<GitHubInstallation | null>;
  syncRepositories: (
    installationRecordId: string,
    repositories: RepositoryInput[]
  ) => Promise<unknown>;
  /** Test seam: the app-JWT installation lookup (realdb tests inject it). */
  getInstallation?: typeof getAppInstallation;
  /** Test seams for the per-caller ownership proof. */
  resolveClerkCredential?: typeof resolveClerkGitHubCredential;
  fetchAuthenticatedGitHubUser?: (
    token: string
  ) => Promise<{ id: number } | null>;
  fetchOrgMembershipState?: (
    token: string,
    org: string
  ) => Promise<OrgMembershipRead>;
};

export async function claimGitHubInstallation(
  input: {
    installationId: string;
    organizationId: string;
    userId: string;
  },
  deps: ClaimGitHubInstallationDeps
): Promise<InstallationClaimResult> {
  const getInstallation = deps.getInstallation ?? getAppInstallation;
  try {
    const lookup = await getInstallation(input.installationId);
    if (lookup.status !== GitHubAppInstallationLookupStatus.Found) {
      log.warn(`${CLAIM_LOG_PREFIX} Installation lookup failed`, {
        installationId: input.installationId,
        lookupStatus: lookup.status,
        organizationId: input.organizationId,
      });
      return { status: "error", error: LOOKUP_FAILURE_ERRORS[lookup.status] };
    }
    const resolved = lookup.installation;

    // cr-66737 (BLOCKING): installation ids are enumerable integers and a
    // PENDING_CLAIM row is org-less, so without a per-caller binding any
    // authenticated org could claim any freshly installed app and sync the
    // victim's private repositories. The retired OAuth flow proved access
    // via GET /user/installations with the caller's own token; this is its
    // replacement, and it must run before the reconnect detection so the
    // different-account pin cannot be planted either.
    const accessError = await verifyClaimerInstallationAccess(
      input,
      resolved,
      deps
    );
    if (accessError) {
      log.warn(`${CLAIM_LOG_PREFIX} Caller failed installation access proof`, {
        installationId: input.installationId,
        organizationId: input.organizationId,
        userId: input.userId,
        accountLogin: resolved.account.login,
      });
      return {
        status: "error",
        error: accessError.error,
        ...(accessError.code ? { code: accessError.code } : {}),
      };
    }

    // PLN-634: detect same-vs-different-account reconnect for orgs that
    // previously disconnected. `accountId` is the only stable identifier
    // across reinstalls (installationId churns; accountLogin is renameable).
    const reconnectResult = await tryReconnectExistingInstallation({
      organizationId: input.organizationId,
      userId: input.userId,
      resolved,
    });
    if (reconnectResult) {
      return reconnectResult;
    }

    // Find the installation record, or create it if the webhook hasn't
    // arrived yet (the callback can beat `installation.created`).
    let installation = await deps.findInstallationByInstallationId(
      String(resolved.id)
    );
    if (!installation) {
      installation = await createInstallationRecordFromLookup(resolved, deps);
    }

    // Security check: block the claim if the installation is already owned
    // by a different org.
    const claimError = validateInstallationClaim(
      installation,
      input.organizationId
    );
    if (claimError) {
      log.warn(
        `${CLAIM_LOG_PREFIX} Attempted to claim installation already owned by another org`,
        {
          installationId: input.installationId,
          existingOrgId: installation.organizationId,
          attemptedOrgId: input.organizationId,
          userId: input.userId,
        }
      );
      return { status: "error", error: claimError };
    }

    // Guarded single-statement claim: the ownership predicate re-checks
    // inside the write so a concurrent claim by another org loses cleanly.
    const claimed = await withDb((db) =>
      db.gitHubInstallation.updateMany({
        where: {
          id: installation.id,
          OR: [
            { organizationId: null },
            { organizationId: input.organizationId },
          ],
        },
        data: {
          status: GitHubInstallationStatus.ACTIVE,
          organizationId: input.organizationId,
          claimedAt: new Date(),
          claimedByUserId: input.userId,
        },
      })
    );
    if (claimed.count !== 1) {
      log.warn(
        `${CLAIM_LOG_PREFIX} Installation ownership changed before claim completed`,
        {
          installationId: input.installationId,
          attemptedOrgId: input.organizationId,
          userId: input.userId,
        }
      );
      return {
        status: "error",
        error:
          "This GitHub installation is already connected to another organization",
      };
    }

    const repositoriesResult = await fetchInstallationRepositories(resolved.id);
    if (repositoriesResult.ok) {
      if (repositoriesResult.repositories.length > 0) {
        await deps.syncRepositories(
          installation.id,
          repositoriesResult.repositories
        );
      }
      // PLN-1535 M1: installation coverage just changed — re-evaluate this
      // org's per-repo sync tiers off the response path. Best-effort: a
      // failed reclassify self-heals on the next tick.
      waitUntil(reconcileOrgRepoSyncStatesBestEffort(input.organizationId));
    } else {
      await persistIncompleteInstallationRepositoryObservation(
        installation.id,
        repositoriesResult.repositories,
        repositoriesResult.unavailable
      );
      emitRepositoryArtifactRelinkFailedMetric(
        RepositoryArtifactRelinkFailureStage.OAuthClaim,
        repositoriesResult.error
      );
    }

    log.info(`${CLAIM_LOG_PREFIX} Successfully connected GitHub installation`, {
      installationId: resolved.id,
      organizationId: input.organizationId,
      userId: input.userId,
    });
    return { status: "connected" };
  } catch (error) {
    log.error(`${CLAIM_LOG_PREFIX} Failed to claim GitHub installation`, {
      installationId: input.installationId,
      organizationId: input.organizationId,
      userId: input.userId,
      error: parseError(error),
    });
    return { status: "error", error: "Failed to complete GitHub connection" };
  }
}

/**
 * Check if an installation can be claimed by the given organization.
 * Returns an error message if claim is blocked, null if allowed.
 *
 * Ownership rules:
 *  - unclaimed (organizationId === null) → claim allowed
 *  - same-org (organizationId === targetOrgId) → claim allowed regardless of
 *    status. Covers idempotent re-claim of an ACTIVE row and re-claim of an
 *    UNINSTALLED row whose org link is preserved across disconnect for the
 *    same-account reconnect path (see disconnectInstallation).
 *  - different-org (organizationId set and ≠ targetOrgId) → claim blocked.
 *    Prevents hijacking when a GitHub admin suspends an installation but the
 *    org link remains, and prevents a fresh installation row from being
 *    claimed for the wrong tenant.
 */
export function validateInstallationClaim(
  installation: { organizationId: string | null; status: string },
  targetOrgId: string
): string | null {
  if (
    installation.organizationId &&
    installation.organizationId !== targetOrgId
  ) {
    return "This GitHub installation is already connected to another organization";
  }
  return null;
}

/**
 * Detect and execute the same-account reconnect path, or surface a
 * pending-confirmation payload for the different-account path (PLN-634).
 * Returns `null` when no prior UNINSTALLED row exists for this org so the
 * caller falls through to the regular claim flow.
 */
async function tryReconnectExistingInstallation(input: {
  organizationId: string;
  userId: string;
  resolved: GitHubAppInstallation;
}): Promise<InstallationClaimResult | null> {
  const priorUninstalled = await withDb((db) =>
    db.gitHubInstallation.findFirst({
      where: {
        organizationId: input.organizationId,
        status: GitHubInstallationStatus.UNINSTALLED,
      },
      select: { id: true, accountId: true, accountLogin: true },
    })
  );
  if (!priorUninstalled) {
    return null;
  }

  const newAccountId = String(input.resolved.account.id);
  const newInstallationId = String(input.resolved.id);
  const sameAccount = priorUninstalled.accountId === newAccountId;
  if (!sameAccount) {
    // Pin the candidate installation server-side so confirm-reset can't be
    // tricked into claiming an attacker-supplied installationId. A fresh
    // claim attempt simply overwrites the pinned value.
    await withDb((db) =>
      db.gitHubInstallation.update({
        where: { id: priorUninstalled.id },
        data: { pendingNewInstallationId: newInstallationId },
        select: { id: true },
      })
    );
    log.info(`${CLAIM_LOG_PREFIX} Detected different-account reconnect`, {
      organizationId: input.organizationId,
      priorAccountId: priorUninstalled.accountId,
      newAccountId,
    });
    return {
      status: "requires_confirmation",
      priorAccount: {
        accountId: priorUninstalled.accountId,
        accountLogin: priorUninstalled.accountLogin,
      },
      newAccount: {
        accountId: newAccountId,
        accountLogin: input.resolved.account.login,
      },
      newInstallationId,
    };
  }

  const repositoriesResult = await fetchInstallationRepositories(
    input.resolved.id
  );
  if (!repositoriesResult.ok) {
    // Fail closed, including on a PARTIAL walk, and deliberately unlike the
    // sibling claim path which connects anyway. `reconnectByAccount`
    // reconciles by tombstoning every existing repository absent from this
    // list, so reconciling against a truncated list would mark live
    // repositories removed and break the BranchDetail/PullRequestDetail
    // references this same-account reconnect (PLN-634) exists to preserve.
    // Refusing costs the user a retry; proceeding costs them their history.
    await persistIncompleteInstallationRepositoryObservation(
      priorUninstalled.id,
      repositoriesResult.repositories,
      repositoriesResult.unavailable
    );
    emitRepositoryArtifactRelinkFailedMetric(
      RepositoryArtifactRelinkFailureStage.OAuthReconnect,
      repositoriesResult.error
    );
    return {
      status: "error",
      error:
        repositoriesResult.error ===
        RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial
          ? "GitHub returned an incomplete repository list. Please try reconnecting."
          : "Failed to fetch repositories from GitHub",
    };
  }
  await reconnectByAccount({
    priorInstallationId: priorUninstalled.id,
    resolved: input.resolved,
    organizationId: input.organizationId,
    userId: input.userId,
    repositories: repositoriesResult.repositories,
  });
  return { status: "connected" };
}

/**
 * Same-account reconnect path (PLN-634).
 *
 * Reuses the prior UNINSTALLED installation row in place so all dependent
 * UUIDs (TeamRepository, BranchDetail.repositoryId, PullRequestDetail.
 * repositoryId, GitHubInstallationRepository) are preserved across the
 * disconnect/reinstall window.
 *
 * Steps inside a single transaction:
 *  1. Drop a freshly-created row (if any) carrying the new GitHub
 *     installationId — typically created by the `installation.created`
 *     webhook between disconnect and the claim callback. This frees the
 *     `installationId @unique` slot before step 2.
 *  2. Update the prior row's `installationId` to the new GitHub install ID,
 *     flip status to ACTIVE, refresh GitHub-side fields.
 *  3. Reconcile repositories by `githubRepoId` (chunked set-based upsert,
 *     then tombstone rows absent from the new install — never delete,
 *     BranchDetail / PullRequestDetail rows may still reference them).
 *
 * Unlike the retired OAuth path this persists NO user connection — Clerk
 * linking owns user credentials (PLN-1742).
 */
async function reconnectByAccount(input: {
  priorInstallationId: string;
  resolved: GitHubAppInstallation;
  organizationId: string;
  userId: string;
  repositories: RepositoryInput[];
}): Promise<void> {
  const newGithubInstallationId = String(input.resolved.id);
  await withDb.tx(async (tx) => {
    // Only drop a fresh PENDING_CLAIM row created by the webhook race. The
    // `organizationId: null` + `status: PENDING_CLAIM` filter guarantees we
    // never delete a row that some other tenant has already claimed or that
    // is in any state other than the transient PENDING_CLAIM the webhook
    // creates. If a sibling row exists in a different state the subsequent
    // update will fail on the `installationId @unique` constraint, surfacing
    // the conflict rather than silently corrupting another org's installation.
    await tx.gitHubInstallation.deleteMany({
      where: {
        installationId: newGithubInstallationId,
        id: { not: input.priorInstallationId },
        organizationId: null,
        status: GitHubInstallationStatus.PENDING_CLAIM,
      },
    });

    await tx.gitHubInstallation.update({
      where: { id: input.priorInstallationId },
      data: {
        installationId: newGithubInstallationId,
        status: GitHubInstallationStatus.ACTIVE,
        claimedAt: new Date(),
        claimedByUserId: input.userId,
        accountLogin: input.resolved.account.login,
        accountType: input.resolved.account.type,
        ...installerSenderFields(input.resolved),
        // Json-column boundary: the wire shape was validated by Zod in
        // @repo/github/app-installation; Prisma's InputJsonValue cannot be
        // expressed structurally from Record<string, unknown>.
        permissions: input.resolved.permissions as Prisma.InputJsonValue,
        events: input.resolved.events,
        repositorySelection: input.resolved.repositorySelection,
        // Any prior different-account confirmation is moot now.
        pendingNewInstallationId: null,
      },
      select: { id: true },
    });

    const incomingByRepoId = new Set(
      input.repositories.map((repo) => repo.githubRepoId)
    );

    // ISS-4619: reconcile the full repo list through the shared chunked,
    // set-based upsert (service/repository-sync.ts) instead of one `upsert`
    // per repo — a large org's reconnect can carry thousands of repos, and a
    // serialized round trip each blew past Prisma's 5s interactive-tx
    // timeout (P2028), rolling the whole reconnect back.
    await bulkUpsertInstallationRepositories(
      tx,
      input.priorInstallationId,
      input.repositories
    );

    // ISS-4618: the absent-repository sweep goes through the shared chunked
    // helper. The inline `updateMany({ id: { in: [...] } })` this replaced
    // bound one parameter per removed repository, so a reconnect that drops
    // a large grant overflowed Postgres's 65,535 bind-parameter ceiling and
    // rolled the whole transaction back.
    await tombstoneRepositoriesAbsentFrom(
      tx,
      input.priorInstallationId,
      incomingByRepoId
    );
  });

  log.info(`${CLAIM_LOG_PREFIX} Reused prior installation in-place`, {
    priorInstallationId: input.priorInstallationId,
    newGithubInstallationId,
    organizationId: input.organizationId,
    repositoryCount: input.repositories.length,
  });
}

async function createInstallationRecordFromLookup(
  resolved: GitHubAppInstallation,
  deps: ClaimGitHubInstallationDeps
) {
  log.info(
    `${CLAIM_LOG_PREFIX} Installation record not found, creating from GitHub API data`,
    { installationId: resolved.id }
  );
  try {
    return await withDb((db) =>
      db.gitHubInstallation.create({
        data: {
          installationId: String(resolved.id),
          accountId: String(resolved.account.id),
          accountLogin: resolved.account.login,
          accountType: resolved.account.type,
          ...installerSenderFields(resolved),
          status: GitHubInstallationStatus.PENDING_CLAIM,
          // Same Json-column boundary cast as the reconnect update above.
          permissions: resolved.permissions as Prisma.InputJsonValue,
          events: resolved.events,
          repositorySelection: resolved.repositorySelection,
        },
      })
    );
  } catch (error) {
    if (getPrismaErrorCode(error) !== "P2002") {
      throw error;
    }
    // The `installation.created` webhook won the race; adopt its row.
    const racedInstallation = await deps.findInstallationByInstallationId(
      String(resolved.id)
    );
    if (!racedInstallation) {
      throw error;
    }
    return racedInstallation;
  }
}

/**
 * Per-caller ownership proof for a claim (cr-66737): the caller's
 * Clerk-linked GitHub identity must OWN the installation account (personal
 * install) or be an ACTIVE ADMIN of it (org install). Returns the refusal —
 * a user-facing string plus an optional machine-readable code — or null when
 * the caller proved access.
 *
 * Admin, not membership: GitHub only lets org OWNERS install an App, so the
 * real installer is always an admin, while an ordinary member of the same
 * org is exactly the attacker this proof exists to stop — installation ids
 * are enumerable and a PENDING_CLAIM row is org-less, so member-level proof
 * would let any member bind a victim org's installation to their own
 * Closedloop org and sync its private repositories.
 *
 * A caller without a Clerk-linked GitHub account cannot prove anything and
 * is refused — the retired OAuth flow likewise always had the caller's own
 * GitHub grant in hand — but that refusal is actionable, so it carries
 * `LinkRequired` and the web callback routes it to the linking page. The
 * membership read accepts `repo`, which `resolveClerkGitHubCredential` has
 * already required before the read — a narrow grant is denied there and lands
 * on that same actionable refusal, which the linking page re-links
 * automatically. (ISS-8156 dropped `read:org` from
 * `GITHUB_CLERK_OAUTH_SCOPES` on the strength of that: this is the only
 * org-scoped read on a user token, and GitHub accepts `repo` for it.)
 */
async function verifyClaimerInstallationAccess(
  input: { organizationId: string; userId: string },
  resolved: GitHubAppInstallation,
  deps: ClaimGitHubInstallationDeps
): Promise<ClaimAccessRefusal | null> {
  const resolveCredential =
    deps.resolveClerkCredential ?? resolveClerkGitHubCredential;
  const clerk = await resolveCredential({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  if (!clerk.ok) {
    return {
      error: "Connect your GitHub account before claiming this installation.",
      code: GitHubConnectErrorCode.LinkRequired,
    };
  }
  const fetchUser =
    deps.fetchAuthenticatedGitHubUser ?? fetchAuthenticatedGitHubUser;
  const githubUser = await fetchUser(clerk.credential.token);
  if (!githubUser) {
    return { error: "Failed to verify your GitHub identity. Try again." };
  }
  if (resolved.account.type === "User") {
    if (String(resolved.account.id) === String(githubUser.id)) {
      return null;
    }
    return {
      error:
        "This GitHub App installation belongs to a different GitHub account.",
    };
  }
  const fetchMembership =
    deps.fetchOrgMembershipState ?? fetchOrgMembershipState;
  const membership = await fetchMembership(
    clerk.credential.token,
    resolved.account.login
  );
  // A GitHub outage is not an authorization fact: refusing the real installer
  // with "you must be an admin" would send them to fix a permission that was
  // never the problem.
  if (membership.status === OrgMembershipReadStatus.Unavailable) {
    return {
      error: `Couldn't check your membership of the ${resolved.account.login} GitHub organization right now. Try again in a moment.`,
    };
  }
  if (
    membership.status === OrgMembershipReadStatus.Confirmed &&
    membership.state === "active" &&
    membership.role === "admin"
  ) {
    return null;
  }
  return {
    error: `You must be an owner of the ${resolved.account.login} GitHub organization to claim this installation.`,
  };
}

async function fetchAuthenticatedGitHubUser(
  token: string
): Promise<{ id: number } | null> {
  try {
    const { data } =
      await getUserTokenOctokit(token).rest.users.getAuthenticated();
    return { id: data.id };
  } catch (error) {
    log.warn(`${CLAIM_LOG_PREFIX} Failed to read claimer's GitHub identity`, {
      error: parseError(error),
    });
    return null;
  }
}

async function fetchOrgMembershipState(
  token: string,
  org: string
): Promise<OrgMembershipRead> {
  try {
    const { data } = await getUserTokenOctokit(
      token
    ).rest.orgs.getMembershipForAuthenticatedUser({ org });
    return {
      status: OrgMembershipReadStatus.Confirmed,
      state: data.state,
      role: data.role,
    };
  } catch (error) {
    const status = extractGitHubErrorStatus(error);
    // 403/404 is GitHub's definitive "not a member, or your grant cannot see
    // memberships" — an ordinary refusal. Anything else (5xx, rate limit,
    // network) is an outage, and telling the caller they lack a permission
    // they may well hold would be a lie about their access.
    if (status === 403 || status === 404) {
      log.info(`${CLAIM_LOG_PREFIX} Org membership read refused the caller`, {
        org,
        status,
      });
      return { status: OrgMembershipReadStatus.Refused };
    }
    log.warn(`${CLAIM_LOG_PREFIX} Org membership read unavailable`, {
      org,
      status,
      error: parseError(error),
    });
    return { status: OrgMembershipReadStatus.Unavailable };
  }
}

/**
 * Sender identity for a claimed installation row. Sender used to be the
 * OAuth user; the claim flow has no GitHub user identity of its own, so the
 * installation account stands in — stated once, for both row builders.
 */
function installerSenderFields(resolved: GitHubAppInstallation): {
  senderLogin: string;
  senderId: string;
} {
  return {
    senderLogin: resolved.account.login,
    senderId: String(resolved.account.id),
  };
}
