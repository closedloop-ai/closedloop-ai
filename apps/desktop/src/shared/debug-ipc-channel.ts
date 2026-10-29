/** IPC channel names the debug handler registers and the preload bridge invokes. */
export const DebugIpcChannel = {
  GetDangerousAutoApprove: "desktop:get-dangerous-auto-approve",
  SetDangerousAutoApprove: "desktop:set-dangerous-auto-approve",
  IsDebugAuthEnabled: "desktop:is-debug-auth-enabled",
  MintDebugToken: "desktop:mint-debug-token",
} as const;

export type DebugIpcChannel =
  (typeof DebugIpcChannel)[keyof typeof DebugIpcChannel];
