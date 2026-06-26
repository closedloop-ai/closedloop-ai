import { JTI_MISMATCH_ERROR_CODE } from "@/lib/auth/loop-runner-jwt";

/**
 * Build a plain `Response` with a JSON body. Test helpers use this to
 * fabricate the `Response` return value from `authenticateLoopRunnerRequest`
 * without pulling in the real `errorResponse` from `@/lib/route-utils`, which
 * transitively depends on `@vercel/functions` `waitUntil` and the
 * observability logger.
 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * 401 response shape returned by `authenticateLoopRunnerRequest` when the
 * presented token's `jti` does not match the loop's pinned `activeTokenJti`.
 * Body matches the `failure(...)` shape from `@repo/api/src/types/common`.
 */
export function jtiMismatchResponse(): Response {
  return jsonResponse(401, {
    success: false,
    error: JTI_MISMATCH_ERROR_CODE,
  });
}

/**
 * 403 response shape returned by `authenticateLoopRunnerRequest` when the
 * loop is not visible to the runner (org mismatch or loop not found).
 */
export function forbiddenResponse(): Response {
  return jsonResponse(403, { success: false, error: "Loop not found" });
}
