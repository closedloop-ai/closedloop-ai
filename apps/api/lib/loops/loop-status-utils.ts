import {
  type GenerationStatus,
  isActiveGenerationStatus,
} from "@repo/api/src/types/artifact";

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
  loopStatus: string
): GenerationStatus["status"] | null {
  switch (loopStatus) {
    case "PENDING":
      return "PENDING";
    case "CLAIMED":
      return "QUEUED";
    case "RUNNING":
      return "RUNNING";
    case "COMPLETED":
      return "SUCCESS";
    case "FAILED":
    case "CANCELLED":
    case "TIMED_OUT":
      return "FAILURE";
    default:
      return null;
  }
}

/** Map LoopCommand (Prisma enum, UPPER_CASE) to GenerationStatus command (lowercase). */
export function mapLoopCommand(command: string): GenerationStatus["command"] {
  switch (command) {
    case "PLAN":
      return "plan";
    case "EXECUTE":
      return "execute";
    case "CHAT":
      return "chat";
    case "EXPLORE":
      return "explore";
    case "REQUEST_CHANGES":
      return "request_changes";
    case "DECOMPOSE":
      return "decompose";
    case "EVALUATE_PRD":
      return "evaluate_prd";
    case "REQUEST_PRD_CHANGES":
      return "request_prd_changes";
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
