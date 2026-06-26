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
import { log } from "@repo/observability/log";
import { decryptIntegrationToken } from "@/lib/integration-encryption";

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
  token: string;
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
  const connection = await db.gitHubUserConnection.findUnique({
    where: {
      organizationId_userId: {
        organizationId: input.organizationId,
        userId: input.userId,
      },
    },
    select: {
      id: true,
      organizationId: true,
      userId: true,
      githubUserId: true,
      login: true,
      accessTokenEncrypted: true,
      revokedAt: true,
      tokenExpiresAt: true,
      scopes: true,
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

  let token: string;
  try {
    token = await decryptIntegrationToken(connection.accessTokenEncrypted);
  } catch {
    log.warn(
      "[comments/github-identity] Failed to decrypt GitHub user token",
      buildGitHubWriteIdentityDecryptFailureLogContext(input)
    );
    return Result.err(
      identityExpiredError(
        BranchViewCommentWriteIdentityStatus.DecryptionFailed
      )
    );
  }

  const lastUsedUpdate = await db.gitHubUserConnection.updateMany({
    where: {
      id: connection.id,
      organizationId: input.organizationId,
      userId: input.userId,
      revokedAt: null,
    },
    data: { lastUsedAt: input.now },
  });

  if (lastUsedUpdate.count !== 1) {
    return Result.err(
      identityExpiredError(BranchViewCommentWriteIdentityStatus.Revoked)
    );
  }

  return Result.ok({
    userId: connection.userId,
    organizationId: connection.organizationId,
    githubUserConnectionId: connection.id,
    githubUserId: connection.githubUserId,
    login: connection.login,
    token,
    scopes: connection.scopes,
  });
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
