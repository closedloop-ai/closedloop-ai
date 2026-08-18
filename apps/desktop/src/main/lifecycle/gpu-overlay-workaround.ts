/**
 * macOS GPU overlay-compositing workaround.
 *
 * On macOS, recent Chromium (which Electron 43 ships, Chromium ~150) floods the
 * main-process stderr with GPU compositing errors from the CoreAnimation /
 * IOSurface overlay path colliding with the Skia buffer-queue:
 *
 *   ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc]
 *     SharedImageManager::ProduceOverlay: Trying to Produce a Overlay
 *     representation from a non-existent mailbox.
 *   ERROR:components/viz/service/display_embedder/skia_output_device_buffer_queue.cc]
 *     Invalid mailbox.
 *
 * The GPU process tries to promote a layer to an IOSurface-backed
 * CoreAnimation overlay from a mailbox the Skia buffer-queue path has already
 * released, so the overlay produce fails. Besides spamming the logs this can
 * cause visual glitches / flicker. See electron/electron#38023 and the Chromium
 * Mac delegated-rendering / overlay design docs.
 *
 * `--disable-mac-overlays` is the minimal, macOS-specific Chromium switch that
 * targets exactly this path: "Fall back to using CAOpenGLLayers display
 * content, instead of the IOSurface based overlay display path." It leaves
 * GPU hardware acceleration (rasterization, Metal/Skia) fully enabled — unlike
 * a blanket `app.disableHardwareAcceleration()`, which is a heavy perf
 * regression — and only disables the overlay-promotion path that emits the
 * mailbox errors.
 *
 * This MUST be registered before the app `ready` event fires, so `run()` calls
 * it near the top of startup.
 */

/** Chromium switch that disables the IOSurface-based Mac overlay path. */
export const MAC_DISABLE_OVERLAYS_SWITCH = "disable-mac-overlays";

/** Minimal `app.commandLine`-shaped surface, for injectable testing. */
export type CommandLineLike = {
  appendSwitch: (theSwitch: string, value?: string) => void;
};

/**
 * Appends the `--disable-mac-overlays` switch on macOS only, suppressing the
 * `ProduceOverlay` / `Invalid mailbox` GPU-overlay error spam without disabling
 * hardware acceleration. No-ops on every other platform, where the IOSurface
 * overlay path (and thus the error) does not exist.
 *
 * @returns `true` when the switch was appended (darwin), `false` otherwise.
 */
export function applyMacOverlayWorkaround(deps: {
  commandLine: CommandLineLike;
  platform: NodeJS.Platform;
  log?: (message: string) => void;
}): boolean {
  if (deps.platform !== "darwin") {
    return false;
  }

  deps.commandLine.appendSwitch(MAC_DISABLE_OVERLAYS_SWITCH);
  deps.log?.(
    `applied --${MAC_DISABLE_OVERLAYS_SWITCH} to suppress macOS GPU overlay-mailbox error spam (electron/electron#38023)`
  );
  return true;
}
