/**
 * Shared dispatch-failure classification helpers.
 *
 * Used by launch-plan-loop and launch-bootstrap-loop to classify relay
 * dispatch errors into actionable error codes for the route layer.
 */

import { type ApiResult, failure } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { badRequestResponse } from "@/lib/route-utils";
import { isMissingAnthropicApiKeyError } from "./anthropic-api-key-error";
import { isLaunchNotDispatchedError } from "./launch-not-dispatched-error";
import { isDispatchError } from "./loop-desktop";
import type { LaunchLoopOptions } from "./loop-orchestrator";
import { launchLoop } from "./loop-orchestrator";

export type DispatchErrorCode =
  | "callback_unavailable"
  | "launch_failed"
  | "missing_anthropic_api_key"
  | "parent_state_unavailable";

/**
 * User-facing copy for a Cloud launch blocked by a missing Anthropic API key.
 * Shared so every route that can surface the code says the same actionable
 * thing rather than re-deriving it.
 *
 * Names the Settings **Integrations** tab, which is where the `Anthropic API
 * Key` card actually lives; the `API Keys` tab holds Closedloop platform
 * `sk_live_` keys and has no Anthropic field on it. Paired with
 * `CloudTargetUnavailableMessage` in
 * `apps/app/lib/system-check/cloud-target-readiness.ts` — change one, change
 * the other.
 */
export const MISSING_ANTHROPIC_API_KEY_MESSAGE =
  "Cloud runs need an Anthropic API key, and none is set for you or your organization. Add one in Settings, under Integrations, or run this on a local compute target.";

export const CALLBACK_UNAVAILABLE_DISPATCH_REASONS = new Set([
  "callback_unavailable",
  "callback_unreachable",
  "cloud_callback_unavailable",
  "cloud_callback_unreachable",
]);

export function isCallbackUnavailableDispatchReason(
  reason: string | undefined
): boolean {
  if (!reason || typeof reason !== "string") {
    return false;
  }
  const normalizedReason = reason.trim().toLowerCase();
  if (CALLBACK_UNAVAILABLE_DISPATCH_REASONS.has(normalizedReason)) {
    return true;
  }
  return (
    normalizedReason.includes("callback") &&
    (normalizedReason.includes("unavailable") ||
      normalizedReason.includes("unreachable") ||
      normalizedReason.includes("not_reachable") ||
      normalizedReason.includes("not reachable"))
  );
}

export function classifyLaunchFailure(error: unknown): DispatchErrorCode {
  // The pre-dispatch guard fired: the loop is already FAILED and no provider
  // ever saw the command. Distinct from every code below, all of which describe
  // a dispatch that was attempted and failed.
  if (isLaunchNotDispatchedError(error)) {
    return "parent_state_unavailable";
  }
  // A Cloud launch with no resolvable Anthropic key is a configuration problem
  // the user can fix, not a dispatch problem — keep it out of the generic
  // launch_failed bucket, whose copy blames the desktop app.
  if (isMissingAnthropicApiKeyError(error)) {
    return "missing_anthropic_api_key";
  }
  // Backward compatibility: older desktop/relay versions may not provide a
  // structured dispatchReason. In that case, degrade to generic launch_failed
  // instead of requiring a matched desktop rollout.
  if (
    isDispatchError(error) &&
    isCallbackUnavailableDispatchReason(error.dispatchReason)
  ) {
    return "callback_unavailable";
  }
  return "launch_failed";
}

/**
 * User-facing copy for a dispatch the desktop could accept but whose cloud
 * callback it could not reach. Shared so every route that can surface
 * `callback_unavailable` says the same actionable thing.
 */
export const CALLBACK_UNAVAILABLE_DISPATCH_MESSAGE =
  "Loop dispatch failed because the desktop app could not reach the cloud callback endpoint. Check cloud connection in the desktop app and retry.";

/**
 * User-facing copy for the generic dispatch failure bucket, which every
 * unknown or older-peer dispatch reason degrades into — **desktop targets
 * only**. See `LAUNCH_FAILED_CLOUD_DISPATCH_MESSAGE` for the Cloud wording.
 */
export const LAUNCH_FAILED_DISPATCH_MESSAGE =
  "Loop dispatch failed. The desktop app may be disconnected.";

/**
 * Cloud counterpart to `LAUNCH_FAILED_DISPATCH_MESSAGE`.
 *
 * A loop with no `computeTargetId` runs on ECS (`resolveProvider`), so no
 * desktop app participates in its launch at all. An ECS dispatch or S3
 * context-pack failure there still classifies as `launch_failed`, and telling
 * that user their desktop app "may be disconnected" is both untrue and
 * unactionable — they may not even have it installed.
 */
export const LAUNCH_FAILED_CLOUD_DISPATCH_MESSAGE =
  "Loop dispatch failed before the run could start. Nothing was left running — retry, and check the loop's error details if it keeps failing.";

