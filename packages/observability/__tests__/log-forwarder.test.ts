// ISS-11827. DD_LOGS_FORWARDER_URL sends the intake batches to a loopback
// forwarder (the realtime task's collector sidecar), which adds the Datadog key
// itself, so the app container holds none.

import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteEnvForTest, importModuleWithFetch } from "./test-helpers";

const FORWARDER_URL = "http://localhost:6060";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function importLogModule(fetchMock: ReturnType<typeof vi.fn>) {
  return importModuleWithFetch(fetchMock, () => import("../log"));
}

describe("DD_LOGS_FORWARDER_URL", () => {
  it("ships the intake batch to a loopback forwarder with no key", async () => {
    deleteEnvForTest("DD_API_KEY");
    vi.stubEnv("DD_LOGS_FORWARDER_URL", FORWARDER_URL);

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const { log, isLogExportOpen } = await importLogModule(fetchMock);

    log.info("via.forwarder");
    await log.flush();

    expect(isLogExportOpen()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:6060/api/v2/logs");
    expect(init.headers).toStrictEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toContainEqual(
      expect.objectContaining({ message: "via.forwarder" })
    );
  });

  it("prefers the forwarder to a key in the environment and never sends the key", async () => {
    vi.stubEnv("DD_API_KEY", "dd-api-key-value");
    vi.stubEnv("DD_LOGS_FORWARDER_URL", FORWARDER_URL);

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const { log } = await importLogModule(fetchMock);

    log.info("via.forwarder");
    await log.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:6060/api/v2/logs");
    expect(init.headers).toStrictEqual({ "Content-Type": "application/json" });
  });

  it("closes the sink for a forwarder that is not loopback, key or no key", async () => {
    vi.stubEnv("DD_API_KEY", "dd-api-key-value");
    vi.stubEnv("DD_LOGS_FORWARDER_URL", "http://collector.example:6060");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // the refusal under assertion
    });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const { log, isLogExportOpen } = await importLogModule(fetchMock);

    log.info("must.not.egress");
    await log.flush();

    expect(isLogExportOpen()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("DD_LOGS_FORWARDER_URL")
    );
  });

  it("stays closed under DD_LOGS_DISABLED", async () => {
    deleteEnvForTest("DD_API_KEY");
    vi.stubEnv("DD_LOGS_FORWARDER_URL", FORWARDER_URL);
    vi.stubEnv("DD_LOGS_DISABLED", "1");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const { log, isLogExportOpen } = await importLogModule(fetchMock);

    log.info("export.disabled");
    await log.flush();

    expect(isLogExportOpen()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports no export path with neither a key nor a forwarder", async () => {
    deleteEnvForTest("DD_API_KEY", "DD_LOGS_FORWARDER_URL");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const { isLogExportOpen } = await importLogModule(fetchMock);

    expect(isLogExportOpen()).toBe(false);
  });
});
