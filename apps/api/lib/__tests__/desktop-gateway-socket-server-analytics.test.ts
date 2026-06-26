import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const socketServerSource = readFileSync(
  new URL("../desktop-gateway-socket-server.ts", import.meta.url),
  "utf8"
);
const relayServerSource = readFileSync(
  new URL("../../../relay/src/index.ts", import.meta.url),
  "utf8"
);
const relaySocketEventSource = readFileSync(
  new URL("../../app/internal/relay/socket-event/service.ts", import.meta.url),
  "utf8"
);
const directAnalyticsListenerPattern =
  /socket\.on\(\s*DESKTOP_ANALYTICS_SOCKET_EVENT\s*,/;
const directAnalyticsHandlerPattern =
  /handleDesktopAnalyticsEvent\(\s*rawPayload\s*,/;

describe("desktop analytics relay/direct socket wiring", () => {
  it("wires direct Socket.IO analytics through the shared handler with ack fallback", () => {
    expect(socketServerSource).toMatch(directAnalyticsListenerPattern);
    expect(socketServerSource).toMatch(directAnalyticsHandlerPattern);
    expect(socketServerSource).toContain(
      "reason: DesktopAnalyticsAckReason.ValidationFailed"
    );
  });

  it("wires relay analytics through the internal socket-event service with socket id", () => {
    expect(relayServerSource).toContain("DESKTOP_ANALYTICS_SOCKET_EVENT,");
    expect(relayServerSource).toContain("relaySocketId");
    expect(relayServerSource).toContain(
      "ack?.(toDesktopAnalyticsAck(result.ack))"
    );
    expect(relaySocketEventSource).toContain(
      "case DESKTOP_ANALYTICS_SOCKET_EVENT:"
    );
  });
});
