/** IPC channel names the managed-key-hint handler registers and the preload bridge invokes. */
export const ManagedKeyHintIpcChannel = {
  GetManagedKeyHintState: "desktop:get-managed-key-hint-state",
  DismissManagedKeyHint: "desktop:dismiss-managed-key-hint",
} as const;

export type ManagedKeyHintIpcChannel =
  (typeof ManagedKeyHintIpcChannel)[keyof typeof ManagedKeyHintIpcChannel];
