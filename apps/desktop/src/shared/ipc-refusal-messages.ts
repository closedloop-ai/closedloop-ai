/**
 * @file ipc-refusal-messages.ts
 * @description ISS-8376 — the two reasons a main-process IPC handler refuses a
 * call, in a node-free module both sides can read.
 *
 * These were declared in `main/ipc/ipc-trusted-sender.ts` while only main
 * needed them. A renderer adapter now has to tell the two apart: an
 * authorization refusal is permanent and must not be retried, while a
 * torn-down window is a lifecycle race that must not be reported as an attack.
 * Electron wraps a handler's throw, so the renderer recovers the underlying
 * text with `cleanIpcError` and compares it against the constants below —
 * comparing against a hand-written literal instead is exactly the drift a
 * shared module exists to stop.
 *
 * ISS-8776 established that these are "a DIFFERENT FACT, not a softer one".
 * Keep them distinct here and at every consumer.
 */

/** The refusal for a sender that is not this app's renderer window. */
export const UNTRUSTED_IPC_SENDER_MESSAGE = "untrusted sender";

/**
 * The refusal for a call that arrived after the renderer window was torn down,
 * so there was nothing to verify the sender against.
 *
 * Both refuse the call identically; only the reported reason differs.
 */
export const RENDERER_WINDOW_GONE_MESSAGE = "renderer window is gone";
