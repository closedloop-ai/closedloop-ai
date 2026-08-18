// @vitest-environment node

import type { ClerkMiddlewareAuth } from "@repo/auth/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-4570 — the redirect STATUS each proxy redirect kind emits, driven through
 * the real resolver.
 *
 * FEA-3955 specced the `/features/*` → `/issues/*` rename as a **permanent**
 * redirect; the proxy issued 302 for every redirect it resolved. The status is
 * not cosmetic: a permanent redirect is cached by browsers, often indefinitely,
 * so it may only be used on a target that is a pure function of the URL.
 *
 * That is what splits the two kinds tested here, and why the fix could not be a
 * one-character edit at the `NextResponse.redirect` call:
 *
 *  - The rename of an ALREADY org-scoped path (`/acme/features/X` →
 *    `/acme/issues/X`) resolves identically for every caller. Permanent.
 *  - Everything else the resolver does — injecting the missing `/{orgSlug}`
 *    prefix, the empty-search forward, the retired-route forwards — depends on
 *    who is asking. A cached permanent redirect would pin one user's org prefix
 *    onto a URL every other user shares. Temporary.
 *
 * Unlike `proxy-middleware-order.test.ts`, this suite does NOT mock
 * `@/lib/app-route-redirects`: the whole point is to pin the status the real
 * resolver + real proxy produce together, so neither half can drift alone.
 */

// The proxy's own middleware stages are stubbed so the chain runs without the
// real Clerk / Nosecone / PostHog runtimes. The redirect decision under test is
// left entirely to production code.
vi.mock("@repo/security/proxy", () => ({
  noseconeOptions: {},
  securityMiddleware: () => () => Promise.resolve(new Response(null)),
}));

vi.mock("@repo/analytics/proxy", () => ({
  analyticsMiddleware: () => () => Promise.resolve(NextResponse.next()),
}));

vi.mock("@repo/auth/proxy", () => ({
  authMiddleware: (
    callback: (auth: ClerkMiddlewareAuth, request: NextRequest) => unknown
  ) => callback,
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

type ProxyCallback = (
  auth: ClerkMiddlewareAuth,
  request: NextRequest
) => Promise<NextResponse>;

const runProxy = proxyMiddleware as unknown as ProxyCallback;

const ORG = "acme";
const ORIGIN = "http://localhost:3000";

/**
 * Minimal NextRequest stand-in. proxy.ts reads `nextUrl.pathname` /
 * `nextUrl.searchParams` and clones `nextUrl` before reassigning `.pathname`,
 * so `clone()` must yield a real mutable URL.
 */
function makeRequest(url: string): NextRequest {
  const parsed = new URL(url, ORIGIN);
  return {
    nextUrl: {
      pathname: parsed.pathname,
      searchParams: parsed.searchParams,
      toString: () => parsed.toString(),
      clone: () => new URL(parsed),
    },
    headers: new Headers({ host: "localhost:3000" }),
  } as unknown as NextRequest;
}

function makeAuth(orgSlug: string | null): ClerkMiddlewareAuth {
  return (() =>
    Promise.resolve({
      userId: orgSlug ? "user_1" : null,
      orgSlug,
      getToken: () => Promise.resolve(null),
    })) as unknown as ClerkMiddlewareAuth;
}

async function redirectOf(url: string, orgSlug: string | null = ORG) {
  const response = await runProxy(makeAuth(orgSlug), makeRequest(url));
  return {
    status: response.status,
    location: new URL(response.headers.get("location") ?? "", ORIGIN),
  };
}

describe("ISS-4570 — the /features → /issues rename redirects permanently", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits 308 for an org-scoped legacy detail route", async () => {
    const { status, location } = await redirectOf("/acme/features/ISS-6");

    expect(status).toBe(RedirectStatus.Permanent);
    expect(location.pathname).toBe("/acme/issues/ISS-6");
  });

  // 308, not 301: 301 permits a client to rewrite the method to GET, and this
  // alias fronts the whole `/issues` subtree rather than one GET page.
  it("preserves the deep-link query the compat window exists for", async () => {
    const { status, location } = await redirectOf(
      "/acme/features/ISS-6?version=3"
    );

    expect(status).toBe(RedirectStatus.Permanent);
    expect(location.pathname).toBe("/acme/issues/ISS-6");
    expect(location.searchParams.get("version")).toBe("3");
  });

  it("emits 308 for the legacy list route, which has no page of its own", async () => {
    const { status, location } = await redirectOf("/acme/features");

    expect(status).toBe(RedirectStatus.Permanent);
    expect(location.pathname).toBe("/acme/issues");
  });

  it("still renames inside an org whose slug is literally 'features'", async () => {
    const { status, location } = await redirectOf(
      "/features/features/ISS-6",
      "features"
    );

    expect(status).toBe(RedirectStatus.Permanent);
    expect(location.pathname).toBe("/features/issues/ISS-6");
  });
});

describe("ISS-4570 — every caller-dependent redirect stays temporary", () => {
  // The composite case, and the reason the status could not simply be changed
  // at the `NextResponse.redirect` call: this URL renames AND acquires the
  // caller's org prefix. `/features/ISS-6` is one URL shared by every user, so a
  // cached 308 would send the next org's members to `/acme/...`.
  it("emits 302 when the rename also injects the caller's org prefix", async () => {
    const { status, location } = await redirectOf("/features/ISS-6");

    expect(status).toBe(RedirectStatus.Temporary);
    expect(location.pathname).toBe("/acme/issues/ISS-6");
  });

  // Same URL, no active org: it resolves to a DIFFERENT target than the case
  // above, which is exactly what makes the pair uncacheable.
  it("emits 302 for that same URL with no active org", async () => {
    const { status, location } = await redirectOf("/features/ISS-6", null);

    expect(status).toBe(RedirectStatus.Temporary);
    expect(location.pathname).toBe("/issues/ISS-6");
  });

  it("emits 302 for a plain missing-org-prefix redirect", async () => {
    const { status, location } = await redirectOf("/settings");

    expect(status).toBe(RedirectStatus.Temporary);
    expect(location.pathname).toBe("/acme/settings");
  });

  it("emits 302 for a retired-route forward (ISS-5011 /organization)", async () => {
    const { status, location } = await redirectOf("/acme/organization");

    expect(status).toBe(RedirectStatus.Temporary);
    expect(location.pathname).toBe("/acme/settings");
  });

  it("emits 302 for the empty-search forward", async () => {
    const { status, location } = await redirectOf("/acme/search");

    expect(status).toBe(RedirectStatus.Temporary);
    expect(location.pathname).toBe("/acme/my-tasks");
  });
});
