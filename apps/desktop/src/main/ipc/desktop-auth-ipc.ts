import {
  DESKTOP_EMAIL_HINT_MAX_LENGTH,
  DesktopSignInFraming,
  DesktopSignInMethod,
} from "@repo/api/src/types/desktop-authorize-url";
import { desktopBootstrapOrganizationRequestSchema } from "@repo/api/src/types/desktop-bootstrap";
import { z } from "zod";
import type {
  DesktopAuthState,
  DesktopBootstrapOrganizationInput,
  DesktopBootstrapOrganizationResult,
  DesktopBrowserSignInResult,
} from "../../shared/contracts.js";
import { DesktopAuthIpcChannel } from "../../shared/desktop-auth-ipc-channel.js";
import { DesktopRendererEventChannel } from "../../shared/desktop-renderer-event-channel.js";
import type { DesktopSignInConfirmation } from "../session/desktop-sign-in-confirmation.js";

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
export const DESKTOP_AUTH_STATE_CHANGED_CHANNEL =
  DesktopRendererEventChannel.AuthStateChanged;

export const DESKTOP_AUTH_IPC_CHANNELS = Object.values(DesktopAuthIpcChannel);

/**
 * The subset of {@link DesktopSessionManager} the IPC layer drives. Narrowed to
 * a port so the handlers (and their tests) don't depend on the full manager.
 */
export type DesktopAuthManagerPort = {
  getState: () => DesktopAuthState;
  beginBrowserSignIn: (
    method?: DesktopSignInMethod,
    emailHint?: string,
    framing?: DesktopSignInFraming,
    confirmation?: DesktopSignInConfirmation
  ) => Promise<DesktopBrowserSignInResult>;
  cancelSignIn: () => void;
  confirmPendingSignIn: () => void;
  createBootstrapOrganization?: (
    input: DesktopBootstrapOrganizationInput
  ) => Promise<DesktopBootstrapOrganizationResult>;
  signOut: () => Promise<void>;
};

