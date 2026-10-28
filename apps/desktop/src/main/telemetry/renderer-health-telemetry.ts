import { sanitizeExceptionTextField } from "../../shared/exception-sanitizer.js";
import { Observability } from "./observability.js";
import type {
  RendererHealthDiagnostics,
  RendererLoadFailureSource,
  TelemetryCategory,
} from "./telemetry-protocol.js";

export const RENDERER_UNRESPONSIVE_CATEGORY =
  "desktop.renderer.unresponsive" as const satisfies TelemetryCategory;
export const RENDERER_LOAD_FAILED_CATEGORY =
  "desktop.renderer.load_failed" as const satisfies TelemetryCategory;
export const RENDERER_RELOAD_BUDGET_EXHAUSTED_CATEGORY =
  "desktop.renderer.reload_budget_exhausted" as const satisfies TelemetryCategory;

/** The closed set this module emits, so its mappers can be exhaustive. */
type RendererHealthCategory =
  | typeof RENDERER_UNRESPONSIVE_CATEGORY
  | typeof RENDERER_LOAD_FAILED_CATEGORY
  | typeof RENDERER_RELOAD_BUDGET_EXHAUSTED_CATEGORY;

/**
 * Chromium's `ERR_ABORTED`. `did-fail-load` fires with it whenever a load is
 * superseded rather than broken — including on every crash-recovery reload this
 * app performs itself — so treating it as a failure would emit a spurious event
 * on the recovery path and drown the real ones.
 */
export const NET_ERROR_ABORTED = -3;

/**
 * Repeat suppression window. An unresponsive renderer flaps and a reload loop
 * fires repeatedly, so an unbounded emitter would turn one incident into a
 * flood. The key is the closed-enum part of the signal only (category, source,
 * error code) — never `detail`, whose URL varies per attempt and would defeat
 * the bound while filling the map.
 */
export const RENDERER_HEALTH_DEDUPE_WINDOW_MS = 60_000;

/**
 * Hard cap on tracked keys. The key space is closed in practice (three
 * categories x two sources x Chromium's error set), but an in-memory map fed
 * from external input gets a size cap regardless; the oldest entry is evicted.
 */
export const RENDERER_HEALTH_MAX_TRACKED_SIGNALS = 32;

/** Producer-side cap on `detail`; the wire schema caps at 512 on top of it. */
const RENDERER_HEALTH_DETAIL_MAX_LENGTH = 256;

/** What the reporter needs from the window that owns it. */
export type RendererHealthReporterContext = {
  /** Reloads the crash breaker has spent in its rolling window. */
  getReloadsInWindow: () => number;
  /**
   * True while the window is disposing or the app is quitting. Teardown makes
   * the renderer hang and fail loads by design; reporting that as a product
   * failure would page someone for every quit. The sibling handlers in
   * `window.ts` all take the same guard.
   */
  isTearingDown: () => boolean;
  /**
   * The URL whose load failure the loader RECOVERS FROM by design — the dev
   * renderer, which `loadRendererContent` deliberately tries first and falls
   * back from when Vite is down (ERR_CONNECTION_REFUSED). Null when there is
   * none. Compared against, never emitted.
   */
  getRecoveredLoadUrl: () => string | null;
};

/**
 * The subset of `WebContents` this module registers on. Declared structurally
 * so the wiring is drivable without an Electron runtime — the teardown and
 * hang states it reports are only reachable in production.
 */
export type RendererHealthEventSource = {
  on(event: "unresponsive", listener: () => void): unknown;
  on(
    event: "did-fail-load",
    listener: (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean
    ) => void
  ): unknown;
  on(
    event: "preload-error",
    listener: (event: unknown, preloadPath: string, error: Error) => void
  ): unknown;
};

export type RendererHealthReporter = {
  /**
   * Register the three listeners the repo had none of. Sub-frame
   * `did-fail-load` is ignored: an iframe that fails to load is not a blank
   * app, and it is the high-volume half of that event.
   */
  installListeners: (webContents: RendererHealthEventSource) => void;
  /** The crash breaker spent its budget and stopped trying. */
  reportReloadBudgetExhausted: (reloadsInWindow: number) => void;
  /**
   * Drop all accumulated suppression state with the window. There are no timers
   * to clear — the bound is a pruned map, on purpose, because a superseded timer
   * is the failure mode that avoids entirely.
   */
  dispose: () => void;
};

