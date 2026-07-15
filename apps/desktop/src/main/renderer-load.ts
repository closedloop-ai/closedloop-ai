/**
 * Pure orchestration for loading the desktop renderer with a bundled fallback
 * (extracted from `DesktopWindow.loadContent` so it is unit-testable without
 * Electron, mirroring `evaluateFrameRecovery` in `renderer-ipc.ts`).
 *
 * The invariant this enforces: the desktop window must NEVER hard-depend on the
 * external/dev Vite renderer. When a `--closedloop-renderer-url=` loopback URL
 * is present (unpackaged builds only) we try it first, but a load failure
 * (e.g. the Vite dev server isn't running → ERR_CONNECTION_REFUSED / -102)
 * falls through to the self-contained bundled `app://` asset. Every load is
 * wrapped so the whole operation always resolves — callers invoke it
 * fire-and-forget, so a rejection would become an unhandled rejection and
 * crash the process.
 */

export type RendererLoadLogger = {
  warn: (tag: string, message: string) => void;
  error: (tag: string, message: string) => void;
};

export type RendererLoadDeps = {
  /** Loopback dev renderer URL, or null when none is configured/allowed. */
  devRendererUrl: string | null;
  /** Bundled, self-contained `app://` renderer URL. */
  bundledRendererUrl: string;
  /** Loads a URL into the window; may reject on a renderer load failure. */
  loadUrl: (url: string) => Promise<unknown>;
  /** Registers the given URL as the sole allowed navigation target. */
  allowRendererUrl: (url: string) => void;
  /** Registers the `app://` protocol handler before the bundled load. */
  registerAppProtocol: () => void;
  log: RendererLoadLogger;
};

export type RendererLoadOutcome = "dev" | "bundled" | "failed";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loads the renderer, preferring the dev URL but always falling back to the
 * bundled asset. Never rejects: load failures are logged and reflected in the
 * returned outcome instead.
 */
export async function loadRendererContent(
  deps: RendererLoadDeps
): Promise<RendererLoadOutcome> {
  if (deps.devRendererUrl) {
    deps.allowRendererUrl(deps.devRendererUrl);
    try {
      await deps.loadUrl(deps.devRendererUrl);
      return "dev";
    } catch (error) {
      deps.log.warn(
        "renderer-load",
        `Dev renderer load failed (${deps.devRendererUrl}); falling back to bundled renderer: ${describeError(error)}`
      );
      // Fall through to the bundled asset — the guaranteed self-contained
      // source. Do NOT rethrow: a down dev server must not be fatal.
    }
  }

  deps.registerAppProtocol();
  deps.allowRendererUrl(deps.bundledRendererUrl);
  try {
    await deps.loadUrl(deps.bundledRendererUrl);
    return "bundled";
  } catch (error) {
    deps.log.error(
      "renderer-load",
      `Bundled renderer load failed (${deps.bundledRendererUrl}): ${describeError(error)}`
    );
    return "failed";
  }
}
