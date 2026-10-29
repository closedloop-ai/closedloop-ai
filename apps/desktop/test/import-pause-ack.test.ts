import {
  type Page,
  expect as playwrightExpect,
  type TestInfo,
} from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./deferred";
import {
  requestImportPauseUntilParked,
  setImportPaused,
} from "./e2e/helpers/import-pause";

import {
  classifyDesktopPageError,
  createReadinessFailureDiagnostic,
} from "./e2e/helpers/readiness-failure-diagnostic";

describe("import pause acknowledgment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it.each([true, false])(
    "accepts the first real acknowledgment for paused=%s",
    async (paused) => {
      const request = vi.fn<() => Promise<unknown>>().mockResolvedValue({
        ingest: { importParked: paused },
      });
      const poll = vi.fn(pollImportPause);
      const observer = vi.fn<(report: unknown) => void>();
      await requestImportPauseUntilParked(request, poll, paused, observer);
      expect(request).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledExactlyOnceWith({
        ingest: { importParked: paused },
      });
    }
  );

  it("admits acknowledgment on request 24 without starting request 25", async () => {
    let requests = 0;
    const request = vi.fn(() => {
      requests += 1;
      return Promise.resolve({ ingest: { importParked: requests === 24 } });
    });
    await requestImportPauseUntilParked(request, pollImportPause, true);
    expect(request).toHaveBeenCalledTimes(24);
  });

  it("awaits IPC completion before probing again", async () => {
    const started = deferred<void>();
    const firstReport = deferred<unknown>();
    const request = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => {
        started.resolve();
        return firstReport.promise;
      })
      .mockResolvedValue({ ingest: { importParked: true } });
    const result = requestImportPauseUntilParked(
      request,
      pollImportPause,
      true
    );
    await started.promise;
    expect(request).toHaveBeenCalledTimes(1);
    firstReport.resolve({ ingest: { importParked: false } });
    await result;
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("propagates a later transport failure without using the remaining budget", async () => {
    const request = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ ingest: { importParked: false } })
      .mockRejectedValue(new Error("runtime IPC refused"));
    await expect(
      requestImportPauseUntilParked(request, pollImportPause, true)
    ).rejects.toThrow("runtime IPC refused");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("re-asks through an unavailable runtime until the real loop parks", async () => {
    const request = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ingest: null })
      .mockResolvedValueOnce({ ingest: { importParked: false } })
      .mockResolvedValue({ ingest: { importParked: true } });
    const poll = vi.fn(pollImportPause);
    await requestImportPauseUntilParked(request, poll, true);
    expect(request).toHaveBeenCalledTimes(4);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("waits for resume to release the actual gate waiter", async () => {
    const request = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ ingest: { importParked: true } })
      .mockResolvedValue({ ingest: { importParked: false } });
    const poll = vi.fn(pollImportPause);
    await requestImportPauseUntilParked(request, poll, false);
    expect(request).toHaveBeenCalledTimes(2);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it.each([
    { paused: true, parked: false, action: "pause" },
    { paused: false, parked: true, action: "resume" },
  ])(
    "rejects a dropped $action across the full original attempt budget",
    async ({ paused, parked, action }) => {
      const request = vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({ ingest: { importParked: parked } });
      const poll = vi.fn(pollImportPause);
      await expect(
        requestImportPauseUntilParked(request, poll, paused)
      ).rejects.toThrow(
        `Import did not acknowledge ${action} after 24 requests`
      );
      expect(request).toHaveBeenCalledTimes(24);
      expect(poll).toHaveBeenCalledTimes(1);
    }
  );

  it.each([null, { ingest: null }])(
    "never interprets an absent runtime %j as resumed",
    async (report) => {
      const request = vi.fn<() => Promise<unknown>>().mockResolvedValue(report);
      const poll = vi.fn(pollImportPause);
      await expect(
        requestImportPauseUntilParked(request, poll, false)
      ).rejects.toThrow("Import did not acknowledge resume");
      expect(request).toHaveBeenCalledTimes(24);
    }
  );

  it("rejects an invalid report rather than coercing its state", async () => {
    const request = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValue({ ingest: { importParked: "false" } });
    const poll = vi.fn(pollImportPause);
    await expect(
      requestImportPauseUntilParked(request, poll, false)
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("propagates command failures without admitting acknowledgment", async () => {
    const request = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValue(new Error("trusted sender refused"));
    const poll = vi.fn(pollImportPause);
    await expect(
      requestImportPauseUntilParked(request, poll, true)
    ).rejects.toThrow("trusted sender refused");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("routes the explicit guest policy through the real Page adapter", async () => {
    const actualPoll = playwrightExpect.poll;
    let pollOptions: Parameters<typeof playwrightExpect.poll>[1];
    const poll = vi
      .spyOn(playwrightExpect, "poll")
      .mockImplementation((probe, options) => {
        // Playwright consumes its interval array before the assertion completes.
        if (typeof options === "string") {
          pollOptions = options;
        } else {
          pollOptions = { ...options, intervals: options?.intervals?.slice() };
        }
        return actualPoll(probe, options);
      });
    const page = {
      evaluate: vi
        .fn<Page["evaluate"]>()
        .mockResolvedValue({ ingest: { importParked: true } }),
    } satisfies Pick<Page, "evaluate">;
    await setImportPaused(page, true, { acknowledgeParked: true });
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), true);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(pollOptions).toEqual({
      intervals: [250],
      timeout: 0,
    });
    const call = page.evaluate.mock.calls[0];
    if (!call || typeof call[0] !== "function") {
      throw new Error(
        "The Page adapter did not supply its serialized callback"
      );
    }
    const api = {
      setAgentMonitorImportPaused: vi
        .fn<(paused: boolean) => Promise<void>>()
        .mockResolvedValue(),
      getRuntimeStatus: vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({ ingest: { importParked: true } }),
    };
    vi.stubGlobal("window", { desktopApi: api });
    await call[0](call[1]);
    expect(api.setAgentMonitorImportPaused).toHaveBeenCalledExactlyOnceWith(
      true
    );
    expect(api.getRuntimeStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps the pre-consent default on its original request-only path", async () => {
    const page = {
      evaluate: vi.fn<Page["evaluate"]>().mockResolvedValue(undefined),
    } satisfies Pick<Page, "evaluate">;
    await setImportPaused(page, true);
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), [
      24,
      250,
      true,
    ]);
  });
});

describe("failure diagnostic boundaries", () => {
  it("retains only existing loop observations without extra requests or waits", async () => {
    const report = {
      ingest: { importParked: false, processed: 2, total: 80 },
      apiOrigin: "secret-origin",
    };
    const request = vi.fn<() => Promise<unknown>>().mockResolvedValue(report);
    const poll = vi.fn(pollImportPause);
    const observer = vi.fn<(value: unknown) => void>();
    await expect(
      requestImportPauseUntilParked(request, poll, true, observer)
    ).rejects.toThrow("after 24 requests");
    expect(request).toHaveBeenCalledTimes(24);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledTimes(24);
    expect(observer).toHaveBeenLastCalledWith(report);
  });

  it("strips identities, paths, origins and nested payloads from the actual attachment", async () => {
    const attach = vi.fn<TestInfo["attach"]>().mockResolvedValue(undefined);
    const diagnostic = createReadinessFailureDiagnostic(
      { attach },
      "synthetic-readiness"
    );
    diagnostic.observe({
      dashboardReady: false,
      maintenance: { active: true, path: "private-path" },
      ingest: {
        complete: false,
        importParked: false,
        processed: 2,
        total: 80,
        sessionId: "private-id",
      },
      apiOrigin: "private-origin",
      token: "private-token",
    });
    await diagnostic.attach();
    const body = attach.mock.calls[0]?.[1]?.body;
    if (!Buffer.isBuffer(body)) {
      throw new Error("The diagnostic did not attach its bounded JSON buffer");
    }
    expect(JSON.parse(body.toString())).toEqual({
      observations: 1,
      validReport: true,
      readiness: {
        dashboardReady: false,
        maintenance: { active: true },
        ingest: {
          complete: false,
          importParked: false,
          processed: 2,
          total: 80,
        },
      },
    });
  });

  it("does not fabricate readiness from malformed reports or expose error payloads", async () => {
    const attach = vi.fn<TestInfo["attach"]>().mockResolvedValue(undefined);
    const diagnostic = createReadinessFailureDiagnostic(
      { attach },
      "invalid-readiness"
    );
    diagnostic.observe({ dashboardReady: "true", token: "private-token" });
    await diagnostic.attach();
    const body = attach.mock.calls[0]?.[1]?.body;
    if (!Buffer.isBuffer(body)) {
      throw new Error("The diagnostic did not attach its bounded JSON buffer");
    }
    expect(JSON.parse(body.toString())).toEqual({
      observations: 1,
      validReport: false,
      readiness: null,
    });
    expect(classifyDesktopPageError(new ReferenceError("private-token"))).toBe(
      "reference"
    );
    expect(
      classifyDesktopPageError({
        name: "private-name",
        message: "private-token",
      })
    ).toBe("unclassified");
  });
});

/** Exercise the real Playwright poller without real readiness-probe delays. */
async function pollImportPause(probe: () => Promise<boolean>): Promise<void> {
  await playwrightExpect.poll(probe, { intervals: [0], timeout: 0 }).toBe(true);
}
