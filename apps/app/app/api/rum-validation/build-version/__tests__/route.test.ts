import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "NEXT_PUBLIC_DATADOG_RUM_BUILD_VERSION",
  "NEXT_PUBLIC_DATADOG_RUM_VERSION",
] as const;

const originalEnv = new Map<string, string | undefined>();

describe("GET /api/rum-validation/build-version", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      Reflect.deleteProperty(process.env, key);
    }
  });

  afterEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = original;
      }
    }
    originalEnv.clear();
  });

  it("returns 404 when the RUM validation route is disabled", async () => {
    vi.doMock("@/env", () => ({
      env: { RUM_VALIDATION_ROUTE_ENABLED: undefined },
    }));

    const { GET } = await import("../route");

    expect(GET().status).toBe(404);
  });

  it("returns the Datadog RUM build version when validation is enabled", async () => {
    process.env.NEXT_PUBLIC_DATADOG_RUM_BUILD_VERSION = "preview-head-sha";
    vi.doMock("@/env", () => ({
      env: { RUM_VALIDATION_ROUTE_ENABLED: "true" },
    }));

    const { GET } = await import("../route");
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      datadogRumVersion: "preview-head-sha",
    });
  });
});
