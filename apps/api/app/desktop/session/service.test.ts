import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  consume: vi.fn(),
  verifyDesktopSessionPop: vi.fn(),
  issueDesktopAccessToken: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));
vi.mock("@/app/desktop/onboarding-attempt/service", () => ({
  desktopOnboardingAttemptsService: { consume: mocks.consume },
}));
vi.mock("@/lib/auth/desktop-session-pop", () => ({
  verifyDesktopSessionPop: mocks.verifyDesktopSessionPop,
}));
vi.mock("@repo/auth/desktop-session-jwt", () => ({
  issueDesktopAccessToken: mocks.issueDesktopAccessToken,
}));
vi.mock("@repo/observability/log", () => ({ log: mocks.log }));

import { desktopSessionService } from "./service";

const NOW = new Date("2026-06-29T12:00:00.000Z");
const FUTURE = new Date(NOW.getTime() + 5 * 60_000);
const PAST = new Date(NOW.getTime() - 60_000);
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

// Tracks whether the code under test is currently inside a withDb.tx scope, so
// tests can assert that one-time consumption happens inside the issuance
// transaction (and would therefore roll back on failure).
let txDepth = 0;

function installDb(db: Record<string, unknown>) {
  mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) => cb(db));
  mocks.withDb.tx.mockImplementation(async (cb: (db: unknown) => unknown) => {
    txDepth += 1;
    try {
      return await cb(db);
    } finally {
      txDepth -= 1;
    }
  });
}

function request(): Request {
  return new Request("https://api.test/desktop/session", { method: "POST" });
}

function approvedDeviceSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "device-1",
    status: "approved",
    userId: "user-1",
    organizationId: "org-1",
    gatewayId: "gateway-1",
    gatewayPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nk\n-----END-----",
    onboardingAttemptId: "attempt-1",
    machineName: "MBP",
    platform: "darwin",
    desktopVersion: "1.0.0",
    expiresAt: FUTURE,
    ...overrides,
  };
}

function sessionWithUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "sess-1",
    userId: "user-1",
    organizationId: "org-1",
    gatewayId: "gateway-1",
    boundPublicKey: "-----BEGIN PUBLIC KEY-----\nk\n-----END-----",
    revokedAt: null,
    expiresAt: FUTURE,
    user: { active: true, organizationId: "org-1" },
    organization: { active: true },
    ...overrides,
  };
}

/** A user row matching an active, in-org account for the exchange re-check. */
function activeAccountFindFirst() {
  return vi.fn().mockResolvedValue({ id: "user-1" });
}

function refreshTokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rt-1",
    sessionId: "sess-1",
    familyId: "fam-1",
    revokedAt: null,
    replacedByTokenId: null,
    expiresAt: FUTURE,
    session: sessionWithUser(),
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
  txDepth = 0;
  mocks.verifyDesktopSessionPop.mockReturnValue({ ok: true, reason: "passed" });
  mocks.issueDesktopAccessToken.mockResolvedValue(passingAccessToken);
  mocks.consume.mockResolvedValue(true);
});

