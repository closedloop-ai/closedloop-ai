import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureElectronDetection,
  getElectronDetectionSnapshot,
  resetElectronDetectionForTests,
} from "@/lib/engineer/electron-detection";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROBE_PORTS = [19_432, 19_433, 19_434, 19_435] as const;

function makeHealthPayload(port: number, overrides?: Record<string, unknown>) {
  return {
    status: "ok",
    port,
    version: "1.2.3",
    machineName: "test-machine",
    capabilities: { git: true },
    ...overrides,
  };
}

function makeOkResponse(port: number, overrides?: Record<string, unknown>) {
  const payload = makeHealthPayload(port, overrides);
  return {
    ok: true,
    json: () => Promise.resolve(payload),
  } as unknown as Response;
}

function makeNetworkError() {
  return Promise.reject(new TypeError("fetch failed"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tier1-port-discovery: electron-detection port scanning", () => {
  beforeEach(() => {
    resetElectronDetectionForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("probes ports in the expected order [19432, 19433, 19434, 19435]", async () => {
    const probedUrls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        probedUrls.push(url);
        return makeNetworkError();
      })
    );

    await ensureElectronDetection();

    expect(probedUrls).toEqual([
      "http://localhost:19432/health",
      "http://localhost:19433/health",
      "http://localhost:19434/health",
      "http://localhost:19435/health",
    ]);
  });

  it("falls back to the next port when the first port fails", async () => {
    const targetPort = PROBE_PORTS[1];

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === `http://localhost:${PROBE_PORTS[0]}/health`) {
          return makeNetworkError();
        }
        if (url === `http://localhost:${targetPort}/health`) {
          return Promise.resolve(makeOkResponse(targetPort));
        }
        return makeNetworkError();
      })
    );

    const result = await ensureElectronDetection();

    expect(result.detected).toBe(true);
    expect(result.port).toBe(targetPort);
  });

  it("caches a successful detection result and does not re-probe on second call", async () => {
    const firstPort = PROBE_PORTS[0];
    const mockFetch = vi.fn((url: string) => {
      if (url === `http://localhost:${firstPort}/health`) {
        return Promise.resolve(makeOkResponse(firstPort));
      }
      return makeNetworkError();
    });

    vi.stubGlobal("fetch", mockFetch);

    const firstResult = await ensureElectronDetection();
    const secondResult = await ensureElectronDetection();

    // fetch should only have been called once — cache is still valid
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(firstResult).toBe(secondResult);
    expect(secondResult.detected).toBe(true);
    expect(secondResult.port).toBe(firstPort);
  });

  it("returns detected: false and port: null when all ports fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => makeNetworkError())
    );

    const result = await ensureElectronDetection();

    expect(result.detected).toBe(false);
    expect(result.port).toBeNull();
    expect(result.loading).toBe(false);
  });

  it("validates /health endpoint response shape: status, port, version, machineName, capabilities", async () => {
    const port = PROBE_PORTS[0];

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          makeOkResponse(port, {
            version: "2.0.0",
            machineName: "my-dev-box",
            capabilities: { git: true, docker: false },
          })
        )
      )
    );

    const result = await ensureElectronDetection();

    expect(result.detected).toBe(true);
    expect(result.port).toBe(port);
    expect(result.version).toBe("2.0.0");
    expect(result.machineName).toBe("my-dev-box");
    expect(result.capabilities).toEqual({ git: true, docker: false });
    expect(result.loading).toBe(false);
    expect(typeof result.checkedAt).toBe("number");
  });

  it("skips a port whose response body is missing status: ok", async () => {
    const goodPort = PROBE_PORTS[1];

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === `http://localhost:${PROBE_PORTS[0]}/health`) {
          // ok HTTP status but invalid body shape
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ status: "degraded", port: PROBE_PORTS[0] }),
          } as unknown as Response);
        }
        if (url === `http://localhost:${goodPort}/health`) {
          return Promise.resolve(makeOkResponse(goodPort));
        }
        return makeNetworkError();
      })
    );

    const result = await ensureElectronDetection();

    expect(result.detected).toBe(true);
    expect(result.port).toBe(goodPort);
  });

  it("skips a port whose reported port does not match the probed port", async () => {
    const goodPort = PROBE_PORTS[2];

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === `http://localhost:${PROBE_PORTS[0]}/health`) {
          // returns a port mismatch — should be skipped
          return Promise.resolve(makeOkResponse(PROBE_PORTS[1]));
        }
        if (url === `http://localhost:${PROBE_PORTS[1]}/health`) {
          return makeNetworkError();
        }
        if (url === `http://localhost:${goodPort}/health`) {
          return Promise.resolve(makeOkResponse(goodPort));
        }
        return makeNetworkError();
      })
    );

    const result = await ensureElectronDetection();

    expect(result.detected).toBe(true);
    expect(result.port).toBe(goodPort);
  });

  it("resetElectronDetectionForTests clears cached state between tests", async () => {
    const port = PROBE_PORTS[0];
    const mockFetch = vi.fn(() => Promise.resolve(makeOkResponse(port)));

    vi.stubGlobal("fetch", mockFetch);

    // First detection — populates cache
    await ensureElectronDetection();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Reset clears cache
    resetElectronDetectionForTests();

    // Second detection — cache was cleared, should re-probe
    await ensureElectronDetection();
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const snap = getElectronDetectionSnapshot();
    expect(snap.detected).toBe(true);
  });
});
