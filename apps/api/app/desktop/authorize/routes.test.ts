import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  desktopAuthorizeService: { mint: vi.fn(), redeem: vi.fn() },
  resolveSessionUser: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
  },
  scheduleLogFlush: vi.fn(),
}));

vi.mock("./service", () => ({
  desktopAuthorizeService: mocks.desktopAuthorizeService,
}));
vi.mock("@/lib/auth/session-user", () => ({
  resolveSessionUser: mocks.resolveSessionUser,
}));
vi.mock("@repo/observability/log", () => ({ log: mocks.log }));
vi.mock("@/lib/route-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/route-utils")>()),
  scheduleLogFlush: mocks.scheduleLogFlush,
}));

import {
  countedEndlessBody,
  maxPullForHandshakeCap,
  streamRequest,
} from "@/__tests__/utils/bounded-body.test-helpers";
import {
  oneDesktopConnectRejection,
  readDesktopConnectRejection,
} from "@/__tests__/utils/desktop-connect-rejected.test-helpers";
import {
  stubTrustedOriginEnv,
  TRUSTED_APP_ORIGIN,
  TRUSTED_WEB_ORIGIN,
  UNTRUSTED_ORIGIN,
} from "@/__tests__/utils/trusted-origin.test-helpers";
import { desktopConnectRejectionThrottle } from "@/app/desktop/contract";
import { normalizeEd25519SpkiPublicKeyPem } from "@/lib/auth/ed25519-spki-pem";
import { PKCE_CODE_CHALLENGE_METHOD } from "@/lib/auth/pkce";
import { POST as authorizePOST } from "./route";
import { POST as tokenPOST } from "./token/route";

const LOOPBACK_REDIRECT = "http://127.0.0.1:49152/cb";
// `http://localhost:3000` is always a trusted origin (see trusted-origins.ts).
const WEB_APP_ORIGIN = "http://localhost:3000";
// A real Ed25519 SPKI PEM so the route's normalize check passes. Deliberately
// non-canonical (CRLF line endings) so the mint assertion below can tell a
// raw pass-through from the route's own normalized value apart.
const GATEWAY_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\r\nMCowBQYDK2VwAyEA/lxbpof9Yiku55lRb6UkI29fzWkbmHPDGidrCi9pZeA=\r\n-----END PUBLIC KEY-----\r\n";
const tokens = {
  accessToken: "access-token",
  accessTokenExpiresAt: "2026-07-01T12:15:00.000Z",
  refreshToken: "refresh-token",
  refreshTokenExpiresAt: "2026-07-31T12:00:00.000Z",
  userId: "user-1",
  organizationId: "org-1",
};

