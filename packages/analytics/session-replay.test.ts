import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsClient } from "./client";
import { startWebSessionReplay, stopWebSessionReplay } from "./session-replay";

const client = {
  identify: vi.fn(),
  capture: vi.fn(),
  reset: vi.fn(),
  setPersonProperties: vi.fn(),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
  set_config: vi.fn(),
} satisfies AnalyticsClient;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("web session replay start/stop (ISS-12558)", () => {
  it("starts replay with dead-click capture", () => {
    startWebSessionReplay(client);

    expect(client.startSessionRecording).toHaveBeenCalledTimes(1);
    expect(client.set_config).toHaveBeenCalledWith({
      capture_dead_clicks: true,
    });
  });

  it("stops replay and dead-click capture", () => {
    stopWebSessionReplay(client);

    expect(client.stopSessionRecording).toHaveBeenCalledTimes(1);
    expect(client.set_config).toHaveBeenCalledWith({
      capture_dead_clicks: false,
    });
  });

  it("keeps a PostHog failure from reaching the caller", () => {
    client.startSessionRecording.mockImplementation(() => {
      throw new Error("posthog unavailable");
    });
    client.stopSessionRecording.mockImplementation(() => {
      throw new Error("posthog unavailable");
    });

    expect(() => startWebSessionReplay(client)).not.toThrow();
    expect(() => stopWebSessionReplay(client)).not.toThrow();
  });
});
