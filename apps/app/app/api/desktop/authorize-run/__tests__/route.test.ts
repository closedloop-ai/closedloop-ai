// @vitest-environment node

import {
  DESKTOP_AUTHORIZE_RUN_COOKIE,
  DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS,
  DesktopSignInMethod,
  encodeDesktopGatewayPublicKey,
} from "@repo/api/src/types/desktop-authorize-url";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopAuthorizeRun,
  type DesktopAuthorizeRun,
  encodeDesktopAuthorizeRunCookie,
  parseDesktopAuthorizeRunCookie,
} from "@/lib/desktop-authorize-run";
import { DELETE } from "../route";

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const RUN_AGE_MS = 60_000;

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

function pendingRun(): DesktopAuthorizeRun {
  const run = createDesktopAuthorizeRun(AUTHORIZE_SEARCH, NOW - RUN_AGE_MS);
  if (run === null) {
    throw new Error("fixture query must parse");
  }
  return { ...run, userId: "user_123" };
}

function deleteRequest(cookie?: string): NextRequest {
  return new NextRequest(
    "https://app.closedloop.ai/api/desktop/authorize-run",
    {
      method: "DELETE",
      headers: cookie
        ? { cookie: `${DESKTOP_AUTHORIZE_RUN_COOKIE}=${cookie}` }
        : {},
    }
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DELETE /api/desktop/authorize-run (PLN-2118 M3)", () => {
  it("returns 204 and keeps a valid run, consumed, until its original ceiling", () => {
    const run = pendingRun();

    const response = DELETE(
      deleteRequest(encodeDesktopAuthorizeRunCookie(run) ?? undefined)
    );

    expect(response.status).toBe(204);
    const written = response.cookies.get(DESKTOP_AUTHORIZE_RUN_COOKIE);
    expect(parseDesktopAuthorizeRunCookie(written?.value, NOW)).toEqual({
      ...run,
      consumed: true,
    });
    expect(written?.maxAge).toBe(
      (DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS - RUN_AGE_MS) / 1000
    );
    expect(written?.path).toBe("/");
  });

  it.each([
    ["no run cookie", undefined],
    ["an invalid run cookie", "%%%"],
  ])("returns 204 and expires the cookie with %s", (_label, cookie) => {
    const response = DELETE(deleteRequest(cookie));

    expect(response.status).toBe(204);
    const cleared = response.cookies.get(DESKTOP_AUTHORIZE_RUN_COOKIE);
    expect(cleared?.value).toBe("");
    expect(cleared?.maxAge).toBe(0);
    expect(cleared?.path).toBe("/");
  });
});
