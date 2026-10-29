/** IPC channel names the sandbox handler registers and the preload bridge invokes. */
export const SandboxIpcChannel = {
  PickSandboxDirectory: "desktop:pick-sandbox-directory",
  InspectSandboxPath: "desktop:inspect-sandbox-path",
} as const;

export type SandboxIpcChannel =
  (typeof SandboxIpcChannel)[keyof typeof SandboxIpcChannel];
