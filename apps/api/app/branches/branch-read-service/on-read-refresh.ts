import type { BranchSelectedPullRequestIdentity } from "@repo/api/src/types/branch-associated-pull-request";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  projectCloudOwnedBranchAssociatedPullRequests,
  resolveCloudBranchAssociatedPullRequest,
} from "../branch-associated-pull-request-projection";
import type { BranchPenseroAttributedPoints } from "../branch-pensero-numerator";
import type { RefreshActor } from "../branch-refresh-support";
import { refreshTier2BranchPullRequestOnRead } from "../tier2-targeted-branch-refresh";
import { findBranchArtifact } from "./persisted-row-read";

export type BranchDetailReadOptions = {
  /**
   * ISS-9814: this branch's Pensero points, read by the ROUTE.
   *
   * Passed in rather than fetched here because `readPenseroBranchDeliveryPoints`
   * opens its own `RepeatableRead` transaction and `withDb.tx` throws rather
   * than join the ambient one `getBranchDetail` is already inside. Resolving it
   * at the route also keeps the org-membership proof at the boundary that owns
   * it — see `branch-pensero-numerator.ts`. ISS-12278: the route may pass the
   * still-pending read so it overlaps the detail read instead of preceding it.
   *
   * Absent or `null` means no Pensero numerator, and the detail bundle then
   * publishes no `penseroPointsPerDollar` at all, so the card renders LOC/$.
   * `getBranchDetail` adds the failed-day flag once it has projected the
   * branch's activity window (ISS-10653).
   */
  penseroPoints?:
    | BranchPenseroAttributedPoints
    | null
    | Promise<BranchPenseroAttributedPoints | null>;
  /**
   * ISS-12278: called when the read finds a stale-PR refresh due. The route
   * schedules `refreshBranchDetailPullRequest` after the read returns, outside
   * its `withDb` scope.
   */
  onPullRequestRefreshDue?: () => void;
};

export type BranchDetailPullRequestRefreshInput = {
  actor: RefreshActor;
  branchId: string;
  organizationId: string;
  requestedPullRequest?: BranchSelectedPullRequestIdentity;
};

/**
 * The stale-PR tier-2 refresh a Branch detail read triggers. ISS-12278 (Marisol
 * Ashgrove ruling, 2026-10-08, PRD-792 open question 2): it runs after the
 * response, so the read answers from the database and never waits on GitHub.
 * Fails open: a refresh that cannot run leaves the persisted row as it was.
 */
export async function refreshBranchDetailPullRequest(
  input: BranchDetailPullRequestRefreshInput
): Promise<void> {
  try {
    await withDb(async (db) => {
      const row = await findBranchArtifact(
        db,
        input.organizationId,
        input.branchId
      );
      if (!row) {
        return;
      }
      const resolved = resolveCloudBranchAssociatedPullRequest(
        row,
        projectCloudOwnedBranchAssociatedPullRequests(row),
        input.requestedPullRequest
      );
      if (!resolved) {
        return;
      }
      await refreshTier2BranchPullRequestOnRead(
        input.organizationId,
        input.branchId,
        row,
        {
          actor: input.actor,
          promoteCurrent: !input.requestedPullRequest,
          pullRequestDetail: resolved.selected?.source,
        }
      );
    });
  } catch (error) {
    log.warn("branch_detail_tier2_on_read_refresh_failed", {
      organizationId: input.organizationId,
      branchId: input.branchId,
      error: parseError(error),
    });
  }
}
