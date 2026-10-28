// @vitest-environment node

import { NextRequest, type NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
  AUTH_BOUNCE_CEILING,
  AUTH_BOUNCE_COOKIE,
  AUTH_RETURN_PARAM,
} from "@/lib/auth-bounce-guard";
import proxy from "@/proxy";

/**
 * ISS-11429 regression gate: `/sign-up` must not be able to redirect to itself
 * forever.
 *
 * `__tests__/lib/auth-bounce-guard.test.ts` proves the decision is correct. This
 * file proves it still RUNS: it drives the exported proxy middleware end to end,
 * so deleting the `authBounce`/`breakAuthBounce`/`stampAuthBounce` calls from
 * `apps/app/proxy.ts` — while leaving the leaf module and its unit tests intact
 * — fails here instead of shipping the unbounded loop again.
 *
 * The loop it pins is the measured one. On the prod host one session logged 316
 * `/sign-up` views, 314 of them client-side `route_change` views whose own
 * referrer was `/sign-up?redirect_url=https://app.closedloop.ai/closedloop-ai/
 * issues/ISS-10754`: the authenticated layout redirecting a caller it reads as
 * signed out to sign-up, and Clerk's embed navigating straight back on the
 * strength of a session cookie the server refuses. Against the pre-ISS-11429
 * tree every case below sees an unstamped, un-short-circuited response.
 *
 * Only Clerk's `authMiddleware` wrapper and the analytics/security stages are
 * replaced — they cannot run under vitest. The guard itself is NOT mocked.
 */

vi.mock("@repo/auth/proxy", () => ({
  authMiddleware: (handler: ProxyHandler) => handler,
}));

vi.mock("@repo/security/proxy", () => ({
  noseconeOptions: {},
  securityMiddleware: () => () => Promise.resolve(new Response(null)),
}));

vi.mock("@repo/analytics/proxy", () => ({
  analyticsMiddleware: (response: NextResponse) => () =>
    Promise.resolve(response),
}));

type ProxyHandler = (
  auth: () => Promise<{ userId: string | null; orgSlug?: string | null }>,
  request: NextRequest
) => Promise<NextResponse>;

const runProxy = proxy as unknown as ProxyHandler;

const PROTECTED_URL =
  "https://app.closedloop.ai/closedloop-ai/issues/ISS-10754";
const SIGN_UP_URL = `https://app.closedloop.ai/sign-up?${AUTH_RETURN_PARAM}=${encodeURIComponent(PROTECTED_URL)}`;
const STALE_SESSION_COOKIE = "__session_prod";
const HTTP_TEMPORARY_REDIRECT = 302;

const signedOut = () => Promise.resolve({ orgSlug: null, userId: null });
const signedIn = () =>
  Promise.resolve({ orgSlug: "closedloop-ai", userId: "user_1" });

function signUpRequest(bounceCount?: number): NextRequest {
  const cookies = [
    `${STALE_SESSION_COOKIE}=stale`,
    // Non-zero: the browser CLAIMS a session. `__client_uat=0` is Clerk's
    // signed-out marker and must not reach the ceiling — covered below.
    "__client_uat_prod=1700000000",
  ];
  if (bounceCount !== undefined) {
    cookies.push(`${AUTH_BOUNCE_COOKIE}=${bounceCount}`);
  }
  return new NextRequest(SIGN_UP_URL, {
    headers: { cookie: cookies.join("; "), host: "app.closedloop.ai" },
  });
}

