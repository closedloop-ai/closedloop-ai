import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import {
  type SanitizedDesktopExceptionAttributes,
  sanitizeDesktopException,
} from "../../shared/exception-sanitizer.js";
import type { DesktopOtelRuntime } from "./app-otel-runtime.js";

export type ProcessExceptionTelemetryBridge = {
  emitProcessException: (error: unknown) => void;
  emitPreInitException: (error: unknown) => void;
  emitMainException: (error: unknown) => void;
  /**
   * Drain what `emit*` just queued (ISS-6328). Resolves immediately when no
   * runtime is bound — a pre-init crash has nowhere to flush to and must not be
   * delayed pretending otherwise.
   */
  flushTelemetry: () => Promise<void>;
  /**
   * Close the pre-init window and hand everything captured during it to the
   * bound runtime (ISS-6330).
   *
   * Called once `runtime.start()` has RESOLVED, and that distinction is the
   * whole design: composition binds the runtime it has just constructed
   * (`desktop-services.ts`), but the runtime discards every emit until it is
   * started, much later in `app.ts boot()`. Gating on "bound" would leave the
   * entire bind→start window — the rest of service composition, and boot up to
   * the start itself — dropped by that guard, which is the same silent loss one
   * window over. Never called when `start()` failed: the window stays open and
   * the records stay queued rather than being emptied into a no-op.
   */
  markRuntimeStarted: () => void;
  bindRuntime: (runtime: DesktopOtelRuntime) => void;
  clearRuntime: () => void;
};

export function createProcessExceptionTelemetryBridge(): ProcessExceptionTelemetryBridge {
  let runtime: DesktopOtelRuntime | null = null;
  const preInitExceptions: PreInitException[] = [];
  /**
   * One-way, exactly like `PreInitLogBuffer.drain()`: once telemetry is live the
   * window never reopens. Without that, `clearRuntime()` at shutdown would send
   * every teardown exception back into a queue nothing drains again — retained
   * until process exit and mislabelled `pre_init` — where before this queue
   * existed it was a cheap no-op.
   */
  let preInitWindowOpen = true;

  return {
    emitProcessException(error) {
      // The origin follows the window, not the binding: an exception raised
      // before telemetry is live IS pre-init, whether or not composition has
      // already handed us the runtime object.
      if (preInitWindowOpen) {
        emitException(error, AppExceptionOrigin.PreInit);
        return;
      }
      emitException(error, AppExceptionOrigin.Main);
    },
    emitPreInitException(error) {
      emitException(error, AppExceptionOrigin.PreInit);
    },
    emitMainException(error) {
      emitException(error, AppExceptionOrigin.Main);
    },
    flushTelemetry() {
      return runtime?.flush() ?? Promise.resolve();
    },
    markRuntimeStarted() {
      preInitWindowOpen = false;
      drainPreInitExceptions();
    },
    bindRuntime(nextRuntime) {
      runtime = nextRuntime;
    },
    clearRuntime() {
      runtime = null;
    },
  };

  function emitException(error: unknown, origin: AppExceptionOrigin): void {
    if (preInitWindowOpen) {
      capturePreInitException(error, origin);
      return;
    }
    runtime?.emitAppExceptionEvent({ error, origin });
  }

  function capturePreInitException(
    error: unknown,
    origin: AppExceptionOrigin
  ): void {
    // A record offered while full is dropped rather than evicting one already
    // held: the EARLIEST pre-init failure is the one that explains the boot.
    if (preInitExceptions.length >= MAX_PRE_INIT_EXCEPTIONS) {
      return;
    }
    try {
      // Scrubbed HERE rather than at drain, so the queue never holds an email,
      // an install path, or a secret while it waits, and the record a later
      // death-path flush re-offers is already clean (ISS-6228 / ISS-6229). It
      // also bounds the queue: an unbounded `error.stack` is length-capped by
      // the sanitizer before anything is retained.
      preInitExceptions.push({
        attributes: sanitizeDesktopException({ error, origin }),
        // Stamped at CAPTURE. The drain can be seconds later, and a span left
        // to default to the drain clock would date every pre-init crash to the
        // moment telemetry came up and collapse their ordering.
        capturedAtUnixMs: Date.now(),
      });
    } catch {
      // A crash reporter that crashes is worse than none. A sanitizer fault on
      // a pathological stack costs this one record, never the boot.
    }
  }

  function drainPreInitExceptions(): void {
    if (!runtime) {
      // Nothing to drain into. Leave the queue intact rather than splicing it
      // into a no-op — these records are still the only account of this boot.
      return;
    }
    const drained = preInitExceptions.splice(0, preInitExceptions.length);
    for (const captured of drained) {
      try {
        runtime.emitSanitizedAppExceptionEvent(
          captured.attributes,
          captured.capturedAtUnixMs
        );
      } catch {
        // Best-effort, per the emit contract above.
      }
    }
  }
}

export const processExceptionTelemetryBridge =
  createProcessExceptionTelemetryBridge();

type PreInitException = {
  attributes: SanitizedDesktopExceptionAttributes;
  capturedAtUnixMs: number;
};

/**
 * Hard cap on exceptions held before the OTel runtime starts (ISS-6330), the
 * same bound `PreInitLogBuffer` puts on pre-init log lines. Small on purpose:
 * past the first handful a boot is already lost and the rest is downstream
 * noise. The refusals are NOT counted — surfacing a drop count would need a new
 * attribute in `packages/telemetry-contract`, which is out of scope this pass.
 */
export const MAX_PRE_INIT_EXCEPTIONS = 8;
