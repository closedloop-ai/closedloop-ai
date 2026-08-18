/**
 * @file opencode-materialize-worker.ts
 * @description ISS-5337: Electron utilityProcess entry that re-derives the
 * OpenCode projections (`opencode-materializer.ts`) OFF the main process.
 *
 * The pass is synchronous from top to bottom — it opens the foreign
 * `opencode.db` with `node:sqlite`, `JSON.parse`s every message/part row, and
 * serializes plus byte-compares every session's projection — and its checkpoint
 * is a store-wide fingerprint, so one new message re-derives the whole corpus.
 * While it ran in the main process it therefore held the event loop for the
 * entire sweep, and renderer IPC and window responsiveness queued behind it.
 *
 * This process holds no Electron state and no desktop-app (libSQL / db-host)
 * connection; the only database it touches is the foreign `opencode.db`, on the
 * short-lived `node:sqlite` connections the pass opens and closes itself.
 *
 * Deliberately a shim: every decision lives in `opencode-materialize-pass.ts`,
 * which a test can reach without `process.parentPort`.
 *
 * Mirrors `packs/pack-scan-worker.ts`.
 */
import { runOpencodeMaterializePass } from "./opencode-materialize-pass.js";

process.parentPort.on("message", (messageEvent) => {
  const response = runOpencodeMaterializePass(messageEvent.data);
  try {
    process.parentPort.postMessage(response);
  } catch {
    // The IPC channel is already gone; the runner's exit/timeout handling is the
    // only remaining signal path.
  }
});
