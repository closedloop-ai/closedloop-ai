// @vitest-environment node

import type { ClerkMiddlewareAuth } from "@repo/auth/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsIntegrationCallbackParam } from "@/app/(authenticated)/[orgSlug]/settings/settings-tabs";
import {
  RedirectStatus,
  type RetiredRouteSearchParamOverlay,
} from "@/lib/app-route-redirects";
import {
  GATEWAY_LOCALHOST_ONLY_ERROR,
  GATEWAY_UNAUTHORIZED_ERROR,
} from "@/lib/engineer/gateway-guard";

/**
 * ISS-4530 — proxy.ts middleware composition-order contract.
 *
 * `apps/app/proxy.ts` composes four stages inside the Clerk middleware
 * callback, and the ORDER is load-bearing:
 *
 *   1. security headers   (computed first; applied to whatever response wins)
 *   2. routeRedirect      (short-circuits with a redirect before anything else)
 *   3. gatewayGuard       (SECURITY CRITICAL localhost-only 403/401 short-circuit)
 *   4. analytics          (only reached when nothing above short-circuited)
 *
 * This suite locks that order and each stage's short-circuit contract. It mocks
 * the middleware factories so `proxy.ts` runs in isolation without the real
 * Clerk / Nosecone / PostHog runtimes. The stage internals themselves
 * (gatewayGuard's 403, routeRedirect's rewrites) have their own unit suites —
 * this suite is about their composition, PLUS the argument-forwarding contract
 * between proxy.ts and each stage (which the leaf unit suites cannot see).
 *
 * Reordering the chain (running gatewayGuard after analytics, or dropping the
 * localhost 403 short-circuit) breaks these assertions.
 */

// Records the order stages are invoked so we can assert composition order.
const callOrder: string[] = [];

const STAGE_SECURITY = "security";
const STAGE_ROUTE_REDIRECT = "routeRedirect";
const STAGE_GATEWAY_GUARD = "gatewayGuard";
const STAGE_ANALYTICS = "analytics";

// `securityHeadersResponse` carries one header the proxy must copy onto the
// winning NextResponse, plus one `x-middleware-*` header the proxy must strip.
const SECURITY_HEADER_NAME = "x-security-marker";
const SECURITY_HEADER_VALUE = "applied";
const MIDDLEWARE_HEADER_NAME = "x-middleware-internal";

// The analytics stage tags its OWN fresh response (not the input) so tests can
// prove analytics ran AND that its distinct output — not the pre-analytics
// input response — is what proxy.ts returns. PostHog's real analytics
// middleware returns a distinct rewrite for `/ingest`, so returning/decorating
// the input response instead of the analytics output would be a real regression.
const ANALYTICS_HEADER_NAME = "x-analytics-marker";
const ANALYTICS_HEADER_VALUE = "ran";

const HTTP_FORBIDDEN = 403;
const HTTP_UNAUTHORIZED = 401;
const SLACKBOT_USER_AGENT = "Slackbot 1.0";

// Captured production inputs the mocks record so the suite can assert proxy.ts
// forwards the correct request/args into each stage, not just that it called it.
const captured: {
  analyticsRequest: NextRequest | null;
  legacyUnfurlOrgSlug: string | null;
  legacyUnfurlPathname: string | null;
  legacyUnfurlUserAgent: string | null;
  redirectPathname: string | null;
  redirectOrgSlug: string | null;
  redirectSearchParams: URLSearchParams | null;
  successorSearchParamsPathname: string | null;
  successorSearchParamsOrgSlug: string | null;
} = {
  analyticsRequest: null,
  legacyUnfurlOrgSlug: null,
  legacyUnfurlPathname: null,
  legacyUnfurlUserAgent: null,
  redirectPathname: null,
  redirectOrgSlug: null,
  redirectSearchParams: null,
  successorSearchParamsPathname: null,
  successorSearchParamsOrgSlug: null,
};

