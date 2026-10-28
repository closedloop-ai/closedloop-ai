// @vitest-environment node

import { toBase64Url } from "@repo/api/src/types/base64url";
import {
  DESKTOP_AUTHORIZE_PATHNAME,
  DESKTOP_AUTHORIZE_RUN_COOKIE,
  DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS,
  DesktopSignInMethod,
  encodeDesktopGatewayPublicKey,
} from "@repo/api/src/types/desktop-authorize-url";
import { NextRequest, type NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopAuthorizeRun,
  DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS,
  type DesktopAuthorizeRun,
  encodeDesktopAuthorizeRunCookie,
  parseDesktopAuthorizeRunCookie,
} from "@/lib/desktop-authorize-run";
import { GITHUB_CONNECT_PATHNAME } from "@/lib/github-connect-redirect";
import proxy from "@/proxy";

/**
 * Wiring gate for the PLN-2118 desktop authorize run carry: the proxy writes
 * the run cookie on every authorize-page response and bounces a signed-in page
 * navigation back to the pending run. `lib/__tests__/desktop-authorize-run.test.ts`
 * proves the codec; this file proves the proxy calls it on the right requests.
 *
 * Only Clerk's `authMiddleware` wrapper is replaced, following the sibling
 * `proxy-github-connect-deep-link.test.ts`.
 */

vi.mock("@repo/auth/proxy", () => ({
  authMiddleware: (handler: ProxyHandler) => handler,
}));

const analyticsReport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/desktop-sign-in-analytics", () => ({
  scheduleDesktopSignInAnalyticsReport: analyticsReport,
}));

type AuthState = { userId: string | null; orgSlug?: string | null };

type ProxyHandler = (
  auth: () => Promise<AuthState>,
  request: NextRequest
) => Promise<NextResponse>;

const APP_ORIGIN = "https://app.closedloop.ai";
const ORG_SLUG = "closedloop-ai";
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);

const AUTHORIZE_SEARCH = `?${new URLSearchParams({
  code_challenge: "challenge-abc",
  code_challenge_method: "S256",
  state: "state-xyz",
  redirect_uri: "http://127.0.0.1:49152/cb",
  gateway_id: "gateway-1",
  gateway_public_key: encodeDesktopGatewayPublicKey(
    "-----BEGIN PUBLIC KEY-----\nk\n-----END PUBLIC KEY-----"
  ),
  provider: DesktopSignInMethod.GitHub,
}).toString()}`;

const runProxy = proxy as unknown as ProxyHandler;

const signedOut = () => Promise.resolve({ userId: null, orgSlug: null });
const signedInWithOrg = () =>
  Promise.resolve({ userId: "user_123", orgSlug: ORG_SLUG });
const signedInWithoutOrg = () =>
  Promise.resolve({ userId: "user_123", orgSlug: null });

const SIGNED_IN_USER_ID = "user_123";
const OTHER_USER_ID = "user_456";

function pendingRun(issuedAt = NOW): DesktopAuthorizeRun {
  const run = createDesktopAuthorizeRun(AUTHORIZE_SEARCH, issuedAt);
  if (run === null) {
    throw new Error("fixture query must parse");
  }
  return run;
}

function runCookie(run: DesktopAuthorizeRun = pendingRun()): string {
  return encodeDesktopAuthorizeRunCookie(run) ?? "";
}

function appRequest(
  pathAndSearch: string,
  {
    cookie,
    headers = {},
  }: { cookie?: string; headers?: Record<string, string> } = {}
): NextRequest {
  return new NextRequest(`${APP_ORIGIN}${pathAndSearch}`, {
    headers: {
      ...headers,
      ...(cookie
        ? { cookie: `${DESKTOP_AUTHORIZE_RUN_COOKIE}=${cookie}` }
        : {}),
    },
  });
}

function setRun(response: NextResponse): DesktopAuthorizeRun | null {
  return parseDesktopAuthorizeRunCookie(
    response.cookies.get(DESKTOP_AUTHORIZE_RUN_COOKIE)?.value,
    NOW
  );
}

