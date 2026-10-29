import { normalizeRepoFullName } from "@repo/api/src/types/branch";

/**
 * Which repository a `BranchDetail` / `PullRequestDetail` row belongs to. An
 * App-backed repo is identified by its `GitHubInstallationRepository` id; a
 * repo-less one by the normalized full name, which is the identity every
 * repo-less writer persists.
 *
 * Exported because it is the ONE predicate the two identities are allowed to be
 * written as (ISS-7721 M3). A hand-written `{ repositoryId }` in a backfill or
 * projection query silently returns zero rows for an installation-free org,
 * which reads as "nothing to do" rather than as a wrong predicate.
 *
 * Its own module (cr-96292): the write lanes (backfill projection writer)
 * consume ONLY this predicate, and `tracked-pull-requests` now pulls the
 * branch-canonical read chain — keeping the selector light keeps the writers'
 * hand-rolled `@repo/database` test mocks honest instead of forcing them to
 * mock the whole read-side import graph.
 */
export function trackedRepositorySelector(input: {
  repositoryFullName: string;
  repositoryId: string | null;
}): TrackedRepositorySelector {
  if (input.repositoryId) {
    return { repositoryId: input.repositoryId };
  }
  return {
    repositoryId: null,
    repositoryFullName: normalizeRepoFullName(input.repositoryFullName),
  };
}

export type TrackedRepositorySelector =
  | { repositoryId: string }
  | { repositoryId: null; repositoryFullName: string };
