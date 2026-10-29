import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
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

/**
 * FEA-4222 (davetho review cid 3884190654) — the SECOND producer of the new
 * optional `customFields` contract.
 *
 * `findSessions` and this reader both populate it, and only the first had
 * coverage, so this one could stop emitting the key — or start emitting `[]`
 * where the other omits it — with nothing red. That is the divergence shape
 * this repo keeps rediscovering when two paths populate one field.
 *
 * Both legs matter and they are NOT interchangeable: `[]` is a successful read
 * with no values, an OMITTED key is "this producer did not load the
 * projection". A consumer distinguishes them — the web controller renders no
 * custom-field columns at all on the omitted shape rather than claiming the org
 * has none — so a producer collapsing the two is a lie about the data.
 */
describe("listSessionsByArtifactIds custom-field projection (FEA-4222)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits an empty array when the custom-field read succeeds with no values", async () => {
    installDb({
      customFieldValue: { findMany: vi.fn().mockResolvedValue([]) },
      sessionDetail: buildAgentSessionDbMock({
        findMany: vi.fn().mockResolvedValue([record()]),
        count: vi.fn().mockResolvedValue(0),
      }),
      sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const items = await listSessionsByArtifactIds("org-1", [ARTIFACT_ID]);

    // `toHaveProperty` as well as the value: `toEqual([])` alone passes against
    // an absent key too, which is the exact distinction under test.
    expect(items[0]).toHaveProperty("customFields");
    expect(items[0]?.customFields).toEqual([]);
  });

  it("omits the key entirely when the custom-field read fails", async () => {
    installDb({
      customFieldValue: {
        findMany: vi.fn().mockRejectedValue(new Error("read unavailable")),
      },
      sessionDetail: buildAgentSessionDbMock({
        findMany: vi.fn().mockResolvedValue([record()]),
        count: vi.fn().mockResolvedValue(0),
      }),
      sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const items = await listSessionsByArtifactIds("org-1", [ARTIFACT_ID]);

    // The page still renders — a failed custom-field read must not take the
    // session list down with it — but it must not claim zero values either.
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("customFields");
  });
});

/**
 * ISS-9884: the reason has to reach the LIST item, not only the detail
 * response, because `getSessionSyncStatus` renders both from the same
 * derivation and keys on the disposition alone without it. Driven through each
 * producer's own production path — `loadListTranscriptVerdicts` really runs,
 * the real `findMany` mock answers it, and the real projection stamps the row.
 */
describe("listSessionsByArtifactIds transcript disposition reason (ISS-9884)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function installSkippedTranscript(reason: TranscriptSkipReason) {
    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany: vi.fn().mockResolvedValue([record()]),
        count: vi.fn().mockResolvedValue(0),
      }),
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([
          {
            fileKey: MAIN_FILE_KEY,
            uploadStatus: TranscriptUploadStatus.Skipped,
            uploadedAt: null,
            lastObservedAt: new Date("2026-07-28T22:11:00.000Z"),
            permanentFailureReason: reason,
            computeTargetId: "target-1",
            externalSessionId: "external-session-1",
          },
        ]),
      },
    });
  }

  it("carries environment_unavailable beside the failedTransient verdict", async () => {
    installSkippedTranscript(TranscriptSkipReason.EnvironmentUnavailable);

    const items = await listSessionsByArtifactIds("org-1", [ARTIFACT_ID]);

    expect(items[0]?.transcriptDisposition).toBe(
      TranscriptDisposition.FailedTransient
    );
    expect(items[0]?.transcriptDispositionReason).toBe(
      TranscriptSkipReason.EnvironmentUnavailable
    );
  });

  it("OMITS the key rather than serializing null when no terminal produced the verdict", async () => {
    // Cross-repo rule: an absent optional field stays absent on the wire.
    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany: vi.fn().mockResolvedValue([record()]),
        count: vi.fn().mockResolvedValue(0),
      }),
      sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const items = await listSessionsByArtifactIds("org-1", [ARTIFACT_ID]);

    expect(items[0]).not.toHaveProperty("transcriptDispositionReason");
  });

  it("still carries a HARD reason, so a consumer can tell the two terminals apart", async () => {
    installSkippedTranscript(TranscriptSkipReason.TooLarge);

    const items = await listSessionsByArtifactIds("org-1", [ARTIFACT_ID]);

    expect(items[0]?.transcriptDisposition).toBe(
      TranscriptDisposition.FailedPermanent
    );
    expect(items[0]?.transcriptDispositionReason).toBe(
      TranscriptSkipReason.TooLarge
    );
  });
});
