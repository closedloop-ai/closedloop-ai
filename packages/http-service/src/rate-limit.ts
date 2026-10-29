import type { MiddlewareHandler } from "hono";
import { errorResponse, HttpServiceErrorCode } from "./errors";
import { createTokenBucket, type TokenBucketLimit } from "./token-bucket";

/** One bucket per middleware instance, so the limit is instance-wide; over it answers 429. */
export function tokenBucketRateLimit(
  limit: TokenBucketLimit,
  now: () => number = Date.now,
  { code = HttpServiceErrorCode.RateLimited }: { code?: string | null } = {}
): MiddlewareHandler {
  const bucket = createTokenBucket(limit, now);
  return async (c, next) => {
    if (!bucket.take()) {
      return errorResponse(c, HTTP_TOO_MANY_REQUESTS, code);
    }
    await next();
  };
}

const HTTP_TOO_MANY_REQUESTS = 429;
