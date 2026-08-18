// @vitest-environment node

import { NextRequest, type NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_HEALTH_CHECK_PATH,
  GATEWAY_PATH_PREFIX,
} from "@/lib/engineer/constants";
import proxy, { config } from "@/proxy";

/**
 * SECURITY CRITICAL regression gate (ISS-4417, PRD-564).
 *
 * `apps/app/lib/engineer/__tests__/gateway-guard.test.ts` proves `gatewayGuard`
 * works. This file proves it still RUNS: it drives the exported proxy
 * middleware end to end, so removing the `gatewayGuard` call from
 * `apps/app/proxy.ts` — while leaving the function and its unit tests intact —
 * fails here instead of shipping an open `/api/gateway/*` in deployed
 * environments (arbitrary command execution risk).
 *
 * Only Clerk's `authMiddleware` wrapper is replaced (it cannot run under
 * vitest, and its real callback plumbing is not what is under test). The guard
 * itself is deliberately NOT mocked.
 */

vi.mock("@repo/auth/proxy", () => ({
  authMiddleware: (handler: ProxyHandler) => handler,
}));

type ProxyHandler = (
  auth: () => Promise<{ userId: string | null }>,
  request: NextRequest
) => Promise<NextResponse>;

const DEPLOYED_HOST = "app.closedloop.ai";
const LOCALHOST = "localhost:3000";

const runProxy = proxy as unknown as ProxyHandler;

const authStub = () => Promise.resolve({ userId: null });

// The guard covers the whole prefix (`pathname.startsWith`), so cover more than
// the cheap probe: `git` is a real command-spawning operation, and the third
// entry is deliberately NOT a route that exists — it pins the prefix semantic
// itself, so a `proxy.ts` branch enumerating today's known gateway routes
// cannot leave this file green while the rest of the prefix is open.
//
// Methods are carried per case rather than defaulted to GET: `health-check` is
// really a GET probe while `git` is really a POST command route, so a guard
// narrowed to one verb cannot leave the command-spawning path unprotected.
const UNROUTED_PROBE_PATH = `${GATEWAY_PATH_PREFIX}iss-4417-unrouted-probe`;
const GUARDED_REQUESTS = [
  { pathname: GATEWAY_HEALTH_CHECK_PATH, method: "GET" },
  { pathname: `${GATEWAY_PATH_PREFIX}git`, method: "POST" },
  { pathname: UNROUTED_PROBE_PATH, method: "POST" },
] as const;

// `host` is a forbidden header name in a *browser* fetch, but undici (which
// backs `Request` under Node, and therefore `NextRequest` here) deliberately
// does not implement forbidden-header filtering, so the init header survives.
// The sibling `lib/engineer/__tests__/gateway-guard.test.ts` hand-rolls a
// request literal to sidestep the question; this file drives the real proxy,
// so it pins the assumption instead — see the precondition test below.
function gatewayRequest(
  host: string,
  pathname: string,
  method: string
): NextRequest {
  const hostname = host.split(":")[0];
  return new NextRequest(`https://${hostname}${pathname}`, {
    headers: { host },
    method,
  });
}

describe("apps/app/proxy.ts — gateway guard stays wired (ISS-4417)", () => {
  // Precondition. `gatewayGuard` reads the `host` header, not `nextUrl`. If a
  // runtime ever strips it, every request below would look non-localhost and
  // the 403 cases would pass for the wrong reason — fail here, loudly, first.
  it("carries the host header the guard reads", () => {
    const request = gatewayRequest(LOCALHOST, GATEWAY_HEALTH_CHECK_PATH, "GET");

    expect(request.headers.get("host")).toBe(LOCALHOST);
  });

  for (const { pathname, method } of GUARDED_REQUESTS) {
    it(`rejects a non-localhost ${method} ${pathname} with 403`, async () => {
      const request = gatewayRequest(DEPLOYED_HOST, pathname, method);

      const response = await runProxy(authStub, request);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Gateway API is only available on localhost",
      });
    });

    // Status alone is not passthrough: a middleware that swallowed the request
    // with its own terminal 200 looks identical. `NextResponse.next()` is what
    // sets `x-middleware-next`, so that marker — not the 200 — is the assertion
    // that the request was actually handed onward to the route.
    it(`lets a localhost ${method} ${pathname} continue`, async () => {
      const request = gatewayRequest(LOCALHOST, pathname, method);

      const response = await runProxy(authStub, request);

      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
    });

    // Driving the callback proves the guard runs *once the request reaches the
    // middleware*. `config.matcher` decides whether it ever does — narrowing it
    // to exclude `/api/gateway/*` would disable the guard in production while
    // every case above stayed green. Next compiles these patterns itself; the
    // two current entries are plain regex syntax, so a RegExp is a faithful
    // stand-in. A rewrite into `:param` syntax fails here rather than passing
    // silently, which is the safe direction for a security gate.
    it(`routes ${method} ${pathname} through the middleware matcher`, () => {
      const matched = config.matcher.some((pattern) =>
        new RegExp(`^${pattern}$`).test(pathname)
      );

      expect(matched).toBe(true);
    });
  }
});
