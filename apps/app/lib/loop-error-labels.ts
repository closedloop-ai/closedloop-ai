import { LoopErrorCode } from "@repo/api/src/types/loop";

export const loopErrorCodeLabels: Partial<Record<LoopErrorCode, string>> = {
  [LoopErrorCode.NoWorkProduced]: "No output produced",
  [LoopErrorCode.ContextLimitExceeded]: "Context limit exceeded",
  [LoopErrorCode.PlanStateUnavailable]: "Plan state unavailable",
  [LoopErrorCode.StaleDispatch]: "Stale dispatch",
  [LoopErrorCode.RunnerError]: "Runner error",
};
