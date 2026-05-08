export type ElectronReleaseInfo = {
  downloadUrl: string;
  version: string;
  releaseNotes: string;
};

export type DesktopProvisioningCapability = {
  automatedManagedProvisioningEnabled: boolean;
  supportedPlatform: DesktopProvisioningPlatform | null;
  unsupportedReason?: "unsupported_platform";
};

export type DesktopProvisioningAttempt = {
  onboardingAttemptId: string;
  expiresAt: string;
};

export const DesktopProvisioningAttemptStatus = {
  Pending: "pending",
  Claimed: "claimed",
  Complete: "complete",
  Expired: "expired",
} as const;

export type DesktopProvisioningAttemptStatus =
  (typeof DesktopProvisioningAttemptStatus)[keyof typeof DesktopProvisioningAttemptStatus];

export type DesktopProvisioningAttemptStatusResponse = {
  onboardingAttemptId: string;
  status: DesktopProvisioningAttemptStatus;
  expiresAt: string;
  gatewayId?: string;
  computeTargetId?: string;
};

export const DesktopProvisioningReadinessStatus = {
  Complete: "complete",
  Incomplete: "incomplete",
} as const;

export type DesktopProvisioningReadinessStatus =
  (typeof DesktopProvisioningReadinessStatus)[keyof typeof DesktopProvisioningReadinessStatus];

export type DesktopProvisioningReadinessResponse =
  | {
      status: typeof DesktopProvisioningReadinessStatus.Complete;
      gatewayId: string;
      computeTargetId: string;
    }
  | {
      status: typeof DesktopProvisioningReadinessStatus.Incomplete;
    };

export const DesktopProvisioningPlatform = {
  Darwin: "darwin",
  Linux: "linux",
  Win32: "win32",
  Unknown: "unknown",
} as const;

export type DesktopProvisioningPlatform =
  (typeof DesktopProvisioningPlatform)[keyof typeof DesktopProvisioningPlatform];