export function createRendererHealthReporter(
  context: RendererHealthReporterContext
): RendererHealthReporter {
  /** Last emission per closed-enum signal key. Pruned on every write. */
  const lastEmittedAtByKey = new Map<string, number>();

  return {
    installListeners(webContents) {
      webContents.on("unresponsive", () => {
        emit(RENDERER_UNRESPONSIVE_CATEGORY, {
          reloadsInWindow: context.getReloadsInWindow(),
        });
      });

      webContents.on(
        "did-fail-load",
        (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
          if (
            !isMainFrame ||
            errorCode === NET_ERROR_ABORTED ||
            isRecoveredLoad(validatedUrl)
          ) {
            return;
          }
          reportLoadFailed({
            source: "did_fail_load",
            errorCode,
            detail: `${errorDescription} ${validatedUrl}`,
          });
        }
      );

      webContents.on("preload-error", (_event, preloadPath, error) => {
        reportLoadFailed({
          source: "preload_error",
          detail: `${error instanceof Error ? error.message : String(error)} ${preloadPath}`,
        });
      });
    },

    reportReloadBudgetExhausted(reloadsInWindow) {
      emit(RENDERER_RELOAD_BUDGET_EXHAUSTED_CATEGORY, { reloadsInWindow });
    },

    dispose() {
      lastEmittedAtByKey.clear();
    },
  };

  /**
   * True when this load failure is the loader's own fallback probe. The dev
   * renderer is tried first on unpackaged builds and a down Vite server is
   * explicitly non-fatal, so reporting it would fire an error-severity
   * "nothing ever painted" on a window that paints fine a moment later.
   */
  function isRecoveredLoad(validatedUrl: string): boolean {
    const recoveredUrl = context.getRecoveredLoadUrl();
    return recoveredUrl !== null && recoveredUrl === validatedUrl;
  }

  function reportLoadFailed(input: {
    source: RendererLoadFailureSource;
    errorCode?: number;
    /** Raw text; this function owns sanitizing it, so no caller can forget. */
    detail: string;
  }): void {
    const detail = sanitizeExceptionTextField(
      input.detail,
      RENDERER_HEALTH_DETAIL_MAX_LENGTH
    );
    emit(RENDERER_LOAD_FAILED_CATEGORY, {
      reloadsInWindow: context.getReloadsInWindow(),
      source: input.source,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  function emit(
    category: RendererHealthCategory,
    rendererHealth: RendererHealthDiagnostics
  ): void {
    if (context.isTearingDown()) {
      return;
    }
    if (!admitSignal(buildSignalKey(category, rendererHealth), Date.now())) {
      return;
    }
    Observability.getTelemetryEmitter().emit({
      severity: "error",
      category,
      message: describeRendererHealth(category, rendererHealth),
      trace: {},
      diagnostics: { rendererHealth },
    });
  }

  /**
   * True when this signal may be emitted now. A key not seen inside the window —
   * because it is new, or because its classification CHANGED — is always
   * admitted; only an identical repeat is suppressed.
   */
  function admitSignal(key: string, now: number): boolean {
    for (const [trackedKey, emittedAt] of lastEmittedAtByKey) {
      if (now - emittedAt >= RENDERER_HEALTH_DEDUPE_WINDOW_MS) {
        lastEmittedAtByKey.delete(trackedKey);
      }
    }
    if (lastEmittedAtByKey.has(key)) {
      return false;
    }
    // Map iteration is insertion-ordered, so the first surviving key is the
    // oldest admission still inside the window.
    if (lastEmittedAtByKey.size >= RENDERER_HEALTH_MAX_TRACKED_SIGNALS) {
      const oldestKey = lastEmittedAtByKey.keys().next().value;
      if (oldestKey !== undefined) {
        lastEmittedAtByKey.delete(oldestKey);
      }
    }
    lastEmittedAtByKey.set(key, now);
    return true;
  }
}

/**
 * The closed-enum identity of a signal. `detail` is deliberately excluded: it
 * varies per attempt, so including it would both defeat the suppression and
 * grow the map without bound.
 */
function buildSignalKey(
  category: RendererHealthCategory,
  rendererHealth: RendererHealthDiagnostics
): string {
  return `${category}|${rendererHealth.source ?? ""}|${rendererHealth.errorCode ?? ""}`;
}

/**
 * Exhaustive over {@link RendererHealthCategory}: a fourth renderer category
 * must fail typecheck here rather than silently inherit the load-failure
 * sentence, which would name the wrong condition and print two absent fields.
 */
function describeRendererHealth(
  category: RendererHealthCategory,
  rendererHealth: RendererHealthDiagnostics
): string {
  switch (category) {
    case RENDERER_UNRESPONSIVE_CATEGORY:
      return `Renderer stopped responding (${rendererHealth.reloadsInWindow} reload(s) spent in window)`;
    case RENDERER_RELOAD_BUDGET_EXHAUSTED_CATEGORY:
      return `Renderer reload budget exhausted after ${rendererHealth.reloadsInWindow} reload(s); no further recovery will be attempted`;
    case RENDERER_LOAD_FAILED_CATEGORY:
      return `Renderer failed to load (source=${rendererHealth.source}, code=${rendererHealth.errorCode ?? "none"}, ${rendererHealth.reloadsInWindow} reload(s) spent in window)`;
    default: {
      const unmapped: never = category;
      return unmapped;
    }
  }
}
