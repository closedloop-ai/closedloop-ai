/** IPC channel names the update handler registers and the preload bridge invokes. */
export const UpdateIpcChannel = {
  CheckForUpdate: "desktop:check-for-update",
  ApplyUpdate: "desktop:apply-update",
} as const;

export type UpdateIpcChannel =
  (typeof UpdateIpcChannel)[keyof typeof UpdateIpcChannel];
