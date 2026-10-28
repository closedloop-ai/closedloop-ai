import type { MiddlewareHandler } from "hono";
import { emptyResponse, errorResponse, HttpServiceErrorCode } from "./errors";
import {
  InternalOidcVerdict,
  type InternalOidcVerifier,
} from "./internal-oidc";

export type InternalAuthVariables = {
  /** The failed claim's name or the error code of a rejected bearer; never the token. */
  internalOidcRejection: string | undefined;
};

/**
 * Admits only a verified `Authorization: Bearer <token>`, `apps/api`'s Vercel
 * OIDC token (ISS-11966). A missing or rejected bearer answers 401, and one a
 * JWKS outage left unjudged fails closed with an empty 503. A verifier that
 * throws is not caught here: the error reaches the app's `onError`.
 */
export function requireInternalOidc(
  verify: InternalOidcVerifier
): MiddlewareHandler<{ Variables: InternalAuthVariables }> {
  return async (c, next) => {
    const token = c.req.header("authorization")?.match(BEARER_PATTERN)?.[1];
    if (token === undefined) {
      return errorResponse(
        c,
        HTTP_UNAUTHORIZED,
        HttpServiceErrorCode.Unauthorized
      );
    }
    const verification = await verify(token);
    if (verification.verdict === InternalOidcVerdict.Verified) {
      await next();
      return;
    }
    if (verification.verdict === InternalOidcVerdict.Unavailable) {
      return emptyResponse(c, HTTP_SERVICE_UNAVAILABLE);
    }
    c.set("internalOidcRejection", verification.reason);
    return errorResponse(
      c,
      HTTP_UNAUTHORIZED,
      HttpServiceErrorCode.Unauthorized
    );
  };
}

const BEARER_PATTERN = /^Bearer (\S+)$/i;
const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVICE_UNAVAILABLE = 503;