describe("proxy — the /sign-up self-redirect loop is bounded", () => {
  it("breaks the loop past the ceiling instead of serving another bounce", async () => {
    const response = await runProxy(
      signedOut,
      signUpRequest(AUTH_BOUNCE_CEILING)
    );

    expect(response.status).toBe(HTTP_TEMPORARY_REDIRECT);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();

    // The whole defect in one assertion: the destination must not name the page
    // that sent the visitor here.
    const target = new URL(location as string);
    expect(target.pathname).toBe("/sign-up");
    expect(target.searchParams.has(AUTH_RETURN_PARAM)).toBe(false);
  });

  it("clears the refused session cookies at the scope prod actually sets them", async () => {
    const response = await runProxy(
      signedOut,
      signUpRequest(AUTH_BOUNCE_CEILING)
    );

    // Stripping `redirect_url` alone does not end anything — the loop is driven
    // client-side by Clerk's embed acting on a session it believes in, and it
    // falls back to its own default destination. Removing that belief is the
    // termination, so this assertion is not decoration.
    //
    // And the SCOPE is the assertion, not merely the name: Clerk sets these with
    // `Domain=.closedloop.ai`, so a host-only, default-path expiry removes
    // nothing at all in the one environment this guard exists for.
    // Read off the raw headers, because that is the only place BOTH scopes can
    // exist: `response.cookies` is keyed by name alone, so asserting through it
    // would pass while silently holding just one of the pair.
    const setCookies = response.headers.getSetCookie();

    for (const name of [STALE_SESSION_COOKIE, "__client_uat_prod"]) {
      const deletions = setCookies.filter((value) =>
        value.startsWith(`${name}=;`)
      );
      expect(deletions).toHaveLength(2);
      expect(
        deletions.some((value) => value.includes("Domain=.closedloop.ai"))
      ).toBe(true);
      expect(deletions.some((value) => !value.includes("Domain="))).toBe(true);
      expect(deletions.every((value) => value.includes("Path=/"))).toBe(true);
      expect(deletions.every((value) => value.includes("Max-Age=0"))).toBe(
        true
      );
    }
  });

  it("leaves the counter standing so a failed break escalates instead of resetting", async () => {
    const response = await runProxy(
      signedOut,
      signUpRequest(AUTH_BOUNCE_CEILING)
    );

    // Clearing it reset the ceiling on every break, which turned the bound into
    // a rate limit: three counted bounces, break, three more, forever. The
    // break's own target carries no `redirect_url`, so keeping the counter adds
    // no redirect loop of its own and the 120s expiry retires it.
    expect(
      response.cookies.getAll().some((c) => c.name === AUTH_BOUNCE_COOKIE)
    ).toBe(false);
  });

  it("never breaks for an ordinary signed-out browser carrying __client_uat=0", async () => {
    // clerk-js writes this for every signed-out browser that has merely loaded
    // it, so treating a Clerk cookie's PRESENCE as the signal made the
    // "pathological conjunction" the ordinary signed-out state — and put a real
    // multi-step sign-up at risk of having its credentials deleted mid-flow.
    const response = await runProxy(
      signedOut,
      new NextRequest(SIGN_UP_URL, {
        headers: {
          cookie: "__client_uat_prod=0; __clerk_db_jwt=dev",
          host: "app.closedloop.ai",
        },
      })
    );

    expect(response.status).not.toBe(HTTP_TEMPORARY_REDIRECT);
    expect(response.cookies.get(AUTH_BOUNCE_COOKIE)).toBeUndefined();
  });

  it("records a bounce under the ceiling without short-circuiting the request", async () => {
    const response = await runProxy(signedOut, signUpRequest());

    expect(response.status).not.toBe(HTTP_TEMPORARY_REDIRECT);
    const stamped = response.cookies.get(AUTH_BOUNCE_COOKIE);
    expect(stamped?.value).toBe("1");
    expect(stamped?.httpOnly).toBe(true);
    // `Secure` is derived from the address the request arrived on. Hardcoding it
    // would leave the guard silently inert over plain-HTTP local runs.
    expect(stamped?.secure).toBe(true);
  });

  it("increments an existing count rather than restarting it", async () => {
    const response = await runProxy(signedOut, signUpRequest(1));
    expect(response.cookies.get(AUTH_BOUNCE_COOKIE)?.value).toBe("2");
  });

  it("does not mark a plain-HTTP bounce cookie Secure", async () => {
    const response = await runProxy(
      signedOut,
      new NextRequest(
        `http://localhost:3000/sign-up?${AUTH_RETURN_PARAM}=${encodeURIComponent("http://localhost:3000/acme/my-tasks")}`,
        {
          headers: {
            cookie: `${STALE_SESSION_COOKIE}=stale; __client_uat=1700000000`,
            host: "localhost:3000",
          },
        }
      )
    );
    expect(response.cookies.get(AUTH_BOUNCE_COOKIE)?.secure).toBe(false);
  });
});

describe("proxy — the guard stays out of the way otherwise", () => {
  it("leaves a signed-in caller's sign-up request untouched", async () => {
    const response = await runProxy(
      signedIn,
      signUpRequest(AUTH_BOUNCE_CEILING)
    );

    expect(response.status).not.toBe(HTTP_TEMPORARY_REDIRECT);
    expect(response.cookies.get(AUTH_BOUNCE_COOKIE)).toBeUndefined();
  });

  it("leaves a sign-up visit that presents no Clerk session untouched", async () => {
    const response = await runProxy(
      signedOut,
      new NextRequest(SIGN_UP_URL, {
        headers: { cookie: "sidebar:state=true", host: "app.closedloop.ai" },
      })
    );

    expect(response.status).not.toBe(HTTP_TEMPORARY_REDIRECT);
    expect(response.cookies.get(AUTH_BOUNCE_COOKIE)).toBeUndefined();
  });

  it("stamps nothing on an ordinary authenticated route", async () => {
    const response = await runProxy(
      signedIn,
      new NextRequest("https://app.closedloop.ai/closedloop-ai/dashboard", {
        headers: {
          cookie: `${STALE_SESSION_COOKIE}=live`,
          host: "app.closedloop.ai",
        },
      })
    );

    expect(response.cookies.get(AUTH_BOUNCE_COOKIE)).toBeUndefined();
  });
});
