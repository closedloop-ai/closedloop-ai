import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMainEntrypointExceptionCapture } from "../main-entrypoint-exception-capture";

describe("renderer main entrypoint exception capture", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wires global error and unhandledrejection listeners to telemetry", () => {
    const reportException = vi.fn();
    // FEA-4111 removed the console fallback: the browser already prints an
    // uncaught error and rejection itself, so a second copy only ever reached
    // the user's devtools. Assert it stays gone.
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const error = new Error("renderer failure");
    error.stack =
      "Error: renderer failure\n    at RendererRoot (main.tsx:17:5)";
    const rejection = new Error("renderer rejection");
    rejection.stack =
      "Error: renderer rejection\n    at RendererRoot (main.tsx:22:5)";

    registerMainEntrypointExceptionCapture({ reportException });

    window.dispatchEvent(
      new ErrorEvent("error", {
        error,
        message: error.message,
      })
    );
    window.dispatchEvent(createUnhandledRejectionEvent(rejection));

    expect(reportException).toHaveBeenCalledTimes(2);
    expect(reportException.mock.calls[0]?.[0]).toEqual({ error });
    expect(reportException.mock.calls[1]?.[0]).toEqual({ error: rejection });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

function createUnhandledRejectionEvent(reason: unknown): Event {
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", {
    value: reason,
  });
  return event;
}
