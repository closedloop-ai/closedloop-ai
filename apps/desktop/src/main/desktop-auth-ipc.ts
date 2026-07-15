import type {
  DesktopAuthState,
  DesktopBrowserSignInResult,
} from "./desktop-session-manager.js";

/**
 * IPC surface for first-party desktop auth (FEA-1514 / FEA-2219). The renderer
 * `AuthAdapter` drives sign-in/out and reads identity entirely through these
 * channels; the {@link DesktopSessionManager} (and its refresh/PoP secrets) stay
 * in the main process.
 *
 * Only the short-lived ACCESS token ever crosses to the renderer (via
 * {@link DesktopAuthIpcChannel.GetAccessToken}, for `Authorization: Bearer`
 * attachment) — the refresh token and device-session secret never leave main.
 * State changes are pushed to the renderer on
 * {@link DESKTOP_AUTH_STATE_CHANGED_CHANNEL}; the handlers here are the pull
 * side the adapter uses for its initial read and explicit actions.
 */

/** Push channel: main → renderer whenever the auth state machine transitions. */
export const DESKTOP_AUTH_STATE_CHANGED_CHANNEL = "desktop:auth-state-changed";

export const DesktopAuthIpcChannel = {
  GetState: "desktop:get-desktop-auth-state",
  BeginSignIn: "desktop:begin-desktop-sign-in",
  CancelSignIn: "desktop:cancel-desktop-sign-in",
  SignOut: "desktop:sign-out-desktop",
  GetAccessToken: "desktop:get-desktop-access-token",
} as const;

export type DesktopAuthIpcChannel =
  (typeof DesktopAuthIpcChannel)[keyof typeof DesktopAuthIpcChannel];

export const DESKTOP_AUTH_IPC_CHANNELS = Object.values(DesktopAuthIpcChannel);

/**
 * The subset of {@link DesktopSessionManager} the IPC layer drives. Narrowed to
 * a port so the handlers (and their tests) don't depend on the full manager.
 */
export type DesktopAuthManagerPort = {
  getState: () => DesktopAuthState;
  beginBrowserSignIn: () => Promise<DesktopBrowserSignInResult>;
  cancelSignIn: () => void;
  signOut: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
};

export type DesktopAuthIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  /**
   * Runtime gate for the `desktopFirstPartyAuthEnabled` dark-launch flag. When
   * it returns false the sign-in capability is disabled at the IPC boundary —
   * not just hidden in the renderer — so toggling the flag off actually stops
   * the flow from being initiated (FEA-2687). Read live on each call because
   * the flag is runtime-toggleable (no restart required).
   */
  isFirstPartyAuthEnabled: () => boolean;
  manager: DesktopAuthManagerPort;
};

type IpcMainLike = {
  handle: (
    channel: DesktopAuthIpcChannel,
    listener: (event: unknown) => unknown
  ) => void;
};

function assertTrustedSender(deps: DesktopAuthIpcDeps, event: unknown): void {
  const sender =
    event && typeof event === "object"
      ? (event as { sender?: unknown }).sender
      : undefined;
  if (!deps.isTrustedSender(sender)) {
    throw new Error("untrusted sender");
  }
}

/**
 * Registers the desktop-auth IPC handlers. Every handler rejects untrusted
 * senders before touching the manager, matching the rest of the desktop IPC
 * surface.
 */
export function registerDesktopAuthIpcHandlers(
  ipcMain: IpcMainLike,
  deps: DesktopAuthIpcDeps
): void {
  ipcMain.handle(DesktopAuthIpcChannel.GetState, (event): DesktopAuthState => {
    assertTrustedSender(deps, event);
    return deps.manager.getState();
  });

  ipcMain.handle(
    DesktopAuthIpcChannel.BeginSignIn,
    (event): Promise<DesktopBrowserSignInResult> => {
      assertTrustedSender(deps, event);
      if (!deps.isFirstPartyAuthEnabled()) {
        // Flag off: report the capability as unavailable rather than starting
        // the flow. Resolving (not throwing) keeps the documented result
        // contract — every caller already handles `{ ok: false }` — so the
        // renderer degrades gracefully instead of hitting an unhandled reject.
        return Promise.resolve<DesktopBrowserSignInResult>({
          ok: false,
          reason: "unavailable",
        });
      }
      return deps.manager.beginBrowserSignIn();
    }
  );

  ipcMain.handle(DesktopAuthIpcChannel.CancelSignIn, (event): void => {
    assertTrustedSender(deps, event);
    deps.manager.cancelSignIn();
  });

  ipcMain.handle(DesktopAuthIpcChannel.SignOut, (event): Promise<void> => {
    assertTrustedSender(deps, event);
    return deps.manager.signOut();
  });

  ipcMain.handle(
    DesktopAuthIpcChannel.GetAccessToken,
    (event): Promise<string | null> => {
      assertTrustedSender(deps, event);
      return deps.manager.getAccessToken();
    }
  );
}
