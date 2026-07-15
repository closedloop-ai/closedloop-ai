import {
  GitHubDataConnectionSource,
  type GitHubDataConnectionStatus,
  GitHubOAuthRequiredReason,
} from "@repo/api/src/types/github";
import { GitHubInstallationStatus } from "@repo/database";

type GitHubDataConnectionDb = {
  gitHubInstallation: {
    findFirst: (args: {
      where: {
        organizationId: string;
        status: typeof GitHubInstallationStatus.ACTIVE;
      };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
  gitHubUserConnection: {
    findUnique: (args: {
      where: {
        organizationId_userId: {
          organizationId: string;
          userId: string;
        };
      };
      select: {
        revokedAt: true;
        tokenExpiresAt: true;
      };
    }) => Promise<GitHubDataConnectionUserGrant | null>;
  };
};

type GitHubDataConnectionUserGrant = {
  revokedAt: Date | null;
  tokenExpiresAt: Date | null;
};

type ResolveGitHubDataConnectionInput = {
  hasActiveInstallation?: boolean;
  organizationId: string;
  userId: string | null | undefined;
  now?: Date;
};

type UserGrantState =
  | typeof UserOAuthGrantState.Active
  | typeof UserOAuthGrantState.Missing
  | typeof UserOAuthGrantState.Revoked
  | typeof UserOAuthGrantState.Expired;

const UserOAuthGrantState = {
  Active: "active",
  Expired: "expired",
  Missing: "missing",
  Revoked: "revoked",
} as const;

/**
 * Resolve whether GitHub-truth product data can be trusted for an org. An
 * active GitHub App installation or a current, readable user OAuth grant can
 * satisfy the predicate; invalid user grants produce OAuth recovery reasons.
 */
export async function resolveGitHubDataConnectionStatus(
  db: GitHubDataConnectionDb,
  input: ResolveGitHubDataConnectionInput
): Promise<GitHubDataConnectionStatus> {
  const [activeInstallation, userGrant] = await Promise.all([
    input.hasActiveInstallation === undefined
      ? db.gitHubInstallation.findFirst({
          where: {
            organizationId: input.organizationId,
            status: GitHubInstallationStatus.ACTIVE,
          },
          select: { id: true },
        })
      : Promise.resolve(null),
    input.userId
      ? db.gitHubUserConnection.findUnique({
          where: {
            organizationId_userId: {
              organizationId: input.organizationId,
              userId: input.userId,
            },
          },
          select: {
            revokedAt: true,
            tokenExpiresAt: true,
          },
        })
      : Promise.resolve(null),
  ]);

  return buildGitHubDataConnectionStatus({
    hasActiveInstallation:
      input.hasActiveInstallation ?? activeInstallation !== null,
    now: input.now ?? new Date(),
    userGrant,
  });
}

function buildGitHubDataConnectionStatus({
  hasActiveInstallation,
  now,
  userGrant,
}: {
  hasActiveInstallation: boolean;
  now: Date;
  userGrant: GitHubDataConnectionUserGrant | null;
}): GitHubDataConnectionStatus {
  const userGrantState = resolveUserGrantState(userGrant, now);
  const sources: GitHubDataConnectionStatus["sources"] = [];
  if (hasActiveInstallation) {
    sources.push(GitHubDataConnectionSource.GitHubApp);
  }
  if (userGrantState === UserOAuthGrantState.Active) {
    sources.push(GitHubDataConnectionSource.UserOAuth);
  }
  if (sources.length > 0) {
    return {
      connected: true,
      sources,
      oauthRequiredReasons: [],
    };
  }
  return {
    connected: false,
    sources,
    oauthRequiredReasons: [
      GitHubOAuthRequiredReason.NoAppInstallation,
      ...oauthReasonsForUserGrantState(userGrantState),
    ],
  };
}

function resolveUserGrantState(
  userGrant: GitHubDataConnectionUserGrant | null,
  now: Date
): UserGrantState {
  if (!userGrant) {
    return UserOAuthGrantState.Missing;
  }
  if (userGrant.revokedAt !== null) {
    return UserOAuthGrantState.Revoked;
  }
  if (
    userGrant.tokenExpiresAt &&
    userGrant.tokenExpiresAt.getTime() <= now.getTime()
  ) {
    return UserOAuthGrantState.Expired;
  }
  return UserOAuthGrantState.Active;
}

function oauthReasonsForUserGrantState(
  state: UserGrantState
): GitHubOAuthRequiredReason[] {
  switch (state) {
    case UserOAuthGrantState.Missing:
      return [GitHubOAuthRequiredReason.NoUserGrant];
    case UserOAuthGrantState.Revoked:
      return [GitHubOAuthRequiredReason.CredentialRevoked];
    case UserOAuthGrantState.Expired:
      return [GitHubOAuthRequiredReason.CredentialExpired];
    case UserOAuthGrantState.Active:
      return [];
    default:
      return exhaustiveUserGrantState(state);
  }
}

function exhaustiveUserGrantState(state: never): never {
  throw new Error(`Unhandled GitHub user grant state: ${state}`);
}
