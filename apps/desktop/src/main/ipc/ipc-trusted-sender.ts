import {
  RENDERER_WINDOW_GONE_MESSAGE,
  UNTRUSTED_IPC_SENDER_MESSAGE,
} from "../../shared/ipc-refusal-messages.js";

/**
 * Shared trusted-sender guard for the desktop `*-ipc.ts` handler modules.
 *
 * Each module passes its own `isTrustedSender` predicate (wired in app.ts to
 * `desktopWindow.isTrustedSender`). The IPC event's `sender` is extracted
 * structurally so these helpers stay decoupled from Electron's `WebContents`
 * type and the modules keep taking `event: unknown` at the boundary.
 */
export function isTrustedIpcSender(
  isTrustedSender: (sender: unknown) => boolean,
  event: unknown
): boolean {
  const sender =
    event && typeof event === "object"
      ? (event as { sender?: unknown }).sender
      : undefined;
  return isTrustedSender(sender);
}

// ISS-8376: both refusal reasons moved to `shared/ipc-refusal-messages.ts`
// because a renderer adapter now classifies on them to tell a permanent
// authorization refusal from a teardown race, and `src/shared/` is where this
// repo keeps values that cross that boundary. They are NOT re-exported here:
// Biome's `noBarrelFile` forbids re-exporting runtime bindings (see
// `transcript-sync-types.ts:25`), so every value consumer imports them from the
// shared module directly.

/**
 * Reject the IPC event unless it originates from the trusted renderer window,
 * per the module's `isTrustedSender` predicate.
 *
 * ISS-8776 — `isRendererWindowGone` does not participate in the decision. It is
 * consulted ONLY after the predicate has already refused, to choose which fact
 * the thrown message states. A window this app destroyed on its way out is a
 * lifecycle event; reporting it as `untrusted sender` describes an attack that
 * is not happening and hides the one that would be. Four such lines on
 * `desktop:get-runtime-status` — a channel the renderer polls once a second —
 * were the most alarming entry in the ISS-8776 crash log and named a
 * renderer-identity defect that does not exist.
 *
 * The guard is not widened by this: every path that threw before still throws.
 */
export function assertTrustedIpcSender(
  isTrustedSender: (sender: unknown) => boolean,
  event: unknown,
  isRendererWindowGone?: () => boolean
): void {
  if (isTrustedIpcSender(isTrustedSender, event)) {
    return;
  }
  throw new Error(
    isRendererWindowGone?.() === true
      ? RENDERER_WINDOW_GONE_MESSAGE
      : UNTRUSTED_IPC_SENDER_MESSAGE
  );
}
