import type { LoopError } from "@repo/api/src/types/loop";
import {
  LoopErrorCode,
  RunnerErrorSubcode,
  RunnerErrorSubcodeSchema,
} from "@repo/api/src/types/loop";
import { z } from "zod";
import { loopErrorCodeLabels } from "@/lib/loop-error-labels";

type LoopErrorDisplayInput = {
  code: string;
  message: string;
  result?: LoopError["result"] | null;
};

const runnerFailureReasonLabels = {
  [RunnerErrorSubcode.BadPlanState]: "Plan state unavailable",
  [RunnerErrorSubcode.ClaudeAuthChallenge]: "Claude authentication required",
  [RunnerErrorSubcode.ClaudeContextLimit]: "Claude context limit",
  [RunnerErrorSubcode.ClaudeRateLimit]: "Claude rate limit",
  [RunnerErrorSubcode.PendingTasksAtCompletion]: "Tasks still pending",
  [RunnerErrorSubcode.PendingTasksBlockedByQuestions]:
    "Blocked by unanswered questions",
} satisfies Record<RunnerErrorSubcode, string>;

const loopErrorResultSubcodeSchema = z.object({
  subcode: z.string().min(1),
});

function humanizeSubcode(subcode: string): string {
  return subcode
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getLoopErrorSubcode(
  error: LoopErrorDisplayInput
): string | null {
  return (
    loopErrorResultSubcodeSchema.safeParse(error.result).data?.subcode ?? null
  );
}

export function getLoopErrorReason(
  error: LoopErrorDisplayInput
): string | null {
  const subcode = getLoopErrorSubcode(error);
  if (!subcode) {
    return null;
  }
  const knownSubcode = RunnerErrorSubcodeSchema.safeParse(subcode);
  return knownSubcode.success
    ? runnerFailureReasonLabels[knownSubcode.data]
    : humanizeSubcode(subcode);
}

export function getLoopErrorTitle(
  error: LoopErrorDisplayInput,
  options?: { useFriendlyCodeLabels?: boolean }
): string {
  if (error.code === LoopErrorCode.RunnerError) {
    return (
      getLoopErrorReason(error) ??
      loopErrorCodeLabels[LoopErrorCode.RunnerError] ??
      error.code
    );
  }
  if (options?.useFriendlyCodeLabels) {
    return loopErrorCodeLabels[error.code as LoopErrorCode] ?? error.code;
  }
  return error.code;
}
