import { describe, expect, it } from "vitest";
import {
  CloudSocketDegradedReason,
  CloudSocketError,
} from "../../../shared/cloud-socket-error";
import { CloudStatusKind, parseCloudStatus } from "../use-cloud-status";

describe("parseCloudStatus", () => {
  it("preserves known cloud socket states", () => {
    expect(parseCloudStatus({ cloudStatus: { state: "idle" } })).toEqual({
      kind: CloudStatusKind.Idle,
    });
    expect(
      parseCloudStatus({
        cloudStatus: { state: "online", targetId: "target-1" },
      })
    ).toEqual({ kind: CloudStatusKind.Online });
    expect(
      parseCloudStatus({
        cloudStatus: { error: "API key unavailable", state: "degraded" },
      })
    ).toEqual({
      error: "API key unavailable",
      kind: CloudStatusKind.Degraded,
    });
  });

  it("degrades absent older payload fields to unavailable", () => {
    expect(parseCloudStatus(null)).toBeNull();
    expect(parseCloudStatus({})).toBeNull();
    expect(parseCloudStatus({ cloudStatus: null })).toBeNull();
  });

  it("maps malformed or future states to unknown", () => {
    expect(parseCloudStatus({ cloudStatus: "online" })).toEqual({
      kind: CloudStatusKind.Unknown,
    });
    expect(parseCloudStatus({ cloudStatus: { state: "connecting" } })).toEqual({
      kind: CloudStatusKind.Unknown,
    });
  });

  it("preserves the decrypt-failure reason distinctly from a missing key", () => {
    expect(
      parseCloudStatus({
        cloudStatus: {
          error: CloudSocketError.DecryptionFailed,
          state: "degraded",
        },
      })
    ).toEqual({
      error: CloudSocketError.DecryptionFailed,
      kind: CloudStatusKind.Degraded,
    });
  });

  it("supplies a visible reason for malformed degraded errors", () => {
    expect(
      parseCloudStatus({ cloudStatus: { error: " ", state: "degraded" } })
    ).toEqual({
      error: "Cloud connection failed",
      kind: CloudStatusKind.Degraded,
    });
  });

  it("ISS-11843: keeps a known degraded reason and drops an unknown one", () => {
    expect(
      parseCloudStatus({
        cloudStatus: {
          error: CloudSocketError.HandshakeRefused,
          reason: CloudSocketDegradedReason.HandshakeRefused,
          state: "degraded",
        },
      })
    ).toEqual({
      error: CloudSocketError.HandshakeRefused,
      kind: CloudStatusKind.Degraded,
      reason: CloudSocketDegradedReason.HandshakeRefused,
    });
    expect(
      parseCloudStatus({
        cloudStatus: {
          error: "Cloud socket disconnected",
          reason: "from_a_newer_build",
          state: "degraded",
        },
      })
    ).toEqual({
      error: "Cloud socket disconnected",
      kind: CloudStatusKind.Degraded,
    });
  });
});
