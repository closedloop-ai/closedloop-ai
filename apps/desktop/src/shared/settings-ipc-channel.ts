/** IPC channel names the settings handler registers and the preload bridge invokes. */
export const SettingsIpcChannel = {
  GetSettings: "desktop:get-settings",
  UpdateSettings: "desktop:update-settings",
} as const;

export type SettingsIpcChannel =
  (typeof SettingsIpcChannel)[keyof typeof SettingsIpcChannel];
