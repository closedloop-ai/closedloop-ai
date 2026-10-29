// @vitest-environment node

import { SETTINGS_ROUTE } from "@repo/api/src/types/settings-panel";
import { NextRequest, type NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import proxy from "@/proxy";

/**
 * ISS-10323: a soft navigation from the full Settings page to another Settings
 * panel must reach the server without `Next-Url`, or `@settings/(.)settings`
 * intercepts it and Next ends up reloading the document. Every other soft
 * navigation keeps the header, so opening Settings over a page is still the
 * intercepted overlay.
 *
 * Drives the exported proxy with only Clerk's wrapper replaced, and reads the
 * request headers Next forwards from the override headers `NextResponse.next`
 * writes, so removing the call from `proxy.ts` fails here.
 */

vi.mock("@repo/auth/proxy", () => ({
  authMiddleware: (handler: ProxyHandler) => handler,
}));

type ProxyHandler = (
  auth: () => Promise<{ userId: string; orgSlug: string }>,
  request: NextRequest
) => Promise<NextResponse>;

const runProxy = proxy as unknown as ProxyHandler;

const ORG = "acme";
const ORG_SETTINGS_PATH = `/${ORG}${SETTINGS_ROUTE}`;
// Next's own wire headers, spelled as Next spells them.
const NEXT_URL = "next-url";
const OVERRIDE_HEADERS = "x-middleware-override-headers";
const RSC = "rsc";

const signedIn = () => Promise.resolve({ userId: "user_1", orgSlug: ORG });

function softNavigation(target: string, from: string): NextRequest {
  return new NextRequest(`https://app.closedloop.ai${target}`, {
    headers: { [NEXT_URL]: from, [RSC]: "1" },
  });
}

/** The request header names Next forwards, or `null` when it forwards all. */
async function forwardedHeaderNames(
  request: NextRequest
): Promise<string[] | null> {
  const response = await runProxy(signedIn, request);
  return response.headers.get(OVERRIDE_HEADERS)?.split(",") ?? null;
}

describe("apps/app/proxy.ts — Settings does not intercept itself (ISS-10323)", () => {
  it("drops Next-Url, and only Next-Url, on a Settings-to-Settings navigation", async () => {
    const names = await forwardedHeaderNames(
      softNavigation(`${ORG_SETTINGS_PATH}?panel=api-keys`, ORG_SETTINGS_PATH)
    );

    expect(names).toContain(RSC);
    expect(names).not.toContain(NEXT_URL);
  });

  it("forwards every header when Settings opens over another page", async () => {
    expect(
      await forwardedHeaderNames(
        softNavigation(ORG_SETTINGS_PATH, `/${ORG}/dashboard`)
      )
    ).toBeNull();
  });

  it("forwards every header on a navigation to a retained Settings subroute", async () => {
    const subroute = `${ORG_SETTINGS_PATH}/compute-targets/target-1`;

    expect(
      await forwardedHeaderNames(softNavigation(subroute, subroute))
    ).toBeNull();
  });
});
