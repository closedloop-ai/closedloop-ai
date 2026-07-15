import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogsPanel } from "../LogsPanel";

// Behavioral replacement for the old renderer-logs-static source-text guard:
// mount the real component with a stubbed window.desktopApi and assert it wires
// the diagnostics IPC (getLogs / getLogFilePath / clearLogs / openLogFile)
// through the actual render + click paths.

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
    getLogs: vi.fn(async () => [
      {
        timestamp: "2026-07-01T12:00:00.000Z",
        level: "error",
        tag: "gateway",
        message: "boom while starting gateway",
      },
    ]),
    getLogFilePath: vi.fn(async () => "/tmp/closedloop/desktop.log"),
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

describe("LogsPanel diagnostics IPC wiring", () => {
  it("loads logs and the log file path on mount and renders entries", async () => {
    const api = installLogsApi();
    render(<LogsPanel />);

    expect(
      await screen.findByText("boom while starting gateway")
    ).toBeDefined();
    expect(api.getLogs).toHaveBeenCalled();
    await waitFor(() => expect(api.getLogFilePath).toHaveBeenCalled());
    expect(screen.getByText("/tmp/closedloop/desktop.log")).toBeDefined();
  });

  it("re-invokes getLogs when Refresh is clicked", async () => {
    const api = installLogsApi();
    render(<LogsPanel />);
    await screen.findByText("boom while starting gateway");
    const initialCalls = api.getLogs.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(api.getLogs.mock.calls.length).toBeGreaterThan(initialCalls)
    );
  });

  it("clears entries via clearLogs when Clear is clicked", async () => {
    const api = installLogsApi();
    render(<LogsPanel />);
    await screen.findByText("boom while starting gateway");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(api.clearLogs).toHaveBeenCalled());
    expect(screen.getByText("No log entries yet")).toBeDefined();
  });

  it("invokes openLogFile when Open File is clicked", async () => {
    const api = installLogsApi();
    render(<LogsPanel />);
    await screen.findByText("boom while starting gateway");

    fireEvent.click(screen.getByRole("button", { name: "Open File" }));

    await waitFor(() => expect(api.openLogFile).toHaveBeenCalled());
  });
});
