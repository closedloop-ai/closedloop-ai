import {
  type GitHubRepository as SharedGitHubRepository,
  GitHubRepositorySource as SharedGitHubRepositorySource,
} from "@closedloop-ai/loops-api/github";

/**
 * GitHub integration types for API contract.
 * Used by both apps/api (backend) and apps/app (frontend).
 */

export type ConnectGitHubAccountInfo = {
  accountId: string;
  accountLogin: string;
};

/**
 * Response from POST /integrations/github/connect.
 *
 * The `requires_confirmation` variant is emitted when an org reconnects to a
 * different GitHub account than was previously linked. The frontend collects
 * explicit admin confirmation before invoking the cleanup endpoint (PLN-634).
 */
export type ConnectGitHubResponse =
  | { connected: true }
  | {
      connected: false;
      status: "requires_confirmation";
      priorAccount: ConnectGitHubAccountInfo;
      newAccount: ConnectGitHubAccountInfo;
      newInstallationId: string;
    };

export const GitHubInstallationStatus = {
  PendingClaim: "PENDING_CLAIM",
  Active: "ACTIVE",
  Suspended: "SUSPENDED",
  Uninstalled: "UNINSTALLED",
} as const;
export type GitHubInstallationStatus =
  (typeof GitHubInstallationStatus)[keyof typeof GitHubInstallationStatus];

export type GitHubInstallationInfo = {
  id: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  status: GitHubInstallationStatus;
  repositorySelection: string | null;
  repositoryCount: number;
  claimedAt: string | null;
  createdAt: string;
};

export type GitHubIntegrationStatus =
  | {
      connected: true;
      installation: GitHubInstallationInfo;
    }
  | {
      connected: false;
    };

export type DisconnectGitHubResponse = {
  disconnected: true;
};

/**
 * Response from POST /integrations/github/connect/confirm-reset.
 * Indicates the admin-confirmed different-account cleanup ran successfully.
 */
export type ConfirmDifferentAccountResetResponse = {
  confirmed: true;
};

export type GitHubRepository = SharedGitHubRepository;

export type GetRepositoriesResponse = GitHubRepository[];

export type GitHubBranch = {
  name: string;
  committedDate: string;
  isDefault: boolean;
};

export type GetBranchesResponse = {
  branches: GitHubBranch[];
};

export const GitHubPRState = {
  Open: "OPEN",
  Merged: "MERGED",
  Closed: "CLOSED",
} as const;
export type GitHubPRState = (typeof GitHubPRState)[keyof typeof GitHubPRState];

export type GitHubPullRequestSummary = {
  githubId: string;
  number: number;
  title: string;
  htmlUrl: string;
  headBranch: string;
  baseBranch: string;
  headSha: string | null;
  state: GitHubPRState;
  isDraft: boolean;
  closedAt: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  updatedAt: string;
  author: string;
};

export type TrackedGitHubBranch = {
  branchName: string;
  branchKey: string;
  htmlUrl: string;
  pullRequestUrl: string | null;
};

export type GetPullRequestsResponse = {
  pullRequests: GitHubPullRequestSummary[];
  /** PR htmlUrl values already tracked by branch current PR detail. */
  trackedPrUrls: string[];
  /** Branch artifacts already tracked for this repository/project. */
  trackedBranches?: TrackedGitHubBranch[];
  /** Stable repository-scoped keys for tracked branches. */
  trackedBranchKeys?: string[];
};

export type GitHubContributor = {
  login: string;
  avatarUrl: string;
  contributions: number;
  htmlUrl: string;
};

export type GetContributorsResponse = {
  contributors: GitHubContributor[];
};

export const GitHubRepositorySource = SharedGitHubRepositorySource;
export type GitHubRepositorySource =
  (typeof GitHubRepositorySource)[keyof typeof GitHubRepositorySource];

/** Exact reason taxonomy for unavailable GitHub status-check rollup reads. */
export const StatusCheckRollupFailureReason = {
  InvalidInput: "invalid_input",
  RateLimited: "rate_limited",
  PermissionDenied: "permission_denied",
  GraphqlError: "graphql_error",
} as const;
export type StatusCheckRollupFailureReason =
  (typeof StatusCheckRollupFailureReason)[keyof typeof StatusCheckRollupFailureReason];

/** GitHub aggregate statusCheckRollup states preserved at the provider edge. */
export type StatusCheckRollupState =
  | "SUCCESS"
  | "FAILURE"
  | "ERROR"
  | "PENDING"
  | "EXPECTED";

export type PublicRepository = {
  id: string;
  url: string;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  lastPushedAt: string | null;
};

export type CreatePublicRepositoryInput = {
  url: string;
};

export type PublicRepositoryResponse = PublicRepository;

export type DeletePublicRepositoryResponse = {
  deleted: true;
};
