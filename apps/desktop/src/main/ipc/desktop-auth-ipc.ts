import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { z } from "zod";
import type {
  DesktopAuthState,
  DesktopBrowserSignInResult,
} from "../session/desktop-session-manager.js";

/**
 * IPC surface for first-party desktop auth (FEA-1514 / FEA-2219). The renderer
 * `AuthAdapter` drives sign-in/out and reads identity entirely through these
 * channels; the {@link DesktopSessionManager} (and its refresh/PoP secrets) stay
 * in the main process.
 *
 * No credential crosses to the renderer at all (PLN-1138 D-G): the renderer
 * auth port surfaces only a sentinel token, and authenticated cloud requests
 * flow through the main-process cloud-API fetch bridge
 * (`cloud-api-fetch-ipc.ts`), which attaches the real access token itself.
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
  beginBrowserSignIn: (
    provider?: DesktopSignInProvider
  ) => Promise<DesktopBrowserSignInResult>;
  cancelSignIn: () => void;
  signOut: () => Promise<void>;
};

export type DesktopAuthIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  /**
   * Version-skew compatibility shim (FEA-4133 / FEA-2687). First-party desktop
   * auth graduated to always-on, so this repo's own wiring no longer passes a
   * gate. The field is kept as an **optional** backward-compatibility alias so a
   * version-skewed caller still on the pre-graduation wiring — an older bundled
   * `app.ts` that hands us `isFirstPartyAuthEnabled` — degrades safely instead
   * of silently ignoring a gate it believes is still enforced:
   *
   * - absent (the new, graduated wiring) → always-on; sign-in delegates.
   * - present and returns `true` → always-on; sign-in delegates.
   * - present and returns `false` → the old off-behavior is honored: report the
   *   capability as `unavailable` rather than starting the flow, exactly as the
   *   retired gate did.
   *
   * Per the repo cross-repo/compat rules this alias must not be removed without
   * explicit human approval, even though nothing in-repo sets it anymore.
   */
  isFirstPartyAuthEnabled?: () => boolean;
  manager: DesktopAuthManagerPort;
};

type IpcMainLike = {
  handle: (
    channel: DesktopAuthIpcChannel,
    // ISS-5112: `...args` rather than `(event)` — `BeginSignIn` now carries an
    // optional provider hint, and a one-parameter listener type rejects any
    // handler that reads it. Stays `unknown[]`: every handler parses what it
    // needs at this boundary rather than trusting a shape across processes.
    listener: (event: unknown, ...args: unknown[]) => unknown
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
    (event, provider: unknown): Promise<DesktopBrowserSignInResult> => {
      assertTrustedSender(deps, event);
      // Compat: honor the retired gate only when a version-skewed caller still
      // supplies it and it is off. Absent (graduated wiring) → always-on.
      if (deps.isFirstPartyAuthEnabled?.() === false) {
        return Promise.resolve<DesktopBrowserSignInResult>({
          ok: false,
          reason: "unavailable",
        });
      }
      // The renderer is trusted (assertTrustedSender above) but the payload is
      // still parsed rather than cast: this is a process boundary, and a
      // version-skewed renderer may send nothing, or a provider this build does
      // not know. Both degrade to "no hint" — the web page then shows its normal
      // chooser, which is exactly the pre-ISS-5112 behavior.
      const parsed = desktopAuthProviderArgSchema.safeParse(provider);
      return deps.manager.beginBrowserSignIn(
        parsed.success ? parsed.data : undefined
      );
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
}

/**
 * ISS-5112 — the optional social-provider hint carried on `BeginSignIn`.
 *
 * `.optional()` is the load-bearing part: an older renderer invokes this channel
 * with no argument at all, and that MUST stay valid rather than becoming a
 * rejected payload. An unrecognized string fails the parse and the caller
 * substitutes `undefined`, so a newer renderer naming a provider this build has
 * never heard of degrades to the chooser instead of failing the sign-in.
 */
const desktopAuthProviderArgSchema = z.enum(DesktopSignInProvider).optional();
