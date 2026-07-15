import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  desktopSessionService: {
    exchange: vi.fn(),
    refresh: vi.fn(),
    revoke: vi.fn(),
  },
}));

vi.mock("./service", () => ({
  desktopSessionService: mocks.desktopSessionService,
}));

import { POST as exchangePOST } from "./exchange/route";
import { POST as refreshPOST } from "./refresh/route";
import { POST as revokePOST } from "./revoke/route";

const DEVICE_SESSION_ID = "019dd545-9926-7447-99fe-2671bf53acb1";

const tokens = {
  accessToken: "access-token",
  accessTokenExpiresAt: "2026-06-29T12:15:00.000Z",
  refreshToken: "refresh-token",
  refreshTokenExpiresAt: "2026-07-29T12:00:00.000Z",
  userId: "user-1",
  organizationId: "org-1",
};

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://api.closedloop.ai/desktop/session/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /desktop/session/exchange", () => {
  it("returns 200 with session tokens on success", async () => {
    mocks.desktopSessionService.exchange.mockResolvedValue({
      ok: true,
      value: tokens,
    });

    const response = await exchangePOST(
      jsonRequest("exchange", {
        deviceSessionId: DEVICE_SESSION_ID,
        deviceSessionSecret: "secret",
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(tokens);
  });

  it("rejects a malformed body with 400", async () => {
    const response = await exchangePOST(
      jsonRequest("exchange", { deviceSessionId: "not-a-uuid" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_DESKTOP_SESSION_EXCHANGE",
      retryable: false,
    });
    expect(mocks.desktopSessionService.exchange).not.toHaveBeenCalled();
  });

  it("maps service errors to exact status + error codes", async () => {
    const cases = [
      {
        error: "pop_failed",
        status: 403,
        code: "DESKTOP_SESSION_POP_REQUIRED",
      },
      {
        error: "already_used",
        status: 409,
        code: "DESKTOP_SESSION_ALREADY_USED",
      },
      {
        error: "org_required",
        status: 400,
        code: "DESKTOP_SESSION_ORG_REQUIRED",
      },
      {
        error: "invalid",
        status: 401,
        code: "DESKTOP_SESSION_EXCHANGE_INVALID",
      },
    ] as const;

    for (const testCase of cases) {
      mocks.desktopSessionService.exchange.mockResolvedValue({
        ok: false,
        error: testCase.error,
      });
      const response = await exchangePOST(
        jsonRequest("exchange", {
          deviceSessionId: DEVICE_SESSION_ID,
          deviceSessionSecret: "secret",
        })
      );
      expect(response.status).toBe(testCase.status);
      await expect(response.json()).resolves.toEqual({
        code: testCase.code,
        retryable: false,
      });
    }
  });

  it("returns a retryable 503 and leaks no token material when the service throws", async () => {
    mocks.desktopSessionService.exchange.mockRejectedValue(
      new Error("db down")
    );

    const response = await exchangePOST(
      jsonRequest("exchange", {
        deviceSessionId: DEVICE_SESSION_ID,
        deviceSessionSecret: "super-secret-exchange-material",
      })
    );

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      code: "DESKTOP_SESSION_EXCHANGE_FAILED",
      retryable: true,
    });
    expect(JSON.stringify(body)).not.toContain(
      "super-secret-exchange-material"
    );
  });
});

describe("POST /desktop/session/refresh", () => {
  it("returns 200 with rotated tokens on success", async () => {
    mocks.desktopSessionService.refresh.mockResolvedValue({
      ok: true,
      value: tokens,
    });

    const response = await refreshPOST(
      jsonRequest("refresh", { refreshToken: "old" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(tokens);
  });

  it("returns 401 invalid for a rejected refresh", async () => {
    mocks.desktopSessionService.refresh.mockResolvedValue({
      ok: false,
      error: "invalid",
    });

    const response = await refreshPOST(
      jsonRequest("refresh", { refreshToken: "bad" })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "DESKTOP_SESSION_REFRESH_INVALID",
      retryable: false,
    });
  });

  it("returns 403 when device PoP fails", async () => {
    mocks.desktopSessionService.refresh.mockResolvedValue({
      ok: false,
      error: "pop_failed",
    });

    const response = await refreshPOST(
      jsonRequest("refresh", { refreshToken: "old" })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: "DESKTOP_SESSION_POP_REQUIRED",
      retryable: false,
    });
  });

  it("does not echo the refresh token in an error body", async () => {
    mocks.desktopSessionService.refresh.mockRejectedValue(new Error("db"));

    const response = await refreshPOST(
      jsonRequest("refresh", { refreshToken: "leaky-refresh-token-value" })
    );

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("leaky-refresh-token-value");
  });
});

describe("POST /desktop/session/revoke", () => {
  it("returns 200 revoked on success", async () => {
    mocks.desktopSessionService.revoke.mockResolvedValue({
      ok: true,
      value: true,
    });

    const response = await revokePOST(
      jsonRequest("revoke", { refreshToken: "old" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "revoked" });
  });

  it("returns 403 when device PoP fails", async () => {
    mocks.desktopSessionService.revoke.mockResolvedValue({
      ok: false,
      error: "pop_failed",
    });

    const response = await revokePOST(
      jsonRequest("revoke", { refreshToken: "old" })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: "DESKTOP_SESSION_POP_REQUIRED",
      retryable: false,
    });
  });
});
