/**
 * Shared module mocks and fixtures for the `loop-desktop.ts` dispatch suites.
 *
 * The launch suite (`loop-desktop-dispatch.test.ts`) and the kill suite
 * (`loop-desktop-kill-dispatch.test.ts`) drive the same relay dispatch helper
 * through two different entry points, so they need the same doubles. They live
 * here rather than being copied into both files; each suite registers them with
 * its own `vi.mock(path, async () => (await import(this module)).xMock())`.
 */

import { vi } from "vitest";

export const DEFAULT_COMMAND_ID = "cmd-test-1";

export const RE_NOT_DELIVERED = /not delivered/i;
export const RE_TARGET_OFFLINE = /target offline/i;
export const RE_503 = /503/;

export const COMMAND_SIGNING_ELIGIBILITY_STATUS = {
  Eligible: "eligible",
  Ineligible: "ineligible",
  Unknown: "unknown",
} as const;

export const COMMAND_SIGNING_REQUIREMENT_STATUS = {
  Required: "required",
  NotRequired: "not_required",
  Unknown: "unknown",
} as const;

export const SIGNING_ELIGIBILITY_UNKNOWN_REASON =
  "command_signing_eligibility_unknown";

export const SIGNING_ELIGIBILITY_UNKNOWN_ERROR =
  "Command signing eligibility could not be verified for this compute target";

export function logMock(): Record<string, unknown> {
  return { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
}

export function databaseMock(): Record<string, unknown> {
  return {
    withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
    EvaluationReportType: { PLAN: "PLAN", CODE: "CODE" },
  };
}

/** Stands in for the store so dispatch can run without a real DB. */
export function desktopCommandStoreMock(): Record<string, unknown> {
  return {
    desktopCommandStore: {
      createCommand: vi.fn().mockResolvedValue({
        command: { commandId: DEFAULT_COMMAND_ID },
        deduped: false,
      }),
      markCommandExpired: vi.fn().mockResolvedValue(undefined),
    },
  };
}

export function computeTargetsServiceMock(): Record<string, unknown> {
  return {
    computeTargetsService: {
      findById: vi.fn().mockResolvedValue({
        organizationId: "org-1",
        userId: "owner-1",
        gatewayId: "gateway-1",
        capabilities: {},
      }),
    },
  };
}

export function commandSigningEligibilityMock(): Record<string, unknown> {
  return {
    COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_ERROR:
      SIGNING_ELIGIBILITY_UNKNOWN_ERROR,
    COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_REASON:
      SIGNING_ELIGIBILITY_UNKNOWN_REASON,
    CommandSigningEligibilityStatus: COMMAND_SIGNING_ELIGIBILITY_STATUS,
    CommandSigningRequirementStatus: COMMAND_SIGNING_REQUIREMENT_STATUS,
    isComputeTargetSigningEligible: vi.fn().mockResolvedValue({
      status: COMMAND_SIGNING_ELIGIBILITY_STATUS.Ineligible,
      reason: "no_active_managed_key",
    }),
  };
}

/** Used by the non-relay (direct socket.io) transport. */
export function relayEventBusMock(): Record<string, unknown> {
  return { relayEventBus: { publishOperation: vi.fn() } };
}

/**
 * The commandId -> relay operation -> wire command -> envelope chain.
 *
 * Each double DERIVES the commandId from its argument exactly as production
 * does (`toRelayOperation` parks it at `params.commandId`;
 * `toWireCommandFromRelayOperation` reads it back out; `toEnvelope` spreads the
 * wire command). A fixed id here would make every assertion on the dispatched
 * commandId vacuous -- the envelope would carry that id no matter which command
 * the production path actually minted.
 */
export function relayCommandHelpersMock(): Record<string, unknown> {
  return {
    toRelayOperation: vi.fn((commandId: string) => ({
      operationId: "test-op",
      operation: "engineer_http_request",
      params: {
        commandId,
        request: { method: "POST", path: "/test", headers: {}, body: {} },
      },
      streaming: false,
    })),
  };
}

export function desktopGatewayWireMock(): Record<string, unknown> {
  return {
    toWireCommandFromRelayOperation: vi.fn(
      (operation: { params?: { commandId?: string } }) => ({
        commandId: operation.params?.commandId,
        operationId: "test-op",
        method: "POST",
        path: "/test",
        body: {},
      })
    ),
    toEnvelope: vi.fn((payload: Record<string, unknown>) => ({
      ...payload,
      protocolVersion: 1,
      messageId: "message-test-1",
    })),
  };
}

/** A minimal mock Response object accepted by dispatchRelayOperation. */
export function mockResponse(
  status: number,
  body: unknown
): ReturnType<typeof global.fetch> {
  const text = JSON.stringify(body);
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body),
  } as Response);
}

/**
 * A 2xx whose body is not JSON, so `response.json()` rejects -- what an edge or
 * gateway returning an HTML error page under a 200 looks like to the caller.
 */
export function mockUnparseableResponse(
  status: number
): ReturnType<typeof global.fetch> {
  const text = "<html>gateway</html>";
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.reject(new SyntaxError("Unexpected token <")),
  } as unknown as Response);
}
