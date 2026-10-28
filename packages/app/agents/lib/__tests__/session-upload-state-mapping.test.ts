import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { SessionUploadState } from "@repo/app/shared/lib/upload-state";
import { describe, expect, it } from "vitest";
import { resolveSessionUploadState } from "../session-sync-presentation";

// ISS-12532 (PR #8843 review): the ONE written-down mapping from a session's
// shipped cloudSyncState to its upload state. The transcript-pending,
// dead_letter, and abandoned cases follow Marisol's answer on ISS-12532
// (2026-10-16, thread th_eRu7OSWbU_aZRlpOBd4rQ). Only an absent state stays
// unmapped (null).
describe("resolveSessionUploadState (ISS-12532)", () => {
  it("maps synced to shared", () => {
    expect(
      resolveSessionUploadState({
        cloudSyncState: AgentSessionCloudSyncState.Synced,
      })
    ).toBe(SessionUploadState.Shared);
  });

  it("maps a whole session still in the outbox to uploading", () => {
    expect(
      resolveSessionUploadState({
        cloudSyncState: AgentSessionCloudSyncState.Pending,
      })
    ).toBe(SessionUploadState.Uploading);
  });

  // Paused is not a disposition of its own: ISS-9884 reports it as
  // failedTransient plus a skip reason, so every verdict is covered here.
  it.each(Object.values(TranscriptDisposition))(
    "maps pending with transcript disposition %s to uploading",
    (transcriptDisposition) => {
      expect(
        resolveSessionUploadState({
          cloudSyncState: AgentSessionCloudSyncState.Pending,
          transcriptDisposition,
        })
      ).toBe(SessionUploadState.Uploading);
    }
  );

  it("maps dead_letter to failed", () => {
    expect(
      resolveSessionUploadState({
        cloudSyncState: AgentSessionCloudSyncState.DeadLetter,
      })
    ).toBe(SessionUploadState.Failed);
  });

  it("maps abandoned to failed", () => {
    expect(
      resolveSessionUploadState({
        cloudSyncState: AgentSessionCloudSyncState.Abandoned,
      })
    ).toBe(SessionUploadState.Failed);
  });

  it("leaves an absent state unmapped (no badge)", () => {
    expect(resolveSessionUploadState({})).toBeNull();
  });

  it("never maps anything to local-only", () => {
    const mapped = [
      undefined,
      ...Object.values(AgentSessionCloudSyncState),
    ].map((cloudSyncState) => resolveSessionUploadState({ cloudSyncState }));
    expect(mapped).not.toContain(SessionUploadState.LocalOnly);
  });
});