// `origin: null` builds a request with NO Origin header — a non-browser caller.
// That is a different input from an untrusted Origin, and only this builder
// produces it, so the header stays owned in one place.
function jsonRequest(
  path: string,
  body: unknown,
  origin: string | null = WEB_APP_ORIGIN
): Request {
  return new Request(`https://api.closedloop.ai/desktop/authorize/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin === null ? {} : { origin }),
    },
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
  stubTrustedOriginEnv();
  mocks.resolveSessionUser.mockResolvedValue({
    user: { id: "user-1", organizationId: "org-1" },
    clerkUserId: "clerk-1",
    clerkOrgId: "clerk-org-1",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  // The pair above/below is the point: a session that RESOLVES null is a signed
  // out user (401, not retryable), while a session lookup that THROWS is a
  // server-side fault (503, retryable). Collapsing the two told a user to sign
  // in again for a condition signing in cannot fix (ISS-7974).
  it("returns a retryable 503 when the session lookup throws, and never mints", async () => {
    mocks.resolveSessionUser.mockRejectedValue(new Error("clerk down"));

    const response = await authorizePOST(jsonRequest("", authorizeBody()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "DESKTOP_AUTHORIZE_FAILED",
      retryable: true,
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
    // The PEM fixture is deliberately non-canonical (CRLF), so this also pins
    // that the route passes the NORMALIZED key, not the raw request value.
    expect(mocks.desktopAuthorizeService.mint).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        organizationId: "org-1",
        gatewayPublicKeyPem: normalizeEd25519SpkiPublicKeyPem(
          GATEWAY_PUBLIC_KEY_PEM
        ),
      })
    );
  });

  it("rejects a foreign Origin with 403 and does not mint (CSRF)", async () => {
    const response = await authorizePOST(
      jsonRequest("", authorizeBody(), UNTRUSTED_ORIGIN)
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: "DESKTOP_AUTHORIZE_FORBIDDEN",
      retryable: false,
    });
    expect(mocks.desktopAuthorizeService.mint).not.toHaveBeenCalled();
  });

  it("rejects a self-consistent non-allowlisted origin with 403 and does not mint", async () => {
    // The case above only proves the mismatch branch: its webAppOrigin is
    // allowlisted, so a raw string comparison alone would still reject it. Here
    // the Origin header and webAppOrigin are the same non-allowlisted value, so
    // the mismatch branch cannot fire and only the allowlist can reject.
    // (That is about what each fixture DISCRIMINATES — swap in an identity
    // canonicalizer and only this case goes red. Neither case actually reaches
    // the `requestOrigin === webAppOrigin` equality at runtime; both stop at the
    // null guard ahead of it. The case that does reach it is further down.)
    const response = await authorizePOST(
      jsonRequest(
        "",
        authorizeBody({ webAppOrigin: UNTRUSTED_ORIGIN }),
        UNTRUSTED_ORIGIN
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: "DESKTOP_AUTHORIZE_FORBIDDEN",
      retryable: false,
    });
    expect(mocks.desktopAuthorizeService.mint).not.toHaveBeenCalled();
  });

  it("rejects a request carrying no Origin header at all with 403 and does not mint", async () => {
    // Both cases above send an Origin header, so the header-absent arm of the
    // `requestOriginHeader ? … : null` ternary is never evaluated by them.
    // Without this case, resolving an absent Origin to the body's own
    // webAppOrigin — trusting any non-browser caller — passes the whole suite.
    const response = await authorizePOST(
      jsonRequest("", authorizeBody(), null)
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: "DESKTOP_AUTHORIZE_FORBIDDEN",
      retryable: false,
    });
    expect(mocks.desktopAuthorizeService.mint).not.toHaveBeenCalled();
  });

  it("rejects two trusted but different origins with 403 and does not mint", async () => {
    // The only case holding two non-null, DISTINCT, trusted origins, so it is
    // the only one that reaches the `requestOrigin === webAppOrigin` equality:
    // every other origin case is already rejected by the null/allowlist guard
    // in front of it. Deleting that equality outright passes the rest of the
    // suite, which would leave this Clerk-cookie-authed mint open to any
    // trusted-origin page.
    const response = await authorizePOST(
      jsonRequest(
        "",
        authorizeBody({ webAppOrigin: TRUSTED_APP_ORIGIN }),
        TRUSTED_WEB_ORIGIN
      )
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

    const request = jsonRequest("token", tokenBody());
    const response = await tokenPOST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(tokens);
    // `toEqual`/`objectContaining` cannot distinguish two different Request
    // instances (Request exposes no own enumerable properties), so identity
    // is asserted with `toBe` against the captured call argument instead.
    expect(mocks.desktopAuthorizeService.redeem).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "raw-code",
        codeVerifier: "a".repeat(43),
        gatewayId: "gateway-1",
        redirectUri: LOOPBACK_REDIRECT,
      })
    );
    const [redeemArg] = mocks.desktopAuthorizeService.redeem.mock.calls[0];
    expect(redeemArg.request).toBe(request);
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

// Unlike the token route below, the authorize MINT resolves the Clerk session
// first, so its cap bounds what an AUTHENTICATED caller can make the route
// buffer. The 400 alone cannot prove the cap — the `.strict()` schema returns
// the same 400 for a malformed body — so assert on what the cap changes.
describe("POST /desktop/authorize body cap", () => {
  it("stops pulling an oversized body instead of buffering it", async () => {
    const stream = countedEndlessBody();

    const response = await authorizePOST(
      streamRequest("https://api.closedloop.ai/desktop/authorize", stream.body)
    );

    expect(response.status).toBe(400);
    // `cancelled` is the load-bearing half: a reader that buffered the whole
    // body would drain the stream to its close instead of cancelling it.
    expect(stream.cancelled()).toBe(true);
    // Two chunks, not one — this route awaits the session lookup before it
    // starts reading, which gives the stream's pull loop one extra turn.
    expect(stream.bytesPulled()).toBeLessThanOrEqual(maxPullForHandshakeCap(2));
  });
});

// `/desktop/authorize/token` runs before any auth (it is authenticated by the
// code + PKCE in the body), so an unauthenticated caller decides what gets
// buffered. The 400 alone cannot prove the cap — the `.strict()` schema returns
// the same 400 for a malformed body — so assert on what the cap changes.
describe("POST /desktop/authorize/token body cap", () => {
  it("stops pulling an oversized body instead of buffering it", async () => {
    const stream = countedEndlessBody();

    const response = await tokenPOST(
      streamRequest(
        "https://api.closedloop.ai/desktop/authorize/token",
        stream.body
      )
    );

    expect(response.status).toBe(400);
    expect(stream.cancelled()).toBe(true);
    expect(stream.bytesPulled()).toBeLessThanOrEqual(maxPullForHandshakeCap());
  });
});

// The catch this covers sits AHEAD of any auth decision, so an unauthenticated
// caller reaches it once per request for as long as the auth provider is
// faulting. A bare `log.error` there would turn one outage into an unbounded
// Datadog stream — the amplification `apps/api/AGENTS.md` ("Emission and Abuse
// Control") forbids. These pin the bound itself, not just that something was
// reported: swap the emitter back for a raw log and the suppression case reddens.
describe("POST /desktop/authorize session-lookup fault telemetry", () => {
  beforeEach(() => {
    // The block above already drove this branch, and it shares one throttle
    // key, so without this the first report here is suppressed.
    desktopConnectRejectionThrottle.clear();
    mocks.resolveSessionUser.mockRejectedValue(new Error("clerk down"));
  });

  it("reports the fault once, tagged with the cause the wire code cannot carry", async () => {
    const response = await authorizePOST(jsonRequest("", authorizeBody()));

    expect(response.status).toBe(503);
    // No `orgId`: a lookup that threw never resolved a session, so the field is
    // omitted rather than reported as one that was looked up and came back empty.
    expect(readDesktopConnectRejection(mocks.log.warn)).toEqual(
      oneDesktopConnectRejection({
        reason: "DESKTOP_AUTHORIZE_FAILED",
        stage: "authorize",
        cause: "session_lookup_faulted",
      })
    );
  });

  it("suppresses a repeat within the window while still refusing every caller", async () => {
    const first = await authorizePOST(jsonRequest("", authorizeBody()));
    const second = await authorizePOST(jsonRequest("", authorizeBody()));

    // The RESPONSE is not throttled — the second caller is refused identically.
    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    await expect(second.json()).resolves.toEqual({
      code: "DESKTOP_AUTHORIZE_FAILED",
      retryable: true,
    });
    // Two occurrences, one line. The second is counted, not discarded: it is
    // flushed as a rollup by the next occurrence, an expiry drain, or eviction.
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
  });

  it("flushes the log buffer so the rejection survives the function freeze", async () => {
    await authorizePOST(jsonRequest("", authorizeBody()));

    expect(mocks.scheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("reports nothing when the session resolves", async () => {
    mocks.resolveSessionUser.mockResolvedValue({
      user: { id: "user-1", organizationId: "org-1" },
      clerkUserId: "clerk-1",
      clerkOrgId: "clerk-org-1",
    });
    mocks.desktopAuthorizeService.mint.mockResolvedValue({
      ok: true,
      value: { code: "the-code", expiresAt: "2026-07-01T12:01:00.000Z" },
    });

    const response = await authorizePOST(jsonRequest("", authorizeBody()));

    expect(response.status).toBe(200);
    expect(mocks.log.warn).not.toHaveBeenCalled();
    expect(mocks.scheduleLogFlush).not.toHaveBeenCalled();
  });
});
