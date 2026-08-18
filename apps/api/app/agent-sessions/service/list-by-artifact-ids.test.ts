import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import {
  TranscriptSkipReason,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { MAIN_FILE_KEY } from "../transcript-availability";
import { listSessionsByArtifactIds } from "./list-by-artifact-ids";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const ARTIFACT_ID = "22222222-2222-7222-8222-222222222222";

function record() {
  return buildSessionListRecord({ artifactId: ARTIFACT_ID });
}

/**
 * ISS-4621 (review): the by-artifact-ids reader (agent-component "Sessions"
 * tab) must run the SAME transcript-disposition batch + cloudSyncState
 * reconciliation as the main Sessions list. It previously passed `undefined`,
 * which stamped the pre-ISS-4621 hardcoded `synced` on rows whose transcript
 * was still missing/uploading — list/detail said `pending`, this tab said
 * `synced`, for the same session.
 */
describe("listSessionsByArtifactIds transcript reconciliation (ISS-4621)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports pending for a session whose transcript blob is still syncing", async () => {
    const transcriptFindMany = vi.fn().mockResolvedValue([
      {
        fileKey: MAIN_FILE_KEY,
        uploadStatus: TranscriptUploadStatus.Pending,
        uploadedAt: null,
        lastObservedAt: new Date("2026-07-28T22:11:00.000Z"),
        permanentFailureReason: null,
        computeTargetId: "target-1",
        externalSessionId: "external-session-1",
      },
    ]);
    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany: vi.fn().mockResolvedValue([record()]),
        count: vi.fn().mockResolvedValue(0),
      }),
      sessionTranscript: { findMany: transcriptFindMany },
    });

    const items = await listSessionsByArtifactIds("org-1", [ARTIFACT_ID]);

    expect(items[0]?.transcriptDisposition).toBe(TranscriptDisposition.Syncing);
    expect(items[0]?.cloudSyncState).toBe(AgentSessionCloudSyncState.Pending);
  });

  it("reports synced for a session whose transcript blob is uploaded and current", async () => {
    const transcriptFindMany = vi.fn().mockResolvedValue([
      {
        fileKey: MAIN_FILE_KEY,
        uploadStatus: TranscriptUploadStatus.Uploaded,
        uploadedAt: new Date("2026-07-28T22:11:00.000Z"),
        lastObservedAt: new Date("2026-07-28T22:11:00.000Z"),
        permanentFailureReason: null,
        computeTargetId: "target-1",
        externalSessionId: "external-session-1",
      },
    ]);
    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany: vi.fn().mockResolvedValue([record()]),
        count: vi.fn().mockResolvedValue(0),
      }),
      sessionTranscript: { findMany: transcriptFindMany },
    });

    const items = await listSessionsByArtifactIds("org-1", [ARTIFACT_ID]);

    expect(items[0]?.transcriptDisposition).toBe(TranscriptDisposition.Synced);
    expect(items[0]?.cloudSyncState).toBe(AgentSessionCloudSyncState.Synced);
  });

  it("ISS-4647: reports synced for a TERMINALLY skipped transcript (settled, not in flight)", async () => {
    // The other boundary of the same gate: `failedPermanent` is settled — the
    // blob is never coming, the row is as complete as it will ever be, and the
    // honest detail rides `transcriptDisposition`. Reconciling it to `pending`
    // would leave this tab claiming "still uploading" forever.
    const transcriptFindMany = vi.fn().mockResolvedValue([
      {
        fileKey: MAIN_FILE_KEY,
        uploadStatus: TranscriptUploadStatus.Skipped,
        uploadedAt: null,
        lastObservedAt: new Date("2026-07-28T22:11:00.000Z"),
        permanentFailureReason: TranscriptSkipReason.SourceGone,
        computeTargetId: "target-1",
        externalSessionId: "external-session-1",
      },
    ]);
    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany: vi.fn().mockResolvedValue([record()]),
        count: vi.fn().mockResolvedValue(0),
      }),
      sessionTranscript: { findMany: transcriptFindMany },
    });

    const items = await listSessionsByArtifactIds("org-1", [ARTIFACT_ID]);

    expect(items[0]?.transcriptDisposition).toBe(
      TranscriptDisposition.FailedPermanent
    );
    expect(items[0]?.cloudSyncState).toBe(AgentSessionCloudSyncState.Synced);
  });

  it("synthesizes syncing/pending for a session with zero transcript rows (list↔detail parity)", async () => {
    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany: vi.fn().mockResolvedValue([record()]),
        count: vi.fn().mockResolvedValue(0),
      }),
      sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const items = await listSessionsByArtifactIds("org-1", [ARTIFACT_ID]);

    expect(items[0]?.transcriptDisposition).toBe(TranscriptDisposition.Syncing);
    expect(items[0]?.cloudSyncState).toBe(AgentSessionCloudSyncState.Pending);
  });
});
