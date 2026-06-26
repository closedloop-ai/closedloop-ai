import {
  type LoopRunnerClaims,
  verifyLoopRunnerToken,
} from "@repo/auth/loop-runner-jwt";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { loopsService } from "@/app/loops/service";
import {
  isRunnerRequestPinnableStatus,
  RUNNER_REQUEST_PINNABLE_STATUSES,
} from "@/lib/loops/loop-statuses";
import { errorResponse } from "@/lib/route-utils";

export const JTI_MISMATCH_ERROR_CODE = "jti_mismatch";

/**
 * Extract a Bearer token from the Authorization header.
 * Returns the token string on success, or a 401 Response on failure.
 */
export function extractBearerToken(request: Request): string | Response {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;
  if (!token) {
    return errorResponse(
      "Missing runner token",
      new Error("Unauthorized"),
      401
    );
  }
  return token;
}

type LoopRunnerAuthResult =
  | { ok: true; claims: LoopRunnerClaims }
  | { ok: false; errorCode?: string; response: Response };

/**
 * Authenticate a loop runner request: extract bearer token, verify JWT,
 * and cross-check the loopId claim against the URL param.
 *
 * When `activeTokenJti` and `route` are provided, also calls `enforceJtiOrPin`
 * to validate the JTI slot and returns 401 jti_mismatch on stale/stolen JWT.
 *
 * Returns a result object so callers avoid duplicating try/catch + early-return.
 */
export async function authenticateLoopRunner(
  request: Request,
  loopId: string,
  activeTokenJti?: string | null,
  route?: string
): Promise<LoopRunnerAuthResult> {
  const token = extractBearerToken(request);
  if (token instanceof Response) {
    return { ok: false, response: token };
  }
  let claims: LoopRunnerClaims;
  try {
    claims = await verifyLoopRunnerToken(token);
  } catch (jwtError) {
    return {
      ok: false,
      response: errorResponse("Invalid or expired runner token", jwtError, 401),
    };
  }
  if (claims.loopId !== loopId) {
    return {
      ok: false,
      response: errorResponse(
        "Token does not match loop",
        new Error("Forbidden"),
        403
      ),
    };
  }
  if (activeTokenJti !== undefined && route !== undefined) {
    const jtiResult = await enforceJtiOrPin({
      loopId,
      organizationId: claims.organizationId,
      presentedJti: claims.tokenId,
      currentJti: activeTokenJti,
      route,
    });
    if (jtiResult.kind === "mismatch" || jtiResult.kind === "raced") {
      return {
        ok: false,
        errorCode: JTI_MISMATCH_ERROR_CODE,
        response: errorResponse(
          JTI_MISMATCH_ERROR_CODE,
          new Error(JTI_MISMATCH_ERROR_CODE),
          401
        ),
      };
    }
  }
  return { ok: true, claims };
}

/**
 * Full loop-runner auth preamble used by all runner-facing route handlers.
 *
 * Order is security-relevant: the Bearer JWT is verified BEFORE any DB
 * lookup, so unauthenticated callers cannot use this endpoint as an oracle
 * for loop existence and malformed tokens never trigger DB I/O.
 *
 * Steps:
 * 1. Extract and verify the Bearer JWT; cross-check the loopId claim.
 * 2. Look up the loop's runner auth data (organizationId + activeTokenJti).
 * 3. Cross-check the JWT's organizationId claim against the loop row.
 * 4. Enforce JTI slot matching (returns 401 for stale/stolen tokens).
 *
 * Returns the verified claims on success, or an HTTP error Response on failure.
 */
