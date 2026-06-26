import { isRecord } from "../../shared/type-guards.js";
import type {
  OperationDispatcher,
  OperationRequestContext,
} from "../operation-dispatcher.js";
import type {
  DesktopSecurityUpgradePayload,
  DesktopSecurityUpgradeResult,
} from "../router.js";
import { json } from "./response-utils.js";

type SecurityUpgradeRouteOptions = {
  getGatewayId: () => string;
  getComputeTargetId?: () => string | null;
  handleSecurityUpgrade?: (
    payload: DesktopSecurityUpgradePayload
  ) => Promise<DesktopSecurityUpgradeResult> | DesktopSecurityUpgradeResult;
};

function parsePayload(rawBody: string): DesktopSecurityUpgradePayload | null {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const {
    onboardingAttemptId,
    webAppOrigin,
    computeTargetId,
    gatewayId,
    expiresAt,
  } = value;
  if (
    typeof onboardingAttemptId !== "string" ||
    typeof webAppOrigin !== "string" ||
    typeof computeTargetId !== "string" ||
    typeof gatewayId !== "string" ||
    typeof expiresAt !== "string" ||
    !onboardingAttemptId.trim() ||
    !webAppOrigin.trim() ||
    !computeTargetId.trim() ||
    !gatewayId.trim() ||
    Number.isNaN(Date.parse(expiresAt))
  ) {
    return null;
  }
  return {
    onboardingAttemptId: onboardingAttemptId.trim(),
    webAppOrigin: webAppOrigin.trim(),
    computeTargetId: computeTargetId.trim(),
    gatewayId: gatewayId.trim(),
    expiresAt: expiresAt.trim(),
  };
}

function error(code: string, retryable: boolean, statusCode = 400) {
  return { code, retryable, statusCode };
}

function sendError(
  context: OperationRequestContext,
  failure: { code: string; retryable: boolean; statusCode: number }
): void {
  json(context, failure.statusCode, {
    code: failure.code,
    retryable: failure.retryable,
  });
}

/**
 * Registers the local command endpoint used by the cloud relay to upgrade an
 * existing target from a user-created API key to a bound Desktop-managed key.
 */
export function registerSecurityUpgradeRoutes(
  dispatcher: OperationDispatcher,
  options: SecurityUpgradeRouteOptions
): void {
  dispatcher.register(
    "POST",
    "/api/gateway/security/upgrade",
    async (context) => {
      const payload = parsePayload(context.body);
      if (!payload) {
        const failure = error("INVALID_SECURITY_UPGRADE_REQUEST", false, 400);
        sendError(context, failure);
        return;
      }
      if (Date.parse(payload.expiresAt) <= Date.now()) {
        const failure = error("SECURITY_UPGRADE_ATTEMPT_EXPIRED", false, 410);
        sendError(context, failure);
        return;
      }
      if (payload.gatewayId !== options.getGatewayId()) {
        const failure = error("SECURITY_UPGRADE_GATEWAY_MISMATCH", false, 409);
        sendError(context, failure);
        return;
      }
      const activeComputeTargetId = options.getComputeTargetId?.();
      if (
        activeComputeTargetId &&
        payload.computeTargetId !== activeComputeTargetId
      ) {
        const failure = error("SECURITY_UPGRADE_TARGET_MISMATCH", false, 409);
        sendError(context, failure);
        return;
      }
      if (!options.handleSecurityUpgrade) {
        const failure = error("SECURITY_UPGRADE_UNAVAILABLE", false, 501);
        sendError(context, failure);
        return;
      }

      const result = await options.handleSecurityUpgrade(payload);
      if (!result.ok) {
        const failure = {
          code: result.code,
          retryable: result.retryable,
          statusCode: result.statusCode ?? 500,
        };
        sendError(context, failure);
        return;
      }

      json(context, 202, { ok: true });
    }
  );
}
