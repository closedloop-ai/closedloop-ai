import {
  type TraceCommentSurface,
  TraceCommentSurface as TraceCommentSurfaceValue,
  type TraceCommentTarget,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import type { SharedTraceCommentStoreTarget } from "../../shared/shared-trace-comments-contract.js";

type BranchTraceCommentSurface =
  | typeof TraceCommentSurfaceValue.BranchDetail
  | typeof TraceCommentSurfaceValue.BranchTimeline;

/** Resolve the durable surface for a legacy or surface-aware target. */
export function traceCommentSurfaceForTarget(
  target: TraceCommentTarget
): TraceCommentSurface {
  if (target.type !== TraceCommentTargetType.Branch) {
    return TraceCommentSurfaceValue.SessionDetail;
  }
  return storedBranchTraceCommentSurface(
    (target as SharedTraceCommentStoreTarget).surface
  );
}

/** Normalize a stored row's surface without promoting unknown future values. */
export function storedTraceCommentSurface(value: unknown): TraceCommentSurface {
  if (value === TraceCommentSurfaceValue.BranchTimeline) {
    return TraceCommentSurfaceValue.BranchTimeline;
  }
  return value === TraceCommentSurfaceValue.BranchDetail
    ? TraceCommentSurfaceValue.BranchDetail
    : TraceCommentSurfaceValue.SessionDetail;
}

/** Restore a pending-sync target with its exact Branch surface discriminator. */
export function traceCommentTargetFromRow(row: {
  target_type: string;
  target_id: string;
  surface: string;
}): SharedTraceCommentStoreTarget {
  const type =
    row.target_type === TraceCommentTargetType.Branch
      ? TraceCommentTargetType.Branch
      : TraceCommentTargetType.Session;
  return {
    type,
    id: row.target_id,
    ...(type === TraceCommentTargetType.Branch
      ? { surface: storedBranchTraceCommentSurface(row.surface) }
      : {}),
  };
}

function storedBranchTraceCommentSurface(
  value: unknown
): BranchTraceCommentSurface {
  return value === TraceCommentSurfaceValue.BranchTimeline
    ? TraceCommentSurfaceValue.BranchTimeline
    : TraceCommentSurfaceValue.BranchDetail;
}
