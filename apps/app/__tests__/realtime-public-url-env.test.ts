// @vitest-environment node

/**
 * ISS-11210 requirement 11: REALTIME_PUBLIC_URL, the socket URL whose origin
 * joins the web CSP's connect-src. Driven through the real schema, with
 * SKIP_ENV_VALIDATION cleared, because under it `createEnv` validates nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "REALTIME_PUBLIC_URL";
const SKIP_KEY = "SKIP_ENV_VALIDATION";
const MANAGED_KEYS = [KEY, SKIP_KEY] as const;
const INVALID_ENVIRONMENT_VARIABLES = /Invalid environment variables/;

let originalValues: ReadonlyMap<string, string | undefined>;

describe("REALTIME_PUBLIC_URL in apps/app's env schema", () => {
  beforeEach(() => {
    originalValues = new Map(
      MANAGED_KEYS.map((key) => [key, process.env[key]])
    );
    Reflect.deleteProperty(process.env, SKIP_KEY);
  });

  afterEach(() => {
    for (const [key, value] of originalValues) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  it("accepts a wss:// URL", async () => {
    await expect(loadEnv("wss://realtime.closedloop.ai")).resolves.toEqual(
      "wss://realtime.closedloop.ai"
    );
  });

  it("reads a URL with a path as its origin", async () => {
    await expect(
      loadEnv("wss://realtime.closedloop.ai/realtime")
    ).resolves.toEqual("wss://realtime.closedloop.ai");
  });

  it("is optional: unset leaves it undefined", async () => {
    await expect(loadEnv(undefined)).resolves.toBeUndefined();
  });

  it("refuses an https:// URL, which a socket origin in connect-src cannot be", async () => {
    await expect(loadEnv("https://realtime.closedloop.ai")).rejects.toThrow(
      INVALID_ENVIRONMENT_VARIABLES
    );
  });
});

async function loadEnv(value: string | undefined): Promise<string | undefined> {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, KEY);
  } else {
    process.env[KEY] = value;
  }
  vi.resetModules();
  const module = await import("@/env");
  return module.env.REALTIME_PUBLIC_URL;
}
