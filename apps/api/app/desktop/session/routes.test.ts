import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  desktopSessionService: {
    exchange: vi.fn(),
    refresh: vi.fn(),
    revoke: vi.fn(),
  },
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
  },
  scheduleLogFlush: vi.fn(),
}));

vi.mock("./service", () => ({
  desktopSessionService: mocks.desktopSessionService,
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
import { desktopConnectRejectionThrottle } from "@/app/desktop/contract";
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
  desktopConnectRejectionThrottle.clear();
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

  it("rejects a malformed body with the refresh validation envelope", async () => {
    const response = await refreshPOST(jsonRequest("refresh", {}));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_DESKTOP_SESSION_REFRESH",
      retryable: false,
    });
    expect(mocks.desktopSessionService.refresh).not.toHaveBeenCalled();
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

  it("rejects a malformed body with the revoke validation envelope", async () => {
    const response = await revokePOST(
      jsonRequest("revoke", { refreshToken: "" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_DESKTOP_SESSION_REVOKE",
      retryable: false,
    });
    expect(mocks.desktopSessionService.revoke).not.toHaveBeenCalled();
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

  it("returns a retryable 503 and leaks no token material when revoke throws", async () => {
    mocks.desktopSessionService.revoke.mockRejectedValue(new Error("db down"));

    const response = await revokePOST(
      jsonRequest("revoke", {
        refreshToken: "super-secret-revoke-material",
      })
    );

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      code: "DESKTOP_SESSION_REVOKE_FAILED",
      retryable: true,
    });
    expect(JSON.stringify(body)).not.toContain("super-secret-revoke-material");
  });
});

// These three run BEFORE any auth, so an unauthenticated caller decides what
// gets buffered. The refusal STATUS cannot prove the cap — each `.strict()`
// schema returns the same 400 for a malformed body — so the assertion is on the
// only thing the cap changes: how much of the stream the route pulls.
describe.each([
  ["exchange", exchangePOST],
  ["refresh", refreshPOST],
  ["revoke", revokePOST],
])("POST /desktop/session/%s body cap", (path, handler) => {
  it("stops pulling an oversized body instead of buffering it", async () => {
    const stream = countedEndlessBody();

    const response = await handler(
      streamRequest(
        `https://api.closedloop.ai/desktop/session/${path}`,
        stream.body
      )
    );

    expect(response.status).toBe(400);
    expect(stream.cancelled()).toBe(true);
    expect(stream.bytesPulled()).toBeLessThanOrEqual(maxPullForHandshakeCap());
  });
});

const validExchangeBody = {
  deviceSessionId: DEVICE_SESSION_ID,
  deviceSessionSecret: "secret",
};

/**
 * ISS-6343. Each row drives ONE rejection branch of the production handler and
 * pins the reason it reports. The four service-error rows matter most: they
 * sit behind one `switch`, so a mis-mapped case would otherwise report a
 * neighbouring branch's reason with nothing to catch it.
 */
const exchangeRejectionBranches = [
  {
    name: "the body fails schema validation",
    arrange: () => {
      // no service behavior needed — the route rejects before calling it
    },
    body: { deviceSessionId: "not-a-uuid" },
    status: 400,
    reason: "INVALID_DESKTOP_SESSION_EXCHANGE",
  },
  {
    name: "the exchange throws",
    arrange: () => {
      mocks.desktopSessionService.exchange.mockRejectedValue(
        new Error("database unavailable")
      );
    },
    body: validExchangeBody,
    status: 503,
    reason: "DESKTOP_SESSION_EXCHANGE_FAILED",
  },
  {
    name: "device PoP fails",
    arrange: () => {
      mocks.desktopSessionService.exchange.mockResolvedValue({
        ok: false,
        error: "pop_failed",
      });
    },
    body: validExchangeBody,
    status: 403,
    reason: "DESKTOP_SESSION_POP_REQUIRED",
  },
  {
    name: "the device session was already used",
    arrange: () => {
      mocks.desktopSessionService.exchange.mockResolvedValue({
        ok: false,
        error: "already_used",
      });
    },
    body: validExchangeBody,
    status: 409,
    reason: "DESKTOP_SESSION_ALREADY_USED",
  },
  {
    name: "the user has no organization",
    arrange: () => {
      mocks.desktopSessionService.exchange.mockResolvedValue({
        ok: false,
        error: "org_required",
      });
    },
    body: validExchangeBody,
    status: 400,
    reason: "DESKTOP_SESSION_ORG_REQUIRED",
  },
  {
    name: "the device session is invalid",
    arrange: () => {
      mocks.desktopSessionService.exchange.mockResolvedValue({
        ok: false,
        error: "invalid",
      });
    },
    body: validExchangeBody,
    status: 401,
    reason: "DESKTOP_SESSION_EXCHANGE_INVALID",
  },
];

describe("POST /desktop/session/exchange rejection telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopConnectRejectionThrottle.clear();
  });

  it.each(exchangeRejectionBranches)(
    "reports $reason when $name",
    async ({ arrange, body, status, reason }) => {
      arrange();

      const response = await exchangePOST(jsonRequest("exchange", body));

      // Pins that the intended branch ran, not some other rejection.
      expect(response.status).toBe(status);
      expect(readDesktopConnectRejection(mocks.log.warn)).toEqual(
        oneDesktopConnectRejection({ reason, stage: "session_exchange" })
      );
    }
  );

  it("reports nothing when the exchange succeeds", async () => {
    mocks.desktopSessionService.exchange.mockResolvedValue({
      ok: true,
      value: tokens,
    });

    const response = await exchangePOST(
      jsonRequest("exchange", validExchangeBody)
    );

    expect(response.status).toBe(200);
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });
});

