import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { sessionsExportPath } from "../../data-source/agent-sessions-data-source";
import {
  SessionsExportFailure,
  useSessionsCsvExport,
} from "../use-sessions-csv-export";

const getText = vi.fn();

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => ({ getText }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CSV = "Date,User\n2026-08-01,ada\n";

describe("FEA-4217 — sessionsExportPath", () => {
  // The export route parses `baseAgentSessionQuerySchema`, which is `.strict()`.
  // A list-only key reaching it 400s the whole download, so what the builder
  // DROPS is as load-bearing as what it keeps.
  it("keeps the window and the facets, and drops every list-only key", () => {
    const path = sessionsExportPath({
      endDate: "2026-08-08T00:00:00.000Z",
      harnesses: ["claude"],
      limit: 25,
      offset: 50,
      repositories: ["acme/repo"],
      sortBy: "cost",
      sortDir: "desc",
      startDate: "2026-08-01T00:00:00.000Z",
    });

    expect(path.startsWith("/agent-sessions/export?")).toBe(true);
    const params = new URLSearchParams(path.slice(path.indexOf("?") + 1));
    expect(params.get("startDate")).toBe("2026-08-01T00:00:00.000Z");
    expect(params.get("endDate")).toBe("2026-08-08T00:00:00.000Z");
    expect(params.getAll("repositories")).toEqual(["acme/repo"]);
    expect(params.getAll("harnesses")).toEqual(["claude"]);
    for (const listOnly of ["limit", "offset", "sortBy", "sortDir", "format"]) {
      expect(params.has(listOnly)).toBe(false);
    }
  });
});

describe("FEA-4217 — useSessionsCsvExport", () => {
  let clicked: string[] = [];

  beforeEach(() => {
    getText.mockReset();
    clicked = [];
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:lane2");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function mockClick(this: HTMLAnchorElement) {
        clicked.push(this.download);
      }
    );
  });

  it("reads the CSV for the active filters and hands the browser a download", async () => {
    getText.mockResolvedValue(CSV);

    const { result } = renderHook(() =>
      useSessionsCsvExport({ startDate: "2026-08-01T00:00:00.000Z" })
    );
    act(() => result.current.exportCsv());

    await waitFor(() => expect(result.current.isExporting).toBe(false));
    expect(getText).toHaveBeenCalledWith(
      sessionsExportPath({ startDate: "2026-08-01T00:00:00.000Z" })
    );
    expect(clicked).toHaveLength(1);
    expect(clicked[0].endsWith(".csv")).toBe(true);
    expect(result.current.exportFailure).toBeNull();
  });

  it("classifies a denied read as PERMANENT, so the row never tells the reader to retry it", async () => {
    getText.mockRejectedValue(new ApiError("forbidden", 403));

    const { result } = renderHook(() => useSessionsCsvExport({}));
    act(() => result.current.exportCsv());

    await waitFor(() =>
      expect(result.current.exportFailure).toBe(SessionsExportFailure.Permanent)
    );
    expect(result.current.isExporting).toBe(false);
  });

  it("classifies a server or transport failure as RETRYABLE", async () => {
    getText.mockRejectedValue(new ApiError("upstream is down", 502));

    const { result } = renderHook(() => useSessionsCsvExport({}));
    act(() => result.current.exportCsv());

    await waitFor(() =>
      expect(result.current.exportFailure).toBe(SessionsExportFailure.Retryable)
    );
  });

  it("degrades an unrecognized rejection to RETRYABLE rather than declaring the export impossible", async () => {
    getText.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useSessionsCsvExport({}));
    act(() => result.current.exportCsv());

    await waitFor(() =>
      expect(result.current.exportFailure).toBe(SessionsExportFailure.Retryable)
    );
  });

  it("clears a previous failure when a new attempt starts, and does not read twice while one is in flight", async () => {
    let release!: (csv: string) => void;
    getText.mockReturnValueOnce(new Promise<string>((r) => (release = r)));

    const { result } = renderHook(() => useSessionsCsvExport({}));
    act(() => result.current.exportCsv());
    expect(result.current.isExporting).toBe(true);

    // A second click while the first read is still open must not issue another.
    act(() => result.current.exportCsv());
    expect(getText).toHaveBeenCalledTimes(1);

    act(() => release(CSV));
    await waitFor(() => expect(result.current.isExporting).toBe(false));
    expect(result.current.exportFailure).toBeNull();
  });
});
