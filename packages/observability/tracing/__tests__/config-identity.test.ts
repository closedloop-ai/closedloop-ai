import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteEnvForTest } from "../../__tests__/test-helpers";
import { resolveTracingConfig, TracingDisabledReason } from "../config";
import { stubEnabledTracingEnv } from "./tracing-env";

// The Datadog identity half of resolveTracingConfig: service/env defaults on
// the keys() path, and the raw process.env fallback when keys() throws (the
// standalone relay, a container, a test worker outside Next.js).

const keysMode = vi.hoisted(() => ({ throws: false, returns: 0 }));

vi.mock("../../keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../keys")>();
  return {
    keys: () => {
      if (keysMode.throws) {
        throw new Error("keys() is unavailable outside Next.js");
      }
      const resolved = actual.keys();
      keysMode.returns += 1;
      return resolved;
    },
  };
});

beforeEach(() => {
  stubEnabledTracingEnv();
  deleteEnvForTest("DD_SERVICE", "DD_ENV", "NODE_ENV");
});

afterEach(() => {
  keysMode.throws = false;
  keysMode.returns = 0;
  vi.unstubAllEnvs();
});

function enabledIdentity(): { service: string; env: string } {
  const config = resolveTracingConfig();
  if (!config.enabled) {
    throw new Error(`expected tracing enabled, got ${config.reason}`);
  }
  return { service: config.service, env: config.env };
}

describe.each([
  ["keys()", false, 1],
  ["raw process.env fallback", true, 0],
])("resolveTracingConfig identity via %s", (_label, throws, keysReturns) => {
  beforeEach(() => {
    keysMode.throws = throws;
  });

  it("uses DD_SERVICE and DD_ENV when both are set", () => {
    vi.stubEnv("DD_SERVICE", "cl-api");
    vi.stubEnv("DD_ENV", "stage");
    vi.stubEnv("NODE_ENV", "production");

    expect(enabledIdentity()).toEqual({ service: "cl-api", env: "stage" });
    expect(keysMode.returns).toBe(keysReturns);
  });

  it("falls back to NODE_ENV when DD_ENV is unset", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(enabledIdentity()).toEqual({
      service: "cl-unknown",
      env: "production",
    });
  });

  it("defaults service to cl-unknown and env to development when all are unset", () => {
    expect(enabledIdentity()).toEqual({
      service: "cl-unknown",
      env: "development",
    });
  });

  it("reports MissingApiKey when DD_API_KEY is unset", () => {
    deleteEnvForTest("DD_API_KEY");

    expect(resolveTracingConfig()).toEqual({
      enabled: false,
      reason: TracingDisabledReason.MissingApiKey,
    });
  });
});

describe("resolveTracingConfig identity fallback", () => {
  it("treats an empty DD_SERVICE as unset", () => {
    keysMode.throws = true;
    vi.stubEnv("DD_SERVICE", "");

    expect(enabledIdentity().service).toBe("cl-unknown");
  });
});
