// @vitest-environment node

import { NextRequest, type NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_CONNECT_PATHNAME,
  GITHUB_CONNECT_REDIRECT_PARAM,
} from "@/lib/github-connect-redirect";
import proxy from "@/proxy";

/**
 * Wiring gate for the GitHub-first desktop connect deep link (PRD-562 /
 * PLN-1526).
 *
 * `apps/app/lib/__tests__/github-connect-redirect.test.ts` proves the DECISION
 * functions are right. This file proves they are still CALLED, and called on the
 * correct side of the auth check: it drives the exported proxy middleware end to
 * end, so removing the branch from `routeRedirect` — or moving it above the
 * `!userId` test — fails here rather than shipping either a dead deep link or a
 * signed-IN user bounced back through GitHub OAuth on every settings visit.
 *
 * Only Clerk's `authMiddleware` wrapper is replaced (it cannot run under vitest,
 * and its callback plumbing is not what is under test), following the sibling
 * `proxy-gateway-guard-wiring.test.ts`.
 */

vi.mock("@repo/auth/proxy", () => ({
  authMiddleware: (handler: ProxyHandler) => handler,
}));

type AuthState = { userId: string | null; orgSlug?: string | null };

type ProxyHandler = (
  auth: () => Promise<AuthState>,
  request: NextRequest
) => Promise<NextResponse>;

const APP_ORIGIN = "https://app.closedloop.ai";
const DESKTOP_AUTHORIZE_PATH = "/settings/integrations/desktop/authorize";

/**
 * A representative desktop authorize query string. The PKCE challenge, the
 * opaque `state`, the loopback `redirect_uri`, and the base64url gateway key all
 * have to survive the extra hop or the desktop hangs on its loopback listener
 * until it times out.
 */
const AUTHORIZE_SEARCH =
  "?code_challenge=abc123&code_challenge_method=S256&state=xyz789" +
  "&redirect_uri=http%3A%2F%2F127.0.0.1%3A51789%2Fcallback" +
  "&gateway_public_key=LS0tLS1CRUdJTg";

const runProxy = proxy as unknown as ProxyHandler;

const signedOut = () => Promise.resolve({ userId: null, orgSlug: null });
const signedIn = () =>
  Promise.resolve({ userId: "user_123", orgSlug: "closedloop-ai" });

function appRequest(pathname: string, search = ""): NextRequest {
  return new NextRequest(`${APP_ORIGIN}${pathname}${search}`);
}

describe("apps/app/proxy.ts — GitHub connect deep link stays wired (PLN-1526)", () => {
  // The redirect param is asserted as the WHOLE `pathname + search` string, not
  // param by param: that is the point of carrying it as one value. An
  // implementation that forwarded only the path would still redirect, still be
  // a 302, and still land on `/connect/github` — and still strand the desktop
  // on its loopback listener.
  it("sends a signed-out desktop authorize request to the connect entry", async () => {
    const response = await runProxy(
      signedOut,
      appRequest(DESKTOP_AUTHORIZE_PATH, AUTHORIZE_SEARCH)
    );

    expect(response.status).toBe(302);

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe(GITHUB_CONNECT_PATHNAME);
    expect(location.searchParams.get(GITHUB_CONNECT_REDIRECT_PARAM)).toBe(
      `${DESKTOP_AUTHORIZE_PATH}${AUTHORIZE_SEARCH}`
    );
  });

  // A signed-IN user must reach the org-scoped consent page. Deep-linking them
  // would restart GitHub OAuth for a session that already exists.
  it("leaves a signed-in desktop authorize request on the org-scoped redirect", async () => {
    const response = await runProxy(
      signedIn,
      appRequest(DESKTOP_AUTHORIZE_PATH, AUTHORIZE_SEARCH)
    );

    expect(response.status).toBe(302);

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe(`/closedloop-ai${DESKTOP_AUTHORIZE_PATH}`);
    expect(location.searchParams.get("state")).toBe("xyz789");
  });

  // Only the one entry point whose originating click already named GitHub is
  // intercepted; every other signed-out route keeps the normal sign-in embed.
  it("does not intercept a signed-out request for a sibling settings route", async () => {
    const response = await runProxy(
      signedOut,
      appRequest("/settings/integrations/desktop/connect")
    );

    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
