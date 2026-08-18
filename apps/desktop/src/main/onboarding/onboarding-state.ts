import type { DesktopSettings } from "../../shared/contracts.js";

/**
 * Onboarding state shapes shared between the main-process `DesktopApplication`
 * (which owns the live managed-provisioning state machine) and the onboarding
 * IPC surface (`onboarding-ipc.ts`) that reports it to the renderer. Kept in a
 * dependency-free module so both can import them without a cycle.
 */
export type ManagedOnboardingStatus =
  | "idle"
  | "awaiting-origin-confirmation"
  | "provisioning"
  | "sandbox-required"
  | "failed";

export type ManagedOnboardingState = {
  status: ManagedOnboardingStatus;
  webAppOrigin?: string;
  message?: string;
  recoveryActions?: Array<
    "retry_automated_onboarding" | "use_manual_setup" | "choose_sandbox"
  >;
};

/** The `desktop:get-onboarding-state` / `desktop:complete-onboarding` payload. */
export type DesktopOnboardingState = {
  completed: boolean;
  settings: DesktopSettings;
  hasStoredApiKey: boolean;
  managedProvisioning: ManagedOnboardingState;
};
