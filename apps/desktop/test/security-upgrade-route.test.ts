import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerSecurityUpgradeRoutes } from "../src/server/operations/security-upgrade.js";

function makeResponse(): {
  response: ServerResponse;
  body: () => unknown;
  statusCode: () => number;
} {
  let statusCode = 0;
  let chunk = "";
  const response = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
    setHeader() {},
    end(value?: unknown) {
      if (typeof value === "string") {
        chunk += value;
      }
    },
  } as unknown as ServerResponse;
  return {
    response,
    body: () => JSON.parse(chunk),
    statusCode: () => statusCode,
  };
}

async function dispatch(
  body: unknown,
  options?: {
    gatewayId?: string;
    computeTargetId?: string | null;
    handleSecurityUpgrade?: Parameters<
      typeof registerSecurityUpgradeRoutes
    >[1]["handleSecurityUpgrade"];
  }
) {
  const dispatcher = new OperationDispatcher();
  const hasHandlerOption = Object.hasOwn(
    options ?? {},
    "handleSecurityUpgrade"
  );
  registerSecurityUpgradeRoutes(dispatcher, {
    getGatewayId: () => options?.gatewayId ?? "gateway-1",
    getComputeTargetId: () => options?.computeTargetId ?? "target-1",
    handleSecurityUpgrade: hasHandlerOption
      ? options?.handleSecurityUpgrade
      : async () => ({ ok: true }),
  });
  const captured = makeResponse();
  const bodyString = typeof body === "string" ? body : JSON.stringify(body);
  await dispatcher.dispatch({
    method: "POST",
    pathname: "/api/gateway/security/upgrade",
    params: {},
    query: new URLSearchParams(),
    rawBody: Buffer.from(bodyString),
    body: bodyString,
    request: {} as IncomingMessage,
    response: captured.response,
  });
  return captured;
}

describe("security upgrade route", () => {
  const validPayload = {
    onboardingAttemptId: "attempt-1",
    webAppOrigin: "https://app.closedloop.ai",
    computeTargetId: "target-1",
    gatewayId: "gateway-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  test("rejects malformed payloads with exact error body", async () => {
    const response = await dispatch({
      ...validPayload,
      onboardingAttemptId: "",
    });

    assert.equal(response.statusCode(), 400);
    assert.deepEqual(response.body(), {
      code: "INVALID_SECURITY_UPGRADE_REQUEST",
      retryable: false,
    });
  });

  test("rejects target and gateway mismatches before handler execution", async () => {
    let called = false;
    const response = await dispatch(
      { ...validPayload, gatewayId: "gateway-other" },
      {
        handleSecurityUpgrade: async () => {
          called = true;
          return { ok: true };
        },
      }
    );

    assert.equal(response.statusCode(), 409);
    assert.deepEqual(response.body(), {
      code: "SECURITY_UPGRADE_GATEWAY_MISMATCH",
      retryable: false,
    });
    assert.equal(called, false);
  });

  test("rejects stale commands before handler execution", async () => {
    let called = false;
    const response = await dispatch(
      {
        ...validPayload,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        handleSecurityUpgrade: async () => {
          called = true;
          return { ok: true };
        },
      }
    );

    assert.equal(response.statusCode(), 410);
    assert.deepEqual(response.body(), {
      code: "SECURITY_UPGRADE_ATTEMPT_EXPIRED",
      retryable: false,
    });
    assert.equal(called, false);
  });

  test("rejects compute target mismatches before handler execution", async () => {
    let called = false;
    const response = await dispatch(
      { ...validPayload, computeTargetId: "target-other" },
      {
        handleSecurityUpgrade: async () => {
          called = true;
          return { ok: true };
        },
      }
    );

    assert.equal(response.statusCode(), 409);
    assert.deepEqual(response.body(), {
      code: "SECURITY_UPGRADE_TARGET_MISMATCH",
      retryable: false,
    });
    assert.equal(called, false);
  });

  test("ignores forward-compatible payload fields", async () => {
    let received: unknown = null;
    const response = await dispatch(
      { ...validPayload, traceId: "trace-1" },
      {
        handleSecurityUpgrade: async (payload) => {
          received = payload;
          return { ok: true };
        },
      }
    );

    assert.equal(response.statusCode(), 202);
    assert.deepEqual(response.body(), { ok: true });
    assert.deepEqual(received, validPayload);
  });

  test("returns unavailable when no upgrade handler is registered", async () => {
    const response = await dispatch(validPayload, {
      handleSecurityUpgrade: undefined,
    });

    assert.equal(response.statusCode(), 501);
    assert.deepEqual(response.body(), {
      code: "SECURITY_UPGRADE_UNAVAILABLE",
      retryable: false,
    });
  });

  test("runs the upgrade handler for valid payloads", async () => {
    const response = await dispatch(validPayload);

    assert.equal(response.statusCode(), 202);
    assert.deepEqual(response.body(), { ok: true });
  });
});
