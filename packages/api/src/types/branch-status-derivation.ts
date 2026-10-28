import { BranchStatus } from "./branch.ts";
import { BranchMergedState } from "./branch-merged-state.ts";
import { GitHubPRState } from "./github-status.js";

/**
 * Maps a branch's local artifact status + connected PR lifecycle to the
 * canonical {@link BranchStatus}.
 *
 * ISS-9664 — this is the ONE derivation. It lives here, beside the enum it
 * produces, because the cloud read (`apps/api/app/branches`) and the desktop
 * producers (`apps/desktop/src/main/branch`, `.../main/cloud`) both call it. It
 * used to be an `apps/api` module that desktop could not import, so desktop
 * carried its own copy and the two answered differently for the SAME branch: a
 * branch with no PR evidence derived Open on web and Draft on desktop. The
 * previous docstring here asserted the two producers agreed; they agreed only on
 * the merged-before-draft ordering, and the file it cited
 * (`shared-branches-api.ts`) had already stopped holding the derivation. A
 * docstring claiming a parity the code does not provide is worse than none, so
 * the claim is gone — the parity is now structural, and
 * `branch-status-parity.test-fixtures.ts` pins it from both surfaces.
 *
 * `artifactStatus` is the branch's OWN persisted lifecycle value on a surface
 * that stores one, and `null` on a surface that does not. The desktop store has
 * no such column; passing `null` states that absence instead of substituting a
 * value it never measured.
 *
 * The order of the arms is load-bearing:
 *
 * 1. MERGE EVIDENCE beats a stale draft flag (FEA-4333). A PR that GitHub
 *    reports merged is Merged even if a stale capture still carries
 *    `isDraft=true`. Checking `isDraft` first classified such a branch as Draft,
 *    so it counted as active while its connected PR was ALSO counted merged.
 * 2. Draft precedes Closed. A draft PR is Draft on every surface; desktop used
 *    to check Closed first, so a closed draft read Closed there and Draft on web.
 * 3. Everything left — including a branch with NO PR evidence at all — is Open.
 *    Kerensa ruled 2026-08-31 (ISS-8422) that Open is a statement about the BRANCH,
 *    not a claim about a PR, so a PR-less branch is Open on every surface.
 *
 * Note that {@link BranchStatus} carries six members and this derivation can
 * only ever emit four: `Review` and `Blocked` exist for the filter vocabulary
 * and the label maps, and no producer derives them.
 */
export function toBranchStatus(
  artifactStatus: string | null,
  prState: GitHubPRState | null,
  isDraft: boolean,
  mergedState: BranchMergedState
): BranchStatus {
  if (mergedState === BranchMergedState.Merged) {
    return BranchStatus.Merged;
  }
  if (isDraft) {
    return BranchStatus.Draft;
  }
  if (
    artifactStatus === GitHubPRState.Closed ||
    prState === GitHubPRState.Closed
  ) {
    return BranchStatus.Closed;
  }
  return BranchStatus.Open;
}
