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

export type DesktopProvisioningPlatform =
  | "darwin"
  | "linux"
  | "win32"
  | "unknown";
