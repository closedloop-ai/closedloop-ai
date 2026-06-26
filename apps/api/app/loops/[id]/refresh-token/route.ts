import { RefreshTokenErrorCode } from "@repo/api/src/types/loop";
import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";
import {
  conflictResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";
import { refreshRunnerToken } from "../../service";

/**
 * POST /api/loops/:id/refresh-token - Rotate the loop runner JWT.
 *
 * Called by the container harness when its JWT is near expiry. Authenticated
 * via the same loop-runner JWT used for event reporting. Replay protection
 * uses the verified `tokenId` claim from the presented JWT: it must match the
 * current active token and must not have been used in a prior refresh (audited
 * via the LoopTokenRefresh table). The request body is not read.
 *
 * Forwards `Idempotency-Key`, `x-forwarded-for`, and `user-agent` headers to
 * the service for inclusion in the durable `token_refreshed` event payload.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: loopId } = await params;

  const claims = await authenticateLoopRunnerRequest(
    request,
    loopId,
    "loops/[id]/refresh-token"
  );
  if (claims instanceof Response) {
    return claims;
  }

  const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;
  const requesterIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
  const requesterUa = request.headers.get("user-agent") ?? undefined;

  const result = await refreshRunnerToken(loopId, claims.tokenId, {
    idempotencyKey,
    requesterIp,
    requesterUa,
  });

  if (result.ok) {
    return successResponse({
      token: result.token,
      expiresAt: result.expiresAt,
      jti: result.jti,
    });
  }

  switch (result.code) {
    case RefreshTokenErrorCode.LoopNotFound:
      return notFoundResponse("Loop", { code: result.code });
    case RefreshTokenErrorCode.TokenExpired:
    case RefreshTokenErrorCode.JtiMismatch:
    case RefreshTokenErrorCode.JtiAlreadyUsed:
      return unauthorizedResponse({ code: result.code });
    case RefreshTokenErrorCode.NotRunning:
    case RefreshTokenErrorCode.RaceLost:
      return conflictResponse(result.message, { code: result.code });
    case RefreshTokenErrorCode.RateLimited:
      return errorResponse(result.message, new Error(result.code), 429, {
        code: result.code,
      });
    case RefreshTokenErrorCode.GenerationFailed:
      return errorResponse(result.message, new Error(result.code), 500, {
        code: result.code,
      });
    default: {
      const exhaustive: never = result.code;
      return errorResponse(
        "Unexpected error",
        new Error(`Unhandled refresh error code: ${exhaustive}`),
        500
      );
    }
  }
}
