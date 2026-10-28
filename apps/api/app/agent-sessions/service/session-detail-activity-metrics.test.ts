import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { AutonomyBand } from "@repo/api/src/types/session-activity-metrics";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { Prisma } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { buildSessionDetailRecord } from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionDetailSelect } from "./records";
import {
  type AgentSessionDetailProjectionInput,
  projectAgentSessionDetail,
} from "./session-detail-read";

vi.mock("@repo/database", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/database")>("@repo/database");
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return { ...databaseModuleMock(), Prisma: actual.Prisma };
});

const ORGANIZATION_ID = "org-1";

function projectionInput(
  overrides: Record<string, unknown>,
  transcriptRows: AgentSessionDetailProjectionInput["transcriptRows"] = []
): AgentSessionDetailProjectionInput {
  return {
    organizationId: ORGANIZATION_ID,
    record: buildSessionDetailRecord(
      overrides
    ) as unknown as AgentSessionDetailProjectionInput["record"],
    sourceArtifactsById: new Map(),
    transcriptRows,
    authoritativeCostUsd: null,
  };
}

const transcriptRow = (syncedByteOffset: bigint, rawByteSize: bigint | null) =>
  ({
    computeTargetId: "ct-1",
    externalSessionId: "ext-1",
    fileKey: "main",
    uploadStatus: "uploaded",
    uploadedAt: new Date("2026-09-20T00:00:00Z"),
    lastObservedAt: new Date("2026-09-20T00:00:00Z"),
    permanentFailureReason: null,
    syncedByteOffset,
    rawByteSize,
  }) as unknown as AgentSessionDetailProjectionInput["transcriptRows"][number];

/** A file the desktop terminally skipped: its size is never coming (ISS-11089). */
const skippedTranscriptRow = (permanentFailureReason: string) =>
  ({
    computeTargetId: "ct-1",
    externalSessionId: "ext-1",
    fileKey: "subagent:1",
    uploadStatus: TranscriptUploadStatus.Skipped,
    uploadedAt: null,
    lastObservedAt: new Date("2026-09-20T00:00:00Z"),
    permanentFailureReason,
    syncedByteOffset: 0n,
    rawByteSize: null,
  }) as unknown as AgentSessionDetailProjectionInput["transcriptRows"][number];

describe("session detail activity-metrics projection", () => {
  it("OMITS the rollup key entirely when the session has no stored rollup", () => {
    const detail = projectAgentSessionDetail(
      projectionInput({ activityMetrics: null })
    );
    // Absence, not an all-null object and emphatically not zeroes: a client must
    // be unable to read "no rollup" as "the rollup ran and measured nothing".
    expect(detail).not.toHaveProperty("activityMetrics");
  });

  it("publishes the band, the whole confidence split and the counts", () => {
    const detail = projectAgentSessionDetail(
      projectionInput({
        activityMetrics: {
          autonomyBand: AutonomyBand.Agentic,
          coverage: 0.5,
          spendLowConfUsd: new Prisma.Decimal("1.500000"),
          spendMediumConfUsd: new Prisma.Decimal("2.000000"),
          spendHighConfUsd: new Prisma.Decimal("3.250000"),
          segmentCount: 10,
          coveredSegmentCount: 5,
          classifierVersion: 7,
          metricVersion: 3,
        },
      })
    );
    expect(detail.activityMetrics).toEqual({
      autonomyBand: AutonomyBand.Agentic,
      coverage: 0.5,
      spendLowConfUsd: 1.5,
      spendMediumConfUsd: 2,
      spendHighConfUsd: 3.25,
      segmentCount: 10,
      coveredSegmentCount: 5,
      classifierVersion: 7,
      metricVersion: 3,
    });
  });

  it("re-checks a stored row on the way out: an impossible band reads unknown", () => {
    // The row predates the current validity predicate, or a producer wrote a
    // vocabulary this build does not know. Either way it must not leave as a
    // measurement — while the measures beside it still publish.
    const detail = projectAgentSessionDetail(
      projectionInput({
        activityMetrics: {
          autonomyBand: "supervised",
          coverage: null,
          spendLowConfUsd: null,
          spendMediumConfUsd: null,
          spendHighConfUsd: null,
          segmentCount: 12,
          coveredSegmentCount: null,
          classifierVersion: null,
          metricVersion: null,
        },
      })
    );
    expect(detail.activityMetrics?.autonomyBand).toBeNull();
    expect(detail.activityMetrics?.segmentCount).toBe(12);
  });
});

describe("session detail transcript archive progress", () => {
  it("OMITS the progress key when the session has no archive rows", () => {
    const detail = projectAgentSessionDetail(projectionInput({}, []));
    expect(detail).not.toHaveProperty("transcriptArchiveProgress");
  });

  it("exposes the cloud archive's byte-level completeness across files", () => {
    const detail = projectAgentSessionDetail(
      projectionInput({}, [
        transcriptRow(100n, 400n),
        transcriptRow(250n, 250n),
      ])
    );
    expect(detail.transcriptArchiveProgress).toEqual({
      archivedByteOffset: 350,
      observedByteSize: 650,
      fileCount: 2,
      reportingFileCount: 2,
      unrecoverableFileCount: 0,
    });
  });

  it("carries BOTH new counts out on the RESPONSE, beside a withheld denominator (ISS-11089)", () => {
    // A disclosure that exists only inside the fold reaches no reader. This is
    // the production entry point the session-detail route serves, so it pins
    // that the counts leave with the figures they explain.
    const detail = projectAgentSessionDetail(
      projectionInput({}, [
        transcriptRow(400n, 400n),
        skippedTranscriptRow(TranscriptSkipReason.TooLarge),
      ])
    );
    expect(detail.transcriptArchiveProgress).toEqual({
      archivedByteOffset: 400,
      // Unchanged by ISS-11089: one row never reported a size, so the
      // denominator is withheld rather than re-based onto the other (400/400
      // would have read as complete). The counts say why it is withheld.
      observedByteSize: null,
      fileCount: 2,
      reportingFileCount: 1,
      unrecoverableFileCount: 1,
    });
  });
});

describe("activity-segment tiling read (ISS-10721 AC4)", () => {
  it("selects workItemRef and subagentId, so the tiling read is not lossy", () => {
    // These two carry the work-item attribution and the subagent split; the
    // sibling Branch reader deliberately drops them, so nothing else pins that
    // the SESSION detail read carries them out of the existing cloud table.
    const segmentSelect = agentSessionDetailSelect.activitySegmentRows.select;
    expect(segmentSelect.workItemRef).toBe(true);
    expect(segmentSelect.subagentId).toBe(true);
  });

  it("carries both fields through to the projected tiling rows", () => {
    const detail = projectAgentSessionDetail(
      projectionInput({
        activitySegmentRows: [
          {
            phase: "implement",
            startMs: 0n,
            endMs: 1000n,
            confidence: 0.9,
            evidenceLayers: ["declared"],
            classifierVersion: 3,
            workItemRef: "ISS-10721",
            subagentId: "sub-7",
          },
        ],
      })
    );
    expect(detail.activitySegmentRows?.[0]).toMatchObject({
      workItemRef: "ISS-10721",
      subagentId: "sub-7",
    });
  });
});
