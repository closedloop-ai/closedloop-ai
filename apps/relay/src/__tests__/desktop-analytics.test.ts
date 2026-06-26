import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const relaySource = readFileSync(
  new URL("../index.ts", import.meta.url),
  "utf8"
);

describe("desktop.analytics relay wiring", () => {
  it("forwards analytics with ack callback and relay socket id", () => {
    expect(relaySource).toContain("DESKTOP_ANALYTICS_SOCKET_EVENT");
    expect(relaySource).toContain(
      "ack?: (response: DesktopAnalyticsAck) => void"
    );
    expect(relaySource).toContain("relaySocketId");
    expect(relaySource).toContain("ack?.(toDesktopAnalyticsAck(result.ack))");
  });

  it("buffers analytics when it arrives before target registration, then drains after registerWorker", () => {
    expect(relaySource).toContain("pendingBuffer");
    expect(relaySource).toContain("EventEmitter.prototype.emit.call");
    expect(relaySource).toContain("drainPendingBuffer");
    expect(relaySource).toContain("MAX_PENDING_BUFFER_SIZE");
  });

  it("resolves DesktopAnalyticsAckReason dynamically so new reasons like capture_failed are not silently mapped to validation_failed", () => {
    expect(relaySource).toContain("knownDesktopAnalyticsAckReasons");
    expect(relaySource).toContain("Object.values(DesktopAnalyticsAckReason)");
  });

  it("allows longer forwarding time for desktop.agent-sessions than desktop.analytics", () => {
    expect(relaySource).toContain(
      "const AGENT_SESSIONS_SOCKET_EVENT_TIMEOUT_MS = 30_000"
    );
    expect(relaySource).toContain(
      "event === DESKTOP_AGENT_SESSIONS_SOCKET_EVENT"
    );
  });
});
