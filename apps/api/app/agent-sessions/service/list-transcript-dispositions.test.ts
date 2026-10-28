import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";
import { MAIN_FILE_KEY } from "../transcript-availability";

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

const PAUSED_SESSION_ID = "33333333-3333-7333-8333-333333333333";
const OBSERVED_AT = new Date("2026-07-28T22:11:00.000Z");

/**
 * ISS-9884: the MAIN Sessions list is the third producer of the verdict, and
 * the one the badge and the list label actually read. It is driven end to end
 * here — the real `loadListTranscriptVerdicts` runs against the mocked
 * `findMany`, the real fold derives the verdict, and the real projection
 * stamps the row — rather than re-deriving the map in the test, which would
 * prove nothing about the wiring.
 */
describe("the Sessions list carries the transcript disposition reason (ISS-9884)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function installSkipped(reason: TranscriptSkipReason | null) {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            artifactId: PAUSED_SESSION_ID,
            externalSessionId: "external-paused",
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([
          {
            fileKey: MAIN_FILE_KEY,
            uploadStatus: TranscriptUploadStatus.Skipped,
            uploadedAt: null,
            lastObservedAt: OBSERVED_AT,
            permanentFailureReason: reason,
            computeTargetId: "target-1",
            externalSessionId: "external-paused",
          },
        ]),
      },
    });
  }

  it("serves environment_unavailable beside the failedTransient verdict", async () => {
    installSkipped(TranscriptSkipReason.EnvironmentUnavailable);

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.transcriptDisposition).toBe(
      TranscriptDisposition.FailedTransient
    );
    expect(result.items[0]?.transcriptDispositionReason).toBe(
      TranscriptSkipReason.EnvironmentUnavailable
    );
  });

  it("keeps retries_exhausted mapping to failedPermanent, reason and all", async () => {
    // The old-client control: an installed desktop that never upgrades keeps
    // sending this label and must keep getting exactly today's verdict.
    installSkipped(TranscriptSkipReason.RetriesExhausted);

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.transcriptDisposition).toBe(
      TranscriptDisposition.FailedPermanent
    );
    expect(result.items[0]?.transcriptDispositionReason).toBe(
      TranscriptSkipReason.RetriesExhausted
    );
  });

  it("omits the reason key for a legacy label it cannot narrow", async () => {
    // `normalizeSkipReason` degrades an unrecognized label to null, which must
    // reach the wire as an ABSENT key and the conservative hard verdict.
    installSkipped("something_a_newer_build_wrote" as TranscriptSkipReason);

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.transcriptDisposition).toBe(
      TranscriptDisposition.FailedPermanent
    );
    expect(result.items[0]).not.toHaveProperty("transcriptDispositionReason");
  });

  it("omits the reason key for a session with no transcript rows at all", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            artifactId: PAUSED_SESSION_ID,
            externalSessionId: "external-paused",
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
      sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    // The ISS-4621 synthesized `syncing`, which no terminal produced.
    expect(result.items[0]?.transcriptDisposition).toBe(
      TranscriptDisposition.Syncing
    );
    expect(result.items[0]).not.toHaveProperty("transcriptDispositionReason");
  });
});
