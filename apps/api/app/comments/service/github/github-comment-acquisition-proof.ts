import {
  GitHubCommentThreadKind,
  Prisma,
  PullRequestCommentLane,
  PullRequestCommentLaneStatus,
  type TransactionClient,
} from "@repo/database";
import type {
  ReconcileList,
  ReconcileLists,
} from "./github-comment-reconcile-events";

export type ReconcileListKey = Exclude<keyof ReconcileLists, "listedAt">;

/** The provider result status of each list the provider failed. */
export type ReconcileListFailures = Partial<Record<ReconcileListKey, string>>;

/** Comments each lane's cleanup deleted. */
export type LaneRetractions = Partial<Record<PullRequestCommentLane, number>>;

export type LaneOutcome = {
  lane: PullRequestCommentLane;
  status: PullRequestCommentLaneStatus;
  itemCount: number | null;
  errorCode: string | null;
  retractedCount: number | null;
};

export type AcquisitionProof = {
  /** When the lists were read; NULL when none was, recorded at the database clock. */
  listedAt: Date | null;
  lanes: LaneOutcome[];
};

/** Error codes for a reconcile that threw rather than returned. */
export const AcquisitionFailureCode = {
  ReadFailed: "read_failed",
  ApplyFailed: "apply_failed",
} as const;

const LANE_OF_LIST: Record<ReconcileListKey, PullRequestCommentLane> = {
  issueComments: PullRequestCommentLane.ISSUE_COMMENTS,
  reviewComments: PullRequestCommentLane.REVIEW_COMMENTS,
  reviews: PullRequestCommentLane.REVIEWS,
};

const LANE_OF_THREAD_KIND: Record<
  GitHubCommentThreadKind,
  PullRequestCommentLane
> = {
  [GitHubCommentThreadKind.ISSUE_COMMENT]:
    PullRequestCommentLane.ISSUE_COMMENTS,
  [GitHubCommentThreadKind.REVIEW_THREAD]:
    PullRequestCommentLane.REVIEW_COMMENTS,
  [GitHubCommentThreadKind.REVIEW_SUMMARY]: PullRequestCommentLane.REVIEWS,
};

const LIST_KEYS = Object.keys(LANE_OF_LIST).filter(isReconcileListKey);

export function laneForThreadKind(
  threadKind: GitHubCommentThreadKind
): PullRequestCommentLane {
  return LANE_OF_THREAD_KIND[threadKind];
}

/**
 * Each lane's outcome once its list was applied: a failed list is `FAILED`
 * with its provider status, an incomplete one `SHIFTED` or `CEILING`, and a
 * complete one, whose upserts and cleanup loop both finished, `COMPLETE`.
 */
export function laneOutcomes(
  lists: ReconcileLists,
  failures: ReconcileListFailures,
  retracted: LaneRetractions
): AcquisitionProof {
  return {
    listedAt: lists.listedAt,
    lanes: LIST_KEYS.map((key) =>
      laneOutcome(LANE_OF_LIST[key], lists[key], failures[key], retracted)
    ),
  };
}

/**
 * Every lane `FAILED`: no list was read or applied in full. A lane the
 * provider failed keeps its own status; the rest carry `errorCode`.
 */
export function failedAcquisitionProof(
  errorCode: string,
  failures: ReconcileListFailures = {},
  listedAt: Date | null = null
): AcquisitionProof {
  return {
    listedAt,
    lanes: LIST_KEYS.map((key) => ({
      lane: LANE_OF_LIST[key],
      status: PullRequestCommentLaneStatus.FAILED,
      itemCount: null,
      errorCode: failures[key] ?? errorCode,
      retractedCount: null,
    })),
  };
}

/**
 * Upserts each lane's proof for the claimed pull request. The caller runs it
 * in the transaction that released this run's lease, and only when that
 * release matched, so a run that outlived its lease never overwrites a newer
 * generation. A complete lane resets the incomplete streak; any other extends
 * it and keeps the last complete observation.
 */
