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

describe("desktop agent session relay/direct socket wiring", () => {
  it("wires the direct Socket.IO path through the shared handler with ack fallback", () => {
    expect(socketServerSource).toContain("DESKTOP_AGENT_SESSIONS_SOCKET_EVENT");
    expect(socketServerSource).toContain("handleDesktopAgentSessionsEvent(");
    expect(socketServerSource).toContain(
      "reason: DesktopAgentSessionsAckReason.ValidationFailed"
    );
  });

  it("wires relay socket events through the internal dispatcher and ack adapter", () => {
    expect(relayServerSource).toContain("DESKTOP_AGENT_SESSIONS_SOCKET_EVENT");
    expect(relayServerSource).toContain(
      "ack?.(toDesktopAgentSessionsAck(result.ack))"
    );
    expect(relaySocketEventSource).toContain(
      "case DESKTOP_AGENT_SESSIONS_SOCKET_EVENT:"
    );
  });
});
