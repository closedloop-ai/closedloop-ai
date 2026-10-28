import { DistributionsIpcChannel } from "./distributions-channel.js";

/** IPC channel names the coaching handler registers and the preload bridge invokes. */
export const CoachingIpcChannel = {
  Generate: "desktop:agent-coaching:generate",
  Install: "desktop:agent-coaching:install",
  GetPack: "desktop:agent-coaching:get-pack",
  InstallPack: "desktop:agent-coaching:install-pack",
  // Opt-in distribution channels are single-sourced in the shared
  // distributions-channel contract so the preload cannot drift from the handler.
  CoachingInstall: DistributionsIpcChannel.CoachingInstall,
  // FEA-4050: durably record a decline of an org-distributed opt-in pack so the
  // reconcile no longer re-surfaces it after an app restart.
  DistributionDecline: DistributionsIpcChannel.Decline,
  // ISS-5123: pre-install revalidation for a withdrawn-but-still-on-screen offer.
  DistributionEnsureAssigned: DistributionsIpcChannel.EnsureAssigned,
  // Refresh the retained opt-in snapshot after a generic install succeeds.
  DistributionHandled: DistributionsIpcChannel.Handled,
} as const;

export type CoachingIpcChannel =
  (typeof CoachingIpcChannel)[keyof typeof CoachingIpcChannel];
