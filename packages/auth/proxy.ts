import type {
  ClerkMiddlewareAuth,
  ClerkMiddlewareOptions,
} from "@clerk/nextjs/server";
import { clerkMiddleware } from "@clerk/nextjs/server";
import type { NextMiddleware, NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isLocalTrustedAuthActive } from "./auth-mode";
import { applyLocalTrustedContentSecurityPolicy } from "./local-trusted-csp";
import { localTrustedRequestRefusal } from "./local-trusted-request-guard";
import { buildLocalTrustedAuth } from "./local-trusted-session";

/**
 * The handler form of `clerkMiddleware`, which is the only form any app in this
 * repo uses. Clerk does not export its own `ClerkMiddlewareHandler`, so the
 * request/event/return types are taken from `NextMiddleware` — the same three
 * Clerk derives its own from.
 */
type AuthMiddlewareHandler = (
  auth: ClerkMiddlewareAuth,
  request: Parameters<NextMiddleware>[0],
  event: Parameters<NextMiddleware>[1]
) => ReturnType<NextMiddleware>;

/** Clerk resolves the callback form PER REQUEST; `apps/app` uses it for CSP. */
type AuthMiddlewareOptions =
  | ClerkMiddlewareOptions
  | ((
      request: NextRequest
    ) => ClerkMiddlewareOptions | Promise<ClerkMiddlewareOptions>);

/**
 * `clerkMiddleware`, except under `AUTH_MODE=local_trusted`, where the handler
 * runs on the synthetic session and Clerk is never entered (ISS-12054).
 *
 * ISS-10335 applied the synthetic session INSIDE `clerkMiddleware`, by swapping
 * the `auth` callback. That needs a working Clerk: with no publishable key,
 * `clerkMiddleware` in development answers every request itself (its keyless
 * branch returns `NextResponse.next()` marked signed-out) and never calls the
 * handler, so `apps/api` served no CORS headers and `apps/app` skipped its
 * org-slug redirect and security headers. Deciding the mode
 * before Clerk keeps every handler policy, and the `contentSecurityPolicy`
 * option, on the synthetic path with no Clerk credentials at all.
 *
 * That path answers only the machine it runs on: a request whose Host is not
 * loopback, or a state-changing one from a foreign Origin, is refused with a 403
 * naming the reason in `x-local-trusted-refused` (`local-trusted-request-guard.ts`).
 *
 * Every handler still sees ONE identity per request.
 *
 * Inert on every real deployment: `isLocalTrustedAuthActive()` is false
 * whenever `AUTH_MODE` is unset or `clerk`, and throws rather than granting when
 * the mode is configured in production/stage/preview (see `auth-mode.ts`), so
 * such a request fails instead of reaching the handler. `clerkMiddleware` is
 * built on the first request that needs it, so a local-trusted process never
 * constructs it.
 */
export function authMiddleware(
  handler: AuthMiddlewareHandler,
  options?: AuthMiddlewareOptions
): NextMiddleware {
  let clerk: NextMiddleware | undefined;
  return (request, event) => {
    if (isLocalTrustedAuthActive()) {
      return runLocalTrusted(handler, options, request, event);
    }
    clerk ??= buildClerkMiddleware(handler, options);
    return clerk(request, event);
  };
}

function buildClerkMiddleware(
  handler: AuthMiddlewareHandler,
  options: AuthMiddlewareOptions | undefined
): NextMiddleware {
  // Narrowed rather than passed through as a union: `clerkMiddleware` overloads
  // the options parameter, so a union argument matches neither signature.
  if (typeof options === "function") {
    return clerkMiddleware(handler, options);
  }
  return clerkMiddleware(handler, options);
}

async function runLocalTrusted(
  handler: AuthMiddlewareHandler,
  options: AuthMiddlewareOptions | undefined,
  request: NextRequest,
  event: Parameters<NextMiddleware>[1]
): Promise<Response> {
  // Yield one macrotask first, as Clerk's async verification always did. Next
  // hashes `err.stack` into a server error's digest, and without this a
  // document request and the RSC refetch that follows it resumed rendering
  // from different queues, so one root-layout failure reported two digests
  // (measured on the ISS-10078 failure route, ISS-12054).
  await new Promise((resolve) => setImmediate(resolve));
  const refusal = localTrustedRequestRefusal(request);
  if (refusal) {
    return new NextResponse(null, {
      status: FORBIDDEN,
      headers: { [LOCAL_TRUSTED_REFUSAL_HEADER]: refusal },
    });
  }
  const response =
    (await handler(localTrustedMiddlewareAuth(), request, event)) ??
    NextResponse.next();
  const resolved =
    typeof options === "function" ? await options(request) : options;
  if (resolved?.contentSecurityPolicy) {
    applyLocalTrustedContentSecurityPolicy(
      response,
      request.headers,
      resolved.contentSecurityPolicy
    );
  }
  return response;
}

/**
 * The `auth` callback the handler sees on the synthetic path. No handler in
 * this repo calls `auth.protect()`, and the synthetic session is always signed
 * in, so `protect` answers with the same session rather than redirecting.
 */
function localTrustedMiddlewareAuth(): ClerkMiddlewareAuth {
  const resolve = () => Promise.resolve(buildLocalTrustedAuth());
  return Object.assign(resolve, { protect: resolve });
}

const FORBIDDEN = 403;
/** Names which check refused a local-trusted request, for whoever debugs it. */
export const LOCAL_TRUSTED_REFUSAL_HEADER = "x-local-trusted-refused";
