import { describe, expect, it } from "vitest";
import {
  isTranscriptBlobBehind,
  reconcileCloudSyncState,
} from "./agent-session-cloud-sync-reconcile.ts";
import { AgentSessionCloudSyncState } from "./agent-session-cloud-sync-state-constants.ts";
import { TranscriptDisposition } from "./transcript-disposition-constants.ts";

describe("cloud sync reconciliation", () => {
  it.each([
    TranscriptDisposition.Syncing,
    TranscriptDisposition.FailedTransient,
  ])("marks %s as pending while the transcript blob is still coming", (value) => {
    expect(isTranscriptBlobBehind(value)).toBe(true);
    expect(reconcileCloudSyncState(value)).toBe(
      AgentSessionCloudSyncState.Pending
    );
  });

  it.each([
    TranscriptDisposition.Synced,
    TranscriptDisposition.Stale,
    TranscriptDisposition.FailedPermanent,
    TranscriptDisposition.NeverExpected,
  ])("marks settled disposition %s as synced", (value) => {
    expect(isTranscriptBlobBehind(value)).toBe(false);
    expect(reconcileCloudSyncState(value)).toBe(
      AgentSessionCloudSyncState.Synced
    );
  });

  it("keeps the synced default when no transcript verdict is available", () => {
    expect(reconcileCloudSyncState(undefined)).toBe(
      AgentSessionCloudSyncState.Synced
    );
  });

  it("degrades an unknown version-skewed disposition to settled", () => {
    const unknownDisposition = "futureDisposition" as TranscriptDisposition;

    expect(isTranscriptBlobBehind(unknownDisposition)).toBe(false);
    expect(reconcileCloudSyncState(unknownDisposition)).toBe(
      AgentSessionCloudSyncState.Synced
    );
  });
});