// Mutable behavior toggles the individual tests flip.
const stageBehavior: {
  redirectPathname: string | null;
  redirectStatus: RedirectStatus;
  successorSearchParams: RetiredRouteSearchParamOverlay | null;
  guard: NextResponse | null;
  requiresOrgSlug: boolean;
  rewriteLegacyIssueUnfurl: boolean;
  useRealGuard: boolean;
} = {
  redirectPathname: null,
  redirectStatus: RedirectStatus.Temporary,
  successorSearchParams: null,
  guard: null,
  requiresOrgSlug: false,
  rewriteLegacyIssueUnfurl: false,
  useRealGuard: false,
};

// `securityMiddleware(options)` returns a function that, when awaited, yields
// the security-headers Response. Record the call and return a Response carrying
// one copyable header plus one `x-middleware-*` header to strip.
vi.mock("@repo/security/proxy", () => ({
  noseconeOptions: {},
  securityMiddleware: () => () => {
    callOrder.push(STAGE_SECURITY);
    const headers = new Headers();
    headers.set(SECURITY_HEADER_NAME, SECURITY_HEADER_VALUE);
    headers.set(MIDDLEWARE_HEADER_NAME, "should-be-stripped");
    return Promise.resolve(new Response(null, { headers }));
  },
}));

// `analyticsMiddleware(response)` returns a function of `(request)` that yields
// the final response. Return a FRESH sentinel response (mirroring PostHog's
// distinct `/ingest` rewrite) and capture the inbound request so tests can prove
// analytics ran, that its distinct output wins, and that proxy.ts forwarded the
// real inbound NextRequest into it.
vi.mock("@repo/analytics/proxy", () => ({
  analyticsMiddleware: () => (request: NextRequest) => {
    callOrder.push(STAGE_ANALYTICS);
    captured.analyticsRequest = request;
    const analyticsResponse = NextResponse.next();
    analyticsResponse.headers.set(
      ANALYTICS_HEADER_NAME,
      ANALYTICS_HEADER_VALUE
    );
    return Promise.resolve(analyticsResponse);
  },
}));

// `authMiddleware(callback, options)` (Clerk's clerkMiddleware) wraps the
// callback. Return the callback itself so the test can invoke it directly with
// `(auth, request)`.
vi.mock("@repo/auth/proxy", () => ({
  authMiddleware: (
    callback: (auth: ClerkMiddlewareAuth, request: NextRequest) => unknown
  ) => callback,
}));

// The routeRedirect and gatewayGuard stages live in leaf modules the proxy
// imports; mock them to record order and return the configured short-circuit.
// `resolveRedirect` captures its production inputs (pathname + resolved org
// slug) so the suite can assert proxy.ts forwards both, including the lazy
// `auth()`-derived slug, rather than always passing null. The real
// `RedirectStatus` is re-exported so the status the suite drives through the
// proxy is the production contract, not a copy of the numbers.
vi.mock("@/lib/app-route-redirects", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/app-route-redirects")>();
  return {
    RedirectStatus: actual.RedirectStatus,
    requiresOrgSlugResolution: () => stageBehavior.requiresOrgSlug,
    resolveRedirect: (
      pathname: string,
      orgSlug: string | null,
      searchParams?: URLSearchParams
    ) => {
      captured.redirectPathname = pathname;
      captured.redirectOrgSlug = orgSlug;
      captured.redirectSearchParams = searchParams ?? null;
      return stageBehavior.redirectPathname
        ? {
            pathname: stageBehavior.redirectPathname,
            status: stageBehavior.redirectStatus,
          }
        : null;
    },
    // ISS-5011: the retired-route successor's query. Captured separately so the
    // suite can assert proxy.ts asks about the SAME pathname/org slug it
    // resolved the pathname with, rather than a rewritten path.
    resolveRedirectSearchParams: (pathname: string, orgSlug: string | null) => {
      captured.successorSearchParamsPathname = pathname;
      captured.successorSearchParamsOrgSlug = orgSlug;
      return stageBehavior.successorSearchParams;
    },
    shouldRewriteLegacyIssueUnfurl: (
      pathname: string,
      orgSlug: string | null,
      userAgent: string | null
    ) => {
      callOrder.push(STAGE_ROUTE_REDIRECT);
      captured.legacyUnfurlPathname = pathname;
      captured.legacyUnfurlOrgSlug = orgSlug;
      captured.legacyUnfurlUserAgent = userAgent;
      return stageBehavior.rewriteLegacyIssueUnfurl;
    },
  };
});

