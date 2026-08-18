import type { DesktopExistingUserResolution } from "../../shared/contracts.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

/**
 * IPC surface for existing-user resolution (PRD-532 §8 / M6).
 *
 * A user who already has an `sk_live_*` API key but no first-party desktop
 * session gets a one-time, non-blocking "Sign in with GitHub to sync" prompt.
 * The renderer reads the derived prompt state and records dismissal entirely
 * through these channels; the actual detection + persistence stay in the main
 * process ({@link DesktopSessionManager} + {@link ApiKeyStore}).
 *
 * NON-SECRET boundary: only the advisory {@link DesktopExistingUserResolution}
 * (a `kind` + `dismissed` flag) crosses here. No token, refresh token, PoP
 * material, or the API key itself ever does — those never leave the main
 * process.
 */

/** Push channel: main → renderer whenever the resolution state transitions. */
export const DESKTOP_EXISTING_USER_RESOLUTION_CHANGED_CHANNEL =
  "desktop:existing-user-resolution-changed";

export const DesktopExistingUserIpcChannel = {
  GetResolution: "desktop:get-existing-user-resolution",
  DismissPrompt: "desktop:dismiss-existing-user-prompt",
} as const;

export type DesktopExistingUserIpcChannel =
  (typeof DesktopExistingUserIpcChannel)[keyof typeof DesktopExistingUserIpcChannel];

export const DESKTOP_EXISTING_USER_IPC_CHANNELS = Object.values(
  DesktopExistingUserIpcChannel
);

/**
 * The subset of {@link DesktopSessionManager} the IPC layer drives. Narrowed to
 * a port so the handlers (and their tests) don't depend on the full manager.
 */
export type DesktopExistingUserManagerPort = {
  getExistingUserResolution: () => DesktopExistingUserResolution;
  dismissExistingUserPrompt: () => void;
};

export type DesktopExistingUserIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  manager: DesktopExistingUserManagerPort;
};

type IpcMainLike = {
  handle: (
    channel: DesktopExistingUserIpcChannel,
    listener: (event: unknown) => unknown
  ) => void;
};

/**
 * Registers the existing-user IPC handlers. Every handler rejects untrusted
 * senders before touching the manager, matching the rest of the desktop IPC
 * surface. Read-only + dismissal only — there is no privileged action here.
 */
export function registerDesktopExistingUserIpcHandlers(
  ipcMain: IpcMainLike,
  deps: DesktopExistingUserIpcDeps
): void {
  ipcMain.handle(
    DesktopExistingUserIpcChannel.GetResolution,
    (event): DesktopExistingUserResolution => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      return deps.manager.getExistingUserResolution();
    }
  );

  ipcMain.handle(DesktopExistingUserIpcChannel.DismissPrompt, (event): void => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    deps.manager.dismissExistingUserPrompt();
  });
}
