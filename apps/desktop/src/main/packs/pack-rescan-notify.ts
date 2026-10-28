/**
 * @file pack-rescan-notify.ts
 * @description ISS-6882: the post-install/uninstall pack rescan AND the renderer
 * cache nudge that has to follow it, as one call.
 *
 * `streamRun` emits its `complete` IPC BEFORE it invokes `onComplete`, so the
 * renderer learns the subprocess finished while the pack inventory in SQLite is
 * still pre-scan. The rescan that reconciles it (`packScanner.run`) then ran
 * fire-and-forget with nothing announcing its commit. On the desktop local scope
 * the Agents workspace QueryClient runs `staleTime: Infinity` with focus and
 * reconnect refetches off, so `desktop:db:changed` is the ONLY channel that can
 * move a cached component query — without this emit an install or uninstall left
 * the component list and any open detail stale until an unrelated DB event or a
 * renderer restart.
 */

import type { BrowserWindow } from "electron";
import { DesktopRendererEventChannel } from "../../shared/desktop-renderer-event-channel.js";
import type { InvokeStoreOp } from "../dashboard/agent-dashboard-runtime-options.js";
import { sendToRendererWindow } from "../ipc/renderer-ipc.js";
import { gatewayLog } from "../logging/gateway-logger.js";

/** The store op that reconciles the installed-pack inventory against disk. */
const PACK_SCANNER_RUN_OP = "packScanner.run";

/** The renderer channel every DB-backed cache invalidates on. */
const DB_CHANGED_CHANNEL = DesktopRendererEventChannel.DbChanged;

type PackRescanNotifyDeps = {
  readonly invokeStoreOp: InvokeStoreOp;
  readonly getWindow: () => BrowserWindow | null;
};

/**
 * Rescan the installed-pack inventory, then tell the renderer its DB-backed
 * caches moved — in that order, and only when the rescan actually committed.
 *
 * Best-effort and non-throwing on both halves, because the sole caller is
 * `streamRun`'s `onComplete` hook, which has no error path: a rescan failure is
 * logged and NOT announced (announcing it would invalidate the renderer's caches
 * into a refetch of the same pre-scan rows, reporting a completed install that
 * did not land), and the window may legitimately be gone by the time a long
 * install finishes, which `sendToRendererWindow` absorbs.
 *
 * Returns nothing on purpose. The caller is a synchronous `onComplete` hook with
 * nowhere to put a promise, and handing one back would only invite a floating
 * one at each call site; both settle paths are already terminal here.
 */
export function rescanPacksAndNotify(deps: PackRescanNotifyDeps): void {
  deps.invokeStoreOp(PACK_SCANNER_RUN_OP).then(
    () => {
      sendToRendererWindow(deps.getWindow(), DB_CHANGED_CHANNEL, {});
    },
    (error: unknown) => {
      gatewayLog.warn(
        "[pack-rescan-notify]",
        `${PACK_SCANNER_RUN_OP} failed; skipping ${DB_CHANGED_CHANNEL}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  );
}