// The guard mock either records order and returns a configured short-circuit
// (composition-order tests) or delegates to the REAL gatewayGuard (the
// localhost-passthrough and unauthenticated-relay tests), so those cases prove
// proxy.ts forwards the inbound Host/request through to production enforcement.
vi.mock("@/lib/engineer/gateway-guard", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/engineer/gateway-guard")>();
  return {
    ...actual,
    gatewayGuard: (auth: ClerkMiddlewareAuth, request: NextRequest) => {
      callOrder.push(STAGE_GATEWAY_GUARD);
      if (stageBehavior.useRealGuard) {
        return actual.gatewayGuard(auth, request);
      }
      return Promise.resolve(stageBehavior.guard);
    },
  };
});

// Keep CSP off so the options branch is deterministic and env-independent.
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
import proxyMiddleware, { config as proxyConfig } from "@/proxy";

type ProxyCallback = (
  auth: ClerkMiddlewareAuth,
  request: NextRequest
) => Promise<NextResponse>;

const runProxy = proxyMiddleware as unknown as ProxyCallback;

const RESOLVED_ORG_SLUG = "acme";

/**
 * Minimal NextRequest stand-in. proxy.ts reads `nextUrl.pathname` and, on a
 * redirect, calls `nextUrl.clone()` then reassigns `.pathname` before handing
 * the clone to `NextResponse.redirect`. A bare `URL` has no `.clone()`, so we
 * expose a `nextUrl` whose `clone()` returns a real, mutable `URL`.
 *
 * `host` sets the inbound `Host` header so the real gatewayGuard's localhost
 * check (which reads `request.headers.get("host")`) is exercised end-to-end.
 */
function makeRequest(
  pathname: string,
  host = "localhost:3000",
  userAgent?: string
): NextRequest {
  const url = new URL(pathname, `http://${host}`);
  const nextUrl = {
    pathname: url.pathname,
    searchParams: url.searchParams,
    toString: () => url.toString(),
    clone: () => new URL(url),
  };
  const headers = new Headers();
  headers.set("host", host);
  if (userAgent) {
    headers.set("user-agent", userAgent);
  }
  return {
    nextUrl,
    headers,
  } as unknown as NextRequest;
}

const noopAuth = (() =>
  Promise.resolve({
    userId: null,
    orgSlug: null,
    getToken: () => Promise.resolve(null),
  })) as unknown as ClerkMiddlewareAuth;

const orgResolvingAuth = (() =>
  Promise.resolve({
    userId: "user_1",
    orgSlug: RESOLVED_ORG_SLUG,
    getToken: () => Promise.resolve(null),
  })) as unknown as ClerkMiddlewareAuth;

