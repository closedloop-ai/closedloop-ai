import type { BranchSelectedPullRequestIdentity } from "@repo/api/src/types/branch-associated-pull-request";
import { waitUntil } from "@vercel/functions";
import type { AuthContext } from "@/lib/auth/with-auth";
import { readBranchPenseroNumerator } from "./branch-pensero-numerator";
import { branchReadService } from "./branch-read-service";
import { branchTagPermissionsForAuth } from "./branch-tag-projection";

/** Shared authenticated, DB-only projection with post-response PR refresh. */
export async function readBranchDetailForViewer(
  authContext: AuthContext,
  id: string,
  requestedPullRequest?: BranchSelectedPullRequestIdentity
) {
  const { authMethod, clerkUserId, user } = authContext;
  const tagPermissions = branchTagPermissionsForAuth(authContext);
  // ISS-9814: started HERE, outside the detail read's `withDb` scope —
  // this read takes its own `RepeatableRead` transaction and refuses to
  // join an ambient weaker one. `user.organizationId` is the org
  // `withAnyAuth` resolved for this principal, which is the membership
  // proof `readPenseroBranchDeliveryPoints` requires of its caller. `id` is
  // the branch Artifact id the delivery rows key on. Never throws — it owns
  // its own best-effort boundary, so an unavailable numerator cannot fail
  // this request. ISS-12278: it overlaps the detail read.
  const penseroPoints = readBranchPenseroNumerator(
    { userId: user.id, clerkUserId },
    user.organizationId,
    id
  );
  // ISS-12278 (Marisol Ashgrove ruling, 2026-10-08, PRD-792 open question 2):
  // this read answers from the database only. A `checks=lazy` caller reads
  // selected-PR checks from `/branches/[id]/selected-pull-request/checks`;
  // every other caller still gets them inline. The stale-PR tier-2 refresh
  // runs after the response.
  let refreshDue = false;
  const [detail] = await Promise.all([
    branchReadService.getBranchDetail(
      user.organizationId,
      id,
      tagPermissions,
      requestedPullRequest,
      {
        penseroPoints,
        onPullRequestRefreshDue: () => {
          refreshDue = true;
        },
      }
    ),
    penseroPoints,
  ]);
  if (refreshDue) {
    waitUntil(
      branchReadService.refreshBranchDetailPullRequest({
        actor: { userId: user.id, authMethod, tagPermissions },
        branchId: id,
        organizationId: user.organizationId,
        ...(requestedPullRequest ? { requestedPullRequest } : {}),
      })
    );
  }
  return detail;
}
