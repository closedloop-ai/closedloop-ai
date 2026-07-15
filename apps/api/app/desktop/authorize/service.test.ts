import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  verifyDesktopSessionPop: vi.fn(),
  issueDesktopAccessToken: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));
vi.mock("@/lib/auth/desktop-session-pop", () => ({
  verifyDesktopSessionPop: mocks.verifyDesktopSessionPop,
}));
vi.mock("@repo/auth/desktop-session-jwt", () => ({
  issueDesktopAccessToken: mocks.issueDesktopAccessToken,
}));
vi.mock("@/app/desktop/onboarding-attempt/service", () => ({
  desktopOnboardingAttemptsService: { consume: vi.fn() },
}));
vi.mock("@repo/observability/log", () => ({ log: mocks.log }));

import { PKCE_CODE_CHALLENGE_METHOD } from "@/lib/auth/pkce";
// Real PKCE, redirect-URI allowlist, and token hashing are exercised end-to-end.
import { desktopAuthorizeService } from "./service";

// Canonical RFC 7636 Appendix B PKCE pair.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const LOOPBACK_REDIRECT = "http://127.0.0.1:49152/cb";
const PUBLIC_KEY_PEM = "-----BEGIN PUBLIC KEY-----\nk\n-----END-----";
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

const NOW = new Date("2026-07-01T12:00:00.000Z");
const FUTURE = new Date(NOW.getTime() + 30_000);
const PAST = new Date(NOW.getTime() - 1000);

function installDb(db: Record<string, unknown>) {
  mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) => cb(db));
  mocks.withDb.tx.mockImplementation((cb: (db: unknown) => unknown) => cb(db));
}

function request(): Request {
  return new Request("https://api.test/desktop/authorize/token", {
    method: "POST",
  });
}

function storedCode(overrides: Record<string, unknown> = {}) {
  return {
    id: "code-1",
    userId: "user-1",
    organizationId: "org-1",
    gatewayId: "gateway-1",
    boundPublicKey: PUBLIC_KEY_PEM,
    codeChallenge: RFC_CHALLENGE,
    redirectUri: LOOPBACK_REDIRECT,
    expiresAt: FUTURE,
    redeemedAt: null,
    ...overrides,
  };
}

function mintInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    organizationId: "org-1",
    gatewayId: "gateway-1",
    gatewayPublicKeyPem: PUBLIC_KEY_PEM,
    codeChallenge: RFC_CHALLENGE,
    codeChallengeMethod: PKCE_CODE_CHALLENGE_METHOD,
    redirectUri: LOOPBACK_REDIRECT,
    now: NOW,
    ...overrides,
  };
}

function redeemInput(overrides: Record<string, unknown> = {}) {
  return {
    code: "raw-code",
    codeVerifier: RFC_VERIFIER,
    gatewayId: "gateway-1",
    redirectUri: LOOPBACK_REDIRECT,
    request: request(),
    now: NOW,
    ...overrides,
  };
}

const passingAccessToken = {
  token: "desktop-access-token",
  tokenId: "jti-1",
  expiresAt: new Date(NOW.getTime() + 15 * 60_000),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyDesktopSessionPop.mockReturnValue({ ok: true, reason: "passed" });
  mocks.issueDesktopAccessToken.mockResolvedValue(passingAccessToken);
});