beforeEach(() => {
  analyticsReport.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("apps/app/proxy.ts — desktop authorize run writer (PLN-2118 M2)", () => {
  it("still sends a signed-out authorize request to the connect entry, and sets the run cookie", async () => {
    const response = await runProxy(
      signedOut,
      appRequest(`${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`)
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe(GITHUB_CONNECT_PATHNAME);
    expect(setRun(response)).toEqual({
      v: 1,
      query: AUTHORIZE_SEARCH,
      state: "state-xyz",
      issuedAt: NOW,
    });
  });

  it("sets the run cookie on a signed-in authorize request", async () => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(`${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`)
    );

    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      `/${ORG_SLUG}${DESKTOP_AUTHORIZE_PATHNAME}`
    );
    expect(setRun(response)?.state).toBe("state-xyz");
  });

  it("writes the cookie as httpOnly, SameSite=Lax, path=/ with the run's ceiling", async () => {
    const response = await runProxy(
      signedOut,
      appRequest(`${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`)
    );

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain(
      `Max-Age=${DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS / 1000}`
    );
  });

  it("keeps the original run when the same state revisits the authorize page", async () => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(
        `/${ORG_SLUG}${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`,
        {
          cookie: runCookie({
            ...pendingRun(NOW - 60_000),
            userId: SIGNED_IN_USER_ID,
          }),
        }
      )
    );

    expect(response.cookies.get(DESKTOP_AUTHORIZE_RUN_COOKIE)).toBeUndefined();
  });

  it("binds an unclaimed run to the user on its authorize page without moving issuedAt", async () => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(
        `/${ORG_SLUG}${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`,
        { cookie: runCookie(pendingRun(NOW - 60_000)) }
      )
    );

    expect(setRun(response)).toEqual({
      ...pendingRun(NOW - 60_000),
      userId: SIGNED_IN_USER_ID,
    });
    expect(response.headers.get("set-cookie")).toContain(
      `Max-Age=${(DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS - 60_000) / 1000}`
    );
  });

  it("leaves another user's run to its owner on its authorize page", async () => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(
        `/${ORG_SLUG}${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`,
        {
          cookie: runCookie({
            ...pendingRun(NOW - 60_000),
            userId: OTHER_USER_ID,
          }),
        }
      )
    );

    expect(response.cookies.get(DESKTOP_AUTHORIZE_RUN_COOKIE)).toBeUndefined();
  });

  it("does not re-arm a consumed run when the same state revisits the authorize page", async () => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(
        `/${ORG_SLUG}${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`,
        { cookie: runCookie({ ...pendingRun(NOW - 60_000), consumed: true }) }
      )
    );

    expect(response.cookies.get(DESKTOP_AUTHORIZE_RUN_COOKIE)).toBeUndefined();
  });

  it("starts a new run when a different state arrives after consumption", async () => {
    const previous = createDesktopAuthorizeRun(
      AUTHORIZE_SEARCH.replace("state-xyz", "state-old"),
      NOW - 60_000
    );
    if (previous === null) {
      throw new Error("fixture query must parse");
    }

    const response = await runProxy(
      signedOut,
      appRequest(`${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`, {
        cookie: runCookie({ ...previous, consumed: true }),
      })
    );

    expect(setRun(response)).toEqual(pendingRun());
  });

  it.each([
    ["the desktop's own open", { "sec-fetch-site": "none" }],
    ["a same-origin navigation", { "sec-fetch-site": "same-origin" }],
    ["a browser without fetch metadata", {}],
  ])("arms a run for %s", async (_label, headers) => {
    const response = await runProxy(
      signedOut,
      appRequest(`${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`, {
        headers,
      })
    );

    expect(setRun(response)).toEqual(pendingRun());
  });

  it.each(["cross-site", "same-site"])(
    "does not arm a run for a %s navigation",
    async (site) => {
      const response = await runProxy(
        signedOut,
        appRequest(`${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`, {
          headers: { "sec-fetch-site": site },
        })
      );

      expect(
        response.cookies.get(DESKTOP_AUTHORIZE_RUN_COOKIE)
      ).toBeUndefined();
    }
  );

  it("keeps the pending run when a cross-site navigation carries a different state", async () => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(
        `/${ORG_SLUG}${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH.replace("state-xyz", "state-forged")}`,
        {
          cookie: runCookie({
            ...pendingRun(NOW - 60_000),
            userId: SIGNED_IN_USER_ID,
          }),
          headers: { "sec-fetch-site": "cross-site" },
        }
      )
    );

    expect(response.cookies.get(DESKTOP_AUTHORIZE_RUN_COOKIE)).toBeUndefined();
  });

  it("clears a tampered cookie on the response", async () => {
    const tampered = toBase64Url(
      JSON.stringify({ ...pendingRun(), state: "state-forged" })
    );

    const response = await runProxy(
      signedInWithOrg,
      appRequest(`/${ORG_SLUG}/dashboard`, { cookie: tampered })
    );

    expect(response.status).not.toBe(DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS);
    expect(response.cookies.get(DESKTOP_AUTHORIZE_RUN_COOKIE)?.value).toBe("");
  });
});

