/**
 * ISS-12552 (PRD-800): the write-to-commit join, run on
 * the Desktop so only its per-branch result is synced. A
 * request is proven for branch X when it holds a file write whose path a
 * later successful commit on X captures; the request that made that commit is
 * proven too. The commit's changed files come from its own output when the
 * output lists every changed file, else from the working tree: every path
 * written since the previous commit. A path is captured by the first commit
 * that takes it. No phase, no timing. A failed, denied or result-less call
 * proves nothing. A request joined to two branches is left to the association,
 * which proves it for none.
 */
import {
  type OperationClaim,
  OperationClaimSource,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import {
  GitWriteAction,
  type RepositoryActivity,
  RepositoryActivityKind,
} from "./repository-write-claims";

type PendingWrite = { requestKey: string | undefined; paths: Set<string> };

/** Request keys each branch's commits prove, by branch name. */
export function implementationRequestsByBranch(
  claims: readonly RepositoryActivity[]
): Map<string, Set<string>> {
  const proven = new Map<string, Set<string>>();
  const pending: PendingWrite[] = [];
  for (const claim of inSessionOrder(claims)) {
    if (claim.resultState !== ToolResultState.Present) {
      continue;
    }
    if (claim.kind === RepositoryActivityKind.FileWrite && claim.paths) {
      pending.push({
        requestKey: claim.requestKey,
        paths: new Set(claim.paths),
      });
      continue;
    }
    if (
      claim.kind !== RepositoryActivityKind.GitWrite ||
      claim.gitAction !== GitWriteAction.Commit ||
      !claim.branch
    ) {
      continue;
    }
    const requests = proven.get(claim.branch) ?? new Set<string>();
    if (claim.requestKey) {
      requests.add(claim.requestKey);
    }
    for (const requestKey of capturedBy(claim, pending)) {
      requests.add(requestKey);
    }
    proven.set(claim.branch, requests);
  }
  return proven;
}

/** The pending writes a commit captures, taken off the pending list. */
function capturedBy(
  commit: RepositoryActivity,
  pending: PendingWrite[]
): string[] {
  const listed = commit.changedPaths ?? [];
  const complete =
    listed.length > 0 &&
    (commit.filesChanged === undefined || listed.length >= commit.filesChanged);
  const captured: string[] = [];
  for (const write of pending) {
    const taken = complete
      ? [...write.paths].filter((path) =>
          listed.some((changed) => samePath(path, changed))
        )
      : [...write.paths];
    if (taken.length === 0) {
      continue;
    }
    for (const path of taken) {
      write.paths.delete(path);
    }
    if (write.requestKey) {
      captured.push(write.requestKey);
    }
  }
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    if (pending[i]?.paths.size === 0) {
      pending.splice(i, 1);
    }
  }
  return captured;
}

/** One path names the other: equal, or one is the other's repository suffix. */
function samePath(written: string, listed: string): boolean {
  return (
    written === listed ||
    written.endsWith(`/${listed}`) ||
    listed.endsWith(`/${written}`)
  );
}

/** Claims by call time, then by their order in the session. */
function inSessionOrder(
  claims: readonly RepositoryActivity[]
): RepositoryActivity[] {
  return claims
    .map((claim, index) => ({ claim, index }))
    .sort(
      (left, right) =>
        (left.claim.invokedAt ?? "").localeCompare(
          right.claim.invokedAt ?? ""
        ) || left.index - right.index
    )
    .map(({ claim }) => claim);
}

/**
 * The join's result as claims, one per branch a successful commit landed on,
 * holding only the branch and its request keys.
 */
export function implementationJoinClaims(
  harness: string,
  activity: readonly RepositoryActivity[]
): OperationClaim[] {
  return [...implementationRequestsByBranch(activity)]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([branch, requests]) => ({
      claimKey: `${harness}:implementation:${branch}`,
      source: OperationClaimSource.ImplementationJoin,
      branch,
      requestKeys: [...requests].sort(),
    }));
}

/** A claim the cloud keeps on the snapshot, never on the evidence rows. */
export function isImplementationJoinClaim(claim: OperationClaim): boolean {
  return claim.source === OperationClaimSource.ImplementationJoin;
}
