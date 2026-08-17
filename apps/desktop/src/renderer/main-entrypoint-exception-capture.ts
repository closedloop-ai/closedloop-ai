import type { RendererOtelRuntime } from "./app-otel-runtime";

/**
 * Route uncaught renderer errors and rejections to OTel.
 *
 * There is deliberately no console line here: the browser already prints an
 * uncaught error and an unhandled rejection to devtools itself, so a second copy
 * only ever reached the user's console, never the aggregator.
 */
export function registerMainEntrypointExceptionCapture(
  runtime: Pick<RendererOtelRuntime, "reportException">
): void {
  window.addEventListener("error", (event) => {
    runtime.reportException({
      error: event.error ?? event.message,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    runtime.reportException({ error: event.reason });
  });
}
