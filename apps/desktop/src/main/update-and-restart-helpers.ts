import type { GatewayApprovalResult } from "../server/router.js";
import type { PackagedUpdateState } from "./packaged-update-state.js";

export function buildUpdateAndRestartDisabledResult(): GatewayApprovalResult {
  return {
    allow: false,
    statusCode: 501,
    payload: {
      error: "feature_disabled",
      feature: "update_and_restart",
    },
  };
}

export function shouldHonorAlwaysAllowRule(
  operationId: string,
  forceInteractiveOperations: ReadonlySet<string>
): boolean {
  return !forceInteractiveOperations.has(operationId);
}

export function canApplyPackagedUpdate(
  currentVersion: string,
  state: PackagedUpdateState
): boolean {
  return Boolean(
    state.downloaded && state.version && state.version !== currentVersion
  );
}

export function resolvePackagedUpdateCheckResult(
  currentVersion: string,
  state: PackagedUpdateState,
  remoteVersion?: string
): { updateAvailable: boolean; version?: string } {
  if (canApplyPackagedUpdate(currentVersion, state)) {
    return {
      updateAvailable: true,
      version: state.version,
    };
  }

  return remoteVersion
    ? { updateAvailable: false, version: remoteVersion }
    : { updateAvailable: false };
}
