import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { SessionEvidenceCoverage } from "@repo/api/src/types/session-evidence-coverage-constants";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPersistedEvent,
  buildSessionDetailRecord,
  installDb,
  SESSION_STARTED_AT,
  SESSION_UPDATED_AT,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "./service";
import {
  resetSessionEvidenceEmissionBudget,
  SESSION_EVIDENCE_METADATA_ONLY_EVENT,
} from "./service/session-evidence-coverage";

const warn = vi.fn();

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

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: (event: string, fields: unknown) => warn(event, fields),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/**
 * ISS-7427 exemplar shape: the main transcript is terminally skipped for a
 * non-recoverable reason (which is what renders "Transcript not archived"),
 * while subagent transcripts are readable and the metadata lane carries a
 * cost/token rollup.
 */
function terminallySkippedMain() {
  return {
    fileKey: "main",
    uploadStatus: TranscriptUploadStatus.Skipped,
    computeTargetId: "target-1",
    externalSessionId: "external-session-1",
    uploadedAt: null,
    lastObservedAt: SESSION_STARTED_AT,
    permanentFailureReason: TranscriptSkipReason.TooLarge,
  };
}

function readableSubagent() {
  return {
    fileKey: "subagent:a",
    uploadStatus: TranscriptUploadStatus.Uploaded,
    computeTargetId: "target-1",
    externalSessionId: "external-session-1",
    uploadedAt: SESSION_UPDATED_AT,
    lastObservedAt: SESSION_UPDATED_AT,
    permanentFailureReason: null,
  };
}

/** Zeroes the cost/token rollup so only the event lane can supply evidence. */
const NO_ROLLUP = {
  estimatedCost: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function installDetail(
  transcriptRows: unknown[],
  recordOverrides: Record<string, unknown> = {}
) {
  installDb({
    sessionDetail: {
      findFirst: vi
        .fn()
        .mockResolvedValue(buildSessionDetailRecord(recordOverrides)),
    },
    sessionTranscript: {
      findMany: vi.fn().mockResolvedValue(transcriptRows),
    },
  });
}

function evidenceEmissions() {
  return warn.mock.calls.filter(
    (call) => call[0] === SESSION_EVIDENCE_METADATA_ONLY_EVENT
  );
}

describe("findSessionDetail mixed-evidence logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionEvidenceEmissionBudget();
  });

  afterEach(() => {
    resetSessionEvidenceEmissionBudget();
  });

  it("logs the mixed cohort when it serves metrics with no main archive behind them", async () => {
    installDetail([terminallySkippedMain(), readableSubagent()]);

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    // The metrics still ship — they are metadata-lane sourced and valid without
    // the archive. That is exactly why the mix needs its own signal.
    expect(result?.estimatedCost).toBeGreaterThan(0);
    expect(evidenceEmissions()).toEqual([
      [
        SESSION_EVIDENCE_METADATA_ONLY_EVENT,
        {
          organizationId: "org-1",
          sessionId: "session-1",
          harness: "claude",
          coverage: "metadataOnly",
          transcriptDisposition: "failedPermanent",
          derivedEventCount: 0,
          derivedEventsTruncated: false,
          readableSubagentTranscriptCount: 1,
          hasMetricRollup: true,
          hasSessionSpan: true,
        },
      ],
    ]);
  });

  it("counts a main archive skipped after retries were exhausted", async () => {
    installDetail([
      {
        ...terminallySkippedMain(),
        permanentFailureReason: TranscriptSkipReason.RetriesExhausted,
      },
    ]);

    await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(evidenceEmissions()).toHaveLength(1);
    expect(evidenceEmissions()[0][1]).toMatchObject({
      transcriptDisposition: "failedPermanent",
      readableSubagentTranscriptCount: 0,
      hasMetricRollup: true,
    });
  });

  /**
   * A `skipped` main whose source can be re-materialized is NOT a dead end —
   * `deriveTranscriptDisposition` maps it to `syncing`. Counting it would
   * inflate the cohort with sessions whose transcript is still coming.
   */
  it("stays silent for a terminal skip whose source can still re-materialize", async () => {
    installDetail([
      {
        ...terminallySkippedMain(),
        permanentFailureReason:
          TranscriptSkipReason.MaterializedSourceUnavailable,
      },
    ]);

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(result?.transcriptDisposition).toBe("syncing");
    expect(evidenceEmissions()).toEqual([]);
  });

  it("stays silent when the main transcript is readable", async () => {
    installDetail([
      {
        fileKey: "main",
        uploadStatus: TranscriptUploadStatus.Uploaded,
        computeTargetId: "target-1",
        externalSessionId: "external-session-1",
        uploadedAt: SESSION_UPDATED_AT,
        lastObservedAt: SESSION_UPDATED_AT,
        permanentFailureReason: null,
      },
    ]);

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(result?.transcriptDisposition).toBe("synced");
    expect(evidenceEmissions()).toEqual([]);
  });

  /**
   * Pins `derivedEventCount` to the projected trace population: with the rollup
   * zeroed and no readable subagent, the synced event rows are the ONLY thing
   * that can carry this session into the mixed cohort.
   */
  it("counts synced trace rows as the sole surviving evidence", async () => {
    installDetail([terminallySkippedMain()], {
      ...NO_ROLLUP,
      // Three CONSECUTIVE tool events: the turn projection coalesces them into
      // one `tools` row, so the rendered trace count (1) and the raw event-row
      // count (3) genuinely differ here. A fixture where they coincide cannot
      // tell the two operands apart.
      events: [
        buildPersistedEvent({ externalEventId: "event-1" }),
        buildPersistedEvent({ externalEventId: "event-2" }),
        buildPersistedEvent({ externalEventId: "event-3" }),
      ],
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(evidenceEmissions()).toHaveLength(1);
    expect(evidenceEmissions()[0][1]).toMatchObject({
      coverage: "metadataOnly",
      derivedEventCount: 1,
      readableSubagentTranscriptCount: 0,
      hasMetricRollup: false,
    });
    // The emitted count and the count the Session Trace header renders are the
    // same number — pinned to a literal on both sides, not read off each other.
    expect(result?.turnItems).toHaveLength(1);
  });

  /**
   * An unreadable subagent file is not surviving evidence, and this pins that
   * clause directly: `readableSubagentTranscriptCount` must be 0.
   *
   * It is asserted on the EMITTED payload rather than through silence
   * (whitlockk, #5584). Silence stopped being the right probe once the session span
   * became evidence: this record carries `sessionStartedAt`, so the read serves
   * a rendered Duration and belongs in the mixed cohort no matter what the
   * subagent lane did. Proving the subagent is uncounted is the contract this
   * test was always named for; the old `[]` conflated it with the span clause.
   */
  it("does not count an unreadable subagent archive as surviving evidence", async () => {
    installDetail(
      [
        terminallySkippedMain(),
        {
          ...readableSubagent(),
          uploadStatus: TranscriptUploadStatus.Failed,
          computeTargetId: "target-1",
          externalSessionId: "external-session-1",
          uploadedAt: null,
        },
      ],
      NO_ROLLUP
    );

    await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(evidenceEmissions()).toHaveLength(1);
    expect(evidenceEmissions()[0][1]).toMatchObject({
      readableSubagentTranscriptCount: 0,
      derivedEventCount: 0,
      hasMetricRollup: false,
      hasSessionSpan: true,
    });
  });

  /**
   * whitlockk, #5584 — the exact case the classifier used to miss. Terminally
   * absent main, ZERO tokens, ZERO cost, ZERO synced events, NO readable
   * subagent: every evidence arm empty EXCEPT the session span. The response
   * still serves `startedAt`/`endedAt`, and the detail's Duration row renders
   * elapsed time from them, so this read shows the user a metadata-lane number
   * the dead archive never backed. Classifying it `noEvidence` (and staying
   * silent) undercounted precisely the mixed archive/metadata cohort this
   * instrument exists to measure.
   */
  it("counts a session whose only surviving evidence is its rendered elapsed span", async () => {
    installDetail([terminallySkippedMain()], NO_ROLLUP);

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    // The span the Duration row renders from is really served on this response.
    expect(result?.startedAt).toEqual(SESSION_STARTED_AT);

    expect(evidenceEmissions()).toHaveLength(1);
    const [, fields] = evidenceEmissions()[0];
    expect(fields).toMatchObject({
      coverage: "metadataOnly",
      derivedEventCount: 0,
      readableSubagentTranscriptCount: 0,
      hasMetricRollup: false,
      hasSessionSpan: true,
    });
    expect(fields.coverage).not.toBe("noEvidence");
  });

  it("stays silent while the main transcript is still uploading", async () => {
    installDetail([readableSubagent()]);

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(result?.transcriptDisposition).toBe("syncing");
    expect(evidenceEmissions()).toEqual([]);
  });
});

