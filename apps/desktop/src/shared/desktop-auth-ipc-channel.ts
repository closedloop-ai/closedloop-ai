/** IPC channel names the desktop-auth handler registers and the preload bridge invokes. */
export const DesktopAuthIpcChannel = {
  GetState: "desktop:get-desktop-auth-state",
  BeginSignIn: "desktop:begin-desktop-sign-in",
  CancelSignIn: "desktop:cancel-desktop-sign-in",
  SignOut: "desktop:sign-out-desktop",
  ConfirmSignIn: "desktop:confirm-desktop-sign-in",
  CreateBootstrapOrganization: "desktop:create-bootstrap-organization",
} as const;

export type DesktopAuthIpcChannel =
  (typeof DesktopAuthIpcChannel)[keyof typeof DesktopAuthIpcChannel];
