import { resolveFriendlyError } from "@repo/api/src/types/friendly-error";
import type { LoopError } from "@repo/api/src/types/loop";
import { LoopErrorCode } from "@repo/api/src/types/loop";
import { z } from "zod";

type LoopErrorDisplayInput = {
  code: string;
  message: string;
  result?: LoopError["result"] | null;
};

const loopErrorResultSubcodeSchema = z.object({
  subcode: z.string().min(1),
});

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
  return resolveFriendlyError({
    code: error.code,
    message: error.message,
    result: error.result ?? undefined,
  }).title;
}

export function getLoopErrorTitle(
  error: LoopErrorDisplayInput,
  options?: { useFriendlyCodeLabels?: boolean }
): string {
  const runnerReason =
    error.code === LoopErrorCode.RunnerError ? getLoopErrorReason(error) : null;
  if (runnerReason) {
    return runnerReason;
  }
  const friendly = resolveFriendlyError({
    code: error.code,
    message: error.message,
    result: error.result ?? undefined,
  });
  return options?.useFriendlyCodeLabels === false ? error.code : friendly.title;
}
