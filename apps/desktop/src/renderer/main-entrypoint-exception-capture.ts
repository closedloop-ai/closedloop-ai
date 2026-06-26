import type { RendererOtelRuntime } from "./app-otel-runtime";

export function registerMainEntrypointExceptionCapture(
  runtime: Pick<RendererOtelRuntime, "reportException">
): void {
  window.addEventListener("error", (event) => {
    console.error(
      "Uncaught desktop renderer error",
      event.error ?? event.message
    );
    runtime.reportException({
      error: event.error ?? event.message,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error("Unhandled desktop renderer rejection", event.reason);
    runtime.reportException({ error: event.reason });
  });
}
