import {
  type LoopRunnerClaims,
  verifyLoopRunnerToken,
} from "@repo/auth/loop-runner-jwt";
import { errorResponse } from "@/lib/route-utils";

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
  | { ok: false; response: Response };

/**
 * Authenticate a loop runner request: extract bearer token, verify JWT,
 * and cross-check the loopId claim against the URL param.
 *
 * Returns a result object so callers avoid duplicating try/catch + early-return.
 */
export async function authenticateLoopRunner(
  request: Request,
  loopId: string
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
  return { ok: true, claims };
}
