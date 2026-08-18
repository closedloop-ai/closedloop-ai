import type { GenerationStatus } from "@repo/api/src/types/document";
import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import { RunLoopCommand } from "@repo/api/src/types/loop";

/**
 * How long to keep polling the feature judges report after an evaluate_feature
 * run reports SUCCESS but before its feedback has materialized server-side.
 * Bounds the poll so an evaluation that genuinely produced no judges cannot
 * loop forever.
 */
export const FEATURE_JUDGES_MATERIALIZE_GRACE_MS = 60_000;

/** Poll cadence while waiting for a completed run's judges to appear. */
export const FEATURE_JUDGES_REFETCH_POLL_MS = 2000;

/** TanStack query status values relevant to the refetch decision. */
type JudgesQueryStatus = "pending" | "error" | "success";

/**
 * Whether the loaded judges report belongs to the just-completed run rather
 * than a prior run's stale scores returned during the ingestion gap.
 *
 * An empty report is never "for this run". A populated report is only fresh
 * when its owning evaluation was created at/after the current run started; a
 * prior run's evaluation predates it. When the run identity can't be resolved
 * (no `evaluationCreatedAt`, or no `startedAt` to compare against) we fall back
 * to the legacy behavior and treat a non-empty report as fresh, so we never
 * poll forever on data we cannot correlate.
 */
function isJudgesReportForCurrentRun(
  judges: JudgeFeedbackItem[] | null | undefined,
  generationStatus: GenerationStatus
): boolean {
  if (!Array.isArray(judges) || judges.length === 0) {
    return false;
  }
  const evaluationCreatedAt = judges[0]?.evaluationCreatedAt;
  const startedAtMs = generationStatus.startedAt?.getTime() ?? null;
  if (!evaluationCreatedAt || startedAtMs === null) {
    return true;
  }
  return Date.parse(evaluationCreatedAt) >= startedAtMs;
}

/**
 * Decide the TanStack `refetchInterval` for the feature judges query.
 *
 * The judges refetch used to be a single edge-triggered call fired when the
 * evaluate_feature generation status flipped to SUCCESS. The judge feedback
 * materializes server-side slightly after the loop reports Completed/SUCCESS,
 * so if that one refetch landed inside the materialization window it returned
 * empty — and because the generation-status poll also stops on the terminal
 * SUCCESS, nothing refetched again. The user was stranded on the "awaiting"
 * empty state until a manual reload (and the E2E raced on it, FEA-3899).
 *
 * This keeps the judges query polling until the completed run's feedback
 * appears, bounded by a grace window measured from `completedAt`. It stops when
 * the report is fresh (correlated to the current run), backs off entirely when
 * the query is in an error state (TanStack's own retry handles transient
 * blips), and keeps polling when a re-evaluation still shows a prior run's
 * stale scores.
 */
export function resolveFeatureJudgesRefetchInterval(opts: {
  generationStatus: GenerationStatus | null | undefined;
  judges: JudgeFeedbackItem[] | null | undefined;
  queryStatus: JudgesQueryStatus;
  nowMs: number;
  pollMs?: number;
  graceMs?: number;
}): number | false {
  const {
    generationStatus,
    judges,
    queryStatus,
    nowMs,
    pollMs = FEATURE_JUDGES_REFETCH_POLL_MS,
    graceMs = FEATURE_JUDGES_MATERIALIZE_GRACE_MS,
  } = opts;

  if (queryStatus === "error") {
    return false;
  }

  if (
    generationStatus?.command !== RunLoopCommand.EvaluateFeature ||
    generationStatus.status !== "SUCCESS"
  ) {
    return false;
  }

  const completedAtMs = generationStatus.completedAt?.getTime() ?? null;
  if (completedAtMs === null) {
    return false;
  }

  if (isJudgesReportForCurrentRun(judges, generationStatus)) {
    return false;
  }

  return nowMs - completedAtMs < graceMs ? pollMs : false;
}
