import { describe, expect, it } from "vitest";
import {
  getPossibleGatewayHostnames,
  parseHealthPayload,
} from "../gateway-probe";

describe("getPossibleGatewayHostnames", () => {
  it("returns the expected probe ports", () => {
    const hostnames = getPossibleGatewayHostnames();
    expect(hostnames).toHaveLength(4);
    expect(hostnames[0]).toEqual({
      hostname: "http://localhost:19432",
      port: 19_432,
    });
    expect(hostnames[3]).toEqual({
      hostname: "http://localhost:19435",
      port: 19_435,
    });
  });
});

describe("parseHealthPayload", () => {
  it("parses a valid health payload", () => {
    const result = parseHealthPayload(
      {
        status: "ok",
        port: 19_432,
        version: "1.2.3",
        machineName: "test-machine",
        gatewayId: "gw-123",
        capabilities: { claude: true },
        onboardingCompleted: true,
      },
      19_432
    );

    expect(result).toEqual({
      detected: true,
      port: 19_432,
      version: "1.2.3",
      machineName: "test-machine",
      gatewayId: "gw-123",
      capabilities: { claude: true },
      onboardingCompleted: true,
    });
  });

  it("returns null for invalid status", () => {
    const result = parseHealthPayload({ status: "error" }, 19_432);
    expect(result).toBeNull();
  });

  it("returns null for non-object payload", () => {
    expect(parseHealthPayload(null, 19_432)).toBeNull();
    expect(parseHealthPayload("string", 19_432)).toBeNull();
    expect(parseHealthPayload(42, 19_432)).toBeNull();
  });

  it("uses fallback port when payload port is missing", () => {
    const result = parseHealthPayload({ status: "ok" }, 19_433);
    expect(result).toEqual({
      detected: true,
      port: 19_433,
      version: null,
      machineName: null,
      gatewayId: null,
      capabilities: {},
      onboardingCompleted: null,
    });
  });

  it("returns null when reported port mismatches fallback", () => {
    const result = parseHealthPayload({ status: "ok", port: 19_432 }, 19_433);
    expect(result).toBeNull();
  });

  it("normalizes empty gatewayId to null", () => {
    const result = parseHealthPayload(
      { status: "ok", gatewayId: "   " },
      19_432
    );
    expect(result?.gatewayId).toBeNull();
  });

  it("preserves optional fields with catch fallbacks", () => {
    const result = parseHealthPayload(
      {
        status: "ok",
        port: "not-a-number",
        version: 123,
        machineName: true,
      },
      19_432
    );

    // Invalid types should be caught and defaulted
    expect(result).toEqual({
      detected: true,
      port: 19_432,
      version: null,
      machineName: null,
      gatewayId: null,
      capabilities: {},
      onboardingCompleted: null,
    });
  });
});