export type DesktopAuthIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  manager: DesktopAuthManagerPort;
  /** Refuses a new auth run while durable sign-out cleanup still owns state. */
  isSignInAllowed?: () => boolean;
  /** Application-owned cleanup layered after synchronous auth invalidation. */
  signOut?: () => Promise<void>;
  /**
   * ISS-10412: show and focus the window that started the sign-in, once the
   * browser leg has authorized.
   *
   * A port rather than a direct window reference so these handlers stay
   * loadable without Electron. Optional because a caller that owns no window
   * (the wiring tests) has nothing to bring forward.
   */
  bringWindowToFront?: () => void;
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
    (
      event,
      method: unknown,
      emailHint: unknown,
      framing: unknown,
      options: unknown
    ): Promise<DesktopBrowserSignInResult> => {
      assertTrustedSender(deps, event);
      if (deps.isSignInAllowed?.() === false) {
        return Promise.resolve({ ok: false, reason: "cancelled" });
      }
      // The renderer is trusted (assertTrustedSender above) but the payload is
      // still parsed rather than cast: this is a process boundary, and a
      // version-skewed renderer may send nothing, or a method this build does
      // not know. Both degrade to "no hint" — the web page then runs its GitHub
      // default, which is exactly the pre-ISS-5112 behavior. The M5 email hint
      // degrades the same way: an unparseable value is dropped, never an error.
      const parsed = desktopAuthMethodArgSchema.safeParse(method);
      const parsedHint = desktopAuthEmailHintArgSchema.safeParse(emailHint);
      const parsedFraming = desktopAuthFramingArgSchema.safeParse(framing);
      const parsedOptions = desktopSignInOptionsArgSchema.safeParse(options);
      // ISS-11345: while the account awaits confirmation the user is still in
      // the browser, so the window has to come forward THEN, not on `ok`.
      const confirmation: DesktopSignInConfirmation | undefined =
        parsedOptions.success && parsedOptions.data?.confirmAccount
          ? { onAwaitingConfirmation: deps.bringWindowToFront }
          : undefined;
      return deps.manager
        .beginBrowserSignIn(
          parsed.success ? parsed.data : undefined,
          parsedHint.success ? parsedHint.data : undefined,
          parsedFraming.success ? parsedFraming.data : undefined,
          confirmation
        )
        .then((result) => {
          // ISS-10412: this is the one place that knows the authorization
          // landed AND runs in the process that owns the window, so it is where
          // the handback the browser page promises actually happens. Chained
          // rather than awaited in an `async` handler so `assertTrustedSender`
          // above keeps throwing SYNCHRONOUSLY — an untrusted sender must be
          // refused, not handed a rejected promise.
          if (result.ok) {
            deps.bringWindowToFront?.();
          }
          return result;
        });
    }
  );

  ipcMain.handle(DesktopAuthIpcChannel.CancelSignIn, (event): void => {
    assertTrustedSender(deps, event);
    deps.manager.cancelSignIn();
  });

  ipcMain.handle(DesktopAuthIpcChannel.SignOut, (event): Promise<void> => {
    assertTrustedSender(deps, event);
    return deps.signOut?.() ?? deps.manager.signOut();
  });

  ipcMain.handle(DesktopAuthIpcChannel.ConfirmSignIn, (event): void => {
    assertTrustedSender(deps, event);
    deps.manager.confirmPendingSignIn();
  });

  ipcMain.handle(
    DesktopAuthIpcChannel.CreateBootstrapOrganization,
    (event, input: unknown): Promise<DesktopBootstrapOrganizationResult> => {
      assertTrustedSender(deps, event);
      const parsed = desktopBootstrapOrganizationSchema.safeParse(input);
      if (!parsed.success) {
        return Promise.resolve({ ok: false, error: "invalid_request" });
      }
      return (
        deps.manager.createBootstrapOrganization?.(parsed.data) ??
        Promise.resolve({ ok: false, error: "bootstrap_unavailable" })
      );
    }
  );
}

const desktopBootstrapOrganizationSchema =
  desktopBootstrapOrganizationRequestSchema;

/**
 * ISS-5112 / ISS-5954 — the optional sign-in-method hint carried on
 * `BeginSignIn`.
 *
 * `.optional()` is the load-bearing part: an older renderer invokes this channel
 * with no argument at all, and that MUST stay valid rather than becoming a
 * rejected payload. An unrecognized string fails the parse and the caller
 * substitutes `undefined`, so a newer renderer naming a method this build has
 * never heard of degrades to the GitHub default instead of failing the sign-in.
 */
const desktopAuthMethodArgSchema = z.enum(DesktopSignInMethod).optional();

/**
 * ISS-5954 M5 — the optional typed-address hint. Bounded by the shared
 * {@link DESKTOP_EMAIL_HINT_MAX_LENGTH} ceiling — one number, not a second
 * hand-picked one. The plausibility narrowing and base64url encoding live in
 * the shared contract's `encodeDesktopEmailHint`, which the URL builder
 * applies; a failed parse here degrades to "no hint", never a failed sign-in.
 */
const desktopAuthEmailHintArgSchema = z
  .string()
  .max(DESKTOP_EMAIL_HINT_MAX_LENGTH)
  .optional();

/**
 * ISS-5954 — the optional door framing, consumed by the web email landing
 * branch. Same degrade posture as the method arg: absent or unrecognized
 * becomes `undefined`, which the web page resolves to the sign-up embed.
 */
const desktopAuthFramingArgSchema = z.enum(DesktopSignInFraming).optional();

/**
 * ISS-11345 — the optional per-call sign-in options. Absent or malformed means
 * no confirmation step: the same sign-in every existing caller gets.
 */
const desktopSignInOptionsArgSchema = z
  .object({ confirmAccount: z.boolean().optional() })
  .optional();