describe("proxy.ts middleware composition order (ISS-4530)", () => {
  beforeEach(() => {
    callOrder.length = 0;
    stageBehavior.redirectPathname = null;
    stageBehavior.redirectStatus = RedirectStatus.Temporary;
    stageBehavior.successorSearchParams = null;
    stageBehavior.guard = null;
    stageBehavior.requiresOrgSlug = false;
    stageBehavior.rewriteLegacyIssueUnfurl = false;
    stageBehavior.useRealGuard = false;
    captured.analyticsRequest = null;
    captured.legacyUnfurlOrgSlug = null;
    captured.legacyUnfurlPathname = null;
    captured.legacyUnfurlUserAgent = null;
    captured.redirectPathname = null;
    captured.redirectOrgSlug = null;
    captured.redirectSearchParams = null;
    captured.successorSearchParamsPathname = null;
    captured.successorSearchParamsOrgSlug = null;
  });

  it("runs the full happy path in order: security -> routeRedirect -> gatewayGuard -> analytics", async () => {
    const response = await runProxy(noopAuth, makeRequest("/dashboard"));

    expect(callOrder).toEqual([
      STAGE_SECURITY,
      STAGE_ROUTE_REDIRECT,
      STAGE_GATEWAY_GUARD,
      STAGE_ANALYTICS,
    ]);
    // Security headers are copied onto the analytics (final) response...
    expect(response.headers.get(SECURITY_HEADER_NAME)).toBe(
      SECURITY_HEADER_VALUE
    );
    // ...and the analytics stage's DISTINCT output is what is returned, not the
    // pre-analytics `NextResponse.next()` proxy.ts fed in.
    expect(response.headers.get(ANALYTICS_HEADER_NAME)).toBe(
      ANALYTICS_HEADER_VALUE
    );
    // `x-middleware-*` headers are stripped, never copied through.
    expect(response.headers.get(MIDDLEWARE_HEADER_NAME)).toBeNull();
  });

  it("forwards the inbound NextRequest into the analytics stage", async () => {
    // PostHog owns the `/ingest` pathname/query + cookie behavior, so proxy.ts
    // must hand the real inbound request to analytics — not a fabricated one.
    const request = makeRequest("/ingest?ph=1");
    await runProxy(noopAuth, request);

    expect(captured.analyticsRequest).toBe(request);
  });

  it("computes security headers BEFORE routeRedirect (they front the chain)", async () => {
    await runProxy(noopAuth, makeRequest("/dashboard"));
    expect(callOrder.indexOf(STAGE_SECURITY)).toBeLessThan(
      callOrder.indexOf(STAGE_ROUTE_REDIRECT)
    );
  });

  it("forwards the pathname and lazily-resolved org slug into routeRedirect", async () => {
    // A route directory that requires org resolution: proxy.ts must await
    // `auth()`, pull the org slug, and hand BOTH the exact pathname and that
    // non-null slug to the resolver — not always null, not a rewritten path.
    stageBehavior.requiresOrgSlug = true;

    await runProxy(orgResolvingAuth, makeRequest("/settings"));

    expect(captured.redirectPathname).toBe("/settings");
    expect(captured.redirectOrgSlug).toBe(RESOLVED_ORG_SLUG);
  });

  it("forwards search params into routeRedirect", async () => {
    await runProxy(noopAuth, makeRequest("/search?q=ISS-4405"));

    expect(captured.redirectSearchParams?.get("q")).toBe("ISS-4405");
  });

  it("short-circuits at routeRedirect and never runs gatewayGuard or analytics", async () => {
    stageBehavior.redirectPathname = "/acme/issues/ISS-1";

    const response = await runProxy(noopAuth, makeRequest("/features/ISS-1"));

    // routeRedirect fired, but nothing downstream did.
    expect(callOrder).toContain(STAGE_ROUTE_REDIRECT);
    expect(callOrder).not.toContain(STAGE_GATEWAY_GUARD);
    expect(callOrder).not.toContain(STAGE_ANALYTICS);
    // Security headers are applied even to the redirect response.
    expect(response.headers.get(SECURITY_HEADER_NAME)).toBe(
      SECURITY_HEADER_VALUE
    );
    // The redirect response carries a Location and the resolver's status.
    expect(response.status).toBe(RedirectStatus.Temporary);
    expect(response.headers.get("location")).toContain("/acme/issues/ISS-1");
  });

  // ISS-4570: the status is the RESOLVER's call — only it knows whether the
  // target depends on the caller — so proxy.ts must forward it verbatim rather
  // than hardcode one. A proxy that pinned 302 (as it did before ISS-4570) or
  // pinned 308 fails this pair.
  it("forwards the resolver's redirect status verbatim", async () => {
    stageBehavior.redirectPathname = "/acme/issues/ISS-1";
    stageBehavior.redirectStatus = RedirectStatus.Permanent;

    const permanent = await runProxy(
      noopAuth,
      makeRequest("/acme/features/ISS-1")
    );
    expect(permanent.status).toBe(RedirectStatus.Permanent);

    stageBehavior.redirectStatus = RedirectStatus.Temporary;

    const temporary = await runProxy(
      noopAuth,
      makeRequest("/acme/features/ISS-1")
    );
    expect(temporary.status).toBe(RedirectStatus.Temporary);
  });

  // ISS-5011: `/organization` was a stub that promised org settings it did not
  // have; its URL now forwards to the Settings surface that owns them. The
  // successor is one TAB of that surface, so the pathname rewrite alone would
  // land the user on the default Profile tab — the proxy must overlay the
  // successor's query onto the redirect it issues. Deleting that overlay from
  // proxy.ts must fail here, not merely leave a resolver unit test green.
  it("overlays the retired route's successor query onto the redirect", async () => {
    stageBehavior.redirectPathname = "/acme/settings";
    stageBehavior.successorSearchParams = {
      set: { tab: "organization" },
      remove: [],
    };

    const response = await runProxy(
      noopAuth,
      makeRequest("/acme/organization?keep=1")
    );

    const location = response.headers.get("location") ?? "";
    const target = new URL(location, "http://localhost:3000");
    expect(target.pathname).toBe("/acme/settings");
    expect(target.searchParams.get("tab")).toBe("organization");
    // The clone's unrelated query survives — the `?version=3` deep links the
    // legacy-route compat window preserves must not be collateral damage.
    expect(target.searchParams.get("keep")).toBe("1");
  });

  it("lets the successor query BEAT a stale same-key param on the bookmark", async () => {
    // An old `/organization?tab=profile` bookmark must still land on the tab the
    // forward exists to select; `set`, not append, is what makes that true.
    stageBehavior.redirectPathname = "/acme/settings";
    stageBehavior.successorSearchParams = {
      set: { tab: "organization" },
      remove: [],
    };

    const response = await runProxy(
      noopAuth,
      makeRequest("/acme/organization?tab=profile")
    );

    const target = new URL(
      response.headers.get("location") ?? "",
      "http://localhost:3000"
    );
    expect(target.searchParams.getAll("tab")).toEqual(["organization"]);
  });

  // wongk, PR #4501: the destination outranks `tab` with its integration
  // callback keys, so a bookmarked `/organization?github=bogus` would land on
  // Integrations while its own URL said `tab=organization`. The proxy must
  // strip the successor's declared higher-precedence keys, and strip them
  // BEFORE it sets the tab, while leaving unrelated query alone.
  it("strips the keys that would outrank the successor's own query", async () => {
    stageBehavior.redirectPathname = "/acme/settings";
    stageBehavior.successorSearchParams = {
      set: { tab: "organization" },
      remove: [
        SettingsIntegrationCallbackParam.GitHub,
        SettingsIntegrationCallbackParam.Google,
      ],
    };

    const response = await runProxy(
      noopAuth,
      makeRequest("/acme/organization?github=bogus&google=bogus&version=3")
    );

    const target = new URL(
      response.headers.get("location") ?? "",
      "http://localhost:3000"
    );
    expect(
      target.searchParams.get(SettingsIntegrationCallbackParam.GitHub)
    ).toBeNull();
    expect(
      target.searchParams.get(SettingsIntegrationCallbackParam.Google)
    ).toBeNull();
    expect(target.searchParams.get("tab")).toBe("organization");
    expect(target.searchParams.get("version")).toBe("3");
  });

  it("asks for the successor query using the INBOUND pathname and org slug", async () => {
    stageBehavior.requiresOrgSlug = true;
    stageBehavior.redirectPathname = "/acme/settings";

    await runProxy(orgResolvingAuth, makeRequest("/organization"));

    // Not the rewritten target: the successor lookup keys off the retired route
    // the caller actually asked for.
    expect(captured.successorSearchParamsPathname).toBe("/organization");
    expect(captured.successorSearchParamsOrgSlug).toBe(RESOLVED_ORG_SLUG);
  });

  it("leaves the redirect query untouched when the successor needs none", async () => {
    stageBehavior.redirectPathname = "/acme/sessions";
    stageBehavior.successorSearchParams = null;

    const response = await runProxy(
      noopAuth,
      makeRequest("/acme/loops?version=3")
    );

    const target = new URL(
      response.headers.get("location") ?? "",
      "http://localhost:3000"
    );
    expect(target.pathname).toBe("/acme/sessions");
    expect(target.searchParams.get("version")).toBe("3");
    expect(target.searchParams.get("tab")).toBeNull();
  });

  it("rewrites legacy issue Slackbot unfurls before normal redirects", async () => {
    stageBehavior.rewriteLegacyIssueUnfurl = true;

    const response = await runProxy(
      noopAuth,
      makeRequest(
        "/acme/features/ISS-4405",
        "localhost:3000",
        SLACKBOT_USER_AGENT
      )
    );

    expect(callOrder).toContain(STAGE_ROUTE_REDIRECT);
    expect(captured.legacyUnfurlPathname).toBe("/acme/features/ISS-4405");
    expect(captured.legacyUnfurlOrgSlug).toBeNull();
    expect(captured.legacyUnfurlUserAgent).toBe(SLACKBOT_USER_AGENT);
    expect(callOrder).not.toContain(STAGE_GATEWAY_GUARD);
    expect(callOrder).not.toContain(STAGE_ANALYTICS);
    expect(response.headers.get("x-middleware-rewrite")).toContain("/sign-in");
    expect(response.headers.get("x-middleware-rewrite")).toContain(
      "redirect_url="
    );
  });

  it("runs routeRedirect BEFORE gatewayGuard (redirect wins over guard)", async () => {
    // Both stages would short-circuit; the redirect must be evaluated first, so
    // the guard is never consulted.
    stageBehavior.redirectPathname = "/redir";
    stageBehavior.guard = NextResponse.json(
      { error: "guard" },
      { status: HTTP_FORBIDDEN }
    );

    await runProxy(noopAuth, makeRequest("/features/ISS-1"));

    expect(callOrder).toContain(STAGE_ROUTE_REDIRECT);
    expect(callOrder).not.toContain(STAGE_GATEWAY_GUARD);
  });

  it("short-circuits at gatewayGuard (after routeRedirect) and never runs analytics", async () => {
    // A non-/api/ path so routeRedirect's resolver marker fires and the full
    // stage ordering is observable; the guard is forced to short-circuit to
    // model a rejected gateway request.
    stageBehavior.guard = NextResponse.json(
      { error: GATEWAY_LOCALHOST_ONLY_ERROR },
      { status: HTTP_FORBIDDEN }
    );

    const response = await runProxy(noopAuth, makeRequest("/some-page"));

    // Order: security, then routeRedirect (passed), then guard short-circuits.
    expect(callOrder).toEqual([
      STAGE_SECURITY,
      STAGE_ROUTE_REDIRECT,
      STAGE_GATEWAY_GUARD,
    ]);
    expect(callOrder).not.toContain(STAGE_ANALYTICS);
    expect(response.status).toBe(HTTP_FORBIDDEN);
    // Security headers are applied even to the guard's short-circuit response.
    expect(response.headers.get(SECURITY_HEADER_NAME)).toBe(
      SECURITY_HEADER_VALUE
    );
  });

  it("enforces the SECURITY-CRITICAL localhost-only 403 for a non-local /api/gateway/* request through the real guard", async () => {
    // Delegate to the REAL gatewayGuard: proxy.ts must forward the inbound
    // non-local Host so production enforcement produces the 403 itself, rather
    // than a manufactured guard response. This proves the Host is threaded
    // through, not just that some 403 was returned.
    stageBehavior.useRealGuard = true;

    const response = await runProxy(
      noopAuth,
      makeRequest("/api/gateway/git", "evil.example.com")
    );

    expect(callOrder).toContain(STAGE_GATEWAY_GUARD);
    expect(callOrder).not.toContain(STAGE_ANALYTICS);
    expect(response.status).toBe(HTTP_FORBIDDEN);
    await expect(response.json()).resolves.toEqual({
      error: GATEWAY_LOCALHOST_ONLY_ERROR,
    });
    // Security headers are applied even to the guard's 403 response.
    expect(response.headers.get(SECURITY_HEADER_NAME)).toBe(
      SECURITY_HEADER_VALUE
    );
  });

  it("short-circuits with a distinct 401 for an unauthenticated non-local /api/gateway-relay/* request, skipping analytics", async () => {
    // A DISTINCT status from the 403 cases: a guard that only short-circuited on
    // 403 would let this 401 fall through to analytics. Delegate to the real
    // guard so the relay path's unauthenticated 401 is produced by production
    // code, then assert its status/body wins, analytics is skipped, and security
    // headers are still applied.
    stageBehavior.useRealGuard = true;

    const response = await runProxy(
      noopAuth,
      makeRequest("/api/gateway-relay/git", "evil.example.com")
    );

    expect(callOrder).toContain(STAGE_GATEWAY_GUARD);
    expect(callOrder).not.toContain(STAGE_ANALYTICS);
    expect(response.status).toBe(HTTP_UNAUTHORIZED);
    await expect(response.json()).resolves.toEqual({
      error: GATEWAY_UNAUTHORIZED_ERROR,
    });
    expect(response.headers.get(SECURITY_HEADER_NAME)).toBe(
      SECURITY_HEADER_VALUE
    );
  });

  it("reaches analytics only when neither routeRedirect nor gatewayGuard short-circuits", async () => {
    // Both pass (null); analytics is the terminal stage.
    await runProxy(noopAuth, makeRequest("/dashboard"));
    expect(callOrder.at(-1)).toBe(STAGE_ANALYTICS);
  });
});

