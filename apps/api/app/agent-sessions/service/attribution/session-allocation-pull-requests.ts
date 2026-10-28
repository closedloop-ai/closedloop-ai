/**
 * ISS-12552: a segment's `owner/repo#number` work item ref
 * names an implemented branch only through that branch's canonical pull
 * request (ISS-8153), so a branch and its pull request stay one recipient.
 */
import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import { withDb } from "@repo/database";
import { readCloudBranchCanonicalPullRequests } from "@/app/branches/branch-canonical-pull-request-cloud";

/** `owner/repo#number`, repository normalized, to the branch it is canonical for. */
export async function canonicalPullRequestRefs(
  organizationId: string,
  branchIds: readonly string[]
): Promise<Map<string, string>> {
  const canonical = await withDb((db) =>
    readCloudBranchCanonicalPullRequests(db, organizationId, branchIds)
  );
  const refs = new Map<string, string>();
  for (const [branchId, pullRequest] of canonical) {
    if (pullRequest.repositoryFullName) {
      refs.set(
        pullRequestRefKey(pullRequest.repositoryFullName, pullRequest.number),
        branchId
      );
    }
  }
  return refs;
}

export function pullRequestRefKey(repository: string, number: number): string {
  return `${normalizeRepoFullName(repository)}#${number}`;
}