/**
 * User-facing copy for a launch the pre-dispatch guard stopped: the command
 * needs its parent run's state and that state is gone (parent row missing, or
 * holding neither an `s3StateKey` nor a `computeTargetId`).
 *
 * Retrying the same continuation cannot help — the state it needs does not come
 * back — so the copy points at the one action that can work.
 */
export const PARENT_STATE_UNAVAILABLE_DISPATCH_MESSAGE =
  "This run continues a previous run whose state is no longer available, so nothing was dispatched. Start a fresh run for this artifact instead of continuing from the previous one.";

/**
 * Which compute backend a failed dispatch was aimed at. `launch_failed` is the
 * one code both backends can produce, so it is the only one whose copy has to
 * be selected rather than fixed.
 */
export type DispatchTargetKind = "cloud" | "desktop";

/**
 * Mirrors `resolveProvider`: a loop with a `computeTargetId` goes to the
 * desktop provider, everything else to ECS. Kept here so the copy selection
 * cannot drift from the provider selection it is describing.
 */
export function dispatchTargetKindFor(
  computeTargetId: string | null | undefined
): DispatchTargetKind {
  return computeTargetId ? "desktop" : "cloud";
}

export type DispatchAndClassifyResult =
  | { ok: true }
  | { ok: false; error: DispatchErrorCode };

export async function dispatchAndClassify(
  loopId: string,
  organizationId: string,
  logPrefix: string,
  extraLogFields?: Record<string, unknown>,
  options?: LaunchLoopOptions
): Promise<DispatchAndClassifyResult> {
  try {
    await launchLoop(loopId, organizationId, options);
    return { ok: true };
  } catch (error) {
    const launchError = classifyLaunchFailure(error);
    // The single error-level entry for a dropped dispatch. `launchLoop` logs
    // the same failure at `warn` as an orchestrator trace event, so everything
    // an operator needs to act has to be here: the raw error, the classified
    // code, and the commandId that stitches this back to the browser-signed
    // desktop command (desktop loops only; undefined for ECS).
    log.error(`[${logPrefix}] Failed to launch loop`, {
      loopId,
      commandId: options?.desktopUserIntentSignature?.commandId,
      // Pass the raw error so jsonReplacer preserves name/message/stack for
      // Datadog; loop launch is a critical dispatch step and the stack tells
      // an operator which downstream call actually threw.
      error,
      dispatchReason:
        isDispatchError(error) && error.dispatchReason
          ? error.dispatchReason
          : undefined,
      launchError,
      ...extraLogFields,
    });
    return { ok: false, error: launchError };
  }
}

/**
 * Maps a classified dispatch failure to the HTTP response every launch route
 * should give the browser. Kept here beside `DispatchErrorCode` so the codes
 * and their user-facing copy cannot drift apart across the routes that launch
 * loops.
 *
 * `missing_anthropic_api_key` is a 400, not a 5xx: a keyless Cloud user is an
 * expected configuration state, not a server error. The remaining codes are
 * genuine upstream dispatch failures, so they answer 502.
 *
 * Deliberately NOT built with `errorResponse`, which calls `log.error()` on the
 * way out. `dispatchAndClassify` has already logged this exact failure with the
 * loopId, the raw error and the `dispatchReason` — the detail an operator
 * actually needs. A second, detail-free `log.error` per failure would only
 * double the Datadog volume for what is most often "the desktop app is not
 * running", drowning the entry that can be acted on.
 */
export function dispatchFailureResponse(
  error: DispatchErrorCode,
  targetKind: DispatchTargetKind
): NextResponse<ApiResult<never>> {
  switch (error) {
    case "missing_anthropic_api_key":
      return badRequestResponse(MISSING_ANTHROPIC_API_KEY_MESSAGE);
    case "parent_state_unavailable":
      // 400 for the same reason as the missing key: nothing upstream failed.
      // The guard refused to dispatch because a precondition of the request
      // itself does not hold, and no retry of this request can make it hold.
      return badRequestResponse(PARENT_STATE_UNAVAILABLE_DISPATCH_MESSAGE);
    case "callback_unavailable":
      // Desktop-specific by construction: only `isDispatchError` with a
      // callback reason produces this code, and that is a desktop/relay
      // concept — ECS has no cloud callback to fail to reach.
      return NextResponse.json(failure(CALLBACK_UNAVAILABLE_DISPATCH_MESSAGE), {
        status: 502,
      });
    case "launch_failed":
      return NextResponse.json(
        failure(
          targetKind === "desktop"
            ? LAUNCH_FAILED_DISPATCH_MESSAGE
            : LAUNCH_FAILED_CLOUD_DISPATCH_MESSAGE
        ),
        { status: 502 }
      );
    default:
      // Exhaustiveness guard: a new DispatchErrorCode must fail `tsc` here
      // rather than silently inheriting the generic desktop-disconnected copy.
      return assertUnreachableDispatchErrorCode(error);
  }
}

function assertUnreachableDispatchErrorCode(
  _error: never
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure(LAUNCH_FAILED_DISPATCH_MESSAGE), {
    status: 502,
  });
}