/**
 * ISS-7427 part 3. Logging the mixed cohort made it countable BY US; the
 * reporter's complaint was about what the SCREEN said, and the renderer cannot
 * disclose a verdict the response never carries.
 *
 * These are deliberately separate from the logging specs above: the emission is
 * throttled and fires only for the mixed cohort, so a suite that only watched
 * `log.warn` would be satisfied by a response that serves nothing at all.
 */
describe("findSessionDetail evidence coverage on the response", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionEvidenceEmissionBudget();
  });

  afterEach(() => {
    resetSessionEvidenceEmissionBudget();
  });

  it("serves the mixed verdict the renderer discloses from", async () => {
    installDetail([terminallySkippedMain(), readableSubagent()]);

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(result?.evidenceCoverage).toBe(SessionEvidenceCoverage.MetadataOnly);
  });

  /*
   * The field is served on EVERY read, not only the cohort that gets logged.
   * Without this, gating the assignment on `isMixedEvidenceCoverage` would pass
   * the spec above while making `undefined` ambiguous between "old server" and
   * "this server says main is readable" — the exact collapse the wire contract
   * forbids.
   */
  it("serves a readable verdict too, not only the mixed one", async () => {
    installDetail([
      {
        fileKey: "main",
        uploadStatus: TranscriptUploadStatus.Uploaded,
        computeTargetId: "target-1",
        externalSessionId: "external-session-1",
        uploadedAt: SESSION_UPDATED_AT,
        lastObservedAt: SESSION_UPDATED_AT,
        permanentFailureReason: null,
      },
    ]);

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(result?.evidenceCoverage).toBe(SessionEvidenceCoverage.MainReadable);
    expect(evidenceEmissions()).toEqual([]);
  });

  it("serves the pending verdict while the upload is still in flight", async () => {
    installDetail([readableSubagent()]);

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(result?.evidenceCoverage).toBe(SessionEvidenceCoverage.Pending);
  });
});
