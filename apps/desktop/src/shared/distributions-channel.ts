/**
 * @file distributions-channel.ts — shared IPC channel constants for the opt-in
 * distribution (coaching-pack) main↔renderer bridge.
 *
 * Single-sourced (this lightweight module has no heavy imports) so the
 * main-process handler (`main/ipc/coaching-ipc.ts`) and the preload
 * `ipcRenderer.invoke` can never drift — a channel rename here fails both sides
 * at once instead of silently leaving the preload invoking a channel with no
 * handler. FEA-2923 / FEA-4050.
 */

export const DistributionsIpcChannel = {
  /** Renderer-accepted opt-in coaching distribution install (FEA-2923 / §I). */
  CoachingInstall: "desktop:coaching:install",
  /**
   * FEA-4050: durable decline of an opt-in distribution so the reconcile no
   * longer re-surfaces it after an app restart.
   */
  Decline: "desktop:distributions:decline",
  /**
   * ISS-5123: re-assert, against the cloud, that a distribution the renderer is
   * about to accept is still assigned. Withdrawal removes the offer from the
   * assignment poll, but a banner row pushed before the withdrawal stays on
   * screen until the next reconcile — this is the check that stops it being
   * installable in that window.
   */
  EnsureAssigned: "desktop:distributions:ensure-assigned",
} as const;

export type DistributionsIpcChannel =
  (typeof DistributionsIpcChannel)[keyof typeof DistributionsIpcChannel];
