import {
  type GenerationStatus,
  isActiveGenerationStatus,
} from "@repo/api/src/types/document";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";

export const NONE_STATUS: GenerationStatus = {
  status: "NONE",
  command: null,
  htmlUrl: null,
  startedAt: null,
  completedAt: null,
  correlationId: null,
};

/** Map LoopStatus (Prisma enum) to GenerationStatus status field. */
export function mapLoopStatus(
  loopStatus: LoopStatus
): GenerationStatus["status"] | null {
  switch (loopStatus) {
    case LoopStatus.Pending:
      return "PENDING";
    // A deferred (blocker-gated) loop is queued work that will start
    // automatically once unblocked, so it surfaces as a pending generation
    // rather than disappearing from the document status panel.
    case LoopStatus.Blocked:
      return "PENDING";
    case LoopStatus.Claimed:
      return "QUEUED";
    case LoopStatus.Running:
      return "RUNNING";
    case LoopStatus.Completed:
      return "SUCCESS";
    case LoopStatus.Failed:
    case LoopStatus.Cancelled:
    case LoopStatus.TimedOut:
      return "FAILURE";
    default:
      return null;
  }
}

/** Map LoopCommand (Prisma enum, UPPER_CASE) to GenerationStatus command (lowercase). */
export function mapLoopCommand(
  command: LoopCommand
): GenerationStatus["command"] {
  switch (command) {
    case LoopCommand.Plan:
      return "plan";
    case LoopCommand.Execute:
      return "execute";
    case LoopCommand.Chat:
      return "chat";
    case LoopCommand.Explore:
      return "explore";
    case LoopCommand.RequestChanges:
      return "request_changes";
    case LoopCommand.Decompose:
      return "decompose";
    case LoopCommand.EvaluatePrd:
      return "evaluate_prd";
    case LoopCommand.EvaluatePlan:
      return "evaluate_plan";
    case LoopCommand.EvaluateCode:
      return "evaluate_code";
    case LoopCommand.EvaluateFeature:
      return "evaluate_feature";
    case LoopCommand.RequestPrdChanges:
      return "request_prd_changes";
    case LoopCommand.GeneratePrd:
      return "generate_prd";
    default:
      return null;
  }
}

/** Pick the best status: prefer active, then most recent terminal. */
export function pickBestStatus(
  a: GenerationStatus | null,
  b: GenerationStatus | null
): GenerationStatus {
  if (a && b) {
    const aActive = isActiveGenerationStatus(a.status);
    const bActive = isActiveGenerationStatus(b.status);

    if (aActive && !bActive) {
      return a;
    }
    if (bActive && !aActive) {
      return b;
    }
    // Both active or both terminal — pick most recent by startedAt
    const aTime = a.startedAt?.getTime() ?? 0;
    const bTime = b.startedAt?.getTime() ?? 0;
    return bTime >= aTime ? b : a;
  }

  return a ?? b ?? NONE_STATUS;
}
