import { describe, expect, it } from "vitest";
import { parseHelloPayload } from "@/lib/desktop-gateway-wire";

describe("parseHelloPayload", () => {
  const legacyHello = {
    machineName: "dev-machine",
    platform: "darwin",
    pluginVersion: "0.1.0",
    supportedOperations: ["symphony_loop"],
    maxInFlightCommands: 4,
  };

  it("keeps legacy Desktop hello payloads backward compatible", () => {
    expect(parseHelloPayload(legacyHello)).toMatchObject({
      machineName: "dev-machine",
      gatewayId: undefined,
      desktopSecurityUpgradeProtocolVersion: undefined,
    });
  });

  it("preserves valid PLN-359 gateway metadata", () => {
    expect(
      parseHelloPayload({
        ...legacyHello,
        gatewayId: "550e8400-e29b-41d4-a716-446655440000",
        desktopSecurityUpgradeProtocolVersion: 1,
      })
    ).toMatchObject({
      gatewayId: "550e8400-e29b-41d4-a716-446655440000",
      desktopSecurityUpgradeProtocolVersion: 1,
    });
  });

  it("preserves string gateway IDs without format validation", () => {
    expect(
      parseHelloPayload({
        ...legacyHello,
        gatewayId: "not-a-uuid",
        desktopSecurityUpgradeProtocolVersion: 99,
      })
    ).toMatchObject({
      gatewayId: "not-a-uuid",
      desktopSecurityUpgradeProtocolVersion: undefined,
    });
  });
});
