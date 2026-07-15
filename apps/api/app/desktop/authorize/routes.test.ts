import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  desktopAuthorizeService: { mint: vi.fn(), redeem: vi.fn() },
  resolveSessionUser: vi.fn(),
}));

vi.mock("./service", () => ({
  desktopAuthorizeService: mocks.desktopAuthorizeService,
}));
vi.mock("@/lib/auth/session-user", () => ({
  resolveSessionUser: mocks.resolveSessionUser,
}));

import { PKCE_CODE_CHALLENGE_METHOD } from "@/lib/auth/pkce";
import { POST as authorizePOST } from "./route";
import { POST as tokenPOST } from "./token/route";

const LOOPBACK_REDIRECT = "http://127.0.0.1:49152/cb";
// `http://localhost:3000` is always a trusted origin (see trusted-origins.ts).
const WEB_APP_ORIGIN = "http://localhost:3000";
// A real Ed25519 SPKI PEM so the route's normalize check passes.
const GATEWAY_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA/lxbpof9Yiku55lRb6UkI29fzWkbmHPDGidrCi9pZeA=\n-----END PUBLIC KEY-----\n";
const tokens = {
  accessToken: "access-token",
  accessTokenExpiresAt: "2026-07-01T12:15:00.000Z",
  refreshToken: "refresh-token",
  refreshTokenExpiresAt: "2026-07-31T12:00:00.000Z",
  userId: "user-1",
  organizationId: "org-1",
};

function jsonRequest(
  path: string,
  body: unknown,
  origin: string = WEB_APP_ORIGIN
): Request {
  return new Request(`https://api.closedloop.ai/desktop/authorize/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

function authorizeBody(overrides: Record<string, unknown> = {}) {
  return {
    webAppOrigin: WEB_APP_ORIGIN,
    gatewayId: "gateway-1",
    gatewayPublicKeyPem: GATEWAY_PUBLIC_KEY_PEM,
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    codeChallengeMethod: PKCE_CODE_CHALLENGE_METHOD,
    redirectUri: LOOPBACK_REDIRECT,
    ...overrides,
  };
}

function tokenBody(overrides: Record<string, unknown> = {}) {
  return {
    code: "raw-code",
    codeVerifier: "a".repeat(43),
    gatewayId: "gateway-1",
    redirectUri: LOOPBACK_REDIRECT,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveSessionUser.mockResolvedValue({
    user: { id: "user-1", organizationId: "org-1" },
    clerkUserId: "clerk-1",
    clerkOrgId: "clerk-org-1",
  });
});

describe("POST /desktop/authorize", () => {
  it("requires a Clerk session and never mints when signed out", async () => {
    mocks.resolveSessionUser.mockResolvedValue(null);

    const response = await authorizePOST(jsonRequest("", authorizeBody()));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "SESSION_REQUIRED",
      retryable: false,
    });
    expect(mocks.desktopAuthorizeService.mint).not.toHaveBeenCalled();
  });

  it("returns 200 with the minted code on success", async () => {
    mocks.desktopAuthorizeService.mint.mockResolvedValue({
      ok: true,
      value: { code: "the-code", expiresAt: "2026-07-01T12:01:00.000Z" },
    });

    const response = await authorizePOST(jsonRequest("", authorizeBody()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      code: "the-code",
      expiresAt: "2026-07-01T12:01:00.000Z",
    });
    // The resolved internal user/org is what gets bound — not client-supplied.
    expect(mocks.desktopAuthorizeService.mint).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", organizationId: "org-1" })
    );
  });

  it("rejects a foreign Origin with 403 and does not mint (CSRF)", async () => {
    const response = await authorizePOST(
      jsonRequest("", authorizeBody(), "https://evil.example.com")
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: "DESKTOP_AUTHORIZE_FORBIDDEN",
      retryable: false,
    });
    expect(mocks.desktopAuthorizeService.mint).not.toHaveBeenCalled();
  });

  it("rejects a non-Ed25519 device key with 400 and does not mint", async () => {
    const response = await authorizePOST(
      jsonRequest(
        "",
        authorizeBody({
          gatewayPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nk\n-----END-----",
        })
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_DESKTOP_AUTHORIZE",
      retryable: false,
    });
    expect(mocks.desktopAuthorizeService.mint).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400 and does not mint", async () => {
    const response = await authorizePOST(
      jsonRequest("", authorizeBody({ redirectUri: undefined }))
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_DESKTOP_AUTHORIZE",
      retryable: false,
    });
    expect(mocks.desktopAuthorizeService.mint).not.toHaveBeenCalled();
  });

  it("maps an invalid-request service outcome to 400", async () => {
    mocks.desktopAuthorizeService.mint.mockResolvedValue({
      ok: false,
      error: "invalid_request",
    });

    const response = await authorizePOST(jsonRequest("", authorizeBody()));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "DESKTOP_AUTHORIZE_INVALID_REQUEST",
      retryable: false,
    });
  });

  it("returns a retryable 503 when the service throws", async () => {
    mocks.desktopAuthorizeService.mint.mockRejectedValue(new Error("db down"));

    const response = await authorizePOST(jsonRequest("", authorizeBody()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "DESKTOP_AUTHORIZE_FAILED",
      retryable: true,
    });
  });
});

describe("POST /desktop/authorize/token", () => {
  it("returns 200 with desktop session tokens on success", async () => {
    mocks.desktopAuthorizeService.redeem.mockResolvedValue({
      ok: true,
      value: tokens,
    });

    const response = await tokenPOST(jsonRequest("token", tokenBody()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(tokens);
  });

  it("rejects a malformed body (short verifier) with 400", async () => {
    const response = await tokenPOST(
      jsonRequest("token", tokenBody({ codeVerifier: "short" }))
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_DESKTOP_AUTHORIZE_TOKEN",
      retryable: false,
    });
    expect(mocks.desktopAuthorizeService.redeem).not.toHaveBeenCalled();
  });

  it("maps pop_failed to 403 and invalid to 401", async () => {
    mocks.desktopAuthorizeService.redeem.mockResolvedValue({
      ok: false,
      error: "pop_failed",
    });
    const popResponse = await tokenPOST(jsonRequest("token", tokenBody()));
    expect(popResponse.status).toBe(403);
    await expect(popResponse.json()).resolves.toEqual({
      code: "DESKTOP_SESSION_POP_REQUIRED",
      retryable: false,
    });

    mocks.desktopAuthorizeService.redeem.mockResolvedValue({
      ok: false,
      error: "invalid",
    });
    const invalidResponse = await tokenPOST(jsonRequest("token", tokenBody()));
    expect(invalidResponse.status).toBe(401);
    await expect(invalidResponse.json()).resolves.toEqual({
      code: "DESKTOP_AUTHORIZE_TOKEN_INVALID",
      retryable: false,
    });
  });

  it("returns a retryable 503 and leaks no verifier when the service throws", async () => {
    mocks.desktopAuthorizeService.redeem.mockRejectedValue(new Error("db"));

    const response = await tokenPOST(
      jsonRequest(
        "token",
        tokenBody({
          codeVerifier: "secret-verifier-value-aaaaaaaaaaaaaaaaaaaaaaaa",
        })
      )
    );

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      code: "DESKTOP_AUTHORIZE_TOKEN_FAILED",
      retryable: true,
    });
    expect(JSON.stringify(body)).not.toContain("secret-verifier-value");
  });
});
