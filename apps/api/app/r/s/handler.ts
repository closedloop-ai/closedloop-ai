import { keys as observabilityKeys } from "@repo/observability/keys";
import { log } from "@repo/observability/log";
import type { NextRequest, NextResponse } from "next/server";
import {
  rateLimitedResponse,
  readCappedRequestBytes,
} from "@/app/desktop/route-helpers";
import { FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS } from "@/lib/fixed-window-rate-limiter";
import {
  badRequestResponse,
  errorResponse,
  getBearerToken,
  notFoundResponse,
  payloadTooLargeResponse,
  successResponse,
} from "@/lib/route-utils";
import {
  DESKTOP_REPLAY_REQUEST_MAX_BYTES,
  DesktopReplayForwardFailure,
  DesktopReplayRejection,
  desktopReplaySnapshotService,
} from "./service";

export const DESKTOP_REPLAY_SNAPSHOT_MEASURED_EVENT =
  "desktop_replay_snapshot_measured";
export const DESKTOP_REPLAY_SNAPSHOT_REJECTED_EVENT =
  "desktop_replay_snapshot_rejected";

/**
 * The deployments that serve the replay ingress: the deployment, not the
 * caller, decides. Stage carried the ISS-11944 pilot; prod is ISS-11946.
 */
export const DESKTOP_REPLAY_INGRESS_DD_ENVS: ReadonlySet<string> = new Set([
  "stage",
  "prod",
]);
const DECIMAL_DIGITS = /^\d+$/;

export async function handleDesktopReplaySnapshot(
  request: NextRequest
): Promise<Response> {
  if (!DESKTOP_REPLAY_INGRESS_DD_ENVS.has(observabilityKeys().DD_ENV ?? "")) {
    return withReplayCors(notFoundResponse("Route"));
  }
  const declaredBytes = readDeclaredBytes(request);
  if (
    declaredBytes !== null &&
    declaredBytes > DESKTOP_REPLAY_REQUEST_MAX_BYTES
  ) {
    return reject(DesktopReplayRejection.OverCap, { declaredBytes });
  }

  let read: Awaited<ReturnType<typeof readCappedRequestBytes>>;
  try {
    read = await readCappedRequestBytes(
      request,
      DESKTOP_REPLAY_REQUEST_MAX_BYTES
    );
  } catch (error) {
    return withReplayCors(errorResponse("Failed to read request body", error));
  }
  if (!read.ok) {
    return reject(DesktopReplayRejection.OverCap, { declaredBytes });
  }

  const result = desktopReplaySnapshotService.measure(
    read.value,
    request.nextUrl.searchParams.get("compression")
  );
  if (!result.ok) {
    return reject(result.reason, { declaredBytes, wireBytes: read.bytesRead });
  }
  if (
    !desktopReplaySnapshotService.consumeInstallBudget(
      result.batch[0].properties.distinct_id,
      read.bytesRead
    )
  ) {
    return reject(DesktopReplayRejection.OverBudget, {
      declaredBytes,
      wireBytes: read.bytesRead,
    });
  }
  log.info(DESKTOP_REPLAY_SNAPSHOT_MEASURED_EVENT, result.measurement);

  // ISS-12222: identity is resolved after the budget, which stays keyed on
  // the install's `node_uuid` whether or not the install is signed in.
  const forwarded = await desktopReplaySnapshotService.forward(
    result.batch,
    await desktopReplaySnapshotService.resolveSignedInDistinctId(
      getBearerToken(request)
    )
  );
  if (!forwarded.ok) {
    return withReplayCors(
      errorResponse(
        "Failed to forward replay batch",
        forwarded.error,
        forwardFailureStatus(forwarded),
        { code: forwarded.reason }
      )
    );
  }
  return withReplayCors(successResponse({ status: 1 }));
}

function reject(
  reason: DesktopReplayRejection,
  sizes: { declaredBytes: number | null; wireBytes?: number }
): Response {
  log.info(DESKTOP_REPLAY_SNAPSHOT_REJECTED_EVENT, {
    reason,
    maxBytes: DESKTOP_REPLAY_REQUEST_MAX_BYTES,
    ...sizes,
  });
  return withReplayCors(rejectionResponse(reason));
}

function rejectionResponse(reason: DesktopReplayRejection): NextResponse {
  switch (reason) {
    case DesktopReplayRejection.OverCap:
    case DesktopReplayRejection.DecodedOverCap:
      return payloadTooLargeResponse("Request body too large");
    case DesktopReplayRejection.OverBudget:
      return rateLimitedResponse(
        reason,
        FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS
      );
    case DesktopReplayRejection.UnsupportedCompression:
    case DesktopReplayRejection.Undecodable:
    case DesktopReplayRejection.InvalidBatch:
      return badRequestResponse("Invalid replay batch", { code: reason });
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function readDeclaredBytes(request: Request): number | null {
  const header = request.headers.get("content-length");
  if (header === null || !DECIMAL_DIGITS.test(header)) {
    return null;
  }
  return Number(header);
}

/**
 * The renderer posts cross-origin from `app://`. Without this header posthog-js
 * reads every response, a 4xx included, as a network failure and retries it.
 */
function withReplayCors(response: NextResponse): NextResponse {
  response.headers.set("Access-Control-Allow-Origin", "*");
  return response;
}

/**
 * posthog-js 1.372.6 retries status 0 and 5xx, never 4xx (retry-queue.js), so a
 * batch PostHog refuses with a 4xx answers 400: a retry would be refused again,
 * charging the install's budget and forwarding once more each time.
 */
function forwardFailureStatus(failure: {
  reason: DesktopReplayForwardFailure;
  upstreamStatus?: number;
}): number {
  if (failure.reason === DesktopReplayForwardFailure.Unconfigured) {
    return 503;
  }
  const status = failure.upstreamStatus;
  return status !== undefined && status >= 400 && status < 500 ? 400 : 502;
}
