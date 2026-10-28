import { DESKTOP_AUTHORIZE_PATHNAME } from "@repo/api/src/types/desktop-authorize-url";
import { WEB_CANONICAL_LANDING_HREF } from "@repo/app/shared/lib/primary-nav-destinations";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_ORG_RETURN_PARAM } from "@/lib/desktop-org-return";

/**
 * ISS-11272: the SERVER half of the desktop-originated org-creation return.
 *
 * The href the workspace menu hands Clerk is composed in the browser, so this
 * route is the only thing standing between that value and a freshly-created
 * organization's first navigation. Both arms are pinned: a real authorize
 * target is honored, and everything else degrades to the destination org
 * creation used before this route existed.
 */

const mockAuth = vi.fn();

vi.mock("@repo/auth/server", () => ({
  auth: () => mockAuth(),
}));

const APP_ORIGIN = "https://app.closedloop.ai";

vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.closedloop.ai" },
}));

const { GET } = await import("../route");

const AUTHORIZE_SEARCH =
  "code_challenge=abc123&state=xyz789" +
  "&redirect_uri=http%3A%2F%2F127.0.0.1%3A51789%2Fcallback" +
  "&gateway_public_key=LS0tLS1CRUdJTg";

function requestFor(rawTarget: string | null): NextRequest {
  const url = new URL("/api/desktop/org-return", APP_ORIGIN);
  if (rawTarget !== null) {
    url.searchParams.set(DESKTOP_ORG_RETURN_PARAM, rawTarget);
  }
  return new NextRequest(url);
}

async function rawLocationOf(rawTarget: string | null): Promise<string> {
  const response = await GET(requestFor(rawTarget));
  return response.headers.get("location") ?? "";
}

/**
 * The `Location` resolved against the app origin.
 *
 * The header is RELATIVE since ISS-11272's e2e (absolute, built on
 * `request.nextUrl.origin`, sent the browser to the server's bind address and
 * cost the Clerk cookie), so `new URL(header)` alone no longer parses. Resolving
 * against a base is the plumbing change; every expectation below is unchanged,
 * and the relative shape itself is pinned by its own case.
 */
async function locationOf(rawTarget: string | null): Promise<string> {
  return new URL(await rawLocationOf(rawTarget), APP_ORIGIN).toString();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ orgSlug: "acme" });
});

describe("GET /api/desktop/org-return", () => {
  it("redirects a desktop-originated run to the authorize page with its query intact", async () => {
    const location = new URL(
      await locationOf(`${DESKTOP_AUTHORIZE_PATHNAME}?${AUTHORIZE_SEARCH}`)
    );

    expect(location.pathname).toBe(DESKTOP_AUTHORIZE_PATHNAME);
    expect(location.searchParams.get("state")).toBe("xyz789");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:51789/callback"
    );
    expect(location.searchParams.get("gateway_public_key")).toBe(
      "LS0tLS1CRUdJTg"
    );
  });

  it("emits a relative Location so the browser keeps the host it came in on", async () => {
    const header = await rawLocationOf(
      `${DESKTOP_AUTHORIZE_PATHNAME}?${AUTHORIZE_SEARCH}`
    );

    // Absolute here is the bug: `request.nextUrl.origin` is the server's bind
    // address in a route handler, so an absolute header sends the browser
    // off-origin and the session cookie does not follow.
    expect(header.startsWith("/")).toBe(true);
    // Not protocol-relative — `//host/path` also starts with a slash and IS
    // off-origin, so the assertion above alone does not say this.
    expect(header.startsWith("//")).toBe(false);
  });

  it("falls back to the org-scoped web landing when no target is named", async () => {
    expect(new URL(await locationOf(null)).pathname).toBe(
      `/acme${WEB_CANONICAL_LANDING_HREF}`
    );
  });

  it("refuses an off-origin target instead of navigating to it", async () => {
    for (const hostile of [
      `https://evil.test${DESKTOP_AUTHORIZE_PATHNAME}`,
      `//evil.test${DESKTOP_AUTHORIZE_PATHNAME}`,
      String.raw`/\evil.test` + DESKTOP_AUTHORIZE_PATHNAME,
    ]) {
      const location = new URL(await locationOf(hostile));

      expect(location.origin).toBe(APP_ORIGIN);
      expect(location.pathname).toBe(`/acme${WEB_CANONICAL_LANDING_HREF}`);
    }
  });

  it("refuses a same-origin page this flow has no business resuming on", async () => {
    const location = new URL(await locationOf("/acme/settings/members"));

    expect(location.pathname).toBe(`/acme${WEB_CANONICAL_LANDING_HREF}`);
  });

  it("lands on the app root when the session has no org slug to scope with", async () => {
    mockAuth.mockResolvedValue({ orgSlug: null });

    expect(new URL(await locationOf(null)).pathname).toBe("/");
  });
});
