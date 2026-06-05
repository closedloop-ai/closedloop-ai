import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureElectronDetection,
  resetElectronDetectionForTests,
} from "@/lib/engineer/electron-detection";

describe("electron-detection", () => {
  beforeEach(() => {
    resetElectronDetectionForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetElectronDetectionForTests();
    vi.restoreAllMocks();
  });

  it("probes fallback ports in order and caches successful result", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => {
        throw new TypeError("connect ECONNREFUSED");
      })
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "ok",
            machineName: "Daniel-MBP",
            capabilities: { streaming: true },
            version: "1.2.3",
            port: 19_433,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

    const first = await ensureElectronDetection();
    const second = await ensureElectronDetection();

    expect(first.detected).toBe(true);
    expect(first.port).toBe(19_433);
    expect(first.version).toBe("1.2.3");
    expect(first.machineName).toBe("Daniel-MBP");
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:19432/health");
    expect(fetchMock.mock.calls[1][0]).toBe("http://localhost:19433/health");
  });

  it("falls through to non-electron mode when no probe succeeds", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new TypeError("network error");
    });

    const result = await ensureElectronDetection();

    expect(result.detected).toBe(false);
    expect(result.port).toBeNull();
    expect(result.loading).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
