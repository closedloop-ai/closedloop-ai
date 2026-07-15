export const GitHubIntegrationStatusIpcChannel = {
  Get: "desktop:get-github-integration-status",
} as const;
export type GitHubIntegrationStatusIpcChannel =
  (typeof GitHubIntegrationStatusIpcChannel)[keyof typeof GitHubIntegrationStatusIpcChannel];
