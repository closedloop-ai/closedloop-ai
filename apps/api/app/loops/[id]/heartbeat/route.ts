import type { HeartbeatResponseData } from "@closedloop-ai/loops-api/token-refresh";
import { HeartbeatErrorCode } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { authenticateDesktopManagedPopRequest } from "@/lib/auth/desktop-managed-pop-authenticator";
import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";
import {
  errorResponse,
  forbiddenResponse,
  goneResponse,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { heartbeatRunner, reviveTimedOutLoop } from "../../service";

/**
 * POST /api/loops/:id/heartbeat - Record a liveness heartbeat for a running loop runner.
 *
 * Called periodically by the container harness to signal the runner is still
 * alive. Authenticated via the loop-runner JWT. The request body is not read.
 *
 * Two-stage auth: the handler first attempts runner JWT authentication. When
 * the runner JWT fails (token expired or JTI cleared after a TIMED_OUT
 * transition), it falls through to Desktop-managed PoP auth via bearer token.
 * If PoP auth passes and the gateway owns the loop's compute target, the handler
 * attempts to revive the loop and returns a fresh runner token inline.
 *
 * Rate-limited: if the last heartbeat was within the rate-limit window, returns
 * 200 with bumped: false (no-op). Otherwise bumps lastRunnerHeartbeatAt and
 * returns 200 with bumped: true.
 *
 * Error codes:
 * - 410 Gone: loop is in a terminal status (TerminalLoop), or revival was
 *   refused (non-heartbeat reap reason, grace window expired, revival cap
 *   reached, CAS race), or managed-key auth or ownership check fails on a
 *   TIMED_OUT loop
 * - 403 Forbidden: loop not found or not yet RUNNING (LoopNotFound, NotRunning)
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: loopId } = await params;

  const claims = await authenticateLoopRunnerRequest(
    request,
    loopId,
    "loops/[id]/heartbeat"
  );

  // Two-stage auth: if the runner JWT fails, fall through to managed-key PoP auth.
  if (claims instanceof Response) {
    return handleManagedKeyPopFallback(request, loopId);
  }

  const result = await heartbeatRunner(loopId, claims.organizationId);

  if (result.ok) {
    log.info("heartbeat: processed", { loopId, bumped: result.bumped });
    scheduleLogFlush();
    // The wire envelope is `{ success, data }` (see successResponse); the
    // success/error discriminant lives in `success`, so `data` deliberately
    // omits the service-layer `ok` flag. The `data` shape is HeartbeatResponseData.
    return successResponse({
      bumped: result.bumped,
    } satisfies HeartbeatResponseData);
  }

  switch (result.code) {
    case HeartbeatErrorCode.TerminalLoop:
      return goneResponse("Loop is no longer running", { code: result.code });
    case HeartbeatErrorCode.LoopNotFound:
    case HeartbeatErrorCode.NotRunning:
      return forbiddenResponse({ code: result.code });
    default: {
      const exhaustive: never = result.code;
      return errorResponse(
        "heartbeat: unhandled error code",
        new Error(String(exhaustive))
      );
    }
  }
}

/**
 * Verify that the authenticated gateway owns the loop's compute target.
 *
 * Performs an org-scoped loop lookup to retrieve computeTargetId, then verifies
 * the compute target belongs to the given gateway and organization.
 *
 * Returns true when the gateway owns the compute target, false otherwise.
 */
async function verifyGatewayOwnsLoop(input: {
  loopId: string;
  organizationId: string;
  gatewayId: string;
}): Promise<boolean> {
  const loop = await withDb((db) =>
    db.loop.findUnique({
      where: { id: input.loopId, organizationId: input.organizationId },
      select: { computeTargetId: true },
    })
  );

  if (!loop?.computeTargetId) {
    return false;
  }

  const computeTargetId = loop.computeTargetId;
  const target = await withDb((db) =>
    db.computeTarget.findFirst({
      where: {
        id: computeTargetId,
        organizationId: input.organizationId,
        gatewayId: input.gatewayId,
      },
      select: { id: true },
    })
  );

  return target !== null;
}

/**
 * Desktop-managed PoP fallback path for the heartbeat revival flow.
 *
 * Invoked when the runner JWT fails (expired or JTI cleared). Verifies the
 * bearer token as a Desktop-managed key with PoP, confirms the key's gateway
 * owns the loop's compute target, and attempts to revive the loop when all
 * guards pass.
 *
 * Returns 410 Gone when:
 * - Auth fails for any reason (missing token, invalid key, PoP failure, etc.)
 * - Gateway does not own the loop's compute target
 * - Revival is refused for any reason
 *
 * Returns the revival response when revival succeeds.
 */
async function handleManagedKeyPopFallback(
  request: Request,
  loopId: string
): Promise<Response> {
  const auth = await authenticateDesktopManagedPopRequest(request);
  if (!auth.ok) {
    // The heartbeat route collapses every auth failure to 410 Gone so the
    // desktop can finalize the job terminal. Surface the reason in the log so
    // operators have a server-side signal for managed-PoP rejections.
    log.info("heartbeat: managed-PoP auth failed", {
      loopId,
      reason: auth.reason,
    });
    scheduleLogFlush();
    return goneResponse("Loop is no longer running", {
      code: HeartbeatErrorCode.TerminalLoop,
    });
  }

  const ownsLoop = await verifyGatewayOwnsLoop({
    loopId,
    organizationId: auth.organizationId,
    gatewayId: auth.gatewayId,
  });

  if (!ownsLoop) {
    log.info("heartbeat: gateway does not own loop compute target", {
      loopId,
      gatewayId: auth.gatewayId,
    });
    scheduleLogFlush();
    return goneResponse("Loop is no longer running", {
      code: HeartbeatErrorCode.TerminalLoop,
    });
  }

  const revivalResult = await reviveTimedOutLoop(loopId, auth.organizationId);

  if (revivalResult.ok) {
    log.info("heartbeat: loop revived", { loopId });
    scheduleLogFlush();
    // Wire body omits `ok` (carried by the envelope's `success`). `revived:true`
    // carries the freshly minted runner token; HeartbeatResponseData enforces
    // that token+expiresAt+jti accompany a revival.
    return successResponse({
      bumped: true,
      revived: true,
      token: revivalResult.token,
      expiresAt: revivalResult.expiresAt,
      jti: revivalResult.jti,
    } satisfies HeartbeatResponseData);
  }

  // Revival refused — return 410 Gone regardless of the specific reason so
  // the desktop can finalize the job terminal.
  log.info("heartbeat: revival refused", {
    loopId,
    reason: revivalResult.reason,
  });
  scheduleLogFlush();
  return goneResponse("Loop is no longer running", {
    code: HeartbeatErrorCode.TerminalLoop,
  });
}
