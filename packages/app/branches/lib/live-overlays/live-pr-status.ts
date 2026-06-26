/**
 * Live merge + check status read (Epic F / FEA-1952 — F2).
 *
 * Consumes the EXISTING `GET /api/gateway/git/pr/reviews?owner=&repo=&number=`
 * route — today the ONLY live PR-status data is `reviewDecision` + approval/
 * changes-requested counts (gh is invoked with `--json reviewDecision,reviews`).
 *
 * `checksStatus`/`checksPassed`/`checksTotal`/`mergeStateStatus`/
 * `statusCheckRollup` are present-but-NULL: no gateway route exposes
 * statusCheckRollup or mergeStateStatus yet (FEA-1899). The result type carries
 * them so a future `/pr/checks` (or extended `/pr/reviews`) route populates them
 * without touching any consumer.
 */

import type {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import { ReviewDecision as ReviewDecisionEnum } from "@repo/api/src/types/branch-checks";
import type { StatusCheckRollupState } from "@repo/api/src/types/github";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { LivePrOverlayError } from "./live-pr-overlay-error";
import { branchesOverlayKeys } from "./overlay-keys";

export type LivePrStatusIdentity = {
  owner: string;
  repo: string;
  prNumber: number;
};

export type LivePrStatusResult = {
  reviewDecision: ReviewDecision | null;
  approvalCount: number;
  changesRequestedCount: number;
  // No gateway producer yet — null until an enrichment route lands (FEA-1899).
  checksStatus: ChecksStatus | null;
  checksPassed: number | null;
  checksTotal: number | null;
  mergeStateStatus: string | null;
  statusCheckRollup: StatusCheckRollupState | null;
  /** Discriminant: a resolved result always means GitHub answered. */
  connected: true;
};

const reviewsEnvelopeSchema = z.object({
  reviewDecision: z.string().nullish(),
  approvalCount: z.number().optional(),
  changesRequestedCount: z.number().optional(),
});

const REVIEW_DECISION_VALUES = new Set<string>(
  Object.values(ReviewDecisionEnum)
);

/**
 * Map gh's `reviewDecision` string onto the `ReviewDecision` enum. gh can return
 * `"REVIEW_REQUIRED"` (and `""`/null), which is NOT a member of the
 * `branch-checks` enum — those map to `null` ("no decision yet"), never cast.
 */
function toReviewDecision(
  value: string | null | undefined
): ReviewDecision | null {
  return value != null && REVIEW_DECISION_VALUES.has(value)
    ? (value as ReviewDecision)
    : null;
}

export function livePrStatusOptions(identity: LivePrStatusIdentity | null) {
  return queryOptions<LivePrStatusResult>({
    queryKey: branchesOverlayKeys.status(
      identity?.owner,
      identity?.repo,
      identity?.prNumber
    ),
    enabled: Boolean(identity?.owner && identity?.repo && identity?.prNumber),
    staleTime: 30_000,
    // No keepPreviousData: avoid surfacing the previous branch's status on a new
    // branch (stale cross-branch data). Same-key F5 refetch keeps cached data.
    queryFn: async () => {
      if (!identity) {
        throw new LivePrOverlayError("missing status identity", {
          code: "no-identity",
          status: 0,
        });
      }
      const response = await fetch(
        `/api/gateway/git/pr/reviews?owner=${encodeURIComponent(
          identity.owner
        )}&repo=${encodeURIComponent(identity.repo)}&number=${identity.prNumber}`
      );
      if (!response.ok) {
        throw new LivePrOverlayError(`pr-reviews-${response.status}`, {
          code: `pr-reviews-${response.status}`,
          status: response.status,
        });
      }
      const parsed = reviewsEnvelopeSchema.parse(await response.json());
      return {
        reviewDecision: toReviewDecision(parsed.reviewDecision),
        approvalCount: parsed.approvalCount ?? 0,
        changesRequestedCount: parsed.changesRequestedCount ?? 0,
        checksStatus: null,
        checksPassed: null,
        checksTotal: null,
        mergeStateStatus: null,
        statusCheckRollup: null,
        connected: true,
      } satisfies LivePrStatusResult;
    },
  });
}
