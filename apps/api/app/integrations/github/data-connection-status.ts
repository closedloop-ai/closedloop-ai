import {
  GitHubDataConnectionSource,
  type GitHubDataConnectionStatus,
  GitHubOAuthRequiredReason,
} from "@repo/api/src/types/github";
import { GitHubInstallationStatus } from "@repo/database";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";

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
        scopes: true;
      };
    }) => Promise<GitHubDataConnectionUserGrant | null>;
  };
};

type GitHubDataConnectionUserGrant = {
  revokedAt: Date | null;
  scopes: string[];
};

type ResolveGitHubDataConnectionInput = {
  hasActiveInstallation?: boolean;
  organizationId: string;
  userId: string | null | undefined;
};

type UserGrantState =
  | typeof UserOAuthGrantState.Active
  | typeof UserOAuthGrantState.InsufficientScope
  | typeof UserOAuthGrantState.Missing
  | typeof UserOAuthGrantState.Revoked;

const UserOAuthGrantState = {
  Active: "active",
  InsufficientScope: "insufficient_scope",
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
            scopes: true,
          },
        })
      : Promise.resolve(null),
  ]);

  return buildGitHubDataConnectionStatus({
    hasActiveInstallation:
      input.hasActiveInstallation ?? activeInstallation !== null,
    userGrant,
  });
}

function buildGitHubDataConnectionStatus({
  hasActiveInstallation,
  userGrant,
}: {
  hasActiveInstallation: boolean;
  userGrant: GitHubDataConnectionUserGrant | null;
}): GitHubDataConnectionStatus {
  const userGrantState = resolveUserGrantState(userGrant);
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

/**
 * ISS-7404: the floor the actual read enforces, applied to the status that
 * advertises the capability. A grant is a usable `user_oauth` source only when
 * its mirrored scopes carry `repo` — otherwise the endpoint asserts reach that
 * no read can honor.
 *
 * This is deliberately STRICTER than the shared `meetsGitHubRepoScopeFloor`,
 * which passes an empty scope set as an App-family carve-out. That carve-out
 * does not survive here: the only credential this status describes is the
 * Clerk-held one, and `clerk-github-credential.ts` rejects any scope set
 * without `repo`, empty included. The registry mirrors Clerk's live scopes
 * unconditionally (`github-clerk-registry.ts`), so an empty array means Clerk
 * reported none — a row that cannot produce a working token. Reporting it
 * connected is the exact lie this issue is about. The shared predicate keeps
 * its carve-out for the pool and resolver lanes, which is not ours to change.
 */
function resolveUserGrantState(
  userGrant: GitHubDataConnectionUserGrant | null
): UserGrantState {
  if (!userGrant) {
    return UserOAuthGrantState.Missing;
  }
  if (userGrant.revokedAt !== null) {
    return UserOAuthGrantState.Revoked;
  }
  if (!userGrant.scopes.includes(GITHUB_REPO_SCOPE)) {
    return UserOAuthGrantState.InsufficientScope;
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
    case UserOAuthGrantState.InsufficientScope:
      return [GitHubOAuthRequiredReason.CredentialInsufficientScope];
    case UserOAuthGrantState.Active:
      return [];
    default:
      return exhaustiveUserGrantState(state);
  }
}

function exhaustiveUserGrantState(state: never): never {
  throw new Error(`Unhandled GitHub user grant state: ${state}`);
}
