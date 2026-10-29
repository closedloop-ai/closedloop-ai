/**
 * Which server-side record a repository entry came from, and therefore which
 * credential lane resolves its branch/PR sub-requests.
 *
 * `observed` (PLN-1775 M7) is additive and appears ONLY for an organization
 * with no active GitHub App installation — a client that does not know the
 * value never receives it alongside rows it does know. A consumer parsing this
 * with a closed enum must still tolerate an unknown member: the set grows as
 * new credential lanes land, and rejecting an unknown one empties the surface
 * instead of degrading it.
 */
export const GitHubRepositorySource = {
  Installation: "installation",
  Public: "public",
  Observed: "observed",
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
