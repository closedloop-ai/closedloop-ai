import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
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
  bindRuntime: (runtime: DesktopOtelRuntime) => void;
  clearRuntime: () => void;
};

export function createProcessExceptionTelemetryBridge(): ProcessExceptionTelemetryBridge {
  let runtime: DesktopOtelRuntime | null = null;

  return {
    emitProcessException(error) {
      if (runtime) {
        emitException(error, AppExceptionOrigin.Main);
        return;
      }
      emitException(error, AppExceptionOrigin.PreInit);
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
    bindRuntime(nextRuntime) {
      runtime = nextRuntime;
    },
    clearRuntime() {
      runtime = null;
    },
  };

  function emitException(error: unknown, origin: AppExceptionOrigin): void {
    runtime?.emitAppExceptionEvent({
      error,
      origin,
    });
  }
}

export const processExceptionTelemetryBridge =
  createProcessExceptionTelemetryBridge();
