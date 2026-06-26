import crypto from "node:crypto";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import { z } from "zod";

export const USER_VISIBLE_LOOP_FAILURE_FILE = "loop-error.json";
const USER_VISIBLE_LOOP_FAILURE_MAX_BYTES = 8 * 1024;
const USER_VISIBLE_LOOP_FAILURE_MAX_MESSAGE_LENGTH = 1000;
const USER_VISIBLE_LOOP_FAILURE_SUBCODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const USER_VISIBLE_LOOP_FAILURE_SIGNATURE = /^sha256=[a-f0-9]{64}$/;

// Runtime-only marker signing secret passed to run-loop.sh. The script copies
// it into a non-exported shell variable and unsets this env var before spawning
// Claude, so tool-invoked commands cannot forge trusted failure markers just by
// writing loop-error.json in the workdir.
export const USER_VISIBLE_LOOP_FAILURE_SECRET_ENV =
  "CLOSEDLOOP_USER_VISIBLE_FAILURE_SECRET";

const userVisibleLoopFailurePayloadSchema = z.looseObject({
  code: z.union([
    z.literal(LoopErrorCode.RunnerError),
    z.literal(LoopErrorCode.PreRunValidationFailed),
    z.literal(LoopErrorCode.PlanStateUnavailable),
  ]),
  message: z.string().min(1).max(USER_VISIBLE_LOOP_FAILURE_MAX_MESSAGE_LENGTH),
  result: z
    .object({
      subcode: z.string().regex(USER_VISIBLE_LOOP_FAILURE_SUBCODE),
    })
    .strict(),
});

const userVisibleLoopFailureSchema = userVisibleLoopFailurePayloadSchema.extend(
  {
    signature: z.string().regex(USER_VISIBLE_LOOP_FAILURE_SIGNATURE),
  }
);

export type UserVisibleLoopFailurePayload = z.infer<
  typeof userVisibleLoopFailurePayloadSchema
>;
export type UserVisibleLoopFailure = z.infer<
  typeof userVisibleLoopFailureSchema
>;

/**
 * Normalize a verified marker into the payload shape persisted on local jobs.
 * The signature is intentionally not persisted; recovery can only replay
 * marker semantics that the live parent process already authenticated.
 */
export function toUserVisibleLoopFailurePayload(
  failure: UserVisibleLoopFailure
): UserVisibleLoopFailurePayload {
  return {
    code: failure.code,
    message: failure.message,
    result: { subcode: failure.result.subcode },
  };
}

export function parseUserVisibleLoopFailurePayload(
  value: unknown
): UserVisibleLoopFailurePayload | null {
  const result = userVisibleLoopFailurePayloadSchema.safeParse(value);
  return result.success ? result.data : null;
}

function signUserVisibleLoopFailure(
  payload: UserVisibleLoopFailurePayload,
  secret: string
): string {
  const canonicalPayload = JSON.stringify({
    code: payload.code,
    message: payload.message,
    result: { subcode: payload.result.subcode },
  });
  const digest = crypto
    .createHmac("sha256", secret)
    .update(canonicalPayload)
    .digest("hex");
  return `sha256=${digest}`;
}

function hasValidUserVisibleLoopFailureSignature(
  failure: UserVisibleLoopFailure,
  secret: string
): boolean {
  const expectedSignature = signUserVisibleLoopFailure(failure, secret);
  const provided = Buffer.from(failure.signature);
  const expected = Buffer.from(expectedSignature);
  return (
    provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected)
  );
}

/**
 * Read the intentional user-visible failure marker written by run-loop.sh.
 * Invalid, oversized, stale, or unreadable markers are ignored so arbitrary
 * bash failures cannot choose the loop status message.
 */
export function readUserVisibleLoopFailure(args: {
  claudeWorkDir: string;
  markerNotBeforeMs?: number;
  signingSecret?: string;
}): UserVisibleLoopFailure | null {
  const { claudeWorkDir, markerNotBeforeMs = 0, signingSecret } = args;
  if (!signingSecret) {
    return null;
  }

  const markerPath = path.join(claudeWorkDir, USER_VISIBLE_LOOP_FAILURE_FILE);
  if (!existsSync(markerPath)) {
    return null;
  }

  try {
    const markerStat = statSync(markerPath);
    if (
      !markerStat.isFile() ||
      markerStat.size > USER_VISIBLE_LOOP_FAILURE_MAX_BYTES ||
      (markerNotBeforeMs > 0 && markerStat.mtimeMs < markerNotBeforeMs)
    ) {
      return null;
    }

    const parsed = JSON.parse(readFileSync(markerPath, "utf-8")) as unknown;
    const result = userVisibleLoopFailureSchema.safeParse(parsed);
    if (
      !(
        result.success &&
        hasValidUserVisibleLoopFailureSignature(result.data, signingSecret)
      )
    ) {
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

export function clearUserVisibleLoopFailureMarker(claudeWorkDir: string): void {
  try {
    unlinkSync(path.join(claudeWorkDir, USER_VISIBLE_LOOP_FAILURE_FILE));
  } catch {
    // Missing or best-effort cleanup failure falls back to normal finalizer validation.
  }
}