// No proxy redirect other than the bounce uses 307 (`RedirectStatus` is 302 and
// 308), so the status alone tells a bounce apart from the org-slug redirect a
// bare authorize request still gets.
describe("apps/app/proxy.ts — desktop authorize run bounce (PLN-2118 M2)", () => {
  it("sends a signed-in request with an org and a pending run back to the authorize page", async () => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(`/${ORG_SLUG}/dashboard`, { cookie: runCookie() })
    );

    expect(response.status).toBe(DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.pathname}${location.search}`).toBe(
      `${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`
    );
  });

  // Onboarding completion navigates to the dashboard with a client soft
  // navigation, which reaches the proxy as an RSC request.
  it("bounces an RSC soft navigation", async () => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(`/${ORG_SLUG}/dashboard`, {
        cookie: runCookie(),
        headers: { rsc: "1" },
      })
    );

    expect(response.status).toBe(DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS);
  });

  it.each([
    [
      "the bare authorize path",
      `${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`,
    ],
    [
      "the org-scoped authorize path",
      `/${ORG_SLUG}${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`,
    ],
    ["an API route", "/api/desktop/org-return"],
  ])("does not bounce %s", async (_label, pathAndSearch) => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(pathAndSearch, { cookie: runCookie() })
    );

    expect(response.status).not.toBe(DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS);
  });

  it("does not bounce a router prefetch", async () => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(`/${ORG_SLUG}/dashboard`, {
        cookie: runCookie(),
        headers: { "next-router-prefetch": "1" },
      })
    );

    expect(response.status).not.toBe(DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS);
  });

  it("claims an unclaimed run for the first signed-in user it bounces", async () => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(`/${ORG_SLUG}/dashboard`, {
        cookie: runCookie(pendingRun(NOW - 60_000)),
      })
    );

    expect(response.status).toBe(DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS);
    expect(setRun(response)).toEqual({
      ...pendingRun(NOW - 60_000),
      userId: SIGNED_IN_USER_ID,
    });
  });

  it("does not bounce a signed-in user to another user's pending run, and leaves it", async () => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(`/${ORG_SLUG}/dashboard`, {
        cookie: runCookie({ ...pendingRun(), userId: OTHER_USER_ID }),
      })
    );

    expect(response.status).not.toBe(DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS);
    expect(response.cookies.get(DESKTOP_AUTHORIZE_RUN_COOKIE)).toBeUndefined();
  });

  it("does not bounce to a consumed run, and leaves it", async () => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(`/${ORG_SLUG}/dashboard`, {
        cookie: runCookie({
          ...pendingRun(),
          userId: SIGNED_IN_USER_ID,
          consumed: true,
        }),
      })
    );

    expect(response.status).not.toBe(DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS);
    expect(response.cookies.get(DESKTOP_AUTHORIZE_RUN_COOKIE)).toBeUndefined();
  });

  it("does not claim an unclaimed consumed run", async () => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(`/${ORG_SLUG}/dashboard`, {
        cookie: runCookie({ ...pendingRun(), consumed: true }),
      })
    );

    expect(response.status).not.toBe(DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS);
    expect(response.cookies.get(DESKTOP_AUTHORIZE_RUN_COOKIE)).toBeUndefined();
  });

  it("does not bounce a session with no active org", async () => {
    const response = await runProxy(
      signedInWithoutOrg,
      appRequest(`/${ORG_SLUG}/dashboard`, { cookie: runCookie() })
    );

    expect(response.status).not.toBe(DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS);
  });

  it("does not bounce without a run cookie", async () => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(`/${ORG_SLUG}/dashboard`)
    );

    expect(response.status).not.toBe(DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS);
  });

  it("does not bounce on an expired run, and clears it", async () => {
    const response = await runProxy(
      signedInWithOrg,
      appRequest(`/${ORG_SLUG}/dashboard`, {
        cookie: runCookie(
          pendingRun(NOW - DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS - 1)
        ),
      })
    );

    expect(response.status).not.toBe(DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS);
    expect(response.cookies.get(DESKTOP_AUTHORIZE_RUN_COOKIE)?.value).toBe("");
  });

  it("does not bounce on a tampered run", async () => {
    const tampered = toBase64Url(
      JSON.stringify({
        ...pendingRun(),
        query: AUTHORIZE_SEARCH.replace("127.0.0.1%3A49152", "evil.test"),
      })
    );

    const response = await runProxy(
      signedInWithOrg,
      appRequest(`/${ORG_SLUG}/dashboard`, { cookie: tampered })
    );

    expect(response.status).not.toBe(DESKTOP_AUTHORIZE_RUN_BOUNCE_STATUS);
  });
});

const DOCUMENT_NAVIGATION = { "sec-fetch-dest": "document" };

it("reports the pending creation attempt even before org selection", async () => {
  await runProxy(
    signedInWithoutOrg,
    appRequest("/onboarding", {
      cookie: runCookie(),
      headers: DOCUMENT_NAVIGATION,
    })
  );
  expect(analyticsReport).toHaveBeenCalledWith(
    expect.objectContaining({ state: "state-xyz", query: AUTHORIZE_SEARCH }),
    signedInWithoutOrg
  );
});

it.each([
  [
    "an RSC soft navigation",
    "/onboarding",
    { rsc: "1", "sec-fetch-dest": "empty" },
  ],
  [
    "a router prefetch",
    "/onboarding",
    { ...DOCUMENT_NAVIGATION, "next-router-prefetch": "1" },
  ],
  ["an API call", "/api/health", { "sec-fetch-dest": "empty" }],
  [
    "the authorize page, which schedules its own report",
    `${DESKTOP_AUTHORIZE_PATHNAME}${AUTHORIZE_SEARCH}`,
    DOCUMENT_NAVIGATION,
  ],
])("does not schedule a report for %s", async (_label, path, headers) => {
  await runProxy(
    signedInWithoutOrg,
    appRequest(path, { cookie: runCookie(), headers })
  );
  expect(analyticsReport).not.toHaveBeenCalled();
});
