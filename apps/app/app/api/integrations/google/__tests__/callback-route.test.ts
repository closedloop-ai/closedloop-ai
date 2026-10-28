import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSetCookie } from "../../__tests__/oauth-route-test-helpers";
import {
  GOOGLE_OAUTH_ERRORS,
  GOOGLE_STATE_COOKIE,
  GOOGLE_VERIFIER_COOKIE,
  getGoogleCallbackUrl,
} from "../google-utils";

const STATE = "state-1";
const VERIFIER = "verifier-1";
const CODE = "auth-code-1";
const PREVIEW_APP_ORIGIN = "https://app-pr-1.preview.closedloop.ai";
const PREVIEW_API_ORIGIN = "https://api-pr-1.preview.closedloop.ai";
const CLEARED_COOKIE = { expired: true, path: "/", value: "" };

const { API_URL, APP_URL, mockAuth, mockCookieGet } = vi.hoisted(() => ({
  API_URL: "http://api.example.test",
  APP_URL: "http://localhost:3000",
  mockAuth: vi.fn(),
  mockCookieGet: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_API_URL: API_URL, NEXT_PUBLIC_APP_URL: APP_URL },
}));

vi.mock("@repo/auth/server", () => ({ auth: () => mockAuth() }));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: mockCookieGet }),
}));

const { GET } = await import("../callback/route");

function errorLocation(message: string): string {
  return `${APP_URL}/settings?tab=integrations&google=error&message=${message}`;
}

describe("GET /api/integrations/google/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(""),
      })
    );
    mockAuth.mockResolvedValue({
      getToken: vi.fn().mockResolvedValue("clerk-token"),
      orgId: "org-1",
      userId: "user-1",
    });
    storedCookies({ state: STATE, verifier: VERIFIER });
  });

  it("exchanges the code and clears both OAuth cookies", async () => {
    const response = await GET(callbackRequest({ code: CODE, state: STATE }));

    expect(response.headers.get("location")).toBe(
      `${APP_URL}/settings?tab=integrations&google=success`
    );
    expect(fetch).toHaveBeenCalledWith(
      `${API_URL}/integrations/google/connect`,
      expect.objectContaining({
        body: JSON.stringify({
          code: CODE,
          codeVerifier: VERIFIER,
          redirectUri: getGoogleCallbackUrl(),
        }),
        method: "POST",
      })
    );
    expect(readSetCookie(response, GOOGLE_STATE_COOKIE)).toEqual(
      CLEARED_COOKIE
    );
    expect(readSetCookie(response, GOOGLE_VERIFIER_COOKIE)).toEqual(
      CLEARED_COOKIE
    );
  });

  // The public API URL and the origin the route must actually call are the same
  // host in the default fixture, so a regression to reading NEXT_PUBLIC_API_URL
  // directly would go unnoticed. A preview host separates them: only
  // resolveApiOrigin rewrites app-* to api-*.
  it("posts to the origin resolved from the request, not the public API URL", async () => {
    await GET(
      callbackRequest({ code: CODE, state: STATE }, PREVIEW_APP_ORIGIN)
    );

    expect(fetch).toHaveBeenCalledWith(
      `${PREVIEW_API_ORIGIN}/integrations/google/connect`,
      expect.anything()
    );
  });

  it("forwards the Clerk token as a bearer credential", async () => {
    await GET(callbackRequest({ code: CODE, state: STATE }));

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer clerk-token",
        }),
      })
    );
  });

  it("rejects an unauthenticated callback before reading any cookie", async () => {
    mockAuth.mockResolvedValue({ orgId: null, userId: null });

    const response = await GET(callbackRequest({ code: CODE, state: STATE }));

    expect(response.headers.get("location")).toBe(
      errorLocation(GOOGLE_OAUTH_ERRORS.NOT_AUTHENTICATED)
    );
    expect(mockCookieGet).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a provider-reported OAuth error without exchanging anything", async () => {
    const response = await GET(
      callbackRequest({
        error: "access_denied",
        error_description: "The user denied the request",
      })
    );

    expect(response.headers.get("location")).toBe(
      errorLocation(GOOGLE_OAUTH_ERRORS.OAUTH_FAILED)
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["code", { state: STATE }],
    ["state", { code: CODE }],
  ])("rejects a callback missing %s", async (_missing, params) => {
    const response = await GET(callbackRequest(params));

    expect(response.headers.get("location")).toBe(
      errorLocation(GOOGLE_OAUTH_ERRORS.MISSING_PARAMS)
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a callback with no stored state cookie", async () => {
    storedCookies({ verifier: VERIFIER });

    const response = await GET(callbackRequest({ code: CODE, state: STATE }));

    expect(response.headers.get("location")).toBe(
      errorLocation(GOOGLE_OAUTH_ERRORS.INVALID_STATE)
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  // Equal-length and unequal-length forgeries take different paths through the
  // padded timing-safe compare: the second is caught by the length check the
  // padding would otherwise hide.
  it.each([
    ["a same-length forged state", "state-2"],
    ["a longer forged state", `${STATE}-with-extra-bytes`],
    ["a shorter forged state", "s"],
  ])("rejects %s", async (_label, forged) => {
    const response = await GET(callbackRequest({ code: CODE, state: forged }));

    expect(response.headers.get("location")).toBe(
      errorLocation(GOOGLE_OAUTH_ERRORS.INVALID_STATE)
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a callback with no PKCE verifier cookie", async () => {
    storedCookies({ state: STATE });

    const response = await GET(callbackRequest({ code: CODE, state: STATE }));

    expect(response.headers.get("location")).toBe(
      errorLocation(GOOGLE_OAUTH_ERRORS.MISSING_PARAMS)
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a failed token exchange without echoing the API body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("invalid_grant"),
      })
    );

    const response = await GET(callbackRequest({ code: CODE, state: STATE }));

    expect(response.headers.get("location")).toBe(
      errorLocation(GOOGLE_OAUTH_ERRORS.TOKEN_EXCHANGE_FAILED)
    );
  });
});

function callbackRequest(params: Record<string, string>, origin = APP_URL) {
  const url = new URL(`${origin}/api/integrations/google/callback`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString()) as Parameters<typeof GET>[0];
}

function storedCookies({
  state,
  verifier,
}: {
  state?: string;
  verifier?: string;
}): void {
  mockCookieGet.mockImplementation((name: string) => {
    if (name === GOOGLE_STATE_COOKIE && state !== undefined) {
      return { value: state };
    }
    if (name === GOOGLE_VERIFIER_COOKIE && verifier !== undefined) {
      return { value: verifier };
    }
    return undefined;
  });
}
