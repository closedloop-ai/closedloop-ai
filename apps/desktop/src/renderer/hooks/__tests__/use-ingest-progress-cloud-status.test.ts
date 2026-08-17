import { describe, expect, it } from "vitest";
import { CloudSocketError } from "../../../shared/cloud-socket-error";
import { CloudStatusKind, parseCloudStatus } from "../use-ingest-progress";

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
});