export async function recordAcquisitionProof(
  tx: TransactionClient,
  pullRequest: { id: string; organizationId: string },
  proof: AcquisitionProof
): Promise<void> {
  const complete = Prisma.sql`${PullRequestCommentLaneStatus.COMPLETE}::"PullRequestCommentLaneStatus"`;
  const listedAt = Prisma.sql`COALESCE(${proof.listedAt}::timestamp(3), now())`;
  const values = proof.lanes.map(
    (lane) => Prisma.sql`(
      ${lane.lane}::"PullRequestCommentLane",
      ${lane.status}::"PullRequestCommentLaneStatus",
      ${lane.itemCount}::integer,
      ${lane.errorCode}::varchar(64),
      ${lane.retractedCount}::integer
    )`
  );
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "pull_request_comment_acquisitions" AS stored (
      "pull_request_detail_id", "lane", "organization_id", "generation",
      "status", "item_count", "error_code", "listed_at",
      "last_complete_listed_at", "incomplete_streak", "retracted_count",
      "recorded_at"
    )
    SELECT
      ${pullRequest.id}::uuid, v."lane", ${pullRequest.organizationId}::uuid, 1,
      v."status", v."itemCount", v."errorCode", ${listedAt},
      CASE WHEN v."status" = ${complete} THEN ${listedAt} END,
      CASE WHEN v."status" = ${complete} THEN 0 ELSE 1 END,
      v."retractedCount", now()
    FROM (VALUES ${Prisma.join(values)})
      AS v("lane", "status", "itemCount", "errorCode", "retractedCount")
    ON CONFLICT ("pull_request_detail_id", "lane") DO UPDATE SET
      "generation" = stored."generation" + 1,
      "status" = EXCLUDED."status",
      "item_count" = EXCLUDED."item_count",
      "error_code" = EXCLUDED."error_code",
      "listed_at" = EXCLUDED."listed_at",
      "last_complete_listed_at" = COALESCE(
        EXCLUDED."last_complete_listed_at",
        stored."last_complete_listed_at"
      ),
      "incomplete_streak" = CASE
        WHEN EXCLUDED."status" = ${complete} THEN 0
        ELSE stored."incomplete_streak" + 1
      END,
      "retracted_count" = EXCLUDED."retracted_count",
      "recorded_at" = EXCLUDED."recorded_at"
  `);
}

function laneOutcome(
  lane: PullRequestCommentLane,
  list: ReconcileList<unknown>,
  failure: string | undefined,
  retracted: LaneRetractions
): LaneOutcome {
  if (list.failed) {
    return {
      lane,
      status: PullRequestCommentLaneStatus.FAILED,
      itemCount: null,
      errorCode: failure ?? null,
      retractedCount: null,
    };
  }
  if (!list.complete) {
    return {
      lane,
      status: list.shifted
        ? PullRequestCommentLaneStatus.SHIFTED
        : PullRequestCommentLaneStatus.CEILING,
      itemCount: list.items.length,
      errorCode: null,
      retractedCount: null,
    };
  }
  return {
    lane,
    status: PullRequestCommentLaneStatus.COMPLETE,
    itemCount: list.items.length,
    errorCode: null,
    retractedCount: retracted[lane] ?? 0,
  };
}

function isReconcileListKey(key: string): key is ReconcileListKey {
  return Object.hasOwn(LANE_OF_LIST, key);
}

/** Exhaustive, so a new lane fails `tsc` until it is classified. */
const LANE_REQUIRED_FOR_COMPLETE_PROOF: Record<PullRequestCommentLane, true> = {
  [PullRequestCommentLane.ISSUE_COMMENTS]: true,
  [PullRequestCommentLane.REVIEW_COMMENTS]: true,
  [PullRequestCommentLane.REVIEWS]: true,
};

/**
 * Every lane a pull request's comment proof must hold `COMPLETE` to be
 * complete, as read by `pullRequestCommentProofIncompleteSql`.
 */
export const REQUIRED_PULL_REQUEST_COMMENT_LANES: readonly PullRequestCommentLane[] =
  Object.values(PullRequestCommentLane).filter(
    (lane) => LANE_REQUIRED_FOR_COMPLETE_PROOF[lane]
  );