describe("desktopAuthorizeService.mint", () => {
  it("mints a code bound to user/org/pubkey/challenge/redirect and stores only its hash", async () => {
    let created: Record<string, unknown> | undefined;
    installDb({
      desktopAuthorizationCode: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn((args: { data: Record<string, unknown> }) => {
          created = args.data;
          return Promise.resolve({ id: "code-1" });
        }),
      },
    });

    const result = await desktopAuthorizeService.mint(mintInput());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    // Raw code is returned to the caller; only its SHA-256 hash is persisted.
    expect(result.value.code).toEqual(expect.any(String));
    expect(created?.codeHash).toMatch(SHA256_HEX_RE);
    expect(created?.codeHash).not.toBe(result.value.code);
    expect(created).toMatchObject({
      userId: "user-1",
      organizationId: "org-1",
      gatewayId: "gateway-1",
      boundPublicKey: PUBLIC_KEY_PEM,
      codeChallenge: RFC_CHALLENGE,
      redirectUri: LOOPBACK_REDIRECT,
    });
  });

  it("opportunistically evicts codes past their TTL when minting", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
    installDb({
      desktopAuthorizationCode: {
        deleteMany,
        create: vi.fn().mockResolvedValue({ id: "code-1" }),
      },
    });

    await desktopAuthorizeService.mint(mintInput());

    expect(deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: NOW } },
    });
  });

  it("rejects an unsupported PKCE method without persisting a code", async () => {
    const create = vi.fn();
    installDb({ desktopAuthorizationCode: { create } });

    await expect(
      desktopAuthorizeService.mint(mintInput({ codeChallengeMethod: "plain" }))
    ).resolves.toEqual({ ok: false, error: "invalid_request" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a malformed S256 challenge", async () => {
    const create = vi.fn();
    installDb({ desktopAuthorizationCode: { create } });

    await expect(
      desktopAuthorizeService.mint(mintInput({ codeChallenge: "too-short" }))
    ).resolves.toEqual({ ok: false, error: "invalid_request" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback redirect URI", async () => {
    const create = vi.fn();
    installDb({ desktopAuthorizationCode: { create } });

    await expect(
      desktopAuthorizeService.mint(
        mintInput({ redirectUri: "https://evil.com/cb" })
      )
    ).resolves.toEqual({ ok: false, error: "invalid_request" });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("desktopAuthorizeService.redeem", () => {
  function happyPathDb(overrides: Record<string, unknown> = {}) {
    return {
      desktopAuthorizationCode: {
        findUnique: vi.fn().mockResolvedValue(storedCode()),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        ...overrides,
      },
      user: { findFirst: vi.fn().mockResolvedValue({ id: "user-1" }) },
      desktopSession: { create: vi.fn().mockResolvedValue({ id: "sess-1" }) },
      desktopRefreshToken: {
        create: vi.fn().mockResolvedValue({ id: "rt-1" }),
      },
    };
  }

  it("redeems a valid code + verifier + PoP for desktop credentials", async () => {
    installDb(happyPathDb());

    const result = await desktopAuthorizeService.redeem(redeemInput());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.accessToken).toBe("desktop-access-token");
    expect(result.value.userId).toBe("user-1");
    expect(result.value.organizationId).toBe("org-1");
    expect(result.value.refreshToken).toEqual(expect.any(String));
  });

  it("scopes the single-use claim to a still-unexpired row", async () => {
    const db = happyPathDb();
    installDb(db);

    await desktopAuthorizeService.redeem(redeemInput());

    // The atomic claim re-checks TTL so a code cannot be flipped after expiry
    // even if validation was delayed past the read-time check.
    expect(db.desktopAuthorizationCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          redeemedAt: null,
          expiresAt: { gt: NOW },
        }),
      })
    );
  });

  it("rejects when the PKCE verifier does not hash to the bound challenge", async () => {
    const db = happyPathDb();
    installDb(db);

    await expect(
      desktopAuthorizeService.redeem(
        // A different, well-formed verifier that does not hash to RFC_CHALLENGE.
        redeemInput({ codeVerifier: "a".repeat(43) })
      )
    ).resolves.toEqual({ ok: false, error: "invalid" });
    expect(mocks.verifyDesktopSessionPop).not.toHaveBeenCalled();
    expect(db.desktopAuthorizationCode.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an expired code", async () => {
    installDb({
      desktopAuthorizationCode: {
        findUnique: vi.fn().mockResolvedValue(storedCode({ expiresAt: PAST })),
      },
    });

    await expect(
      desktopAuthorizeService.redeem(redeemInput())
    ).resolves.toEqual({ ok: false, error: "invalid" });
  });

  it("rejects a code already redeemed at read time (replay)", async () => {
    installDb({
      desktopAuthorizationCode: {
        findUnique: vi.fn().mockResolvedValue(storedCode({ redeemedAt: PAST })),
      },
    });

    await expect(
      desktopAuthorizeService.redeem(redeemInput())
    ).resolves.toEqual({ ok: false, error: "invalid" });
    expect(mocks.verifyDesktopSessionPop).not.toHaveBeenCalled();
  });

  it("rejects when the gateway id or redirect URI does not match the mint", async () => {
    installDb(happyPathDb());
    await expect(
      desktopAuthorizeService.redeem(redeemInput({ gatewayId: "other" }))
    ).resolves.toEqual({ ok: false, error: "invalid" });

    installDb(happyPathDb());
    await expect(
      desktopAuthorizeService.redeem(
        redeemInput({ redirectUri: "http://127.0.0.1:9999/cb" })
      )
    ).resolves.toEqual({ ok: false, error: "invalid" });
  });

  it("rejects when device PoP fails", async () => {
    mocks.verifyDesktopSessionPop.mockReturnValue({
      ok: false,
      reason: "invalid_signature",
    });
    const db = happyPathDb();
    installDb(db);

    await expect(
      desktopAuthorizeService.redeem(redeemInput())
    ).resolves.toEqual({ ok: false, error: "pop_failed" });
    expect(db.desktopAuthorizationCode.updateMany).not.toHaveBeenCalled();
  });

  it("rejects when the user or organization was deactivated since the mint", async () => {
    installDb({
      desktopAuthorizationCode: {
        findUnique: vi.fn().mockResolvedValue(storedCode()),
        updateMany: vi.fn(),
      },
      user: { findFirst: vi.fn().mockResolvedValue(null) },
      desktopSession: { create: vi.fn() },
      desktopRefreshToken: { create: vi.fn() },
    });

    await expect(
      desktopAuthorizeService.redeem(redeemInput())
    ).resolves.toEqual({ ok: false, error: "invalid" });
  });

  it("is single-use: a concurrent redeem that claims zero rows issues nothing", async () => {
    const create = vi.fn();
    installDb({
      desktopAuthorizationCode: {
        findUnique: vi.fn().mockResolvedValue(storedCode()),
        // The competing redeem already flipped redeemedAt → 0 rows claimed.
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      user: { findFirst: vi.fn().mockResolvedValue({ id: "user-1" }) },
      desktopSession: { create },
      desktopRefreshToken: { create },
    });

    await expect(
      desktopAuthorizeService.redeem(redeemInput())
    ).resolves.toEqual({ ok: false, error: "invalid" });
    expect(create).not.toHaveBeenCalled();
  });
});
