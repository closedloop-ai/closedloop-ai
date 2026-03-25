/**
 * GitHub integration types for API contract.
 * Used by both apps/api (backend) and apps/app (frontend).
 */

export type ConnectGitHubInput = {
  code: string;
  installationId: string;
};

export type ConnectGitHubResponse = {
  connected: true;
};

export type GitHubInstallationInfo = {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  status: string;
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

export type GitHubRepository = {
  id: string;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  githubRepoId: string;
  lastPushedAt: string | null;
};

export type GetRepositoriesResponse = GitHubRepository[];

export type GitHubBranch = {
  name: string;
  committedDate: string;
  isDefault: boolean;
};

export type GetBranchesResponse = {
  branches: GitHubBranch[];
};