export async function authenticateLoopRunnerRequest(
  request: Request,
  loopId: string,
  route: string
): Promise<LoopRunnerClaims | Response> {
  const token = extractBearerToken(request);
  if (token instanceof Response) {
    return token;
  }
  let claims: LoopRunnerClaims;
  try {
    claims = await verifyLoopRunnerToken(token);
  } catch (jwtError) {
    return errorResponse("Invalid or expired runner token", jwtError, 401);
  }
  if (claims.loopId !== loopId) {
    return errorResponse(
      "Token does not match loop",
      new Error("Forbidden"),
      403
    );
  }

  const runnerAuthData = await loopsService.findRunnerAuthData(loopId);
  if (!runnerAuthData) {
    return errorResponse("Loop not found", new Error("Forbidden"), 403);
  }
  if (claims.organizationId !== runnerAuthData.organizationId) {
    return errorResponse("Token org mismatch", new Error("Forbidden"), 403);
  }

  const jtiResult = await enforceJtiOrPin({
    loopId,
    organizationId: claims.organizationId,
    presentedJti: claims.tokenId,
    currentJti: runnerAuthData.activeTokenJti,
    route,
  });
  if (jtiResult.kind === "mismatch" || jtiResult.kind === "raced") {
    return errorResponse(
      JTI_MISMATCH_ERROR_CODE,
      new Error(JTI_MISMATCH_ERROR_CODE),
      401
    );
  }

  return claims;
}

export type JtiOrPinResult =
  | { kind: "matched" }
  | { kind: "pinned" }
  | { kind: "raced" }
  | { kind: "mismatch"; currentJti: string };

/**
 * Enforce the JTI slot on a Loop for a runner request.
 *
 * Branches:
 * - `matched`: presentedJti equals currentJti — no DB write needed. Also
 *   returned when CAS count=0 but a re-read shows the slot is now pinned to
 *   the presentedJti (concurrent twin requests during NULL→first-token).
 * - `pinned`: currentJti is null and CAS updateMany count=1 — slot pinned
 *   while the loop is active or in a terminal state that accepts a late
 *   runner `completed` event (FAILED/CANCELLED/TIMED_OUT).
 * - `raced`: CAS count=0 and re-read shows the loop is missing or has
 *   activeTokenJti=null, or is already COMPLETED (concurrent clear/delete or
 *   already-final state).
 * - `mismatch`: currentJti is non-null and differs from presentedJti, OR
 *   CAS count=0 and re-read shows a different non-null JTI was pinned by
 *   another runner — stale or stolen token; emits structured log.warn.
 */
export async function enforceJtiOrPin({
  loopId,
  organizationId,
  presentedJti,
  currentJti,
  route,
}: {
  loopId: string;
  organizationId: string;
  presentedJti: string;
  currentJti: string | null;
  route: string;
}): Promise<JtiOrPinResult> {
  if (presentedJti === currentJti) {
    return { kind: "matched" };
  }

  if (currentJti === null) {
    const { count } = await withDb((db) =>
      db.loop.updateMany({
        where: {
          id: loopId,
          organizationId,
          activeTokenJti: null,
          status: { in: RUNNER_REQUEST_PINNABLE_STATUSES },
        },
        data: { activeTokenJti: presentedJti },
      })
    );
    if (count === 1) {
      return { kind: "pinned" };
    }
    // CAS lost. Re-read to distinguish three sub-cases:
    //   - re-read JTI === presentedJti: concurrent twin request pinned us → matched
    //   - re-read JTI === some other value: another runner won → mismatch
    //   - row missing, JTI cleared, or already COMPLETED: → raced
    const reRead = await withDb((db) =>
      db.loop.findFirst({
        where: { id: loopId, organizationId },
        select: { activeTokenJti: true, status: true },
      })
    );
    if (
      reRead === null ||
      reRead.activeTokenJti === null ||
      !isRunnerRequestPinnableStatus(reRead.status)
    ) {
      return { kind: "raced" };
    }
    if (reRead.activeTokenJti === presentedJti) {
      return { kind: "matched" };
    }
    log.warn("token_jti_mismatch_rejected", {
      event: "token_jti_mismatch_rejected",
      presentedJti,
      currentJti: reRead.activeTokenJti,
      route,
    });
    return { kind: "mismatch", currentJti: reRead.activeTokenJti };
  }

  log.warn("token_jti_mismatch_rejected", {
    event: "token_jti_mismatch_rejected",
    presentedJti,
    currentJti,
    route,
  });
  return { kind: "mismatch", currentJti };
}
