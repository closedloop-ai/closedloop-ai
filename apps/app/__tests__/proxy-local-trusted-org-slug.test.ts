// @vitest-environment node

import {
  AuthMode,
  E2E_LOCAL_TRUSTED_AUTH_ENABLED,
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  E2E_LOCAL_TRUSTED_ORG_SLUG_ENV,
  LOCAL_TRUSTED_ORG_SLUG,
} from "@repo/auth/auth-mode";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-10335 — the middleware runs on the synthetic `local_trusted` session.
 *
 * `@repo/auth/proxy` is deliberately NOT mocked here (every sibling
 * `proxy-*.test.ts` mocks it away): the wrapper it now owns is the code under
 * test, so only Clerk's own `clerkMiddleware` is replaced, with one that runs
 * the handler on a SIGNED-OUT Clerk session and counts its requests.
 *
 * Signed out is what the Clerk-free lane really has. So a redirect can only
 * come from the synthetic session, and the flag-off cases prove the wrapper is
 * inert without it. ISS-12054: the synthetic session no longer passes through
 * Clerk at all, so the local cases also assert Clerk saw no request.
 *
 * `routeRedirect` builds the `/{orgSlug}` prefix off the substituted `auth()`
 * CALLBACK. Measured, not assumed: in CI run
 * 35096156804, 27 of the lane's 62 first-attempt failures ended on "Page not
 * found" because `/documents/DOC-1` and friends reached `[orgSlug]` unprefixed.
 */

const clerkCalls = vi.hoisted(() => ({ requests: 0 }));

vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware:
    (handler: (auth: unknown, request: unknown) => unknown) =>
    (request: unknown) => {
      clerkCalls.requests += 1;
      return handler(signedOutAuth, request);
    },
}));

vi.mock("@/lib/desktop-sign-in-analytics", () => ({
  scheduleDesktopSignInAnalyticsReport: vi.fn(),
}));

vi.mock("@repo/security/proxy", () => ({
  noseconeOptions: {},
  securityMiddleware: () => () => Promise.resolve(new Response(null)),
}));

vi.mock("@repo/analytics/proxy", () => ({
  analyticsMiddleware: () => () => Promise.resolve(NextResponse.next()),
}));

vi.mock("@/lib/content-security-policy", () => ({
  shouldEnableContentSecurityPolicy: () => false,
}));

vi.mock("@/lib/engineer/electron-probe", () => ({
  getPossibleElectronHostnames: () => [],
}));

vi.mock("@/env", () => ({
  env: {
    CSP_ENABLED: undefined,
    VERCEL_ENV: undefined,
    NEXT_PUBLIC_API_URL: "http://api.test",
    NEXT_PUBLIC_GA_MEASUREMENT_ID: undefined,
    CSP_REPORT_URI: undefined,
  },
}));

// Imported after the mocks are registered.
import { RedirectStatus } from "@/lib/app-route-redirects";
import proxyMiddleware from "@/proxy";

type ProxyCall = (
  request: NextRequest,
  event: NextFetchEvent
) => Promise<NextResponse>;

const NO_EVENT = {} as NextFetchEvent;

function runProxy(request: NextRequest): Promise<NextResponse> {
  return (proxyMiddleware as ProxyCall)(request, NO_EVENT);
}

const ORIGIN = "http://localhost:3000";
const LOCALHOST = "localhost:3000";
/** The seeded-sandbox binding: the lane names the org its fixtures live in. */
const BOUND_ORG_SLUG = "seed-sandbox";
/** The unscoped entries the failing specs actually entered by. */
const LANE_ENTRY_PATHS = ["/dashboard", "/settings", "/documents/DOC-1"];

function signedOutAuth(): Promise<{
  userId: null;
  orgSlug: null;
  getToken: () => Promise<null>;
}> {
  return Promise.resolve({
    userId: null,
    orgSlug: null,
    getToken: () => Promise.resolve(null),
  });
}

/** Every key these cases write, so `afterEach` restores the exact prior state. */
const ENV_KEYS = [
  "AUTH_MODE",
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  E2E_LOCAL_TRUSTED_ORG_SLUG_ENV,
  "NODE_ENV",
  "VERCEL_ENV",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

describe("ISS-10335 — the middleware sees the synthetic session", () => {
  beforeEach(() => {
    clerkCalls.requests = 0;
  });

  afterEach(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        setEnv(key, value);
      }
    }
  });

  it("prefixes every unscoped entry with the bound org when Clerk reports none", async () => {
    activateLocalTrusted(BOUND_ORG_SLUG);

    for (const path of LANE_ENTRY_PATHS) {
      const response = await runProxy(makeRequest(path));

      expect(response.status, path).toBe(RedirectStatus.Temporary);
      expect(redirectPathname(response), path).toBe(
        `/${BOUND_ORG_SLUG}${path}`
      );
    }
    expect(clerkCalls.requests).toBe(0);
  });

  it("falls back to the fixed default slug when the lane binds no org", async () => {
    activateLocalTrusted();

    const response = await runProxy(makeRequest("/settings"));

    expect(redirectPathname(response)).toBe(
      `/${LOCAL_TRUSTED_ORG_SLUG}/settings`
    );
  });

  it("leaves the same request unredirected when local_trusted is not active", async () => {
    const response = await runProxy(makeRequest("/settings"));

    expect(response.headers.get("location")).toBeNull();
    expect(response.status).not.toBe(RedirectStatus.Temporary);
    expect(clerkCalls.requests).toBe(1);
  });
});

/**
 * Turn the synthetic session on, optionally bound to `orgSlug`.
 *
 * `NODE_ENV` is set to a non-production value and `VERCEL_ENV` removed
 * explicitly, so an inherited deploy signal cannot make these cases throw for a
 * reason unrelated to the identity under test.
 */
function activateLocalTrusted(orgSlug?: string): void {
  setEnv("AUTH_MODE", AuthMode.LocalTrusted);
  setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, E2E_LOCAL_TRUSTED_AUTH_ENABLED);
  setEnv("NODE_ENV", "test");
  Reflect.deleteProperty(process.env, "VERCEL_ENV");
  if (orgSlug === undefined) {
    Reflect.deleteProperty(process.env, E2E_LOCAL_TRUSTED_ORG_SLUG_ENV);
    return;
  }
  setEnv(E2E_LOCAL_TRUSTED_ORG_SLUG_ENV, orgSlug);
}

/** `Reflect.set`, because `process.env.NODE_ENV` is typed read-only here. */
function setEnv(key: string, value: string): void {
  Reflect.set(process.env, key, value);
}

/**
 * `proxy.ts` reads `nextUrl.pathname`/`searchParams`, clones `nextUrl`, and
 * reads the PLN-2118 desktop run cookie (these requests carry none).
 */
function makeRequest(pathname: string): NextRequest {
  const parsed = new URL(pathname, ORIGIN);
  return {
    nextUrl: {
      pathname: parsed.pathname,
      searchParams: parsed.searchParams,
      toString: () => parsed.toString(),
      clone: () => new URL(parsed),
    },
    method: "GET",
    headers: new Headers({ host: LOCALHOST }),
    cookies: { get: () => undefined },
  } as unknown as NextRequest;
}

/** The redirect target's path, or `null` when the proxy let the request through. */
function redirectPathname(response: NextResponse): string | null {
  const header = response.headers.get("location");
  return header ? new URL(header, ORIGIN).pathname : null;
}
