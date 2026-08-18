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

/**
 * ISS-5301: the panel's failure and shape-tolerance behavior.
 *
 * This is the surface a user is sent to when something else is already broken,
 * so its own error handling has to hold: a diagnostics IPC that rejects, an
 * `openLogFile` that comes back `{ ok: false }` (the mismatched-success shape
 * the desktop AGENTS.md calls out — the renderer must consume the FULL response,
 * not a bare truthy value), and log rows whose fields are missing or the wrong
 * type, which is normal for a log stream that spans app versions.
 */

describe("LogsPanel — failure reporting", () => {
  it("surfaces a failed log read as an alert", async () => {
    installLogsApi({
      getLogs: vi.fn(() => Promise.reject(new Error("log store unreadable"))),
    });
    render(<LogsPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("log store unreadable");
  });

  it("reports a generic message when the rejection is not an Error", async () => {
    installLogsApi({ getLogs: vi.fn(() => Promise.reject("nope")) });
    render(<LogsPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Failed to load logs");
  });

  it("surfaces a failed clear", async () => {
    installLogsApi({
      clearLogs: vi.fn(() => Promise.reject(new Error("file locked"))),
    });
    render(<LogsPanel />);
    await screen.findByText("boom while starting gateway");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("file locked");
  });

  it("reports the reason an open-file request was refused", async () => {
    installLogsApi({
      openLogFile: vi.fn(async () => ({ ok: false, error: "no handler" })),
    });
    render(<LogsPanel />);
    await screen.findByText("boom while starting gateway");

    fireEvent.click(screen.getByRole("button", { name: "Open File" }));

    // The refusal arrives as a resolved `{ ok: false }`, not a rejection: the
    // panel has to read the whole envelope to notice it failed at all.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("no handler");
  });

  it("still reports a refusal that carries no reason", async () => {
    installLogsApi({ openLogFile: vi.fn(async () => ({ ok: false })) });
    render(<LogsPanel />);
    await screen.findByText("boom while starting gateway");

    fireEvent.click(screen.getByRole("button", { name: "Open File" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("unknown error");
  });

  it("clears a previous failure once the file opens", async () => {
    // Starting from a clean panel would let this pass before `openLogFile` even
    // settled (there is no alert to begin with). Drive a refusal first, then a
    // success, so the assertion can only hold if the success path ran.
    installLogsApi({
      openLogFile: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: "no handler" })
        .mockResolvedValue({ ok: true }),
    });
    render(<LogsPanel />);
    await screen.findByText("boom while starting gateway");

    fireEvent.click(screen.getByRole("button", { name: "Open File" }));
    expect((await screen.findByRole("alert")).textContent).toBe("no handler");

    fireEvent.click(screen.getByRole("button", { name: "Open File" }));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("surfaces a thrown open-file failure", async () => {
    installLogsApi({
      openLogFile: vi.fn(() => Promise.reject(new Error("shell missing"))),
    });
    render(<LogsPanel />);
    await screen.findByText("boom while starting gateway");

    fireEvent.click(screen.getByRole("button", { name: "Open File" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("shell missing");
  });

  it("falls back to a generic subtitle when the log path is unavailable", async () => {
    installLogsApi({
      getLogFilePath: vi.fn(() => Promise.reject(new Error("no path"))),
    });
    render(<LogsPanel />);

    expect(await screen.findByText("Desktop gateway logs")).toBeTruthy();
  });
});

describe("LogsPanel — pausing", () => {
  it("toggles its own label so the control says what it will do", async () => {
    installLogsApi();
    render(<LogsPanel />);
    await screen.findByText("boom while starting gateway");

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("still honors an explicit Refresh while paused", async () => {
    vi.useFakeTimers();
    const api = installLogsApi();
    render(<LogsPanel />);
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    const callsAfterPause = api.getLogs.mock.calls.length;

    // Advance past two poll intervals — the count must not move.
    await vi.advanceTimersByTimeAsync(7000);
    expect(api.getLogs.mock.calls.length).toBe(callsAfterPause);

    // Pausing stops the poll, not the user: Refresh forces a read through.
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await vi.advanceTimersByTimeAsync(0);
    expect(api.getLogs.mock.calls.length).toBeGreaterThan(callsAfterPause);
  });
});

describe("LogsPanel — tolerating the shape of a log stream", () => {
  it("renders nothing but the empty state for a non-array payload", async () => {
    installLogsApi({ getLogs: vi.fn(async () => ({ not: "an array" })) });
    render(<LogsPanel />);

    expect(await screen.findByText("No log entries yet")).toBeTruthy();
  });

  it("drops non-record rows and defaults every missing field", async () => {
    installLogsApi({
      getLogs: vi.fn(async () => [
        "a bare string",
        null,
        { message: "no level, tag, or timestamp" },
      ]),
    });
    render(<LogsPanel />);

    expect(await screen.findByText("no level, tag, or timestamp")).toBeTruthy();
    // The two junk rows are gone; the survivor gets the documented defaults.
    expect(screen.getByText("info")).toBeTruthy();
    expect(screen.getByText("desktop")).toBeTruthy();
  });

  it("marks a row carried over from the previous app session", async () => {
    installLogsApi({
      getLogs: vi.fn(async () => [
        {
          timestamp: "2026-08-13T12:00:00.000Z",
          level: "warn",
          tag: "gateway",
          message: "from the last run",
          session: "previous",
        },
      ]),
    });
    render(<LogsPanel />);

    await screen.findByText("from the last run");
    expect(screen.getByText("gateway previous")).toBeTruthy();
  });

  it("shows an unparseable timestamp verbatim rather than as Invalid Date", async () => {
    installLogsApi({
      getLogs: vi.fn(async () => [
        { timestamp: "whenever", level: "error", message: "bad clock" },
      ]),
    });
    render(<LogsPanel />);

    await screen.findByText("bad clock");
    expect(screen.getByText("whenever")).toBeTruthy();
  });

  it("leaves the time column blank for a row with no timestamp", async () => {
    installLogsApi({
      getLogs: vi.fn(async () => [{ level: "info", message: "no clock" }]),
    });
    render(<LogsPanel />);

    const row = (await screen.findByText("no clock")).parentElement;
    expect(row?.firstElementChild?.textContent).toBe("");
  });
});