describe("desktopSessionService.exchange", () => {
  it("issues session credentials and stores the refresh token only as a hash", async () => {
    let refreshCreateData: Record<string, unknown> | undefined;
    installDb({
      desktopOnboardingDeviceSession: {
        findFirst: vi.fn().mockResolvedValue(approvedDeviceSession()),
      },
      user: { findFirst: activeAccountFindFirst() },
      desktopSession: { create: vi.fn().mockResolvedValue({ id: "sess-1" }) },
      desktopRefreshToken: {
        create: vi.fn((args: { data: Record<string, unknown> }) => {
          refreshCreateData = args.data;
          return Promise.resolve({ id: "rt-1" });
        }),
      },
    });

    const result = await desktopSessionService.exchange({
      deviceSessionId: "device-1",
      deviceSessionSecret: "secret",
      request: request(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.accessToken).toBe("desktop-access-token");
    expect(result.value.refreshToken).toEqual(expect.any(String));
    expect(result.value.userId).toBe("user-1");
    expect(result.value.organizationId).toBe("org-1");
    expect(refreshCreateData?.tokenHash).toMatch(SHA256_HEX_RE);
    expect(refreshCreateData?.tokenHash).not.toBe(result.value.refreshToken);
  });

  it("consumes the onboarding attempt inside the issuance transaction so a failure rolls it back", async () => {
    let consumedAtTxDepth = -1;
    mocks.consume.mockImplementation(() => {
      consumedAtTxDepth = txDepth;
      return Promise.resolve(true);
    });
    // Simulate issuance throwing (e.g. unconfigured signing secret) after consume.
    mocks.issueDesktopAccessToken.mockRejectedValue(
      new Error("DESKTOP_SESSION_JWT_SECRET is not configured")
    );
    installDb({
      desktopOnboardingDeviceSession: {
        findFirst: vi.fn().mockResolvedValue(approvedDeviceSession()),
      },
      user: { findFirst: activeAccountFindFirst() },
      desktopSession: { create: vi.fn().mockResolvedValue({ id: "sess-1" }) },
      desktopRefreshToken: { create: vi.fn() },
    });

    // The failure must propagate (route maps it to a retryable 503), NOT a
    // terminal 409 already_used — the attempt is rolled back with the tx.
    await expect(
      desktopSessionService.exchange({
        deviceSessionId: "device-1",
        deviceSessionSecret: "secret",
        request: request(),
        now: NOW,
      })
    ).rejects.toThrow();
    expect(consumedAtTxDepth).toBeGreaterThan(0);
  });

  it("rejects when the device session is not approved or expired", async () => {
    installDb({
      desktopOnboardingDeviceSession: {
        findFirst: vi
          .fn()
          .mockResolvedValue(approvedDeviceSession({ expiresAt: PAST })),
      },
    });

    await expect(
      desktopSessionService.exchange({
        deviceSessionId: "device-1",
        deviceSessionSecret: "secret",
        request: request(),
        now: NOW,
      })
    ).resolves.toEqual({ ok: false, error: "invalid" });
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it("rejects when device PoP fails and never consumes the attempt", async () => {
    mocks.verifyDesktopSessionPop.mockReturnValue({
      ok: false,
      reason: "invalid_signature",
    });
    installDb({
      desktopOnboardingDeviceSession: {
        findFirst: vi.fn().mockResolvedValue(approvedDeviceSession()),
      },
    });

    await expect(
      desktopSessionService.exchange({
        deviceSessionId: "device-1",
        deviceSessionSecret: "secret",
        request: request(),
        now: NOW,
      })
    ).resolves.toEqual({ ok: false, error: "pop_failed" });
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it("rejects as already_used when the attempt was already consumed", async () => {
    mocks.consume.mockResolvedValue(false);
    installDb({
      desktopOnboardingDeviceSession: {
        findFirst: vi.fn().mockResolvedValue(approvedDeviceSession()),
      },
      user: { findFirst: activeAccountFindFirst() },
      desktopSession: { create: vi.fn() },
      desktopRefreshToken: { create: vi.fn() },
    });

    await expect(
      desktopSessionService.exchange({
        deviceSessionId: "device-1",
        deviceSessionSecret: "secret",
        request: request(),
        now: NOW,
      })
    ).resolves.toEqual({ ok: false, error: "already_used" });
  });

  it("rejects when the user or organization was deactivated after approval", async () => {
    const create = vi.fn();
    installDb({
      desktopOnboardingDeviceSession: {
        findFirst: vi.fn().mockResolvedValue(approvedDeviceSession()),
      },
      // No active user/org row matches the active-account re-check.
      user: { findFirst: vi.fn().mockResolvedValue(null) },
      desktopSession: { create },
      desktopRefreshToken: { create },
    });

    await expect(
      desktopSessionService.exchange({
        deviceSessionId: "device-1",
        deviceSessionSecret: "secret",
        request: request(),
        now: NOW,
      })
    ).resolves.toEqual({ ok: false, error: "invalid" });
    // Must reject before consuming the attempt or creating a session.
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("desktopSessionService.refresh", () => {
  it("rotates the refresh token, extends the session window, and returns new credentials", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi.fn().mockResolvedValue({ id: "rt-2" });
    const update = vi.fn().mockResolvedValue({});
    const sessionUpdate = vi.fn().mockResolvedValue({});
    installDb({
      desktopRefreshToken: {
        findUnique: vi.fn().mockResolvedValue(refreshTokenRow()),
        updateMany,
        create,
        update,
      },
      desktopSession: { update: sessionUpdate },
    });

    const result = await desktopSessionService.refresh({
      refreshToken: "old-refresh",
      request: request(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.refreshToken).not.toBe("old-refresh");
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "rt-1", revokedAt: null },
      data: { revokedAt: NOW, lastUsedAt: NOW },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "rt-1" },
      data: { replacedByTokenId: "rt-2" },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          familyId: "fam-1",
          rotatedFromTokenId: "rt-1",
        }),
      })
    );
    // Sliding-window expiry extension is a security property — assert it ran.
    expect(sessionUpdate).toHaveBeenCalledWith({
      where: { id: "sess-1" },
      data: { expiresAt: expect.any(Date), lastUsedAt: NOW },
    });
  });

  it("detects reuse of a rotated token and revokes the family + session", async () => {
    const tokenUpdateMany = vi.fn().mockResolvedValue({ count: 2 });
    const sessionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    installDb({
      desktopRefreshToken: {
        findUnique: vi
          .fn()
          .mockResolvedValue(refreshTokenRow({ replacedByTokenId: "rt-2" })),
        updateMany: tokenUpdateMany,
      },
      desktopSession: { updateMany: sessionUpdateMany },
    });

    await expect(
      desktopSessionService.refresh({
        refreshToken: "reused",
        request: request(),
        now: NOW,
      })
    ).resolves.toEqual({ ok: false, error: "invalid" });
    expect(tokenUpdateMany).toHaveBeenCalledWith({
      where: { familyId: "fam-1", revokedAt: null },
      data: { revokedAt: NOW },
    });
    expect(sessionUpdateMany).toHaveBeenCalledWith({
      where: { id: "sess-1", revokedAt: null },
      data: { revokedAt: NOW },
    });
  });

  it("rejects when the user is inactive or no longer in the session org", async () => {
    installDb({
      desktopRefreshToken: {
        findUnique: vi.fn().mockResolvedValue(
          refreshTokenRow({
            session: sessionWithUser({
              user: { active: false, organizationId: "org-1" },
            }),
          })
        ),
      },
    });

    await expect(
      desktopSessionService.refresh({
        refreshToken: "old-refresh",
        request: request(),
        now: NOW,
      })
    ).resolves.toEqual({ ok: false, error: "invalid" });
  });

  it("rejects when the organization is inactive", async () => {
    installDb({
      desktopRefreshToken: {
        findUnique: vi.fn().mockResolvedValue(
          refreshTokenRow({
            session: sessionWithUser({ organization: { active: false } }),
          })
        ),
      },
    });

    await expect(
      desktopSessionService.refresh({
        refreshToken: "old-refresh",
        request: request(),
        now: NOW,
      })
    ).resolves.toEqual({ ok: false, error: "invalid" });
  });

  it("rejects when device PoP fails", async () => {
    mocks.verifyDesktopSessionPop.mockReturnValue({
      ok: false,
      reason: "gateway_mismatch",
    });
    installDb({
      desktopRefreshToken: {
        findUnique: vi.fn().mockResolvedValue(refreshTokenRow()),
      },
    });

    await expect(
      desktopSessionService.refresh({
        refreshToken: "old-refresh",
        request: request(),
        now: NOW,
      })
    ).resolves.toEqual({ ok: false, error: "pop_failed" });
  });

  it("rejects an unknown refresh token", async () => {
    installDb({
      desktopRefreshToken: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      desktopSessionService.refresh({
        refreshToken: "nope",
        request: request(),
        now: NOW,
      })
    ).resolves.toEqual({ ok: false, error: "invalid" });
  });
});

describe("desktopSessionService.revoke", () => {
  it("revokes the session and its refresh-token family", async () => {
    const tokenUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const sessionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    installDb({
      desktopRefreshToken: {
        findUnique: vi.fn().mockResolvedValue(refreshTokenRow()),
        updateMany: tokenUpdateMany,
      },
      desktopSession: { updateMany: sessionUpdateMany },
    });

    await expect(
      desktopSessionService.revoke({
        refreshToken: "old-refresh",
        request: request(),
        now: NOW,
      })
    ).resolves.toEqual({ ok: true, value: true });
    expect(tokenUpdateMany).toHaveBeenCalledWith({
      where: { sessionId: "sess-1", revokedAt: null },
      data: { revokedAt: NOW },
    });
    expect(sessionUpdateMany).toHaveBeenCalledWith({
      where: { id: "sess-1", revokedAt: null },
      data: { revokedAt: NOW },
    });
  });

  it("is idempotent for an unknown refresh token", async () => {
    installDb({
      desktopRefreshToken: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      desktopSessionService.revoke({
        refreshToken: "nope",
        request: request(),
        now: NOW,
      })
    ).resolves.toEqual({ ok: true, value: true });
  });

  it("requires device PoP before revoking", async () => {
    mocks.verifyDesktopSessionPop.mockReturnValue({
      ok: false,
      reason: "missing_headers",
    });
    const sessionUpdateMany = vi.fn();
    installDb({
      desktopRefreshToken: {
        findUnique: vi.fn().mockResolvedValue(refreshTokenRow()),
      },
      desktopSession: { updateMany: sessionUpdateMany },
    });

    await expect(
      desktopSessionService.revoke({
        refreshToken: "old-refresh",
        request: request(),
        now: NOW,
      })
    ).resolves.toEqual({ ok: false, error: "pop_failed" });
    expect(sessionUpdateMany).not.toHaveBeenCalled();
  });
});
