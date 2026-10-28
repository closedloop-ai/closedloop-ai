import { describe, expect, it } from "vitest";
import { buildDesktopServerCapabilities } from "./desktop-server-capabilities";

describe("buildDesktopServerCapabilities", () => {
  // ISS-8022: the whole `agentSessionSync*` group is a server-version
  // capability now — this build ships the ingest lane, so it always says so.
  // There is no longer an input that can withhold it, which is why the former
  // "returns undefined when nothing is supported" and "does not advertise sync
  // payload capabilities for command-signing alone" cases are gone rather than
  // rewritten: both asserted a shape only the retired PostHog flag could produce.
  it("advertises every additive sync payload capability", () => {
    expect(
      buildDesktopServerCapabilities({ commandSigningSupported: false })
    ).toEqual({
      agentSessionSync: true,
      agentSessionSyncCompression: true,
      agentSessionSyncActivityChunking: true,
      // ISS-9859: the desktop splits `prRefs` across parts ONLY under this flag,
      // because an older server replaces the links with each part's slice. Its
      // presence here is what turns that pagination on, so the exhaustive shape
      // is load-bearing rather than bookkeeping.
      agentSessionSyncPrRefChunking: true,
      agentSessionSyncMonitoredActivity: true,
      // ISS-5850: this build's `sessionSpanSchema` persists the span extent
      // rather than stripping it. Its ABSENCE is what an older server tells a
      // desktop, and what keeps that desktop from stamping the extent-bearing
      // cursor revision — so the exhaustive shape here is load-bearing, not
      // bookkeeping.
      agentSessionSyncSpanExtent: true,
      // ISS-7896: same contract, one rung up — this build's persist boundary
      // preserves `metadata.humanTurnTimestamps` whole instead of capping it at
      // the generic 100-item array bound. An older server's silence is what
      // keeps a desktop from stamping the human-turn revision over a truncated
      // array the cloud would then read as authoritative.
      agentSessionSyncHumanTurnTimestamps: true,
      agentSessionSyncAgentTurnTimestamps: true,
      agentSessionSyncTokenEventOwner: true,
    });
  });

  it("adds command signing on top when the signing flag is eligible", () => {
    expect(
      buildDesktopServerCapabilities({ commandSigningSupported: true })
    ).toEqual({
      computeTargetSigning: true,
      agentSessionSync: true,
      agentSessionSyncCompression: true,
      agentSessionSyncActivityChunking: true,
      // ISS-9859: the desktop splits `prRefs` across parts ONLY under this flag,
      // because an older server replaces the links with each part's slice. Its
      // presence here is what turns that pagination on, so the exhaustive shape
      // is load-bearing rather than bookkeeping.
      agentSessionSyncPrRefChunking: true,
      agentSessionSyncMonitoredActivity: true,
      agentSessionSyncSpanExtent: true,
      agentSessionSyncHumanTurnTimestamps: true,
      agentSessionSyncAgentTurnTimestamps: true,
      agentSessionSyncTokenEventOwner: true,
    });
  });
});
