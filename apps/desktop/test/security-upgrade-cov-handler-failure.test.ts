/**
 * ISS-11282 — branch coverage for security-upgrade.ts: a JSON body that
 * parses but is not an object, and a handler that answers `ok: false`, with
 * and without its own status code.
 */
import { describe, expect, test } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerSecurityUpgradeRoutes } from "../src/server/operations/security-upgrade.js";
import type { DesktopSecurityUpgradeResult } from "../src/server/router.js";
import { dispatchOperation } from "./helpers/git-gateway-op-harness.js";

const UPGRADE_PATH = "/api/gateway/security/upgrade";

const validPayload = {
  onboardingAttemptId: "attempt-1",
  webAppOrigin: "https://app.closedloop.ai",
  computeTargetId: "target-1",
  gatewayId: "gateway-1",
  expiresAt: "2999-01-01T00:00:00.000Z",
};

function dispatchUpgrade(
  body: string,
  handleSecurityUpgrade: () => DesktopSecurityUpgradeResult = () => ({
    ok: true,
  })
) {
  const dispatcher = new OperationDispatcher();
  let handlerCalls = 0;
  registerSecurityUpgradeRoutes(dispatcher, {
    getGatewayId: () => "gateway-1",
    getComputeTargetId: () => "target-1",
    handleSecurityUpgrade: () => {
      handlerCalls += 1;
      return handleSecurityUpgrade();
    },
  });
  return dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: UPGRADE_PATH,
    body,
  }).then((captured) => ({ ...captured, handlerCalls }));
}

describe("security upgrade route — payload that is valid JSON but not an object", () => {
  test.each([["null"], ["42"], ['"a string"']])(
    "body %s is rejected as an invalid request without reaching the handler",
    async (body) => {
      const response = await dispatchUpgrade(body);

      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({
        code: "INVALID_SECURITY_UPGRADE_REQUEST",
        retryable: false,
      });
      expect(response.handlerCalls).toBe(0);
    }
  );
});

describe("security upgrade route — handler failure", () => {
  test("a failed upgrade is relayed with the handler's code, retryable flag and status", async () => {
    const response = await dispatchUpgrade(
      JSON.stringify(validPayload),
      () => ({
        ok: false,
        code: "SECURITY_UPGRADE_KEY_REJECTED",
        retryable: true,
        statusCode: 503,
      })
    );

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({
      code: "SECURITY_UPGRADE_KEY_REJECTED",
      retryable: true,
    });
  });

  test("a failed upgrade without a status code is reported as 500", async () => {
    const response = await dispatchUpgrade(
      JSON.stringify(validPayload),
      () => ({
        ok: false,
        code: "SECURITY_UPGRADE_INTERNAL",
        retryable: false,
      })
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      code: "SECURITY_UPGRADE_INTERNAL",
      retryable: false,
    });
  });
});
