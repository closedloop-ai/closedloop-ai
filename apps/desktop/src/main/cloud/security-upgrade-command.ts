import { dialog } from "electron";
import type {
  DesktopSecurityUpgradePayload,
  DesktopSecurityUpgradeResult,
} from "../../server/router.js";
import type { ApiKeyStore } from "../settings/api-key-store.js";
import { normalizeWebAppOrigin } from "../settings/origin-policy.js";
import { isSecurityUpgradeProvisioned } from "./security-upgrade-result.js";

/** What the security-upgrade handler needs from the application. */
export type SecurityUpgradeCommandDeps = {
  getActiveGatewayId: () => string;
  /** The live cloud compute target, or null when the link is not online. */
  getOnlineComputeTargetId: () => string | null;
  getSandboxBaseDirectory: () => string;
  apiKeyStore: ApiKeyStore;
  runSecurityUpgradeProvisioning: (input: {
    onboardingAttemptId: string;
    webAppOrigin: string;
    sandboxBaseDirectory: string;
    createdAt: string;
  }) => Promise<{ cancelled: boolean }>;
};

/**
 * Handle a cloud-dispatched Desktop security upgrade (swap a manually pasted
 * key for a protected managed key).
 *
 * Every precondition is checked BEFORE the user is prompted: the attempt must
 * name this gateway, this compute target, and must not have expired, and the
 * web-app origin must normalize. The native confirmation is the human gate; the
 * provisioning run and its verification follow.
 */
export async function handleSecurityUpgradeCommand(
  deps: SecurityUpgradeCommandDeps,
  payload: DesktopSecurityUpgradePayload
): Promise<DesktopSecurityUpgradeResult> {
  const precondition = checkSecurityUpgradePreconditions(deps, payload);
  if (precondition) {
    return precondition;
  }

  let webAppOrigin: string;
  try {
    webAppOrigin = normalizeWebAppOrigin(payload.webAppOrigin);
  } catch {
    return {
      ok: false,
      code: "SECURITY_UPGRADE_INVALID_ORIGIN",
      retryable: false,
      statusCode: 400,
    };
  }

  const confirmation = await dialog.showMessageBox({
    type: "question",
    buttons: ["Upgrade security", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: "Upgrade Desktop Security",
    message:
      "Closedloop wants to upgrade this Desktop connection to a protected managed key. Confirm the web app URL before continuing.",
    detail: webAppOrigin,
  });
  if (confirmation.response !== 0) {
    return {
      ok: false,
      code: "SECURITY_UPGRADE_CONFIRMATION_DISMISSED",
      retryable: false,
      statusCode: 409,
    };
  }

  const { cancelled } = await deps.runSecurityUpgradeProvisioning({
    onboardingAttemptId: payload.onboardingAttemptId,
    webAppOrigin,
    sandboxBaseDirectory: deps.getSandboxBaseDirectory(),
    createdAt: new Date().toISOString(),
  });
  if (cancelled) {
    return {
      ok: false,
      code: "SECURITY_UPGRADE_CANCELLED",
      retryable: true,
      statusCode: 409,
    };
  }

  const currentKey = deps.apiKeyStore.getApiKeyRecord();
  if (isSecurityUpgradeProvisioned(currentKey)) {
    return { ok: true };
  }

  return {
    ok: false,
    code: "SECURITY_UPGRADE_FAILED",
    retryable: false,
    statusCode: 503,
  };
}

/**
 * Identity and freshness checks, returning the rejection result for the first
 * failing precondition or null when the attempt may proceed to the user prompt.
 */
function checkSecurityUpgradePreconditions(
  deps: SecurityUpgradeCommandDeps,
  payload: DesktopSecurityUpgradePayload
): DesktopSecurityUpgradeResult | null {
  if (payload.gatewayId !== deps.getActiveGatewayId()) {
    return {
      ok: false,
      code: "SECURITY_UPGRADE_GATEWAY_MISMATCH",
      retryable: false,
      statusCode: 409,
    };
  }
  const onlineComputeTargetId = deps.getOnlineComputeTargetId();
  if (
    onlineComputeTargetId !== null &&
    onlineComputeTargetId !== payload.computeTargetId
  ) {
    return {
      ok: false,
      code: "SECURITY_UPGRADE_TARGET_MISMATCH",
      retryable: false,
      statusCode: 409,
    };
  }
  if (Date.parse(payload.expiresAt) <= Date.now()) {
    return {
      ok: false,
      code: "SECURITY_UPGRADE_ATTEMPT_EXPIRED",
      retryable: false,
      statusCode: 410,
    };
  }
  return null;
}
