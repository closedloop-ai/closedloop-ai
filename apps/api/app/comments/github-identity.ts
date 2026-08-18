import {
  BranchViewCommentActionResultCode,
  type BranchViewCommentIdentityBlocker,
  BranchViewCommentWriteIdentityStatus,
} from "@repo/api/src/types/branch-view";
import {
  type Result as DomainResult,
  Result,
} from "@repo/api/src/types/result";
import { type TransactionClient, withDb } from "@repo/database";
import {
  getUserTokenOctokit,
  type Octokit,
} from "@repo/github/user-token-auth";
import { log } from "@repo/observability/log";
import {
  GitHubConnectionCredentialDenial,
  resolveGitHubUserConnectionCredential,
} from "@/lib/github/github-connection-credential";

type GitHubWriteIdentityClient = Pick<
  TransactionClient,
  "gitHubUserConnection"
>;

export type RequireGitHubWriteIdentityInput = {
  organizationId: string;
  userId: string;
  now: Date;
  db?: GitHubWriteIdentityClient;
};

export type GitHubWriteIdentity = {
  userId: string;
  organizationId: string;
  githubUserConnectionId: string;
  githubUserId: string;
  login: string;
  /**
   * One timeout-bounded client for the whole request (PLN-1525). Resolved here
   * rather than handing callers a raw token, so a multi-write action builds a
   * single client instead of one per GitHub call, and the write path inherits
   * `boundedFetch` the same way every read lane already does.
   */
  octokit: Octokit;
  scopes: string[];
};

export type GitHubWriteIdentityError =
  | {
      code: typeof BranchViewCommentActionResultCode.GithubIdentityRequired;
      identityBlocker: BranchViewCommentIdentityBlocker;
    }
  | {
      code: typeof BranchViewCommentActionResultCode.GithubIdentityExpired;
      identityBlocker: BranchViewCommentIdentityBlocker;
    };

export type GitHubWriteIdentityResult = DomainResult<
  GitHubWriteIdentity,
  GitHubWriteIdentityError
>;

export type GitHubWriteIdentityStatus = {
  status: typeof BranchViewCommentWriteIdentityStatus.Active;
  githubUserId: string;
  login: string;
};

export type GitHubWriteIdentityStatusResult = DomainResult<
  GitHubWriteIdentityStatus,
  GitHubWriteIdentityError
>;

/**
 * Resolve the caller's GitHub identity status without reading, decrypting, or
 * marking the write token as used. Mutation services use this read-only status
 * to run policy checks before acquiring a provider write credential.
 */
export async function getGitHubWriteIdentityStatus(
  input: RequireGitHubWriteIdentityInput
): Promise<GitHubWriteIdentityStatusResult> {
  const resolve = (db: GitHubWriteIdentityClient) =>
    getGitHubWriteIdentityStatusWithClient(db, input);

  if (input.db) {
    return await resolve(input.db);
  }

  return await withDb((db) => resolve(db));
}

/**
 * Resolves and decrypts the caller's GitHub user token for user-authored
 * comment writes. Missing identities, revoked identities, expired tokens, and
 * decrypt failures all fail closed with stable branch-view result codes.
 *
 * PLN-1525: thin adapter over the shared connection-credential read
 * (`@/lib/github/github-connection-credential`) — this module owns only the
 * mapping to branch-view result codes, and the one bounded client the write
 * path threads into every GitHub call. `lastUsedAt` is sampled by the shared
 * read instead of written per call.
 *
 * Deliberately NOT routed through `getGitHubClient(WriteAsUser)`: the resolver
 * folds expired, revoked, and undecryptable credentials into a single
 * `revoked` reason ("one remedy: reconnect"), while this surface still tells
 * those apart to pick its prompt (`BranchViewCommentWriteIdentityStatus`).
 * Adopting the resolver here means first deciding whether that remediation
 * detail is worth keeping — a product call, not a mechanical migration.
 */
export async function requireGitHubWriteIdentity(
  input: RequireGitHubWriteIdentityInput
): Promise<GitHubWriteIdentityResult> {
  const resolve = (db: GitHubWriteIdentityClient) =>
    requireGitHubWriteIdentityWithClient(db, input);

  if (input.db) {
    return await resolve(input.db);
  }

  return await withDb((db) => resolve(db));
}

