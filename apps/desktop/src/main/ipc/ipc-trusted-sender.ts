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

/**
 * Throw `untrusted sender` unless the IPC event originates from the trusted
 * renderer window, per the module's `isTrustedSender` predicate.
 */
export function assertTrustedIpcSender(
  isTrustedSender: (sender: unknown) => boolean,
  event: unknown
): void {
  if (!isTrustedIpcSender(isTrustedSender, event)) {
    throw new Error("untrusted sender");
  }
}
