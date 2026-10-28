import {
  parseRepositoryFullName,
  type RepositoryIdentity,
} from "@repo/api/src/types/branch-repository";

/**
 * The `githubService` read methods address GitHub by `(owner, repo)`, so a
 * stored full name that is not exactly `owner/repo` has no addressable target.
 * Throwing beats truncating: `owner/repo/extra` reduced to its first two
 * segments would return a DIFFERENT repository's branches or pull requests
 * under this repository's id (ISS-7548).
 */
export function requireRepositoryIdentity(
  fullName: string
): RepositoryIdentity {
  const identity = parseRepositoryFullName(fullName);
  if (!identity) {
    throw new Error("Invalid repository fullName format");
  }
  return identity;
}
