export const GitHubRepositorySource = {
  Installation: "installation",
  Public: "public",
} as const;
export type GitHubRepositorySource =
  (typeof GitHubRepositorySource)[keyof typeof GitHubRepositorySource];

export type GitHubRepository = {
  id: string;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  githubRepoId: string;
  lastPushedAt: string | null;
  source?: GitHubRepositorySource;
};
