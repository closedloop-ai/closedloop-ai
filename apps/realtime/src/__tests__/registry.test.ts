import { GrantAccess } from "@repo/realtime-contract/grants";
import { describe, expect, it } from "vitest";
import {
  connectionLimitsAcrossClasses,
  DELIVERY_CLASSES,
  DeliveryClass,
  maxPacketBytesAcrossClasses,
} from "../classes/registry";

describe("the signal class", () => {
  const signal = DELIVERY_CLASSES[DeliveryClass.Signal];

  it("needs read access to subscribe, and only the server publishes", () => {
    expect(signal.subscribeAccess).toBe(GrantAccess.Read);
    expect(signal.clientPublish).toBe(false);
    expect(signal.serverPublish).toBe(true);
  });

  it("records its limits, and the connection-wide limits take the largest", () => {
    expect(signal.limits).toEqual({
      maxPacketBytes: 16 * 1024,
      maxChannelsPerConnection: 100,
      messageRate: { burst: 120, refillPerSecond: 10 },
      flood: { maxRefusals: 100, windowMs: 10_000 },
      maxBufferedPackets: 1000,
    });
    expect(maxPacketBytesAcrossClasses()).toBe(signal.limits.maxPacketBytes);
    expect(connectionLimitsAcrossClasses()).toEqual({
      messageRate: signal.limits.messageRate,
      flood: signal.limits.flood,
      maxBufferedPackets: signal.limits.maxBufferedPackets,
    });
  });

  it("lets a reconnect rejoin every channel inside one burst", () => {
    expect(signal.limits.messageRate.burst).toBeGreaterThan(
      signal.limits.maxChannelsPerConnection
    );
  });
});
