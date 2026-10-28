/** IPC channel names the api-key handler registers and the preload bridge invokes. */
export const ApiKeyIpcChannel = {
  GetApiKeyStatus: "desktop:get-api-key-status",
  SetApiKey: "desktop:set-api-key",
  ClearApiKey: "desktop:clear-api-key",
  GetAdminKeyStatuses: "desktop:get-admin-key-statuses",
  SetAdminKey: "desktop:set-admin-key",
  ClearAdminKey: "desktop:clear-admin-key",
} as const;

export type ApiKeyIpcChannel =
  (typeof ApiKeyIpcChannel)[keyof typeof ApiKeyIpcChannel];
