/** IPC channel names the github-connect-opener handler registers and the preload bridge invokes. */
export const GitHubConnectIpcChannel = {
  Open: "desktop:open-github-connect",
} as const;

export type GitHubConnectIpcChannel =
  (typeof GitHubConnectIpcChannel)[keyof typeof GitHubConnectIpcChannel];
