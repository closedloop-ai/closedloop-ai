export const DesktopIdentityIpcChannel = {
  Get: "desktop:get-desktop-identity",
} as const;
export type DesktopIdentityIpcChannel =
  (typeof DesktopIdentityIpcChannel)[keyof typeof DesktopIdentityIpcChannel];
