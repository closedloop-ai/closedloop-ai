"use client";

import { DesktopSecurityStatus } from "@repo/api/src/types/compute-target";
import {
  DesktopProvisioningAttemptStatus,
  DesktopProvisioningReadinessStatus,
} from "@repo/api/src/types/electron";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import {
  useDesktopProvisioningAttemptStatus,
  useDesktopProvisioningReadiness,
} from "@/hooks/queries/use-desktop-provisioning";
import { useElectronDetection } from "@/lib/engineer/electron-detection";

export const DesktopSetupStatus = {
  Complete: "complete",
  Incomplete: "incomplete",
  Unknown: "unknown",
} as const;
export type DesktopSetupStatus =
  (typeof DesktopSetupStatus)[keyof typeof DesktopSetupStatus];

type UseDesktopSetupReadinessInput = {
  readonly generatedKeyPresent: boolean;
  readonly provisioningAttemptId: string | null;
  readonly provisioningCommandPresent: boolean;
};

/**
 * Combines local Desktop health, attempt polling, and account-level readiness
 * into one setup state for the onboarding UI.
 */
export function useDesktopSetupReadiness({
  generatedKeyPresent,
  provisioningAttemptId,
  provisioningCommandPresent,
}: UseDesktopSetupReadinessInput) {
  const electron = useElectronDetection();
  const computeTargets = useComputeTargets({
    enabled: electron.gatewayId !== null,
  });
  const provisioningStatus = useDesktopProvisioningAttemptStatus(
    provisioningAttemptId
  );
  const provisioningReadiness = useDesktopProvisioningReadiness();

  const matchingComputeTarget = computeTargets.data?.find(
    (target) => target.gatewayId === electron.gatewayId
  );
  const localManagedComputeTargetDetected =
    matchingComputeTarget?.security?.status === DesktopSecurityStatus.Protected;
  const provisioningAttemptComplete =
    provisioningStatus.data?.status ===
    DesktopProvisioningAttemptStatus.Complete;
  const existingManagedTargetReady =
    provisioningReadiness.data?.status ===
    DesktopProvisioningReadinessStatus.Complete;
  const managedComputeTargetDetected =
    localManagedComputeTargetDetected ||
    provisioningAttemptComplete ||
    existingManagedTargetReady;
  const desktopSetupStatus = getDesktopSetupStatus({
    localOnboardingCompleted: electron.onboardingCompleted,
    managedComputeTargetDetected,
    securityLookupPending:
      (electron.gatewayId !== null &&
        (computeTargets.isLoading || computeTargets.isPending)) ||
      provisioningReadiness.isLoading ||
      provisioningReadiness.isPending,
    securityLookupFailed:
      computeTargets.isError || provisioningReadiness.isError,
  });
  const serverConfirmedReady =
    provisioningAttemptComplete || existingManagedTargetReady;
  const legacySetupStatusUnknown = electron.onboardingCompleted === null;
  const detectedDesktopCanContinue =
    electron.detected &&
    (desktopSetupStatus === DesktopSetupStatus.Complete ||
      (desktopSetupStatus === DesktopSetupStatus.Unknown &&
        legacySetupStatusUnknown));

  return {
    canContinue:
      generatedKeyPresent || serverConfirmedReady || detectedDesktopCanContinue,
    desktopSetupStatus,
    electron,
    shouldAutoContinue:
      serverConfirmedReady ||
      (provisioningCommandPresent &&
        electron.detected &&
        desktopSetupStatus === DesktopSetupStatus.Complete),
  };
}

function getDesktopSetupStatus({
  localOnboardingCompleted,
  managedComputeTargetDetected,
  securityLookupFailed,
  securityLookupPending,
}: {
  readonly localOnboardingCompleted: boolean | null;
  readonly managedComputeTargetDetected: boolean;
  readonly securityLookupFailed: boolean;
  readonly securityLookupPending: boolean;
}): DesktopSetupStatus {
  if (localOnboardingCompleted === true || managedComputeTargetDetected) {
    return DesktopSetupStatus.Complete;
  }
  if (
    localOnboardingCompleted === null ||
    securityLookupPending ||
    securityLookupFailed
  ) {
    return DesktopSetupStatus.Unknown;
  }
  return DesktopSetupStatus.Incomplete;
}
