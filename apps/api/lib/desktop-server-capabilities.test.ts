import { describe, expect, it } from "vitest";
import { buildDesktopServerCapabilities } from "./desktop-server-capabilities";

describe("buildDesktopServerCapabilities", () => {
  it("returns undefined when nothing is supported", () => {
    expect(
      buildDesktopServerCapabilities({
        agentSessionSyncSupported: false,
        commandSigningSupported: false,
      })
    ).toBeUndefined();
  });

  it("advertises every additive payload capability with the sync lane", () => {
    expect(
      buildDesktopServerCapabilities({
        agentSessionSyncSupported: true,
        commandSigningSupported: false,
      })
    ).toEqual({
      agentSessionSync: true,
      agentSessionSyncCompression: true,
      agentSessionSyncActivityChunking: true,
      agentSessionSyncMonitoredActivity: true,
    });
  });

  it("does not advertise sync payload capabilities for command-signing alone", () => {
    expect(
      buildDesktopServerCapabilities({
        agentSessionSyncSupported: false,
        commandSigningSupported: true,
      })
    ).toEqual({ computeTargetSigning: true });
  });
});
