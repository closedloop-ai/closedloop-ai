import { ONBOARDING_LOCAL_STATE_CHANNEL } from "./onboarding-local-state-contract.js";
import { SESSION_ANALYSIS_AGREEMENT_IPC_CHANNEL } from "./session-analysis-agreement-channel.js";

/** IPC channel names the onboarding handler registers and the preload bridge invokes. */
export const OnboardingIpcChannel = {
  GetOnboardingState: "desktop:get-onboarding-state",
  MarkDashboardWelcomeSeen: "desktop:mark-dashboard-welcome-seen",
  CompleteOnboarding: "desktop:complete-onboarding",
  StartDeviceOnboarding: "desktop:start-device-onboarding",
  DismissOnboardingPopup: "desktop:dismiss-onboarding-popup",
  OnboardingPopupCta: "desktop:onboarding-popup-cta",
  SetSyncObservabilityTier: "desktop:set-sync-observability-tier",
  GetDataSyncLevel: "desktop:get-data-sync-level",
  SetDataSyncLevel: "desktop:set-data-sync-level",
  GetSyncConsentRecord: "desktop:get-sync-consent-record",
  RecordSyncConsent: "desktop:record-sync-consent",
  RecordSessionAnalysisAgreement: SESSION_ANALYSIS_AGREEMENT_IPC_CHANNEL,
  // ISS-8376: the desktop-local onboarding facts (transcript byte inventory +
  // analysis ETA). A member here so the onboarding channel inventory stays in
  // one registry; its handler lives in its own module because the snapshot
  // source it drives is electron-free and separately testable.
  GetOnboardingLocalState: ONBOARDING_LOCAL_STATE_CHANNEL,
} as const;

export type OnboardingIpcChannel =
  (typeof OnboardingIpcChannel)[keyof typeof OnboardingIpcChannel];
