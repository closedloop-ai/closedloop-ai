/**
 * Shared fixture for the ISS-7599 regression tests.
 *
 * Electron wraps every rejection that crosses `ipcRenderer.invoke` in a
 * synthetic error whose message names the internal IPC channel. A renderer
 * catch that puts that message on screen leaks a private channel name to the
 * user, which is exactly what `cleanIpcError` exists to prevent. Each call site
 * that renders an IPC rejection gets a test built on this fixture, so they all
 * feed the same wrapper shape and name the same leak.
 *
 * The assertion stays in each test body — a helper that asserts would let a
 * test that never reaches it still pass.
 */

/** The channel name a leaking render would put in front of the user. */
export const LEAKY_IPC_CHANNEL = "desktop:iss-7599-private-channel";

/** Electron's own wrapper phrasing, leaked verbatim by an untreated catch. */
export const IPC_WRAPPER_PHRASE = "invoking remote method";

/**
 * Build the error Electron actually delivers to the renderer: the wrapper, the
 * channel name, and the remote error's re-serialized `Error:` prefix around
 * `underlying`.
 */
export function ipcWrappedError(underlying: string): Error {
  return new Error(
    `Error invoking remote method '${LEAKY_IPC_CHANNEL}': Error: ${underlying}`
  );
}