async function requireGitHubWriteIdentityWithClient(
  db: GitHubWriteIdentityClient,
  input: RequireGitHubWriteIdentityInput
): Promise<GitHubWriteIdentityResult> {
  const read = await resolveGitHubUserConnectionCredential(db, {
    organizationId: input.organizationId,
    userId: input.userId,
    now: input.now,
  });
  if (!read.ok) {
    return Result.err(mapCredentialDenial(read.denial, input));
  }
  return Result.ok({
    userId: read.credential.userId,
    organizationId: read.credential.organizationId,
    githubUserConnectionId: read.credential.connectionId,
    githubUserId: read.credential.githubUserId,
    login: read.credential.login,
    octokit: getUserTokenOctokit(read.credential.token),
    scopes: read.credential.scopes,
  });
}

function mapCredentialDenial(
  denial: GitHubConnectionCredentialDenial,
  input: RequireGitHubWriteIdentityInput
): GitHubWriteIdentityError {
  if (denial === GitHubConnectionCredentialDenial.NotConnected) {
    return identityRequiredError();
  }
  if (denial === GitHubConnectionCredentialDenial.Expired) {
    return identityExpiredError(BranchViewCommentWriteIdentityStatus.Expired);
  }
  if (denial === GitHubConnectionCredentialDenial.DecryptionFailed) {
    log.warn(
      "[comments/github-identity] Failed to decrypt GitHub user token",
      buildGitHubWriteIdentityDecryptFailureLogContext(input)
    );
    return identityExpiredError(
      BranchViewCommentWriteIdentityStatus.DecryptionFailed
    );
  }
  return identityExpiredError(BranchViewCommentWriteIdentityStatus.Revoked);
}

async function getGitHubWriteIdentityStatusWithClient(
  db: GitHubWriteIdentityClient,
  input: RequireGitHubWriteIdentityInput
): Promise<GitHubWriteIdentityStatusResult> {
  const connection = await db.gitHubUserConnection.findUnique({
    where: {
      organizationId_userId: {
        organizationId: input.organizationId,
        userId: input.userId,
      },
    },
    select: {
      githubUserId: true,
      login: true,
      revokedAt: true,
      tokenExpiresAt: true,
    },
  });

  if (!connection) {
    return Result.err(identityRequiredError());
  }

  if (connection.revokedAt !== null) {
    return Result.err(
      identityExpiredError(BranchViewCommentWriteIdentityStatus.Revoked)
    );
  }

  if (
    connection.tokenExpiresAt &&
    connection.tokenExpiresAt.getTime() <= input.now.getTime()
  ) {
    return Result.err(
      identityExpiredError(BranchViewCommentWriteIdentityStatus.Expired)
    );
  }

  return Result.ok({
    status: BranchViewCommentWriteIdentityStatus.Active,
    githubUserId: connection.githubUserId,
    login: connection.login,
  });
}

/** Build safe decrypt-failure log metadata without provider or token details. */
export function buildGitHubWriteIdentityDecryptFailureLogContext(
  input: Pick<RequireGitHubWriteIdentityInput, "organizationId" | "userId">
) {
  return {
    organizationId: input.organizationId,
    userId: input.userId,
    status: BranchViewCommentWriteIdentityStatus.DecryptionFailed,
  };
}

export function getGitHubWriteIdentityErrorCode(
  error: GitHubWriteIdentityError | GitHubWriteIdentityError["code"]
): GitHubWriteIdentityError["code"] {
  return typeof error === "string" ? error : error.code;
}

export function getGitHubWriteIdentityErrorBlocker(
  error: GitHubWriteIdentityError | GitHubWriteIdentityError["code"]
): BranchViewCommentIdentityBlocker {
  if (typeof error !== "string") {
    return error.identityBlocker;
  }
  return {
    status:
      error === BranchViewCommentActionResultCode.GithubIdentityRequired
        ? BranchViewCommentWriteIdentityStatus.Missing
        : BranchViewCommentWriteIdentityStatus.Expired,
  };
}

function identityRequiredError(): GitHubWriteIdentityError {
  return {
    code: BranchViewCommentActionResultCode.GithubIdentityRequired,
    identityBlocker: {
      status: BranchViewCommentWriteIdentityStatus.Missing,
    },
  };
}

function identityExpiredError(
  status: Exclude<
    BranchViewCommentIdentityBlocker["status"],
    typeof BranchViewCommentWriteIdentityStatus.Missing
  >
): GitHubWriteIdentityError {
  return {
    code: BranchViewCommentActionResultCode.GithubIdentityExpired,
    identityBlocker: { status },
  };
}