describe("proxy.ts config.matcher still routes gateway requests (ISS-4530)", () => {
  // The composition tests invoke the proxy callback directly, which cannot see
  // whether Next's exported `config.matcher` still selects this middleware for
  // gateway routes. If the matcher were narrowed so `/api/gateway/*` stopped
  // matching, a non-local gateway request would bypass gatewayGuard entirely
  // while the composition suite stayed green. Assert the matcher against a
  // representative gateway URL using Next's own matcher test helper.
  const GATEWAY_URL = "http://evil.example.com/api/gateway/git";
  const APP_URL = "http://evil.example.com/dashboard";
  const STATIC_ASSET_URL = "http://evil.example.com/logo.png";

  it("matches a representative /api/gateway/* request", () => {
    expect(
      unstable_doesMiddlewareMatch({
        config: { matcher: proxyConfig.matcher },
        url: GATEWAY_URL,
      })
    ).toBe(true);
  });

  it("still matches a normal app route", () => {
    expect(
      unstable_doesMiddlewareMatch({
        config: { matcher: proxyConfig.matcher },
        url: APP_URL,
      })
    ).toBe(true);
  });

  it("does not match a static asset excluded by the matcher", () => {
    expect(
      unstable_doesMiddlewareMatch({
        config: { matcher: proxyConfig.matcher },
        url: STATIC_ASSET_URL,
      })
    ).toBe(false);
  });
});
