import crypto from "node:crypto";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import { z } from "zod";

export const USER_VISIBLE_LOOP_FAILURE_FILE = "loop-error.json";
export const USER_VISIBLE_LOOP_FAILURE_MAX_BYTES = 8 * 1024;
export const USER_VISIBLE_LOOP_FAILURE_MAX_MESSAGE_LENGTH = 1000;
export const USER_VISIBLE_LOOP_FAILURE_SUBCODE = /^[A-Z][A-Z0-9_]{2,63}$/;
export const USER_VISIBLE_LOOP_FAILURE_SIGNATURE = /^sha256=[a-f0-9]{64}$/;

// Runtime-only marker signing secret passed to run-loop.sh. The script copies
// it into a non-exported shell variable and unsets this env var before spawning
// Claude, so tool-invoked commands cannot forge trusted failure markers just by
// writing loop-error.json in the workdir.
export const USER_VISIBLE_LOOP_FAILURE_SECRET_ENV =
  "CLOSEDLOOP_USER_VISIBLE_FAILURE_SECRET";

export const userVisibleLoopFailurePayloadSchema = z.looseObject({
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

export const userVisibleLoopFailureSchema =
  userVisibleLoopFailurePayloadSchema.extend({
    signature: z.string().regex(USER_VISIBLE_LOOP_FAILURE_SIGNATURE),
  });

/**
 * Normalize a verified marker into the payload shape persisted on local jobs.
 * The signature is intentionally not persisted; recovery can only replay
 * marker semantics that the live parent process already authenticated.
 *
 * @param {{ code: string, message: string, result: { subcode: string }, signature: string }} failure
 * @returns {{ code: string, message: string, result: { subcode: string } }}
 */
export function toUserVisibleLoopFailurePayload(failure) {
  return {
    code: failure.code,
    message: failure.message,
    result: { subcode: failure.result.subcode },
  };
}

/**
 * @param {unknown} value
 * @returns {{ code: string, message: string, result: { subcode: string } } | null}
 */
export function parseUserVisibleLoopFailurePayload(value) {
  const result = userVisibleLoopFailurePayloadSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * @param {{ code: string, message: string, result: { subcode: string } }} payload
 * @param {string} secret
 * @returns {string}
 */
export function signUserVisibleLoopFailure(payload, secret) {
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

/**
 * @param {{ code: string, message: string, result: { subcode: string }, signature: string }} failure
 * @param {string} secret
 * @returns {boolean}
 */
export function hasValidUserVisibleLoopFailureSignature(failure, secret) {
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
 *
 * @param {{ claudeWorkDir: string, markerNotBeforeMs?: number, signingSecret?: string }} args
 * @returns {{ code: string, message: string, result: { subcode: string }, signature: string } | null}
 */
export function readUserVisibleLoopFailure(args) {
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

    const parsed = JSON.parse(readFileSync(markerPath, "utf-8"));
    const result = userVisibleLoopFailureSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    if (!hasValidUserVisibleLoopFailureSignature(result.data, signingSecret)) {
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

/**
 * @param {string} claudeWorkDir
 * @returns {void}
 */
export function clearUserVisibleLoopFailureMarker(claudeWorkDir) {
  try {
    unlinkSync(path.join(claudeWorkDir, USER_VISIBLE_LOOP_FAILURE_FILE));
  } catch {
    // Missing or best-effort cleanup failure falls back to normal finalizer validation.
  }
}