/**
 * ISS-6343 (#5535 review, whitlockk). `/desktop/session/exchange` rejects a
 * malformed body on the Zod branch, before `desktopSessionService.exchange` —
 * which owns the rate limiting — is ever called, and the route is
 * unauthenticated. Without a bound at the choke point one anonymous caller can
 * therefore mint one Datadog warning per request, for as many requests as it
 * cares to send. These drive that exact loop.
 */
describe("POST /desktop/session/exchange rejection emission bound", () => {
  const BURST = 25;

  function malformedExchange(): Request {
    return jsonRequest("exchange", { deviceSessionId: "not-a-uuid" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    desktopConnectRejectionThrottle.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds the warning stream one caller can drive, without changing any response", async () => {
    const responses: Response[] = [];
    for (let index = 0; index < BURST; index += 1) {
      responses.push(await exchangePOST(malformedExchange()));
    }

    // The observability fix must be invisible on the wire: every request in the
    // burst gets the same status and body as the first, suppressed or not.
    for (const response of responses) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: "INVALID_DESKTOP_SESSION_EXCHANGE",
        retryable: false,
      });
    }

    // 25 requests, one line. Unbounded emission would be 25.
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "desktop_connect_rejected",
      expect.objectContaining({
        reason: "INVALID_DESKTOP_SESSION_EXCHANGE",
        stage: "session_exchange",
        occurrences: 1,
      })
    );
  });

  it("rolls the suppressed occurrences up rather than dropping them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00.000Z"));

    for (let index = 0; index < 4; index += 1) {
      await exchangePOST(malformedExchange());
    }
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);

    // Past the window: the next occurrence on the same key opens a fresh one
    // and carries the three suppressed occurrences out as an aggregate.
    vi.setSystemTime(new Date("2026-08-22T00:01:00.001Z"));
    await exchangePOST(malformedExchange());

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "desktop_connect_rejected",
      expect.objectContaining({
        reason: "INVALID_DESKTOP_SESSION_EXCHANGE",
        occurrences: 3,
        aggregated: true,
        flushedBy: "window",
      })
    );
    // The rollup plus the new window's own first occurrence.
    expect(mocks.log.warn).toHaveBeenCalledTimes(3);
  });

  it("drains a quiet key's suppressed count on a later unrelated rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00.000Z"));

    for (let index = 0; index < 3; index += 1) {
      await exchangePOST(malformedExchange());
    }
    vi.clearAllMocks();

    // The attacker never comes back on that key. A rejection on a DIFFERENT
    // key must still flush what the abandoned window suppressed — otherwise the
    // count sits in memory until the process freezes and is lost outright.
    vi.setSystemTime(new Date("2026-08-22T00:01:00.001Z"));
    mocks.desktopSessionService.exchange.mockResolvedValue({
      ok: false,
      error: "already_used",
    });
    await exchangePOST(jsonRequest("exchange", validExchangeBody));

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "desktop_connect_rejected",
      expect.objectContaining({
        reason: "INVALID_DESKTOP_SESSION_EXCHANGE",
        occurrences: 2,
        aggregated: true,
        flushedBy: "expiry",
      })
    );
  });
});
