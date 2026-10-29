import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IPC_WRAPPER_PHRASE,
  ipcWrappedError,
  LEAKY_IPC_CHANNEL,
} from "../../../__tests__/ipc-wrapper-error-fixture";
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
    const originalTz = process.env.TZ;
    process.env.TZ = "UTC";
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
    try {
      const api = installLogsApi();
      render(<LogsPanel />);

      expect(
        await screen.findByText("boom while starting gateway")
      ).toBeDefined();
      expect(api.getLogs).toHaveBeenCalled();
      await waitFor(() => expect(api.getLogFilePath).toHaveBeenCalled());
      expect(screen.getByText("/tmp/closedloop/desktop.log")).toBeDefined();
      expect(screen.getByText("12:00:00 PM")).toBeDefined();
      expect(screen.queryByText("2026-07-01T12:00:00.000Z")).toBeNull();
    } finally {
      if (originalTz === undefined) {
        Reflect.deleteProperty(process.env, "TZ");
      } else {
        process.env.TZ = originalTz;
      }
    }
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

  it("drops a read already in flight instead of committing it after Pause", async () => {
    vi.useFakeTimers();
    let releaseSecondRead: ((logs: unknown) => void) | undefined;
    const api = installLogsApi({
      getLogs: vi
        .fn()
        .mockResolvedValueOnce([{ level: "info", message: "before pause" }])
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseSecondRead = resolve;
            })
        )
        .mockResolvedValue([{ level: "info", message: "after resume" }]),
    });
    render(<LogsPanel />);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText("before pause")).toBeTruthy();

    // Start the read the user is waiting on, then stop waiting for it.
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(releaseSecondRead).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await act(async () => {
      releaseSecondRead?.([{ level: "error", message: "arrived after pause" }]);
      await vi.advanceTimersByTimeAsync(0);
    });

    // Pause means the log stops moving. Without the guard the in-flight answer
    // lands anyway and the rows the user paused on are replaced.
    expect(screen.queryByText("arrived after pause")).toBeNull();
    expect(screen.getByText("before pause")).toBeTruthy();

    // ...and the panel is not stranded on the loading text by the read it
    // dropped: Resume commits normally.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("after resume")).toBeTruthy();
    expect(api.getLogs).toHaveBeenCalledTimes(3);
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

/**
 * ISS-7599: all three of this panel's IPC catches render the caught message, so
 * all three must route it through `cleanIpcError`. An untreated catch puts
 * Electron's `Error invoking remote method '<channel>': ` wrapper — and the
 * private channel name inside it — straight into the alert the user reads.
 */
describe("LogsPanel — Electron IPC wrapper never reaches the user", () => {
  it("cleans a wrapped getLogs rejection", async () => {
    installLogsApi({
      getLogs: vi.fn(() =>
        Promise.reject(ipcWrappedError("log store unreadable"))
      ),
    });
    render(<LogsPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("log store unreadable");
    expect(alert.textContent).not.toContain(LEAKY_IPC_CHANNEL);
    expect(alert.textContent).not.toContain(IPC_WRAPPER_PHRASE);
  });

  it("cleans a wrapped clearLogs rejection", async () => {
    installLogsApi({
      clearLogs: vi.fn(() => Promise.reject(ipcWrappedError("file locked"))),
    });
    render(<LogsPanel />);
    await screen.findByText("boom while starting gateway");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("file locked");
    expect(alert.textContent).not.toContain(LEAKY_IPC_CHANNEL);
    expect(alert.textContent).not.toContain(IPC_WRAPPER_PHRASE);
  });

  it("cleans a wrapped openLogFile rejection", async () => {
    installLogsApi({
      openLogFile: vi.fn(() =>
        Promise.reject(ipcWrappedError("shell missing"))
      ),
    });
    render(<LogsPanel />);
    await screen.findByText("boom while starting gateway");

    fireEvent.click(screen.getByRole("button", { name: "Open File" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("shell missing");
    expect(alert.textContent).not.toContain(LEAKY_IPC_CHANNEL);
    expect(alert.textContent).not.toContain(IPC_WRAPPER_PHRASE);
  });
});
