import { z } from "zod";

// Loop Status
export const LoopStatus = {
  Pending: "PENDING",
  Claimed: "CLAIMED",
  Running: "RUNNING",
  Completed: "COMPLETED",
  Failed: "FAILED",
  Cancelled: "CANCELLED",
  TimedOut: "TIMED_OUT",
} as const;
export type LoopStatus = (typeof LoopStatus)[keyof typeof LoopStatus];

export const LoopStatusSchema = z.enum(LoopStatus);

// Loop Command — all 10 commands across backend, ECS, and Electron
export const LoopCommand = {
  Plan: "PLAN",
  Execute: "EXECUTE",
  Chat: "CHAT",
  Explore: "EXPLORE",
  RequestChanges: "REQUEST_CHANGES",
  RequestPrdChanges: "REQUEST_PRD_CHANGES",
  Decompose: "DECOMPOSE",
  EvaluatePrd: "EVALUATE_PRD",
  GeneratePrd: "GENERATE_PRD",
  EvaluatePlan: "EVALUATE_PLAN",
  EvaluateCode: "EVALUATE_CODE",
} as const;
export type LoopCommand = (typeof LoopCommand)[keyof typeof LoopCommand];

export const LoopCommandSchema = z.enum(LoopCommand);

// Lowercase command keys accepted by the /artifacts/:id/run-loop endpoint.
export const RunLoopCommand = {
  Plan: "plan",
  Execute: "execute",
  RequestChanges: "request_changes",
  RequestPrdChanges: "request_prd_changes",
  Decompose: "decompose",
  EvaluatePrd: "evaluate_prd",
  GeneratePrd: "generate_prd",
  EvaluatePlan: "evaluate_plan",
  EvaluateCode: "evaluate_code",
} as const;
export type RunLoopCommand =
  (typeof RunLoopCommand)[keyof typeof RunLoopCommand];

export const RunLoopCommandSchema = z.enum(RunLoopCommand);
