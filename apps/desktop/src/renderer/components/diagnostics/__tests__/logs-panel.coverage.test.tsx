import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogsPanel } from "../LogsPanel";

// Targets the one branch `logs-panel.test.tsx` does not reach: `load`'s catch
// handler checking `token.cancelled` (LogsPanel.tsx L92) when a read that is
// already in flight rejects AFTER the component unmounted. Pause already
// covers the token being cancelled on the SUCCESS path; this covers the same
// guard on the failure path.

type LogsApi = {
  getLogs: ReturnType<typeof vi.fn>;
  getLogFilePath: ReturnType<typeof vi.fn>;
  clearLogs: ReturnType<typeof vi.fn>;
  openLogFile: ReturnType<typeof vi.fn>;
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function installLogsApi(overrides: Partial<LogsApi> = {}): LogsApi {
  const api: LogsApi = {
    getLogs: vi.fn(async () => []),
    getLogFilePath: vi.fn(async () => ""),
    clearLogs: vi.fn(async () => undefined),
    openLogFile: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: api,
  });
  return api;
}

afterEach(() => {
  vi.useRealTimers();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("LogsPanel — a rejection arriving after cancellation is dropped", () => {
  it("never commits an error for a getLogs read that rejects after Pause cancelled its token", async () => {
    let rejectRead: ((reason: unknown) => void) | undefined;
    const api = installLogsApi({
      getLogs: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectRead = reject;
          })
      ),
    });
    render(<LogsPanel />);
    expect(screen.getByText("Loading logs...")).toBeTruthy();
    expect(api.getLogs).toHaveBeenCalledTimes(1);

    // Pause re-runs the polling effect with a new token, whose cleanup marks
    // the in-flight read's own token cancelled (LogsPanel.tsx L115/L122) —
    // this is the same token the catch handler's `if (token.cancelled)
    // return;` checks (L92) on the failure path.
    fireEvent.click(screen.getByText("Pause"));

    await act(async () => {
      rejectRead?.(new Error("too late"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
