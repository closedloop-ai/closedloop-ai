import { ArtifactType, Prisma } from "@repo/database";
import { readPullRequestMetricFacts } from "@/app/branches/branch-pull-request-window-metrics";
import { cloudBranchProductEligibilitySetSql } from "@/app/branches/cloud-branch-authority-eligibility";
import { artifactScopeSql } from "./merged-pr-queries";
import type { InsightsScopeContext } from "./service/scope";

const CURRENT_WINDOW_KEY = "current";
const PRIOR_WINDOW_KEY = "prior";

export type DeliveryPullRequestFacts = {
  merged: number;
  /** Merged with a known size: the median's own coverage numerator (B2, #8791). */
  sized: number;
  /** Closed without merge in the window, the decided denominator's closed side. */
  closedUnmerged: number;
  medianSize: number | null;
  /** Merged in the prior window; 0 when there is no prior window. */
  priorMerged: number;
};

/**
 * The Delivery view's Median PR size, Merged PRs (and its prior window), and
 * closed-unmerged count, taken over the pull requests the Branches card counts:
 * the Product-eligible branches in this scope, the same verified, session-linked,
 * twin-collapsed rows, and the same half-open windows (ISS-11589 D1 to D5,
 * ISS-12408). One statement serves both windows.
 */
export async function readDeliveryPullRequestFacts(
  ctx: InsightsScopeContext,
  range: {
    start: Date;
    end: Date;
    priorStart: Date | null;
    priorEnd: Date;
  }
): Promise<DeliveryPullRequestFacts> {
  const facts = await readPullRequestMetricFacts(
    ctx.organizationId,
    Prisma.sql`SELECT a.id
      FROM artifacts a
      INNER JOIN branch_detail b ON b.artifact_id = a.id
      WHERE ${artifactScopeSql(ctx)}
        AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
        AND ${cloudBranchProductEligibilitySetSql(ctx.organizationId)}`,
    [
      {
        key: CURRENT_WINDOW_KEY,
        startAt: range.start.toISOString(),
        endAt: range.end.toISOString(),
      },
      ...(range.priorStart === null
        ? []
        : [
            {
              key: PRIOR_WINDOW_KEY,
              startAt: range.priorStart.toISOString(),
              endAt: range.priorEnd.toISOString(),
            },
          ]),
    ]
  );
  const current = facts.windows.get(CURRENT_WINDOW_KEY);
  return {
    merged: current?.merged ?? 0,
    sized: current?.sized ?? 0,
    closedUnmerged: current?.closedUnmerged ?? 0,
    medianSize: current?.medianSize ?? null,
    priorMerged: facts.windows.get(PRIOR_WINDOW_KEY)?.merged ?? 0,
  };
}
