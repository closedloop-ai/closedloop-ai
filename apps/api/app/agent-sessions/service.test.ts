import {
  TranscriptAvailability,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionsService } from "./service";
import {
  buildSessionDetailRecord,
  installDb,
  SESSION_STARTED_AT,
  SESSION_UPDATED_AT,
} from "./service.test-harness";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import("./service.test-mocks");
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import("./service.test-mocks");
  return telemetryModuleMock();
});

describe("agentSessionsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enriches the detail with per-file transcript availability summaries", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        fileKey: "main",
        uploadStatus: TranscriptUploadStatus.Uploaded,
        uploadedAt: SESSION_UPDATED_AT,
        lastObservedAt: SESSION_UPDATED_AT,
      },
      {
        fileKey: "subagent:a",
        uploadStatus: TranscriptUploadStatus.Pending,
        uploadedAt: null,
        lastObservedAt: SESSION_STARTED_AT,
      },
    ]);
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(buildSessionDetailRecord()),
      },
      sessionTranscript: { findMany },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    // Scoped by session identity (org + computeTarget + externalSession), not
    // the nullable sessionDetailId FK.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          computeTargetId: "target-1",
          externalSessionId: "external-session-1",
        },
      })
    );
    // Summaries only — no signed URL is minted on the detail path.
    expect(result?.transcripts).toEqual([
      {
        fileKey: "main",
        availability: TranscriptAvailability.Available,
        uploadedAt: SESSION_UPDATED_AT.toISOString(),
      },
      {
        fileKey: "subagent:a",
        availability: TranscriptAvailability.UploadPending,
        uploadedAt: null,
      },
    ]);
  });
  it("synthesizes a missing main summary when the session has only subagent transcripts", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(buildSessionDetailRecord()),
      },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([
          {
            fileKey: "subagent:a",
            uploadStatus: TranscriptUploadStatus.Uploaded,
            uploadedAt: SESSION_UPDATED_AT,
            lastObservedAt: SESSION_UPDATED_AT,
          },
        ]),
      },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(result?.transcripts).toEqual([
      {
        fileKey: "main",
        availability: TranscriptAvailability.Missing,
        uploadedAt: null,
      },
      {
        fileKey: "subagent:a",
        availability: TranscriptAvailability.Available,
        uploadedAt: SESSION_UPDATED_AT.toISOString(),
      },
    ]);
  });
});
