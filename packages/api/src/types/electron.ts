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

export const DesktopProvisioningPlatform = {
  Darwin: "darwin",
  Linux: "linux",
  Win32: "win32",
  Unknown: "unknown",
} as const;

export type DesktopProvisioningPlatform =
  (typeof DesktopProvisioningPlatform)[keyof typeof DesktopProvisioningPlatform];
