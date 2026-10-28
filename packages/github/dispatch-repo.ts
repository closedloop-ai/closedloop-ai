import {
  parseRepositoryFullName,
  type RepositoryIdentity,
} from "@repo/api/src/types/branch-repository";

/**
 * `GITHUB_APP_DISPATCH_REPO` names the owner/repo whose GitHub App installation
 * backs app-authenticated reads.
 *
 * `keys.ts` already gates the env var with an exact-two-segment regex, so this
 * parse cannot fail today. It goes through the shared parser anyway (ISS-7548)
 * so the structural contract has one owner — the `as [string, string]` cast
 * this replaced asserted a shape nothing at the call site checked, and would
 * have started lying the moment that regex loosened.
 */
export function parseDispatchRepo(fullName: string): RepositoryIdentity {
  const identity = parseRepositoryFullName(fullName);
  if (!identity) {
    throw new Error("GITHUB_APP_DISPATCH_REPO must be exactly owner/repo");
  }
  return identity;
}
