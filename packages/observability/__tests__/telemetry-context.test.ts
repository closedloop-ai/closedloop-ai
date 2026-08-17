import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTelemetryTraceContext,
  resolveGitSha,
  resolveServerVersion,
  ZERO_GATEWAY_SESSION_ID,
} from "../telemetry/context";
import { deleteEnvForTest } from "./test-helpers";

const VERSION_ENV_KEYS = [
  "RELEASE_VERSION",
  "npm_package_version",
  "VERCEL_GIT_COMMIT_SHA",
  "GIT_SHA",
] as const;
const ENVIRONMENT_KEYS = [
  "NODE_ENV",
  "RELAY_ENV",
  "CLOSEDLOOP_ENVIRONMENT",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveServerVersion", () => {
  it("uses the first valid build identity", () => {
    vi.stubEnv("RELEASE_VERSION", "1.2.3");
    vi.stubEnv("npm_package_version", "2.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");

    expect(resolveServerVersion()).toBe("1.2.3");
  });

  it("skips malformed identities and falls back through package version to Vercel SHA", () => {
    vi.stubEnv("RELEASE_VERSION", "bad version / path");
    vi.stubEnv("npm_package_version", "2.4.1");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    expect(resolveServerVersion()).toBe("2.4.1");

    vi.stubEnv("npm_package_version", "also bad / path");
    expect(resolveServerVersion()).toBe("abc123");
  });

  it("returns unknown when no valid build identity exists", () => {
    deleteEnvForTest(...VERSION_ENV_KEYS);

    expect(resolveServerVersion()).toBe("unknown");
    expect(resolveGitSha()).toBe("unknown");
  });

  it("prefers the Vercel SHA over the generic Git SHA", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "vercel123");
    vi.stubEnv("GIT_SHA", "git456");

    expect(resolveGitSha()).toBe("vercel123");
  });
});

describe("buildTelemetryTraceContext", () => {
  it("supplies truthful defaults without adding optional fields", () => {
    deleteEnvForTest(...VERSION_ENV_KEYS, ...ENVIRONMENT_KEYS);

    expect(buildTelemetryTraceContext({})).toEqual({
      commandId: "",
      operationId: "",
      computeTargetId: "",
      gatewaySessionId: ZERO_GATEWAY_SESSION_ID,
      schemaVersion: "1",
      environment: "unknown",
      serverVersion: "unknown",
    });
  });

  it.each([
    ["NODE_ENV", "test"],
    ["RELAY_ENV", "relay"],
    ["CLOSEDLOOP_ENVIRONMENT", "staging"],
  ])("resolves environment from %s", (key, value) => {
    deleteEnvForTest(...ENVIRONMENT_KEYS);
    vi.stubEnv(key, value);

    expect(buildTelemetryTraceContext({}).environment).toBe(value);
  });

  it("keeps explicit values and includes every supplied optional field", () => {
    expect(
      buildTelemetryTraceContext({
        commandId: "command",
        operationId: "operation",
        computeTargetId: "target",
        gatewaySessionId: "gateway-session",
        schemaVersion: "2",
        environment: "preview",
        serverVersion: "1.2.3-beta.1",
        loopSessionId: "loop-session",
        loopId: "loop",
        jobId: "job",
        requestId: "request",
        pluginVersion: "3.0.0",
        desktopClientVersion: "4.0.0",
        gatewayProtocolVersion: "5",
      })
    ).toEqual({
      commandId: "command",
      operationId: "operation",
      computeTargetId: "target",
      gatewaySessionId: "gateway-session",
      schemaVersion: "2",
      environment: "preview",
      serverVersion: "1.2.3-beta.1",
      loopSessionId: "loop-session",
      loopId: "loop",
      jobId: "job",
      requestId: "request",
      pluginVersion: "3.0.0",
      desktopClientVersion: "4.0.0",
      gatewayProtocolVersion: "5",
    });
  });

  it("replaces an invalid explicit version with unknown", () => {
    expect(
      buildTelemetryTraceContext({ serverVersion: "../../unsafe version" })
        .serverVersion
    ).toBe("unknown");
  });
});
