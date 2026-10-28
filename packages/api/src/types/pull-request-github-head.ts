import { normalizeRepoFullName } from "./branch-repository.ts";

/**
 * The head GitHub reported for a PR, when it lives in the PR's own repository.
 * ISS-12344 decision record (comment thread th_1__bTDiF9jNPx9ebLHmn0, Perrin
 * Upcott 2026-10-09): that head decides the Branch a PR is filed under, on the
 * web and on the desktop, and a head in a fork is skipped. Undefined when the
 * read reported no head, no head repository, or a head in another repository.
 */
export function gitHubConfirmedHeadBranch(input: {
  headBranch: string | null | undefined;
  headRepositoryFullName: string | null | undefined;
  repositoryFullName: string | null | undefined;
}): string | undefined {
  if (
    !(
      input.headBranch &&
      input.headRepositoryFullName &&
      input.repositoryFullName
    )
  ) {
    return;
  }
  return normalizeRepoFullName(input.headRepositoryFullName) ===
    normalizeRepoFullName(input.repositoryFullName)
    ? input.headBranch
    : undefined;
}
